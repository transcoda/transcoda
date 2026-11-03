// Restore (#39): put a recycled original back over the job's output, or undo that.
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { basename, dirname, relative, sep } from 'node:path';
import { type Database, durably } from '../db/open.ts';
import {
  claimRestoreJournal,
  deleteRecycled,
  findJob,
  findJobResult,
  findRecycled,
  hasActiveJobAt,
  hasFileJournal,
  insertRecycled,
  type JobRow,
  listRecycledForJob,
  type RecycledRow,
  type RestoreJournal,
  type RestoreMove,
  updateJob,
} from '../db/repos/jobs.ts';
import { findLibrary } from '../db/repos/libraries.ts';
import { findRestore, insertRestore, markRestoreUndone } from '../db/repos/restores.ts';
import type { Logger } from '../logger.ts';
import { fingerprintKey } from './fingerprint.ts';
import { ClobberRefused, errorCode, type FsOps, renameNoClobber, syncDirs } from './fs-ops.ts';
import { fingerprintFromStats, recyclePathFor } from './replace.ts';

export interface RestoreDeps {
  db: Database;
  fs: FsOps;
  now(): Date;
  log: Logger;
  /** The recycle folder's retention, to name the cleanup date when an original is gone. */
  retentionDays?: number;
}

export type RestoreResult =
  | { kind: 'restored' | 'undone'; jobId: string; restoreId: string; notRestored: string[] }
  | { kind: 'not-found' }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; reason: string };

const REASON = {
  sidecar: "A subtitle file comes back with its video's original; restore that instead.",
  busy: 'This job is still running or replacing its file.',
  deleted:
    "This library deletes originals instead of recycling them, so there's nothing to restore.",
  active: 'A job for this file is queued or running; restore it once that job ends.',
  unreachable: "The library's folder can't be reached (is the share mounted?).",
  noOutputKey:
    "Transcoda can't tell whether the file at this path is still its output, so it won't replace it.",
  notOutput:
    "The file at this path isn't the one the job wrote (another program changed or moved it), so restoring could lose that change.",
  changedSinceRestore:
    "This file changed after the restore (another program wrote it), so putting Transcoda's version back could lose that change.",
  originalSize: 'The file in the recycle folder is not the original any more (its size changed).',
  outputSize:
    "The file in the recycle folder is not Transcoda's version any more (its size changed).",
  undone: 'This restore was undone already.',
  notFromRestore:
    "This file was set aside when a restore stopped part-way, so there's no restore to undo. Move it back by hand or delete it.",
  noFolder: "Transcoda can't tell which recycle folder this file is in.",
  inFlight: 'This file is already being restored.',
  raced:
    'Restoring stopped because another program wrote to the same place meanwhile. Nothing was lost; the recycle folder holds both versions.',
} as const;

/**
 * The recycle folder a recycled copy sits in: `copyPath` is
 * `recyclePathFor(folder, libraryRoot, originalPath, n)`, so this strips the library-relative path
 * and any `.n`. Null when `copyPath` doesn't end that way.
 */
export function recycleFolderOf(
  copyPath: string,
  libraryRoot: string,
  originalPath: string,
): string | null {
  const rel = relative(libraryRoot, originalPath);
  if (rel === '' || rel.startsWith('..')) return null;
  const strip = (p: string): string | null =>
    p.endsWith(`${sep}${rel}`) ? p.slice(0, p.length - rel.length - 1) : null;
  const direct = strip(copyPath);
  if (direct !== null) return direct;
  const numbered = /^(.*)\.\d+$/.exec(copyPath);
  return numbered ? strip(numbered[1] as string) : null;
}

class Refused extends Error {}

/** `stat` (or `lstat`) of `p`, null when nothing is there. */
async function statOrNull(
  fs: FsOps,
  p: string,
  how: 'stat' | 'lstat' = 'stat',
): Promise<Stats | null> {
  try {
    return await fs[how](p);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null;
    throw err;
  }
}

