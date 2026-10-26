import type { Dirent, Stats } from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { Logger } from '../logger.ts';

/**
 * Every disk touch the engine makes (queueing, the pipeline, the replace, the recycle prune and the
 * sweep); injectable for fault tests. Only reading a job log's tail (`readTail`) opens files
 * directly.
 */
export interface FsOps {
  stat(p: string): Promise<Stats>;
  lstat(p: string): Promise<Stats>;
  realpath(p: string): Promise<string>;
  readdir(p: string): Promise<Dirent[]>;
  statfs(p: string): Promise<{ bavail: number; bsize: number }>;
  copyFile(src: string, dst: string): Promise<void>;
  fsyncFile(p: string): Promise<void>;
  fsyncDir(p: string): Promise<void>;
  rename(a: string, b: string): Promise<void>;
  link(a: string, b: string): Promise<void>;
  unlink(p: string): Promise<void>;
  rm(p: string, opts: { recursive: true }): Promise<void>;
  chown(p: string, uid: number, gid: number): Promise<void>;
  utimes(p: string, atime: Date, mtime: Date): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
  /** Recursive (`mkdir -p`). */
  mkdir(p: string): Promise<void>;
  /** Throws (EACCES, …) when `p` cannot be opened for reading (`access(p, R_OK)`). */
  canRead(p: string): Promise<void>;
  /** Creates `p` empty, or empties it. */
  truncate(p: string): Promise<void>;
  /**
   * Copies a regular file of at most `maxBytes` to a new `dst` (exclusive). Opens `src` with
   * O_NOFOLLOW and checks the open handle, so a symlink or a swap after a check cannot redirect
   * the read. Throws an Error whose message says why (symlink, not a regular file, too large).
   */
  copyRegular(src: string, dst: string, maxBytes: number): Promise<void>;
  /** True when anything is at `p` (a dangling symlink counts: `lstat`, not `stat`). */
  exists(p: string): Promise<boolean>;
}

export const errorCode = (err: unknown): string | undefined =>
  err instanceof Error && 'code' in err ? String(err.code) : undefined;

