import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { type Database, durably } from '../db/open.ts';
import { type RecycledRow, type ReplaceJournal, updateJob } from '../db/repos/jobs.ts';
import type { Logger } from '../logger.ts';
import { type Fingerprint, sameFingerprint } from './fingerprint.ts';
import { errorCode, type FsOps, renameNoClobber, syncDir, syncDirs, syncFile } from './fs-ops.ts';
import { recordRecycledRow } from './recycle.ts';
/** Free space the original's filesystem must keep beyond the replacement's size. */
export const FREE_SPACE_MARGIN_BYTES = 5 * 1024 ** 3;

export interface ReplaceInput {
  jobId: string;
  originalPath: string;
  /** The verified output in the job temp dir; copied (never moved) next to the original. */
  outputPath: string;
  /** The original's fingerprint when the job probed it. */
  expected: Fingerprint;
  /** null = keep the original as `.orig` beside the file until the replace is done. */
  recycleFolder: string | null;
  owner: { uid: number; gid: number } | null;
  /** The library the file belongs to (recycle index). */
  libraryId: string;
  /** The library root; the recycle folder mirrors paths relative to it. */
  libraryRoot: string;
}

export interface ReplaceDeps {
  fs: FsOps;
  /** Synchronous SQLite write of the *intent*, completed before the action it names starts. */
  journal(j: ReplaceJournal | null): void;
  /** Records the recycled original (the `recycled` index), right after it is moved there. */
  recordRecycled(row: RecycledRow): void;
  /**
   * Called while the original's filesystem lacks room; resolves when it is worth re-checking.
   * Gets the replace's `signal`; the replace stops waiting on abort whether or not it listens.
   */
  waitForSpace(neededBytes: number, available: number, signal?: AbortSignal): Promise<void>;
  /**
   * Told on every check while the replace waits for space (C4: the job says what it waits for),
   * and `null` once the wait is over (room found, or stopped).
   */
  onSpaceWait?(wait: SpaceWait | null): void;
  now(): Date;
  log: Logger;
  /**
   * Honoured until the tmp is about to be written (nothing on disk has changed by then, including
   * while waiting for space); from the `writing_tmp` intent on, the replace completes.
   */
  signal?: AbortSignal;
}

export type ReplaceResult =
  | { kind: 'replaced'; recyclePath: string | null; afterBytes: number }
  | { kind: 'fingerprint-changed' }
  /** Aborted before anything on disk changed; the journal is cleared, the output left in temp. */
  | { kind: 'cancelled' }
  | { kind: 'failed'; step: ReplaceJournal['step']; message: string };

/**
 * A replace waiting for room on the original's filesystem. `path` is the library root (where the
 * user knows the files; the free space is that filesystem's).
 */
export interface SpaceWait {
  path: string;
  neededBytes: number;
  availableBytes: number;
}

/** "5.4 GB", "41 KB": decimal units, as `df -H` and the web's sizes print them. */
function bytesText(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

/** "waiting for 5.4 GB free on /media (5.1 GB free)": the job's reason while it waits. */
export function spaceWaitText(w: SpaceWait): string {
  return `waiting for ${bytesText(w.neededBytes)} free on ${w.path} (${bytesText(w.availableBytes)} free)`;
}

/** Default `waitForSpace`: re-check after 30 s, or at once when `signal` aborts. */
export function pollForSpace(
  _neededBytes?: number,
  _available?: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, 30_000);
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}

/**
 * The `journal` and `recordRecycled` deps for a job, each committed with `synchronous = FULL`: an
 * intent must survive power loss before the disk action it names runs, and so must the record of
 * an original moved into the recycle folder.
 */
export function durableReplaceWrites(
  db: Database,
  jobId: string,
  now: () => Date,
  log: Logger,
): Pick<ReplaceDeps, 'journal' | 'recordRecycled'> {
  return {
    journal: (j) =>
      durably(db, () => {
        if (updateJob(db, jobId, { replaceJournal: j }, now()) === null) {
          throw new Error(`job ${jobId} vanished; the replace journal was not written`);
        }
      }),
    recordRecycled: (row) => durably(db, () => recordRecycledRow(db, row, log)),
  };
}

export function tmpPathFor(originalPath: string, jobId: string): string {
  return join(dirname(originalPath), `.transcoda-${jobId}.tmp`);
}

export function origPathFor(originalPath: string, jobId: string): string {
  return `${originalPath}.transcoda-${jobId}.orig`;
}