const why = (err: unknown): string =>
  errorCode(err) ?? (err instanceof Error ? err.message : String(err));

async function firstFree(
  fs: FsOps,
  folder: string,
  root: string,
  path: string,
  taken: Set<string>,
): Promise<string> {
  for (let n = 0; ; n += 1) {
    const p = recyclePathFor(folder, root, path, n);
    if (!taken.has(p) && !(await fs.exists(p))) {
      taken.add(p);
      return p;
    }
  }
}

function writeJournal(db: Database, jobId: string, j: RestoreJournal | null, now: Date): void {
  durably(db, () => {
    updateJob(db, jobId, { restoreJournal: j }, now);
  });
}

/** A planned sidecar move with what to record once it is done. */
interface SidecarPlan {
  move: RestoreMove;
  /** Restore: the recycle row the sidecar came from. Undo: the sidecar's path (its way back). */
  row: RecycledRow | null;
  sizeBytes: number;
}

/**
 * Restores the recycled original at `input.path` over its job's output (the output goes to the
 * recycle folder as a `restored-output` entry, the job's recycled subtitle files come back), or,
 * given a `restored-output` entry, undoes that restore. Every check runs before anything moves;
 * the moves are journaled on the job one at a time, and a failed move rolls back the ones before
 * it. A `sidecar` entry is refused (it comes back with its video).
 */
