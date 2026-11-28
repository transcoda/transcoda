// Resolves the web UI's minified stack frames with the source maps the web build writes next to its
// bundles (Vite's `sourcemap: 'hidden'`). The maps are never served (`http/static.ts`): only this
// reader opens them, so a stack in the server log points at real code and nothing is published.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';

// A scrubbed frame on one of the build's own bundles (`scrubFrame` in @transcoda/shared).
const FRAME_RE = /^at (?:(.+?) \()?\/assets\/([\w-]+(?:\.[\w-]+)*\.js):(\d+):(\d+)\)?$/;

/** Maps kept parsed; the app has a handful of bundles. */
const CACHE_SIZE = 8;
/** A map larger than this is not read (the web app's largest is a few MB). */
const MAX_MAP_BYTES = 30_000_000;

/** A map's source as a path in the repository (`src/jobs/JobPage/JobPage.tsx`). */
export function sourcePath(source: string): string {
  const s = source.replace(/^[a-z]+:\/\/\/?/i, '').replace(/\\/g, '/');
  const nm = s.lastIndexOf('node_modules/');
  if (nm >= 0) return s.slice(nm);
  return s.replace(/^(?:\.{1,2}\/)+/, '');
}

export type ReadMap = (path: string) => Promise<string>;

export class SourceMaps {
  private readonly cache = new Map<string, Promise<TraceMap | null>>();

  /**
   * `assetsDir`: the web build's `assets` folder, or null when the server serves no UI (then
   * frames stay as they are).
   */
  constructor(
    private readonly assetsDir: string | null,
    private readonly read: ReadMap = (path) => readFile(path, 'utf8'),
  ) {}

  /** The frame with its bundle position replaced by the original file, line and column. */
  async resolve(frame: string): Promise<string> {
    const m = FRAME_RE.exec(frame);
    if (!m || this.assetsDir === null) return frame;
    const [, fn, file, line, column] = m;
    const map = await this.load(file as string);
    if (!map) return frame;
    const pos = originalPositionFor(map, { line: Number(line), column: Number(column) - 1 });
    if (pos.source === null || pos.line === null) return frame;
    const where = `${sourcePath(pos.source)}:${pos.line}:${pos.column + 1}`;
    return fn ? `at ${fn} (${where})` : `at ${where}`;
  }

  private load(file: string): Promise<TraceMap | null> {
    const hit = this.cache.get(file);
    if (hit) {
      // Most recently used last, so the oldest goes first.
      this.cache.delete(file);
      this.cache.set(file, hit);
      return hit;
    }
    const loading = this.parse(file);
    this.cache.set(file, loading);
    if (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return loading;
  }

  /** Null when the map is missing (a tab still running an older build), too large or broken. */
  private async parse(file: string): Promise<TraceMap | null> {
    try {
      const text = await this.read(join(this.assetsDir as string, `${file}.map`));
      if (text.length > MAX_MAP_BYTES) return null;
      return new TraceMap(text);
    } catch {
      return null;
    }
  }
}
