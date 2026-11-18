// Small JPEG thumbnails of the posters beside library files, for the Jobs list and the job page.
// The store opens the image itself (no symlink following), checks the open handle and its first
// bytes, and pipes it into ffmpeg's stdin with the demuxer forced from those bytes: ffmpeg never
// opens a path from a library and never guesses a format from content. One thumbnail per poster
// path, kept in `dir` (no pruning: they are small, and one per show or movie).
import childProcess from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { Logger } from '../logger.ts';
import { errorCode, openRegular, why } from './fs-ops.ts';
import { isWithin } from './paths.ts';

export type PosterDemuxer = 'jpeg_pipe' | 'png_pipe' | 'webp_pipe';
export type ThumbRunner = (o: {
  ffmpegPath: string;
  demuxer: PosterDemuxer;
  input: Readable;
  outPath: string;
  timeoutMs: number;
}) => Promise<void>;
export interface Thumbnail {
  path: string;
  size: number;
  mtimeMs: number;
}

export const POSTER_MAX_BYTES = 20 * 1024 * 1024;
export const POSTER_WIDTH = 208;
export const POSTER_BUILD_TIMEOUT_MS = 15_000;
export const POSTER_MAX_BUILDS = 2;
/** Builds that may wait for a slot; past this a request builds nothing and gets the cache. */
export const POSTER_MAX_WAITING = 32;
export const POSTER_FAILURE_MEMORY_MS = 10 * 60 * 1000;

/** Bytes read for {@link sniffPoster}: enough for the WebP signature. */
const HEAD_BYTES = 12;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** null for an unsupported or too-short header. */
export function sniffPoster(head: Buffer): PosterDemuxer | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'jpeg_pipe';
  }
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png_pipe';
  if (
    head.length >= 12 &&
    head.toString('latin1', 0, 4) === 'RIFF' &&
    head.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp_pipe';
  }
  return null;
}

/** The largest image a poster may decode to (40 megapixels): a small file cannot ask for more memory. */
export const POSTER_MAX_PIXELS = 40_000_000;

/**
 * ffmpeg arguments: forced demuxer on stdin, decoded to at most POSTER_MAX_PIXELS, one frame,
 * 208 px wide, JPEG to `outPath`.
 */
export function thumbArgs(demuxer: PosterDemuxer, outPath: string): string[] {
  // No -nostdin: stdin is the image.
  return [
    ...['-hide_banner', '-loglevel', 'error', '-y'],
    ...['-max_pixels', String(POSTER_MAX_PIXELS), '-f', demuxer, '-i', 'pipe:0'],
    ...['-frames:v', '1', '-vf', `scale=${POSTER_WIDTH}:-2`, '-q:v', '4'],
    ...['-f', 'mjpeg', outPath],
  ];
}

/**
 * Runs ffmpeg ({@link thumbArgs}) from `input` to `outPath`, modelled on `buildPreview`. Resolves
 * when ffmpeg exits 0; rejects with ffmpeg's first stderr line (or the exit) otherwise, when it
 * cannot be started, when reading `input` failed, or when it ran longer than `timeoutMs` (killed).
 * `input` is destroyed either way.
 */
export const runThumb: ThumbRunner = (o) =>
  new Promise((resolve, reject) => {
    const child = childProcess.spawn(o.ffmpegPath, thumbArgs(o.demuxer, o.outPath), {
      shell: false,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let firstStderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (!firstStderr) firstStderr = chunk.split('\n')[0]?.trim() ?? '';
    });
    // ffmpeg stops reading after one frame or on an error: EPIPE on stdin is expected then.
    let inputError: Error | null = null;
    child.stdin.on('error', () => o.input.destroy());
    o.input.on('error', (err) => {
      inputError ??= err;
      child.stdin.destroy();
    });
    o.input.pipe(child.stdin);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, o.timeoutMs);
    let settled = false;
    const settle = () => {
      settled = true;
      clearTimeout(timer);
      o.input.destroy();
    };
    child.on('error', (err) => {
      if (settled) return;
      settle();
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settle();
      if (timedOut) reject(new Error(`ffmpeg ran longer than ${o.timeoutMs / 1000} s`));
      else if (inputError) reject(new Error(`reading the poster failed: ${inputError.message}`));
      else if (code === 0) resolve();
      else reject(new Error(firstStderr || `ffmpeg exited with ${code ?? signal}`));
    });
  });

/** The open, checked source of a build. */
interface Source {
  handle: fsp.FileHandle;
  info: Stats;
  demuxer: PosterDemuxer;
}

/** Two file times to the millisecond (setting a time may drop its sub-millisecond part). */
const sameMs = (a: number, b: number): boolean => Math.trunc(a) === Math.trunc(b);

export class PosterStore {
  /** Builds and lookups running now, by cache key: concurrent calls share one. */
  private readonly inFlight = new Map<string, Promise<Thumbnail | null>>();
  /** When a build last failed, by cache key (ms). */
  private readonly failedAt = new Map<string, number>();
  private active = 0;
  /** Builds waiting for a slot, first come first served. */
  private readonly waiting: Array<() => void> = [];
  private readonly run: ThumbRunner;

  constructor(
    private readonly deps: {
      dir: string;
      ffmpegPath: string;
      now: () => Date;
      log: Logger;
      run?: ThumbRunner;
    },
  ) {
    this.run = deps.run ?? runThumb;
  }