export async function restoreRecycled(
  deps: RestoreDeps,
  input: { path: string; userId: string },
): Promise<RestoreResult> {
  const { db, fs, log } = deps;
  const row = findRecycled(db, input.path);
  if (row === null) return { kind: 'not-found' };
  if (row.kind === 'sidecar') return { kind: 'refused', reason: REASON.sidecar };
  const job = findJob(db, row.jobId);
  if (job === null) return { kind: 'not-found' };
  if (job.state !== 'done' || hasFileJournal(db, job.id)) {
    return { kind: 'refused', reason: REASON.busy };
  }
  const result = findJobResult(db, job.id);
  if (result === null || result.replacedTo !== 'recycle') {
    return { kind: 'refused', reason: REASON.deleted };
  }
  if (hasActiveJobAt(db, job.path)) return { kind: 'refused', reason: REASON.active };
  const library = findLibrary(db, job.libraryId);
  if (library === null || library.deletedAt !== null) {
    return { kind: 'refused', reason: REASON.unreachable };
  }
  const root = library.path;
  for (const dir of [root, dirname(job.path), dirname(row.path)]) {
    if (!(await fs.exists(dir))) return { kind: 'refused', reason: REASON.unreachable };
  }
  const direction = row.kind === 'restored-output' ? 'undo' : 'restore';
  const restoreId = direction === 'undo' ? row.restoreId : randomUUID();
  if (restoreId === null) return { kind: 'refused', reason: REASON.notFromRestore };

  // One file operation per job: claimed before the disk checks, so a second restore of this job
  // is refused while this one checks and moves.
  const journal: RestoreJournal = { direction, restoreId, libraryRoot: root, moves: [], next: 0 };
  if (!claimRestoreJournal(db, job.id, journal))
    return { kind: 'refused', reason: REASON.inFlight };

  let plan: {
    moves: RestoreMove[];
    sidecars: SidecarPlan[];
    notRestored: string[];
    atPathBytes: number;
  };
  try {
    plan = await planMoves(deps, {
      direction,
      row,
      job,
      root,
      restoreId,
      fingerprint: result.fingerprint,
      outputFingerprint: result.outputFingerprint ?? null,
    });
  } catch (err) {
    writeJournal(db, job.id, null, deps.now());
    if (err instanceof Refused) return { kind: 'refused', reason: err.message };
    throw err;
  }

  const notRestored = [...plan.notRestored];
  const done = new Set<RestoreMove>();
  journal.moves = plan.moves;
  for (let i = 0; i < plan.moves.length; i += 1) {
    const move = plan.moves[i] as RestoreMove;
    journal.next = i;
    writeJournal(db, job.id, journal, deps.now());
    try {
      if (move.role === 'sidecar' && direction === 'undo') await fs.mkdir(dirname(move.to));
      await renameNoClobber(fs, move.from, move.to);
      done.add(move);
      await syncDirs(fs, [dirname(move.from), dirname(move.to)], log);
    } catch (err) {
      if (move.role === 'sidecar' && !done.has(move)) {
        if (err instanceof ClobberRefused) {
          notRestored.push(`${basename(move.from)} (its place is taken)`);
          continue;
        }
        if (errorCode(err) === 'ENOENT') {
          notRestored.push(`${basename(move.from)} (gone from the recycle folder)`);
          continue;
        }
      }
      log.warn({ msg: 'restore move failed; rolling back', job: job.id, code: why(err) });
      const current = findJob(db, job.id) as JobRow;
      const back = await rollBackRestore(deps, current);
      if (back.keptAside.length > 0) return { kind: 'failed', reason: REASON.raced };
      const tail =
        back.outcome === 'conflict' ? '; some files could not be put back, see the server log' : '';
      return {
        kind: 'failed',
        reason: `Restoring failed and nothing was changed: ${why(err)}${tail}`,
      };
    }
  }

  const at = deps.now().toISOString();
  const outputMove = plan.moves.find(
    (m) => m.role === (direction === 'restore' ? 'output' : 'original'),
  ) as RestoreMove;
  const movedSidecars = plan.sidecars.filter((s) => done.has(s.move));
  durably(db, () => {
    if (direction === 'restore') {
      insertRestore(db, {
        id: restoreId,
        jobId: job.id,
        restoredAt: at,
        restoredBy: input.userId,
        sidecarPaths: movedSidecars.map((s) => s.move.to),
        sidecarKeys: Object.fromEntries(
          movedSidecars.flatMap((s) => (s.move.key ? [[s.move.to, s.move.key]] : [])),
        ),
      });
      insertRecycled(db, {
        path: outputMove.to,
        libraryId: job.libraryId,
        jobId: job.id,
        sizeBytes: plan.atPathBytes,
        recycledAt: at,
        kind: 'restored-output',
        originalPath: job.path,
        restoreId,
      });
      deleteRecycled(db, row.path);
      for (const s of movedSidecars) deleteRecycled(db, s.move.from);
    } else {
      markRestoreUndone(db, restoreId, at, input.userId);
      deleteRecycled(db, row.path);
      insertRecycled(db, {
        path: outputMove.to,
        libraryId: job.libraryId,
        jobId: job.id,
        sizeBytes: plan.atPathBytes,
        recycledAt: at,
        kind: 'original',
        originalPath: job.path,
      });
      for (const s of movedSidecars) {
        insertRecycled(db, {
          path: s.move.to,
          libraryId: job.libraryId,
          jobId: job.id,
          sizeBytes: s.sizeBytes,
          recycledAt: at,
          kind: 'sidecar',
          originalPath: s.move.from,
        });
      }
    }
    updateJob(db, job.id, { restoreJournal: null }, deps.now());
  });
  log.info({
    msg: direction === 'restore' ? 'restored an original' : 'undid a restore',
    job: job.id,
    restore: restoreId,
  });
  return {
    kind: direction === 'restore' ? 'restored' : 'undone',
    jobId: job.id,
    restoreId,
    notRestored,
  };
}

/**
 * Why the recycled copy is gone: removed by hand, or, once its cleanup date has passed, maybe by
 * the cleanup on that date.
 */
function goneReason(deps: RestoreDeps, row: RecycledRow, direction: 'restore' | 'undo'): string {
  const what = direction === 'restore' ? 'The original' : "Transcoda's version";
  const due =
    deps.retentionDays === undefined
      ? null
      : new Date(Date.parse(row.recycledAt) + deps.retentionDays * 86_400_000);
  const when =
    due !== null && due.getTime() <= deps.now().getTime()
      ? `removed on ${due.toISOString().slice(0, 10)} or by hand`
      : 'removed by hand';
  return `${what} is no longer in the recycle folder (${when}).`;
}