/** `${recycleFolder}/${relative(libraryRoot, originalPath)}`, with `.${n}` appended for n > 0. */
export function recyclePathFor(
  recycleFolder: string,
  libraryRoot: string,
  originalPath: string,
  n = 0,
): string {
  const base = join(recycleFolder, relative(libraryRoot, originalPath));
  return n > 0 ? `${base}.${n}` : base;
}

export function fingerprintFromStats(st: Stats): Fingerprint {
  return { sizeBytes: st.size, mtimeMs: st.mtimeMs, ino: st.ino, dev: st.dev, nlink: st.nlink };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A check refused the replace while nothing had moved (only the recycle folder may be created). */
class CheckFailed extends Error {}
/** The signal aborted while nothing on disk had changed. */
class Cancelled extends Error {}

/**
 * Replaces the original with the verified output so that a crash at any point leaves the
 * original's bytes at its path or at the copy path (recycle folder or `.orig`):
 *
 * 1. `checking`: same file as probed, copy path on the original's filesystem, room for the
 *    replacement (waiting for space is cancellable), neither the tmp nor the copy path taken.
 * 2. `writing_tmp`: output → `.transcoda-<job>.tmp` beside the original (mode, times, owner), fsync.
 * 3. `moving_original`: original → copy path (no clobber), fsync both directories. EXDEV here
 *    (bind mounts of one filesystem share `st_dev`) undoes the tmp and fails as "different
 *    filesystem" at `checking`.
 * 4. `installing_tmp`: tmp → original path (no clobber), fsync the directory.
 * 5. `cleaning`: the `.orig` is removed when not recycling.
 *
 * Each intent is journaled before its action. Any throw while `checking` clears the journal
 * (nothing has moved); any later throw returns `failed` at the current intent and leaves the
 * journal for the startup sweep, which decides from what is on disk.
 */
export async function replaceOriginal(
  input: ReplaceInput,
  deps: ReplaceDeps,
): Promise<ReplaceResult> {
  if (deps.signal?.aborted) return { kind: 'cancelled' };
  const { fs, log } = deps;
  const { originalPath, outputPath, jobId } = input;
  const dir = dirname(originalPath);
  const tmpPath = tmpPathFor(originalPath, jobId);
  const recycling = input.recycleFolder !== null;
  let step: ReplaceJournal['step'] = 'checking';
  let journal: ReplaceJournal | null = null;
  const intent = (next: ReplaceJournal['step']): void => {
    step = next;
    if (journal === null) throw new Error('journal written before it was started');
    journal = { ...journal, step: next };
    deps.journal(journal);
  };
  const refuse = (msg: string): never => {
    throw new CheckFailed(msg);
  };
  const differentFilesystem = (copyDir: string): string =>
    `recycle folder ${input.recycleFolder ?? copyDir} is on a different filesystem than ${originalPath}`;
  /** Waits for space until the signal aborts (the wait itself may ignore the signal). */
  const waitForSpace = async (needed: number, available: number): Promise<void> => {
    const signal = deps.signal;
    if (signal === undefined) return deps.waitForSpace(needed, available);
    if (signal.aborted) throw new Cancelled();
    let onAbort = (): void => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Cancelled());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([deps.waitForSpace(needed, available, signal), aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (signal.aborted) throw new Cancelled();
  };

  try {
    const outputBytes = (await fs.stat(outputPath)).size;
    let copyPath: string;
    if (input.recycleFolder !== null) {
      const rel = relative(input.libraryRoot, originalPath);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        refuse(`${originalPath} is not under the library root ${input.libraryRoot}`);
      }
      let n = 0;
      copyPath = recyclePathFor(input.recycleFolder, input.libraryRoot, originalPath);
      while (await fs.exists(copyPath)) {
        n += 1;
        copyPath = recyclePathFor(input.recycleFolder, input.libraryRoot, originalPath, n);
      }
    } else {
      copyPath = origPathFor(originalPath, jobId);
    }
    const copyDir = dirname(copyPath);

    journal = {
      step: 'checking',
      originalPath,
      tmpPath,
      outputPath,
      copyPath,
      libraryRoot: input.libraryRoot,
      recycling,
      fingerprint: input.expected,
      outputBytes,
    };
    deps.journal(journal);

    let copyDev: number | null = null;
    if (recycling) {
      await fs.mkdir(copyDir);
      copyDev = (await fs.stat(copyDir)).dev;
    }
    const needed = outputBytes + FREE_SPACE_MARGIN_BYTES;
    let waiting: { path: string; since: number } | null = null;
    let room = false;
    try {
      for (;;) {
        const { bavail, bsize } = await fs.statfs(dir);
        const available = bavail * bsize;
        if (available >= needed) {
          room = true;
          break;
        }
        const path = input.libraryRoot;
        const wait: SpaceWait = { path, neededBytes: needed, availableBytes: available };
        if (waiting === null) {
          waiting = { path, since: deps.now().getTime() };
          log.info({ msg: 'replace waits for free space', job: jobId, wait: spaceWaitText(wait) });
        }
        deps.onSpaceWait?.(wait);
        await waitForSpace(needed, available);
      }
    } finally {
      if (waiting !== null) {
        log.info({
          msg: 'replace stopped waiting for free space',
          job: jobId,
          path: waiting.path,
          outcome: room ? 'space free' : 'stopped',
          waitedSeconds: Math.round((deps.now().getTime() - waiting.since) / 1000),
        });
        deps.onSpaceWait?.(null);
      }
    }
    // After any wait for space: the file must still be the one the job probed.
    const origStat = await fs.stat(originalPath);
    if (!sameFingerprint(fingerprintFromStats(origStat), input.expected)) {
      await fs.unlink(outputPath);
      deps.journal(null);
      return { kind: 'fingerprint-changed' };
    }
    if (copyDev !== null && copyDev !== origStat.dev) refuse(differentFilesystem(copyDir));
    if (await fs.exists(copyPath)) refuse(`${copyPath} already exists`);
    if (await fs.exists(tmpPath)) refuse(`${tmpPath} already exists`);
    if (deps.signal?.aborted) throw new Cancelled();

    intent('writing_tmp');
    await fs.copyFile(outputPath, tmpPath);
    if (input.owner !== null) {
      const st = await fs.stat(tmpPath);
      if (st.uid !== input.owner.uid || st.gid !== input.owner.gid) {
        try {
          await fs.chown(tmpPath, input.owner.uid, input.owner.gid);
        } catch (err) {
          if (errorCode(err) !== 'EPERM') throw err;
          log.warn({
            msg: 'could not set the owner of the replacement',
            path: originalPath,
            uid: input.owner.uid,
            gid: input.owner.gid,
          });
        }
      }
    }
    // chown first: it may clear set-id bits, chmod restores the original's mode.
    await fs.chmod(tmpPath, origStat.mode & 0o7777);
    await fs.utimes(tmpPath, origStat.atime, origStat.mtime);
    await syncFile(fs, tmpPath, log);
    // The copy took a while: the original must still be the probed file before it moves.
    if (!sameFingerprint(fingerprintFromStats(await fs.stat(originalPath)), input.expected)) {
      await fs.unlink(tmpPath);
      await fs.unlink(outputPath);
      deps.journal(null);
      return { kind: 'fingerprint-changed' };
    }

    intent('moving_original');
    try {
      await renameNoClobber(fs, originalPath, copyPath);
    } catch (err) {
      if (errorCode(err) !== 'EXDEV') throw err;
      // The kernel refused the move across mounts; nothing moved. Same ruling as a different
      // st_dev: no copy+unlink fallback, the job fails.
      await fs.unlink(tmpPath);
      deps.journal(null);
      return { kind: 'failed', step: 'checking', message: differentFilesystem(copyDir) };
    }
    await syncDirs(fs, [copyDir, dir], log);
    if (recycling) {
      deps.recordRecycled({
        path: copyPath,
        libraryId: input.libraryId,
        jobId,
        sizeBytes: origStat.size,
        recycledAt: deps.now().toISOString(),
      });
    }

    intent('installing_tmp');
    await renameNoClobber(fs, tmpPath, originalPath);
    await syncDir(fs, dir, log);

    intent('cleaning');
    if (!recycling) await fs.unlink(copyPath);
    deps.journal(null);
    return {
      kind: 'replaced',
      recyclePath: recycling ? copyPath : null,
      afterBytes: outputBytes,
    };
  } catch (err) {
    if (step === 'checking' && journal !== null) {
      // Nothing has moved yet: no journal may outlive this replace (the sweep would otherwise
      // act on a job the pipeline already settled).
      try {
        deps.journal(null);
      } catch (clearErr) {
        log.error({
          msg: 'could not clear the replace journal',
          job: jobId,
          error: message(clearErr),
        });
      }
    }
    if (err instanceof Cancelled) return { kind: 'cancelled' };
    if (err instanceof CheckFailed)
      return { kind: 'failed', step: 'checking', message: err.message };
    log.error({
      msg: 'replace failed',
      job: jobId,
      step,
      file: basename(originalPath),
      error: message(err),
    });
    return { kind: 'failed', step, message: message(err) };
  }
}