async function fsync(p: string): Promise<void> {
  const fh = await fsp.open(p, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export const nodeFsOps: FsOps = {
  stat: (p) => fsp.stat(p),
  lstat: (p) => fsp.lstat(p),
  realpath: (p) => fsp.realpath(p),
  readdir: (p) => fsp.readdir(p, { withFileTypes: true }),
  statfs: async (p) => {
    const s = await fsp.statfs(p);
    return { bavail: s.bavail, bsize: s.bsize };
  },
  copyFile: (src, dst) => fsp.copyFile(src, dst, fsp.constants.COPYFILE_EXCL),
  fsyncFile: fsync,
  fsyncDir: fsync,
  rename: (a, b) => fsp.rename(a, b),
  link: (a, b) => fsp.link(a, b),
  unlink: (p) => fsp.unlink(p),
  rm: (p, opts) => fsp.rm(p, { recursive: opts.recursive, force: true }),
  chown: (p, uid, gid) => fsp.chown(p, uid, gid),
  utimes: (p, atime, mtime) => fsp.utimes(p, atime, mtime),
  chmod: (p, mode) => fsp.chmod(p, mode),
  mkdir: async (p) => {
    await fsp.mkdir(p, { recursive: true });
  },
  canRead: (p) => fsp.access(p, fsp.constants.R_OK),
  truncate: (p) => fsp.writeFile(p, ''),
  copyRegular: async (src, dst, maxBytes) => {
    let input: fsp.FileHandle;
    try {
      input = await fsp.open(
        src,
        // O_NONBLOCK: a FIFO in place of the file must not block open(); fstat then refuses it.
        fsp.constants.O_RDONLY | fsp.constants.O_NOFOLLOW | fsp.constants.O_NONBLOCK,
      );
    } catch (err) {
      if (errorCode(err) === 'ELOOP') throw new Error('it is a symbolic link');
      throw err;
    }
    try {
      const info = await input.stat();
      if (!info.isFile()) throw new Error('it is not a regular file');
      if (info.size > maxBytes) throw new Error(`it is larger than ${maxBytes} bytes`);
      const output = await fsp.open(dst, 'wx', 0o600);
      try {
        // Read at most maxBytes + 1 so a file that grew after the check is still refused.
        const buffer = Buffer.alloc(Math.min(maxBytes + 1, 1 << 20));
        let total = 0;
        for (;;) {
          const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          total += bytesRead;
          if (total > maxBytes) throw new Error(`it is larger than ${maxBytes} bytes`);
          await output.write(buffer, 0, bytesRead);
        }
      } finally {
        await output.close();
      }
    } finally {
      await input.close();
    }
  },
  exists: async (p) => {
    try {
      await fsp.lstat(p);
      return true;
    } catch (err) {
      if (errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR') return false;
      throw err;
    }
  },
};

/**
 * Tests: `base` with `op` throwing `error ?? new Error('injected')` on its `nth` call (1-based);
 * earlier and later calls pass through.
 */
export function failingAt(base: FsOps, op: keyof FsOps, nth: number, error?: Error): FsOps {
  let calls = 0;
  const original = base[op] as (...args: unknown[]) => Promise<unknown>;
  const wrapped = async (...args: unknown[]): Promise<unknown> => {
    calls += 1;
    if (calls === nth) throw error ?? new Error('injected');
    return original.apply(base, args);
  };
  return { ...base, [op]: wrapped } as FsOps;
}

/** Thrown by {@link renameNoClobber} when the destination is taken. */
export class ClobberRefused extends Error {
  constructor(readonly path: string) {
    super(`refusing to rename over an existing path: ${path}`);
  }
}

/** `link()` errors meaning "no hard link here" (SMB, FAT, some FUSE, bind mounts, link limit). */
const NO_HARD_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'ENOSYS']);

/**
 * `rename(a, b)` that refuses to clobber: throws {@link ClobberRefused} when anything is at `b`.
 * The replace and the sweep only ever rename through this.
 *
 * Atomic where hard links work: `link(a, b)` fails `EEXIST` in the kernel when `b` is taken, then
 * `unlink(a)`. A crash between the two leaves one file under both names (same inode), which the
 * sweep recognises. Where `link` is not possible (codes in `NO_HARD_LINK`) it falls back to
 * check-then-rename, which has a window between the check and the rename.
 */
export async function renameNoClobber(fs: FsOps, a: string, b: string): Promise<void> {
  try {
    await fs.link(a, b);
  } catch (err) {
    const code = errorCode(err);
    if (code === 'EEXIST') throw new ClobberRefused(b);
    if (code === undefined || !NO_HARD_LINK.has(code)) throw err;
    if (await fs.exists(b)) throw new ClobberRefused(b);
    await fs.rename(a, b);
    return;
  }
  await fs.unlink(a);
}

/** fsync errors meaning "this mount does not do fsync" (some network and FUSE mounts). */
const FSYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);

async function tolerant(op: () => Promise<void>, p: string, log: Logger): Promise<void> {
  try {
    await op();
  } catch (err) {
    const code = errorCode(err);
    if (code === undefined || !FSYNC_UNSUPPORTED.has(code)) throw err;
    log.warn({ msg: 'fsync is not supported here; continuing', path: p, code });
  }
}

/** `fsyncDir`, where a mount without fsync support (EINVAL/ENOTSUP) is a warning; EIO stays fatal. */
export function syncDir(fs: FsOps, p: string, log: Logger): Promise<void> {
  return tolerant(() => fs.fsyncDir(p), p, log);
}

/** `fsyncFile`, with the same tolerance as {@link syncDir}. */
export function syncFile(fs: FsOps, p: string, log: Logger): Promise<void> {
  return tolerant(() => fs.fsyncFile(p), p, log);
}

/** {@link syncDir} for each distinct directory, in order (both sides of a cross-directory move). */
export async function syncDirs(fs: FsOps, dirs: string[], log: Logger): Promise<void> {
  for (const d of new Set(dirs)) await syncDir(fs, d, log);
}
