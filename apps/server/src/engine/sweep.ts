import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { RUNNING_JOB_STATES } from '@transcoda/shared';
import type { Database } from '../db/open.ts';
import {
  deleteRecycled,
  hasReplaceJournal,
  type JobRow,
  jobsInStates,
  jobsWithReplaceJournal,
  listRecycled,
  type ReplaceJournal,
  updateJob,
} from '../db/repos/jobs.ts';
import type { Logger } from '../logger.ts';
import { sameFingerprint } from './fingerprint.ts';
import {
  ClobberRefused,
  errorCode,
  type FsOps,
  renameNoClobber,
  syncDir,
  syncDirs,
} from './fs-ops.ts';
import { recordRecycledRow } from './recycle.ts';
import { fingerprintFromStats } from './replace.ts';
import { TEST_OUTPUT_DIR } from './test-outputs.ts';

export interface SweepResult {
  /** The replacement is installed; the job stays `replacing` with intent `cleaning` for the engine to finish. */
  completed: string[];
  /** The original was moved back to its path; the job failed (not requeued). */
  rolledBack: string[];
  /** Requeued once (or failed on the second interruption). */
  interrupted: string[];
  /**
   * The original never moved and the job had already ended (failed, cancelled, requeued by the
   * pipeline): tmp removed, journal cleared, state kept — never requeued by the sweep.
   */
  cleared: string[];
  /**
   * Left for the user: two copies, a missing original, a recovery that failed or an unreachable
   * library (the last two keep their journal and are settled again on the next start).
   */
  conflicts: string[];
  /** Entries removed from the transcode dir plus stray library tmp files. */
  tempRemoved: number;
}

export interface SweepDeps {
  fs: FsOps;
  transcodeDir: string;
  libraryRoots: string[];
  now(): Date;
  log: Logger;
  /** SIGKILLs the process group named in a leftover `ffmpeg.pid` (default {@link killStaleFfmpeg}). */
  killStaleGroup?: (pidFile: string) => Promise<void>;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const STRAY_TMP = /^\.transcoda-(.+)\.tmp$/;

/**
 * Requeues an interrupted job once: `queued` with `requeues + 1` while `requeues < 1` (not paused,
 * no finished time), else `failed`; both with `reason`, no lane and no progress. `attempt` is
 * unchanged. Refused (throws) while the job has a replace journal: the sweep settles that first.
 */
export function requeueOnce(db: Database, job: JobRow, reason: string, now: Date): JobRow {
  if (hasReplaceJournal(db, job.id)) {
    throw new Error(`job ${job.id} has a replace in flight; the startup sweep settles it first`);
  }
  const row =
    job.requeues < 1
      ? updateJob(
          db,
          job.id,
          {
            state: 'queued',
            requeues: job.requeues + 1,
            reason,
            lane: null,
            progress: null,
            paused: false,
            finishedAt: null,
          },
          now,
        )
      : updateJob(db, job.id, { state: 'failed', reason, lane: null, progress: null }, now);
  if (row === null) throw new Error(`job ${job.id} vanished`);
  return row;
}

const execFileAsync = promisify(execFile);

/** The running process's command name, or null when no such process exists. */
async function processName(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'comm=', '-p', String(pid)]);
    const name = stdout.trim();
    return name === '' ? null : name;
  } catch {
    return null; // ps exits 1 when the pid does not exist
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === 'EPERM';
  }
};

/**
 * SIGKILLs the process group named in a leftover `ffmpeg.pid`, but only when that pid is alive and
 * is an ffmpeg (a pid from before a restart may have been reused by anything else), then waits up
 * to 2 s for it to go. Never throws.
 *
 * Pid namespaces: in the container the server has its own pid namespace, so a stale pid can only
 * name a process of this container. Run outside a container (or with a shared pid namespace), a
 * reused pid that happens to be another program's ffmpeg group leader (Jellyfin, Plex) would be
 * killed; accepted, since only a crash leaves a pid file and the name check rules out the rest.
 */
export async function killStaleFfmpeg(pidFile: string, log: Logger): Promise<void> {
  let text: string;
  try {
    text = (await readFile(pidFile, 'utf8')).trim();
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') {
      log.warn({ msg: 'could not read a stale ffmpeg.pid', path: pidFile, code: errorCode(err) });
    }
    return;
  }
  const pid = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    log.warn({ msg: 'ignoring a malformed ffmpeg.pid', path: pidFile });
    return;
  }
  const name = await processName(pid);
  if (name === null) return;
  if (!/ffmpeg/i.test(basename(name))) {
    log.warn({ msg: 'stale ffmpeg.pid names a process that is not ffmpeg; not killed', pid, name });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (err) {
    if (errorCode(err) !== 'ESRCH') {
      log.warn({ msg: 'could not kill a stale ffmpeg group', pid, code: errorCode(err) });
    }
    return;
  }
  log.warn({ msg: 'killed a leftover ffmpeg process group', pid });
  for (let i = 0; i < 40 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 50));
}

