import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { emptyGraph, type StoredJobMedia } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertJob } from '../db/repos/jobs.ts';
import { insertLibrary, softDeleteLibrary } from '../db/repos/libraries.ts';
import { insertRun } from '../db/repos/runs.ts';
import { insertWorkflow } from '../db/repos/workflows.ts';
import type { Logger } from '../logger.ts';
import { createTestApp, type TestApp } from '../test-app.ts';
import { tempDir } from './fixtures.ts';
import {
  POSTER_BUILD_TIMEOUT_MS,
  POSTER_FAILURE_MEMORY_MS,
  POSTER_MAX_BUILDS,
  POSTER_MAX_BYTES,
  POSTER_MAX_WAITING,
  PosterStore,
  sniffPoster,
  type ThumbRunner,
  thumbArgs,
} from './poster-store.ts';

const execFileAsync = promisify(execFile);

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP')]);

describe('sniffPoster', () => {
  it('names the demuxer for a JPEG, PNG or WebP header', () => {
    expect(sniffPoster(JPEG)).toBe('jpeg_pipe');
    expect(sniffPoster(PNG)).toBe('png_pipe');
    expect(sniffPoster(WEBP)).toBe('webp_pipe');
  });

  it('refuses playlists, concat scripts and short headers', () => {
    expect(sniffPoster(Buffer.from('#EXTM3U\n#EXT'))).toBeNull();
    expect(sniffPoster(Buffer.from('ffconcat version 1.0'))).toBeNull();
    expect(sniffPoster(Buffer.alloc(0))).toBeNull();
    expect(sniffPoster(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffPoster(Buffer.from('RIFF\0\0\0\0AVI '))).toBeNull();
  });
});

describe('thumbArgs', () => {
  it('forces the demuxer on stdin and writes one 208 px wide JPEG frame', () => {
    const args = thumbArgs('png_pipe', '/x/t.jpg');
    const joined = args.join(' ');
    expect(joined).toContain('-f png_pipe -i pipe:0');
    expect(joined).toContain('-frames:v 1');
    expect(args[args.indexOf('-vf') + 1]).toContain('scale=208:-2');
    expect(args.at(-1)).toBe('/x/t.jpg');
    expect(args.indexOf('-f')).toBeLessThan(args.indexOf('-i'));
    // A decoder cap of 40 megapixels, before the input it applies to.
    expect(joined).toContain('-max_pixels 40000000 -f png_pipe -i pipe:0');
  });

  it('never names a library path', () => {
    const args = thumbArgs('jpeg_pipe', '/cache/k.tmp');
    expect(args.filter((a) => a.startsWith('/'))).toEqual(['/cache/k.tmp']);
  });
});

describe('PosterStore', () => {
  let base: string;
  let lib: string;
  let dir: string;
  let now: Date;
  let calls: Parameters<ThumbRunner>[0][];
  let run: ThumbRunner;
  const log: Logger = { info: () => {}, warn: () => {}, error: () => {} };

  /** A fake runner: drains the input and writes a marker JPEG to `outPath`. */
  const fakeRun: ThumbRunner = async (o) => {
    calls.push(o);
    for await (const _ of o.input) {
      // drain
    }
    await writeFile(o.outPath, 'thumb');
  };

  beforeEach(async () => {
    base = await tempDir('poster-store-');
    lib = join(base, 'lib');
    dir = join(base, 'cache', 'posters');
    await mkdir(join(lib, 'Sherlock Jr. (1924)'), { recursive: true });
    now = new Date('2026-11-17T12:00:00.000Z');
    calls = [];
    run = fakeRun;
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const store = () => new PosterStore({ dir, ffmpegPath: 'ffmpeg', now: () => now, log, run });
  const keyOf = (p: string) => createHash('sha256').update(p).digest('hex');
  const leftovers = async () =>
    (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.tmp'));

  async function poster(name = 'poster.jpg', head: Buffer = JPEG): Promise<string> {
    const p = join(lib, 'Sherlock Jr. (1924)', name);
    await writeFile(p, Buffer.concat([head, Buffer.alloc(100)]));
    const past = new Date(Date.now() - 60_000);
    await utimes(p, past, past);
    return p;
  }

  it('builds once and then serves the cache', async () => {
    const p = await poster();
    const s = store();
    const first = await s.thumbnail(p, lib);
    const info = await stat(join(dir, `${keyOf(p)}.jpg`));
    expect(first).toEqual({ path: join(dir, `${keyOf(p)}.jpg`), size: 5, mtimeMs: info.mtimeMs });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.demuxer).toBe('jpeg_pipe');
    expect(calls[0]?.ffmpegPath).toBe('ffmpeg');
    expect(calls[0]?.timeoutMs).toBe(POSTER_BUILD_TIMEOUT_MS);
    expect(POSTER_BUILD_TIMEOUT_MS).toBe(15_000);

    expect(await s.thumbnail(p, lib)).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(await leftovers()).toEqual([]);
  });

  it('rebuilds when the source is newer than the cache', async () => {
    const p = await poster('folder.png', PNG);
    const s = store();
    await s.thumbnail(p, lib);
    const future = new Date(Date.now() + 60_000);
    await utimes(p, future, future);
    expect(await s.thumbnail(p, lib)).not.toBeNull();
    expect(calls.map((c) => c.demuxer)).toEqual(['png_pipe', 'png_pipe']);
  });

  it('builds a source with a future time once, and rebuilds when its time moves back', async () => {
    const p = await poster();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await utimes(p, future, future);
    const s = store();
    expect(await s.thumbnail(p, lib)).not.toBeNull();
    expect(await s.thumbnail(p, lib)).not.toBeNull();
    expect(calls).toHaveLength(1);
    // An older copy put back in its place is a change too.
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await utimes(p, past, past);
    expect(await s.thumbnail(p, lib)).not.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('serves the cache once the source is gone', async () => {
    const p = await poster();
    const s = store();
    const first = await s.thumbnail(p, lib);
    await unlink(p);
    expect(await s.thumbnail(p, lib)).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  it('is null, never a throw, for a poster path that is not a string', async () => {
    const s = store();
    const call = () => s.thumbnail(42 as unknown as string, lib);
    expect(call).not.toThrow();
    expect(await call()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('is null for a missing source without a cache', async () => {
    expect(await store().thumbnail(join(lib, 'nope.jpg'), lib)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  describe('refuses without building', () => {
    it('a path outside the library root', async () => {
      const outside = join(base, 'elsewhere.jpg');
      await writeFile(outside, JPEG);
      expect(await store().thumbnail(outside, lib)).toBeNull();
    });

    it('a symlink to an image inside the root', async () => {
      const real = await poster();
      const link = join(lib, 'link.jpg');
      await symlink(real, link);
      expect(await store().thumbnail(link, lib)).toBeNull();
    });

    it('a path through a symlinked folder', async () => {
      const real = await poster();
      await symlink(join(lib, 'Sherlock Jr. (1924)'), join(lib, 'alias'));
      expect(await store().thumbnail(join(lib, 'alias', 'poster.jpg'), lib)).toBeNull();
      expect(real).toBeTruthy();
    });

    it('a directory', async () => {
      const d = join(lib, 'poster.jpg');
      await mkdir(d);
      expect(await store().thumbnail(d, lib)).toBeNull();
    });

    it('a file over the size cap', async () => {
      const big = join(lib, 'big.jpg');
      await writeFile(big, JPEG);
      await execFileAsync('truncate', ['-s', String(POSTER_MAX_BYTES + 1), big]);
      expect(await store().thumbnail(big, lib)).toBeNull();
    });

    it('a playlist named poster.jpg', async () => {
      const p = join(lib, 'Sherlock Jr. (1924)', 'poster.jpg');
      await writeFile(p, '#EXTM3U\n#EXTINF:-1,x\nhttp://example.invalid/a.ts\n');
      expect(await store().thumbnail(p, lib)).toBeNull();
    });

    afterEach(async () => {
      expect(calls).toHaveLength(0);
      expect(await readdir(dir).catch(() => [])).toEqual([]);
    });
  });

  it('serves only the cache without a library root', async () => {
    const p = await poster();
    expect(await store().thumbnail(p, null)).toBeNull();
    expect(calls).toHaveLength(0);
    const s = store();
    const built = await s.thumbnail(p, lib);
    expect(await s.thumbnail(p, null)).toEqual(built);
    expect(calls).toHaveLength(1);
  });

  it('shares one build between concurrent calls for one path', async () => {
    const p = await poster();
    const s = store();
    const [a, b] = await Promise.all([s.thumbnail(p, lib), s.thumbnail(p, lib)]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });

  it('runs at most two builds at once', async () => {
    let active = 0;
    let peak = 0;
    run = async (o) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      await fakeRun(o);
      active--;
    };
    const paths = await Promise.all([1, 2, 3, 4, 5].map((n) => poster(`p${n}.jpg`)));
    const s = store();
    const out = await Promise.all(paths.map((p) => s.thumbnail(p, lib)));
    expect(out.every((t) => t !== null)).toBe(true);
    expect(calls).toHaveLength(5);
    expect(peak).toBe(2);
  });

  /** A runner that blocks every build until `open()` is called. */
  const gatedRun = (): { open: () => void } => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    run = async (o) => {
      await gate;
      await fakeRun(o);
    };
    return { open: release };
  };
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it('opens a waiting build source only once it has a slot', async () => {
    const gate = gatedRun();
    const busy = await Promise.all(
      Array.from({ length: POSTER_MAX_BUILDS }, (_, n) => poster(`busy${n}.jpg`)),
    );
    const p = await poster('late.jpg');
    const s = store();
    const running = busy.map((b) => s.thumbnail(b, lib));
    const late = s.thumbnail(p, lib);
    await settle();
    // Replaced while it waits: a source opened before its slot would still read the old JPEG.
    await unlink(p);
    await poster('late.jpg', PNG);
    gate.open();
    await Promise.all(running);
    expect(await late).not.toBeNull();
    expect(calls.map((c) => c.demuxer)).toEqual(['jpeg_pipe', 'jpeg_pipe', 'png_pipe']);
  });

  it('builds nothing when the queue is full: the cache or null, and no failure remembered', async () => {
    const withCache = await poster('cached.jpg');
    const without = await poster('uncached.jpg');
    const old = await store().thumbnail(withCache, lib);
    expect(old).not.toBeNull();
    const future = new Date(Date.now() + 60_000);
    await utimes(withCache, future, future);
    calls = [];

    const gate = gatedRun();
    const s = store();
    const fill = await Promise.all(
      Array.from({ length: POSTER_MAX_BUILDS + POSTER_MAX_WAITING }, (_, n) =>
        poster(`fill${n}.jpg`),
      ),
    );
    const filling = fill.map((f) => s.thumbnail(f, lib));
    await settle();
    expect(await s.thumbnail(withCache, lib)).toEqual(old);
    expect(await s.thumbnail(without, lib)).toBeNull();
    gate.open();
    await Promise.all(filling);
    expect(calls).toHaveLength(fill.length);

    // Not a failure: both build once the queue has room.
    expect(await s.thumbnail(withCache, lib)).not.toEqual(old);
    expect(await s.thumbnail(without, lib)).not.toBeNull();
    expect(calls).toHaveLength(fill.length + 2);
    expect(POSTER_MAX_WAITING).toBe(32);
  });

  it('remembers a failed build for ten minutes', async () => {
    run = async (o) => {
      calls.push(o);
      await writeFile(o.outPath, 'partial');
      throw new Error('Invalid data found when processing input');
    };
    const p = await poster();
    const s = store();
    expect(await s.thumbnail(p, lib)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
    now = new Date(now.getTime() + POSTER_FAILURE_MEMORY_MS - 1);
    expect(await s.thumbnail(p, lib)).toBeNull();
    expect(calls).toHaveLength(1);
    now = new Date(now.getTime() + 1);
    expect(await s.thumbnail(p, lib)).toBeNull();
    expect(calls).toHaveLength(2);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('engine.jobPoster', () => {
  let base: string;
  let lib: string;
  let t: TestApp;
  let built: string[];
  const start = new Date('2026-11-17T12:00:00.000Z');

  beforeEach(async () => {
    base = await tempDir('job-poster-');
    lib = join(base, 'lib');
    await mkdir(lib, { recursive: true });
    t = createTestApp({ config: { configDir: join(base, 'config') } });
    built = [];
    // The real ffmpeg is not the point here: a fake runner stands in.
    Object.assign(t.deps.engine.posters, {
      run: async (o: Parameters<ThumbRunner>[0]) => {
        built.push(o.outPath);
        o.input.destroy();
        await writeFile(o.outPath, 'thumb');
      },
    });
    const db = t.deps.db;
    insertWorkflow(
      db,
      { id: 'w1', kind: 'workflow', name: 'Shrink', graph: emptyGraph('workflow'), createdBy: 'u' },
      start,
    );
    insertLibrary(
      db,
      { id: 'l1', name: 'Movies', path: lib, recycleFolder: null, processHardlinked: false },
      start,
    );
    insertRun(
      db,
      {
        id: 'r1',
        libraryId: 'l1',
        workflowId: 'w1',
        workflowVersion: 1,
        requestedPath: lib,
        dryRun: true,
        testEncode: false,
        force: false,
        createdBy: 'u',
      },
      start,
    );
  });
  afterEach(async () => {
    await t.deps.engine.stop();
    await rm(base, { recursive: true, force: true });
  });

  function job(id: string, posterPath: string | null): void {
    const media: StoredJobMedia = {
      kind: 'movie',
      title: 'The General',
      year: 1926,
      season: null,
      episode: null,
      episodeTitle: null,
      source: 'sidecar',
      posterPath,
    };
    insertJob(
      t.deps.db,
      {
        id,
        runId: 'r1',
        libraryId: 'l1',
        fileId: null,
        path: join(lib, `${id}.mkv`),
        workflowId: 'w1',
        workflowVersion: 1,
        dryRun: true,
        testEncode: false,
        state: 'queued',
        priority: 0,
        media,
      },
      start,
    );
  }

  it('is null for an unknown job or a job without a poster', async () => {
    job('a', null);
    expect(await t.deps.engine.jobPoster('nope')).toBeNull();
    expect(await t.deps.engine.jobPoster('a')).toBeNull();
  });

  it('builds into the config folder and serves only the cache once the library is deleted', async () => {
    const p = join(lib, 'poster.jpg');
    await writeFile(p, JPEG);
    job('a', p);
    const thumb = await t.deps.engine.jobPoster('a');
    expect(thumb?.path.startsWith(join(base, 'config', 'posters'))).toBe(true);
    expect(built).toHaveLength(1);

    softDeleteLibrary(t.deps.db, 'l1', start);
    const future = new Date(Date.now() + 60_000);
    await utimes(p, future, future);
    expect(await t.deps.engine.jobPoster('a')).toEqual(thumb);
    expect(built).toHaveLength(1);
    await unlink(thumb?.path ?? '');
    expect(await t.deps.engine.jobPoster('a')).toBeNull();
  });
});