/** Checks the files on disk and plans the moves; throws {@link Refused} with the reason. */
async function planMoves(
  deps: RestoreDeps,
  ctx: {
    direction: 'restore' | 'undo';
    row: RecycledRow;
    job: JobRow;
    root: string;
    restoreId: string;
    fingerprint: string;
    outputFingerprint: string | null;
  },
): Promise<{
  moves: RestoreMove[];
  sidecars: SidecarPlan[];
  notRestored: string[];
  atPathBytes: number;
}> {
  const { db, fs } = deps;
  const { direction, row, job, root } = ctx;
  const restore = direction === 'undo' ? findRestore(db, ctx.restoreId) : null;
  if (direction === 'undo' && (restore === null || restore.undoneAt !== null)) {
    throw new Refused(REASON.undone);
  }
  const atPath = await statOrNull(fs, job.path);
  const atKey = atPath ? fingerprintKey(fingerprintFromStats(atPath)) : null;
  if (direction === 'restore') {
    if (ctx.outputFingerprint === null) throw new Refused(REASON.noOutputKey);
    if (atKey !== ctx.outputFingerprint) throw new Refused(REASON.notOutput);
  } else if (atKey !== ctx.fingerprint) {
    throw new Refused(REASON.changedSinceRestore);
  }
  const copy = await statOrNull(fs, row.path);
  if (copy === null) {
    deleteRecycled(db, row.path);
    throw new Refused(goneReason(deps, row, direction));
  }
  if (copy.size !== row.sizeBytes) {
    throw new Refused(direction === 'restore' ? REASON.originalSize : REASON.outputSize);
  }
  const folder = recycleFolderOf(row.path, root, job.path);
  if (folder === null) throw new Refused(REASON.noFolder);

  const taken = new Set<string>();
  const aside = await firstFree(fs, folder, root, job.path, taken);
  const keyOf = (st: Stats): string => fingerprintKey(fingerprintFromStats(st));
  const moves: RestoreMove[] = [
    {
      from: job.path,
      to: aside,
      role: direction === 'restore' ? 'output' : 'original',
      key: atKey as string,
    },
    {
      from: row.path,
      to: job.path,
      role: direction === 'restore' ? 'original' : 'output',
      key: keyOf(copy),
    },
  ];
  const sidecars: SidecarPlan[] = [];
  const notRestored: string[] = [];
  if (direction === 'restore') {
    for (const s of listRecycledForJob(db, job.id)) {
      if (s.kind !== 'sidecar') continue;
      const name = basename(s.originalPath ?? s.path);
      if (s.originalPath === null) {
        notRestored.push(`${name} (its place wasn't recorded)`);
        continue;
      }
      const st = await statOrNull(fs, s.path);
      if (st === null) {
        notRestored.push(`${name} (gone from the recycle folder)`);
      } else if (await fs.exists(s.originalPath)) {
        notRestored.push(`${name} (its place is taken)`);
      } else {
        const move: RestoreMove = {
          from: s.path,
          to: s.originalPath,
          role: 'sidecar',
          key: keyOf(st),
        };
        moves.push(move);
        sidecars.push({ move, row: s, sizeBytes: s.sizeBytes });
      }
    }
  } else {
    for (const p of (restore as NonNullable<typeof restore>).sidecarPaths) {
      const st = await statOrNull(fs, p, 'lstat');
      if (st === null || !st.isFile()) continue;
      const was = (restore as NonNullable<typeof restore>).sidecarKeys[p];
      if (was !== undefined && keyOf(st) !== was) {
        notRestored.push(`${basename(p)} (changed since the restore, left in place)`);
        continue;
      }
      const move: RestoreMove = {
        from: p,
        to: await firstFree(fs, folder, root, p, taken),
        role: 'sidecar',
        key: keyOf(st),
      };
      moves.push(move);
      sidecars.push({ move, row: null, sizeBytes: st.size });
    }
  }
  return { moves, sidecars, notRestored, atPathBytes: atPath?.size ?? 0 };
}

