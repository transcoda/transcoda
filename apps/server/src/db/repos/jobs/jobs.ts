import { isFinalState, type JobState, type JsonValue } from '@transcoda/shared';
import type { Database } from '../../open.ts';
import {
  ACTIVE_SQL,
  type DbJob,
  FINAL_SQL,
  type JobInsert,
  type JobPatch,
  type JobRow,
  placeholders,
  toJob,
  toJson,
} from './rows.ts';

// The jobs table: insert, find, update and the queue's reads. The list, results, trace, journals,
// parked approvals and prior runs are in the other files of this folder; code outside imports them from here.

export {
  deleteApproval,
  findApproval,
  insertApproval,
  listApprovals,
  parkedBytes,
} from './approvals.ts';
export {
  claimRestoreJournal,
  hasFileJournal,
  hasReplaceJournal,
  jobsWithReplaceJournal,
  jobsWithRestoreJournal,
} from './journals.ts';
export type { JobListFilter, JobListRow } from './list.ts';
export {
  countAwaitingApproval,
  countDependsOnSize,
  countJobsByState,
  countProblems,
  DEPENDS_ON_SIZE_SQL,
  findJobListRow,
  listJobListRows,
  listJobs,
} from './list.ts';
export type { ProcessedResult } from './prior-runs.ts';
export { alreadyProcessedReason, findPriorRun, findProcessedResult } from './prior-runs.ts';
export type { JobResultRow } from './results.ts';
export { findJobResult, insertJobResult, recentRatios } from './results.ts';
export type {
  JobPatch,
  JobProgress,
  JobRow,
  ReplaceJournal,
  RestoreJournal,
  RestoreMove,
  WalkStep,
} from './rows.ts';
export { parseMedia } from './rows.ts';
export { ACTIVE_RESTORE_SQL, allTimeSaved, jobHistory, jobStats } from './stats.ts';
export { appendTrace, listTrace, nextTraceSeq } from './trace.ts';

/** A new job at attempt 1; a job inserted in a final state (skipped, already_processed) is finished now. */
export function insertJob(db: Database, input: JobInsert, now: Date): JobRow {
  const ts = now.toISOString();
  db.prepare(
    `INSERT INTO jobs (id, run_id, library_id, file_id, path, workflow_id, workflow_version, dry_run,
       test_encode, state, priority, reason, media, queued_at, finished_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.runId,
    input.libraryId,
    input.fileId,
    input.path,
    input.workflowId,
    input.workflowVersion,
    input.dryRun ? 1 : 0,
    input.testEncode ? 1 : 0,
    input.state,
    input.priority,
    input.reason ?? null,
    toJson(input.media ?? null),
    ts,
    isFinalState(input.state) ? ts : null,
    ts,
  );
  const row = findJob(db, input.id);
  if (!row) throw new Error(`job ${input.id} vanished after insert`);
  return row;
}

export function findJob(db: Database, id: string): JobRow | null {
  const r = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as DbJob | undefined;
  return r ? toJob(r) : null;
}

const same = (v: unknown): unknown => v;
/** Patch key → column and SQLite encoding. */
const PATCH_COLUMNS: Record<keyof JobPatch, [string, (v: unknown) => unknown]> = {
  state: ['state', same],
  paused: ['paused', (v) => (v ? 1 : 0)],
  lane: ['lane', same],
  attempt: ['attempt', same],
  requeues: ['requeues', same],
  encodedOn: ['encoded_on', same],
  failedGpus: ['failed_gpus', toJson],
  progress: ['progress', toJson],
  reason: ['reason', same],
  failureCode: ['failure_code', same],
  replaceJournal: ['replace_journal', toJson],
  restoreJournal: ['restore_journal', toJson],
  walkPath: ['walk_path', toJson],
  startedAt: ['started_at', same],
  finishedAt: ['finished_at', same],
  fileId: ['file_id', same],
  workflowVersion: ['workflow_version', same],
};

/** Patches a job; moving into a final state stamps finished_at with `now` unless the patch sets it. */
export function updateJob(db: Database, id: string, patch: JobPatch, now: Date): JobRow | null {
  const sets = ['updated_at = ?'];
  const values: unknown[] = [now.toISOString()];
  for (const key of Object.keys(PATCH_COLUMNS) as (keyof JobPatch)[]) {
    if (patch[key] === undefined) continue;
    const [column, encode] = PATCH_COLUMNS[key];
    sets.push(`${column} = ?`);
    values.push(encode(patch[key]));
  }
  // A final state is never paused (the pause chip belongs to a live job).
  if (patch.state !== undefined && isFinalState(patch.state) && patch.paused === undefined) {
    sets.push('paused = 0');
  }
  if (patch.state !== undefined && isFinalState(patch.state) && patch.finishedAt === undefined) {
    // In SET, `state` is the old value: a job that was already final keeps its time.
    sets.push(
      `finished_at = CASE WHEN state IN (${FINAL_SQL}) AND finished_at IS NOT NULL THEN finished_at ELSE ? END`,
    );
    values.push(now.toISOString());
  }
  const info = db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  return info.changes === 0 ? null : findJob(db, id);
}

/** Runnable jobs: queued and not paused, by priority DESC then queued_at. */
/**
 * The next queued, unpaused jobs in queue order. Jobs of a `library` run whose library is in
 * `heldLibraryIds` (its run hours are closed) are passed over; manual runs never are.
 */
export function nextQueuedJobs(
  db: Database,
  limit: number,
  heldLibraryIds: readonly string[] = [],
): JobRow[] {
  const held =
    heldLibraryIds.length === 0
      ? ''
      : `AND NOT (library_id IN (${placeholders(heldLibraryIds.length)})
           AND run_id IN (SELECT id FROM runs WHERE source = 'library'))`;
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE state = 'queued' AND paused = 0 ${held}
       ORDER BY priority DESC, queued_at, rowid LIMIT ?`,
    )
    .all(...heldLibraryIds, limit) as DbJob[];
  return rows.map(toJob);
}

export function jobsInStates(db: Database, states: JobState[]): JobRow[] {
  if (states.length === 0) return [];
  const rows = db
    .prepare(`SELECT * FROM jobs WHERE state IN (${placeholders(states.length)}) ORDER BY rowid`)
    .all(...states) as DbJob[];
  return rows.map(toJob);
}

/** True when a queued or running job works on the file at `path`. */
export function hasActiveJobAt(db: Database, path: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM jobs WHERE path = ? AND state IN (${ACTIVE_SQL}) LIMIT 1`)
      .get(path) !== undefined
  );
}

// ---- job probe ----

/** Stores the probe this job's attempt was planned from (the latest attempt's wins). */
export function setJobProbe(db: Database, jobId: string, probe: JsonValue): void {
  db.prepare('UPDATE jobs SET probe = ? WHERE id = ?').run(toJson(probe), jobId);
}

/** The probe stored with the job; null when it was never probed (or queued before migration 4). */
export function findJobProbe(db: Database, jobId: string): JsonValue | null {
  const r = db.prepare('SELECT probe FROM jobs WHERE id = ?').get(jobId) as
    | { probe: string | null }
    | undefined;
  return r?.probe ? (JSON.parse(r.probe) as JsonValue) : null;
}