/**
 * Startup recovery, before anything runs:
 * 1. SIGKILL ffmpeg groups left in the transcode dir (`<job>/ffmpeg.pid`).
 * 2. Every job with a replace journal is settled from what is on disk (original O, tmp T, copy C).
 * 3. Running jobs without a journal are requeued once (`interrupted`).
 * 4. Everything under the transcode dir is removed, and `.transcoda-<job>.tmp` files in the library
 *    roots whose job had no journal. Nothing else is ever touched.
 */
export async function startupSweep(db: Database, deps: SweepDeps): Promise<SweepResult> {
  const { fs, log } = deps;
  const now = deps.now();
  const result: SweepResult = {
    completed: [],
    rolledBack: [],
    interrupted: [],
    cleared: [],
    conflicts: [],
    tempRemoved: 0,
  };
  const killStale = deps.killStaleGroup ?? ((p: string) => killStaleFfmpeg(p, log));

  // 1. Leftover ffmpeg first: nothing else may be touched while one could still be writing.
  // Kept test-encode outputs are not temp: their own store sweeps them.
  const tempEntries = (
    (await fs.exists(deps.transcodeDir)) ? await fs.readdir(deps.transcodeDir) : []
  ).filter((e) => e.name !== TEST_OUTPUT_DIR);
  for (const e of tempEntries) {
    if (e.isDirectory()) await killStale(join(deps.transcodeDir, e.name, 'ffmpeg.pid'));
  }

  // 2. Journaled replaces.
  const journaled = jobsWithReplaceJournal(db);
  const journaledIds = new Set(journaled.map((j) => j.id));
  for (const job of journaled) {
    const j = job.replaceJournal as ReplaceJournal;
    result[await settleOne(db, deps, job, j, now, true)].push(job.id);
  }

  // 3. Interrupted running jobs.
  for (const job of jobsInStates(db, [...RUNNING_JOB_STATES])) {
    if (job.replaceJournal !== null) continue;
    requeueOnce(db, job, 'interrupted', now);
    result.interrupted.push(job.id);
  }

  // 4. Temp: the whole transcode dir's contents, and stray tmp files in the library roots.
  for (const e of tempEntries) {
    await fs.rm(join(deps.transcodeDir, e.name), { recursive: true });
    result.tempRemoved += 1;
  }
  // A tmp is never stray while its job had or still has a journal (an unreachable library keeps it).
  for (const j of jobsWithReplaceJournal(db)) journaledIds.add(j.id);
  for (const root of deps.libraryRoots) {
    let reachable: boolean;
    try {
      reachable = await fs.exists(root);
    } catch {
      reachable = false;
    }
    if (!reachable) {
      log.warn({
        msg: 'library root unavailable; its stray tmp files are left for the next start',
        path: root,
      });
      continue;
    }
    result.tempRemoved += await removeStrayTmp(fs, root, journaledIds, log);
  }
  if (Object.values(result).some((v) => (Array.isArray(v) ? v.length > 0 : v > 0))) {
    log.info({
      msg: 'startup sweep',
      completed: result.completed.length,
      rolledBack: result.rolledBack.length,
      interrupted: result.interrupted.length,
      conflicts: result.conflicts.length,
      tempRemoved: result.tempRemoved,
    });
  }
  return result;
}

type Bucket = 'completed' | 'rolledBack' | 'interrupted' | 'cleared' | 'conflicts';

/** The first of the paths a decision depends on that is not there (an unmounted share), or null. */
async function firstMissing(fs: FsOps, paths: string[]): Promise<string | null> {
  for (const p of paths) if (!(await fs.exists(p))) return p;
  return null;
}

type SettleDeps = Pick<SweepDeps, 'fs' | 'log'>;

/** settleJournal, where a throw keeps the journal and fails the job (settled again next start). */
async function settleOne(
  db: Database,
  deps: SettleDeps,
  job: JobRow,
  j: ReplaceJournal,
  now: Date,
  requeueRunning: boolean,
): Promise<Bucket> {
  try {
    return await settleJournal(db, deps, job, j, now, requeueRunning);
  } catch (err) {
    deps.log.error({ msg: 'replace recovery failed', job: job.id, error: message(err) });
    updateJob(
      db,
      job.id,
      {
        state: 'failed',
        reason: `replace recovery failed: ${message(err)}; the original is at ${j.originalPath} or ${j.copyPath}`,
        lane: null,
        progress: null,
      },
      now,
    );
    return 'conflicts';
  }
}