  /** The cached thumbnail for `posterPath`, built or refreshed when needed; null when there is none. Never throws. */
  thumbnail(posterPath: string, libraryRoot: string | null): Promise<Thumbnail | null> {
    // A stored path comes from the database: one that is not a string has no poster.
    if (typeof posterPath !== 'string' || posterPath === '') return Promise.resolve(null);
    const key = createHash('sha256').update(posterPath).digest('hex');
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = this.resolve(key, posterPath, libraryRoot)
      .catch((err: unknown) => {
        this.deps.log.warn({ msg: 'poster thumbnail failed', key, error: why(err) });
        return null;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  private async resolve(
    key: string,
    posterPath: string,
    libraryRoot: string | null,
  ): Promise<Thumbnail | null> {
    const target = join(this.deps.dir, `${key}.jpg`);
    const cached = await this.cached(target);
    if (libraryRoot === null) return cached;
    // Decided without opening the source: the cache carries its source's time (see `build`), so
    // the same time is an unchanged source; one that is gone keeps the cache.
    let time: number;
    try {
      time = (await fsp.lstat(posterPath)).mtimeMs;
    } catch (err) {
      this.refused(key, why(err));
      return cached;
    }
    if (cached && sameMs(cached.mtimeMs, time)) return cached;
    const failed = this.failedAt.get(key);
    if (failed !== undefined && this.deps.now().getTime() - failed < POSTER_FAILURE_MEMORY_MS) {
      return cached;
    }
    // A slot before the source is opened: a waiting build holds no file. A full queue builds
    // nothing (and is no failure).
    if (!(await this.acquire())) return cached;
    try {
      const source = await this.open(key, posterPath, libraryRoot);
      if (!source) return cached;
      // Any time other than the cache's is a changed source; a future one is still built once.
      if (cached && sameMs(cached.mtimeMs, source.info.mtimeMs)) {
        await source.handle.close();
        return cached;
      }
      return (await this.build(key, target, source)) ?? cached;
    } finally {
      this.release();
    }
  }

  /** The cache file's facts, or null when there is none. */
  private async cached(target: string): Promise<Thumbnail | null> {
    try {
      const info = await fsp.stat(target);
      return info.isFile() ? { path: target, size: info.size, mtimeMs: info.mtimeMs } : null;
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err;
      return null;
    }
  }

  /**
   * Opens the poster and checks it: a regular file (not a symlink) of at most POSTER_MAX_BYTES, a
   * JPEG, PNG or WebP signature, its real path equal to `posterPath` and inside `libraryRoot`, and
   * that path still the opened file. null (handle closed) when any check fails or it is gone.
   */
  private async open(key: string, posterPath: string, libraryRoot: string): Promise<Source | null> {
    let handle: fsp.FileHandle;
    try {
      handle = await openRegular(posterPath, POSTER_MAX_BYTES);
    } catch (err) {
      this.refused(key, why(err));
      return null;
    }
    try {
      const info = await handle.stat();
      const head = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0);
      const demuxer = sniffPoster(head.subarray(0, bytesRead));
      if (!demuxer) return this.refuse(handle, key, 'not a JPEG, PNG or WebP image');
      if ((await fsp.realpath(posterPath)) !== posterPath) {
        return this.refuse(handle, key, 'its path is not its real path');
      }
      const realRoot = await fsp.realpath(libraryRoot).catch(() => libraryRoot);
      if (!isWithin(posterPath, libraryRoot) && !isWithin(posterPath, realRoot)) {
        return this.refuse(handle, key, 'outside its library');
      }
      const now = await fsp.lstat(posterPath);
      if (now.dev !== info.dev || now.ino !== info.ino) {
        return this.refuse(handle, key, 'replaced while it was checked');
      }
      return { handle, info, demuxer };
    } catch (err) {
      return this.refuse(handle, key, why(err));
    }
  }

  private async refuse(handle: fsp.FileHandle, key: string, reason: string): Promise<null> {
    await handle.close().catch(() => {});
    this.refused(key, reason);
    return null;
  }

  private refused(key: string, reason: string): void {
    this.deps.log.debug?.({ msg: 'poster not used', key, reason });
  }

  /** Builds `target` from `source` (whose handle it owns), in the caller's slot; null when ffmpeg failed. */
  private async build(key: string, target: string, source: Source): Promise<Thumbnail | null> {
    const tmp = join(this.deps.dir, `${key}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await fsp.mkdir(this.deps.dir, { recursive: true });
      await this.run({
        ffmpegPath: this.deps.ffmpegPath,
        demuxer: source.demuxer,
        // Read from 0 (the sniff did not move the position), never past the cap.
        input: source.handle.createReadStream({ start: 0, end: POSTER_MAX_BYTES - 1 }),
        outPath: tmp,
        timeoutMs: POSTER_BUILD_TIMEOUT_MS,
      });
      const sourceTime = source.info.mtimeMs / 1000;
      await fsp.utimes(tmp, sourceTime, sourceTime);
      await fsp.rename(tmp, target);
      this.failedAt.delete(key);
      return await this.cached(target);
    } catch (err) {
      this.failedAt.set(key, this.deps.now().getTime());
      this.deps.log.warn({ msg: 'poster thumbnail build failed', key, error: why(err) });
      await fsp.rm(tmp, { force: true }).catch(() => {});
      return null;
    } finally {
      // The stream closes the handle when it ends; a runner that never read it leaves it open.
      await source.handle.close().catch(() => {});
    }
  }

  /** A build slot; false (no slot) when POSTER_MAX_WAITING builds already wait. */
  private async acquire(): Promise<boolean> {
    if (this.active < POSTER_MAX_BUILDS) {
      this.active++;
      return true;
    }
    if (this.waiting.length >= POSTER_MAX_WAITING) return false;
    // release() hands its slot straight to the next waiter, so `active` stays counted.
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    return true;
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}