/** What a rollback did: `keptAside` lists files left in the recycle folder (see below). */
export interface RestoreRollback {
  outcome: 'rolled-back' | 'conflict';
  keptAside: string[];
}

/** The kind a file moved into the recycle folder is recorded as, by its role. */
const ASIDE_KIND = { output: 'restored-output', original: 'original', sidecar: 'sidecar' } as const;

/**
 * Undoes the moves of the job's restore journal from `next` down to the first, reading only the
 * disk: a file at `to` and none at `from` goes back; the same file under both names (half a
 * link + unlink) loses its `to` name; only `from` there means the move never ran.
 *
 * Two different files at `from` and `to`: when the one at `to` is not the file the move planned
 * (its fingerprint key differs), the move never ran and a stranger took `to`; it is left alone.
 * When it is ours, another program wrote `from` after the move: ours stays where it is and, when
 * that is the recycle folder, is recorded there, so nothing is lost and the job is not wedged.
 * Anything else is a conflict for the video files (logged, the journal kept) and skipped for a
 * subtitle file. The database records are only written once every move is done, so they never
 * need undoing.
 */
export async function rollBackRestore(deps: RestoreDeps, job: JobRow): Promise<RestoreRollback> {
  const { db, fs, log } = deps;
  const j = job.restoreJournal;
  if (j === null) return { outcome: 'rolled-back', keptAside: [] };
  let conflict = false;
  const keptAside: { move: RestoreMove; sizeBytes: number }[] = [];
  for (let i = Math.min(j.next, j.moves.length - 1); i >= 0; i -= 1) {
    const move = j.moves[i] as RestoreMove;
    const [from, to] = [
      await statOrNull(fs, move.from, 'lstat'),
      await statOrNull(fs, move.to, 'lstat'),
    ];
    const toIsOurs =
      to !== null &&
      move.key !== undefined &&
      fingerprintKey(fingerprintFromStats(to)) === move.key;
    // Where a move's `to` is in the recycle folder: the set-aside file, and an undo's subtitles.
    const toRecycle = j.direction === 'restore' ? move.role === 'output' : move.role !== 'output';
    if (to !== null && from === null) {
      await renameNoClobber(fs, move.to, move.from);
      await syncDirs(fs, [dirname(move.from), dirname(move.to)], log);
    } else if (to !== null && from !== null && to.ino === from.ino && to.dev === from.dev) {
      await fs.unlink(move.to);
      await syncDirs(fs, [dirname(move.to)], log);
    } else if (from !== null && to === null) {
      // The move never ran.
    } else if (to !== null && move.key !== undefined && !toIsOurs) {
      // The move never ran; another program's file is at `to`.
    } else if (to !== null && toIsOurs && toRecycle) {
      log.warn({
        msg: 'restore raced another program; kept in the recycle folder',
        job: job.id,
        path: move.to,
      });
      keptAside.push({ move, sizeBytes: to.size });
    } else if (move.role === 'sidecar') {
      // A subtitle file someone else changed: left as it is.
    } else {
      log.error({
        msg: 'restore left files to sort out',
        job: job.id,
        from: move.from,
        to: move.to,
      });
      conflict = true;
    }
  }
  if (conflict) return { outcome: 'conflict', keptAside: [] };
  const at = deps.now().toISOString();
  durably(db, () => {
    for (const { move, sizeBytes } of keptAside) {
      insertRecycled(db, {
        path: move.to,
        libraryId: job.libraryId,
        jobId: job.id,
        sizeBytes,
        recycledAt: at,
        kind: ASIDE_KIND[move.role],
        originalPath: move.from,
        restoreId: null,
      });
    }
    updateJob(db, job.id, { restoreJournal: null }, deps.now());
  });
  return { outcome: 'rolled-back', keptAside: keptAside.map((k) => k.move.to) };
}