export type SettleOutcome = Bucket;

/**
 * Settles a replace that just failed past its `checking` step, at once and with the sweep's own
 * rules (what is on disk decides), instead of leaving it to the next start. A job whose original
 * never moved is `cleared` (never requeued here); `completed` leaves the job `replacing` at intent
 * `cleaning` for the caller to finish (`removeOrigCopy`, then clear the journal).
 */
export function settleReplaceNow(
  db: Database,
  deps: SettleDeps,
  job: JobRow,
  now: Date,
): Promise<SettleOutcome> {
  const j = job.replaceJournal;
  if (j === null) return Promise.resolve('cleared');
  return settleOne(db, deps, job, j, now, false);
}

/**
 * The `cleaning` step of a replace: the `.orig` copy is removed when not recycling (already gone
 * is fine). False when it could not be removed (the journal stays for the next start).
 */
export async function removeOrigCopy(
  deps: SettleDeps,
  jobId: string,
  j: ReplaceJournal,
): Promise<boolean> {
  if (j.recycling) return true;
  try {
    await deps.fs.unlink(j.copyPath);
    return true;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return true;
    deps.log.warn({
      msg: 'could not remove the .orig of a finished replace',
      job: jobId,
      code: errorCode(err),
    });
    return false;
  }
}

/** Decides one journaled job from the disk (see the table in docs/decisions.md, Task 13). */
async function settleJournal(
  db: Database,
  deps: SettleDeps,
  job: JobRow,
  j: ReplaceJournal,
  now: Date,
  requeueRunning: boolean,
): Promise<Bucket> {
  const { fs, log } = deps;
  /** Keeps the journal: nothing is decided while the library cannot be seen. */
  const unavailable = (missing: string): Bucket => {
    log.warn({
      msg: 'library unavailable; replace left for the next start',
      job: job.id,
      path: missing,
    });
    updateJob(
      db,
      job.id,
      {
        state: 'failed',
        reason: `library root unavailable: ${missing}`,
        lane: null,
        progress: null,
      },
      now,
    );
    return 'conflicts';
  };
  // Absence only means something when the library is there: an unmounted share reads as empty.
  const missing = await firstMissing(fs, [j.libraryRoot, dirname(j.originalPath)]);
  if (missing !== null) return unavailable(missing);

  const O = await fs.exists(j.originalPath);
  let T = await fs.exists(j.tmpPath);
  let C = await fs.exists(j.copyPath);
  if (!O) {
    // The original moved (or is gone): its copy's folder must be reachable to tell which.
    const copyDirMissing = await firstMissing(fs, [dirname(j.copyPath)]);
    if (copyDirMissing !== null) return unavailable(copyDirMissing);
  }
  const sizeOf = async (p: string): Promise<number> => (await fs.stat(p)).size;
  const isOriginal = async (p: string): Promise<boolean> =>
    sameFingerprint(fingerprintFromStats(await fs.stat(p)), j.fingerprint);
  const sameFile = async (a: string, b: string): Promise<boolean> => {
    const [x, y] = [await fs.stat(a), await fs.stat(b)];
    return x.ino === y.ino && x.dev === y.dev;
  };

  // One file under two names (a crash inside renameNoClobber's link + unlink, or a rename replayed
  // after power loss): the second name is not a second copy. Drop it, keep the path.
  if (O && C && (await sameFile(j.originalPath, j.copyPath))) {
    await fs.unlink(j.copyPath);
    await syncDir(fs, dirname(j.copyPath), log);
    C = false;
  }
  if (O && T && (await sameFile(j.originalPath, j.tmpPath))) {
    await fs.unlink(j.tmpPath);
    await syncDir(fs, dirname(j.tmpPath), log);
    T = false;
  }

  const fail = (reason: string): void => {
    updateJob(
      db,
      job.id,
      { state: 'failed', reason, replaceJournal: null, lane: null, progress: null },
      now,
    );
  };
  /** The replacement is at the original path: the engine finishes the `cleaning` step. */
  const completed = (): Bucket => {
    db.transaction(() => {
      // A row of an earlier job at this path is stale (C5): this job's original is there now.
      const recorded = listRecycled(db).some((r) => r.path === j.copyPath && r.jobId === job.id);
      if (j.recycling && C && !recorded) {
        recordRecycledRow(
          db,
          {
            path: j.copyPath,
            libraryId: job.libraryId,
            jobId: job.id,
            sizeBytes: j.fingerprint.sizeBytes,
            recycledAt: now.toISOString(),
          },
          log,
        );
      }
      updateJob(
        db,
        job.id,
        { state: 'replacing', replaceJournal: { ...j, step: 'cleaning' }, finishedAt: null },
        now,
      );
    })();
    return 'completed';
  };
  const installedAtO = async (): Promise<boolean> =>
    !T && (await sizeOf(j.originalPath)) === j.outputBytes && !(await isOriginal(j.originalPath));
  /** By the `installing_tmp` intent the original had certainly left its path. */
  const movedBefore = j.step === 'installing_tmp' || j.step === 'cleaning';

  if (O) {
    if (C) {
      // The copy is the original (same inode, size, mtime) and the path holds the replacement:
      // the install happened, only the cleaning intent was not recorded.
      if ((await isOriginal(j.copyPath)) && (await installedAtO())) return completed();
      fail(`replace left two copies: ${j.originalPath}, ${j.copyPath}`);
      return 'conflicts';
    }
    if (movedBefore) {
      // `.orig` already removed by cleaning (or the recycled copy pruned): the replace finished.
      if (await installedAtO()) return completed();
      // The original is back although it had moved: an earlier sweep restored it, then crashed.
      if (await isOriginal(j.originalPath)) {
        if (T) await fs.unlink(j.tmpPath);
        // That sweep synced both directories already; only the path's directory is synced again.
        await finishRestore(db, deps, job, j, now, [dirname(j.originalPath)]);
        return 'rolledBack';
      }
    }
    if (T) await fs.unlink(j.tmpPath);
    // Only a job that was running when the server stopped is requeued; one the pipeline already
    // settled (failed, cancelled, requeued) keeps its state.
    const running = requeueRunning && RUNNING_JOB_STATES.includes(job.state);
    db.transaction(() => {
      if (j.recycling) deleteRecycled(db, j.copyPath);
      updateJob(db, job.id, { replaceJournal: null }, now);
      if (running) requeueOnce(db, job, 'interrupted', now);
    })();
    return running ? 'interrupted' : 'cleared';
  }
  if (T && C) {
    if ((await sizeOf(j.tmpPath)) === j.outputBytes) {
      await renameNoClobber(fs, j.tmpPath, j.originalPath);
      await syncDir(fs, dirname(j.originalPath), log);
      return completed();
    }
    // A tmp that is not the full replacement is never installed: restore the original instead.
    await restore(db, deps, job, j, now);
    await fs.unlink(j.tmpPath);
    return 'rolledBack';
  }
  if (C) {
    try {
      await renameNoClobber(fs, j.copyPath, j.originalPath);
    } catch (err) {
      // Only a taken path is a conflict; any other error keeps the journal for the next start.
      if (!(err instanceof ClobberRefused)) throw err;
      fail(`could not restore the original: ${message(err)}; the original is at ${j.copyPath}`);
      return 'conflicts';
    }
    await finishRestore(db, deps, job, j, now);
    return 'rolledBack';
  }
  if (j.recycling) deleteRecycled(db, j.copyPath);
  fail('original missing');
  return 'conflicts';
}

async function restore(
  db: Database,
  deps: SettleDeps,
  job: JobRow,
  j: ReplaceJournal,
  now: Date,
): Promise<void> {
  await renameNoClobber(deps.fs, j.copyPath, j.originalPath);
  await finishRestore(db, deps, job, j, now);
}

async function finishRestore(
  db: Database,
  deps: SettleDeps,
  job: JobRow,
  j: ReplaceJournal,
  now: Date,
  // Both sides of the move: the restored name and the removed copy name.
  dirs = [dirname(j.originalPath), dirname(j.copyPath)],
): Promise<void> {
  await syncDirs(deps.fs, dirs, deps.log);
  db.transaction(() => {
    if (j.recycling) deleteRecycled(db, j.copyPath);
    updateJob(
      db,
      job.id,
      {
        state: 'failed',
        reason: 'interrupted; original restored',
        replaceJournal: null,
        lane: null,
        progress: null,
      },
      now,
    );
  })();
}

/** Removes `.transcoda-<job>.tmp` files under `root` whose job had no journal; returns the count. */
async function removeStrayTmp(
  fs: FsOps,
  root: string,
  journaled: Set<string>,
  log: Logger,
): Promise<number> {
  let removed = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: Awaited<ReturnType<FsOps['readdir']>>;
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      log.warn({ msg: 'sweep could not read a library folder', path: dir, code: errorCode(err) });
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      const m = STRAY_TMP.exec(e.name);
      if (!e.isFile() || m === null || journaled.has(m[1] as string)) continue;
      try {
        await fs.unlink(p);
        removed += 1;
      } catch (err) {
        log.warn({ msg: 'sweep could not remove a stray tmp', path: p, code: errorCode(err) });
      }
    }
  };
  await walk(root);
  return removed;
}
