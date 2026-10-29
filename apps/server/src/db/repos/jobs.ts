import { basename } from 'node:path';
import {
  ACTIVE_JOB_STATES,
  FINAL_JOB_STATES,
  isFinalState,
  JOB_STATES,
  type JobPlan,
  type JobState,
  type JsonValue,
  type Lane,
  planSummary,
  RUNNING_JOB_STATES,
  type TraceEntry,
  TraceEntrySchema,
} from '@transcoda/shared';
import { type Fingerprint, fingerprintKey } from '../../engine/fingerprint.ts';
import type { Database } from '../open.ts';

export interface JobProgress {
  percent: number | null;
  outTimeSeconds: number;
  speed: number | null;
  fps: number | null;
  sizeBytes: number | null;
  etaSeconds: number | null;
  /** Verifying only: which part of the verify runs; `done`/`total` count its checks. */
  verify?: {
    stage: 'checks' | 'full-decode' | 'source';
    done: number | null;
    total: number | null;
  };
}

/** An *intent*: the action the replace is about to perform (written before it); the sweep decides from the disk, not from the step. */
export interface ReplaceJournal {
  step: 'checking' | 'writing_tmp' | 'moving_original' | 'installing_tmp' | 'cleaning';
  originalPath: string;
  tmpPath: string;
  outputPath: string;
  /** The recycle path, or the `.orig` path when recycling is off. */
  copyPath: string;
  /** The library root: the sweep decides nothing while it is unreachable (an unmounted share). */
  libraryRoot: string;
  recycling: boolean;
  fingerprint: Fingerprint;
  outputBytes: number;
}

/** One node of the file's path through the workflow and the file output it left by (null: none). */
export interface WalkStep {
  workflowPath: string[];
  nodeId: string;
  port: string | null;
}

export interface JobRow {
  id: string;
  runId: string;
  libraryId: string;
  fileId: string | null;
  path: string;
  workflowId: string;
  workflowVersion: number;
  dryRun: boolean;
  /** Dry runs only: encode, verify and measure for real, then stop before the first write. */
  testEncode: boolean;
  state: JobState;
  paused: boolean;
  priority: number;
  lane: Lane | null;
  attempt: number;
  requeues: number;
  /** The label of the slot that ran the encode; null before one did. */
  encodedOn: string | null;
  /** GPU ids this job's encode already failed on; a retry clears it. */
  failedGpus: string[];
  progress: JobProgress | null;
  reason: string | null;
  replaceJournal: ReplaceJournal | null;
  /** The path the walk took (partial up to the failing node on a walk failure); null before. */
  walkPath: WalkStep[] | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface JobListRow extends JobRow {
  fileName: string;
  libraryName: string;
  workflowName: string;
  result: {
    outcome: JobState;
    beforeBytes: number | null;
    afterBytes: number | null;
    replacedTo: 'recycle' | 'deleted' | null;
    /** The original was kept because the source is damaged ("Damaged source"). */
    sourceDamaged: boolean;
  } | null;
  /** The result's problems (empty when none or no result). */
  problems: string[];
  /** Dry runs only: the estimated output size; null for a real run or a row without one. */
  estimatedBytes: number | null;
  /** Dry runs only: {@link planSummary} of the stored plan; null without one. */
  planSummary: string | null;
  /**
   * A plan-only dry run that ended `dry_run` whose size gate decides after encoding (#41): the
   * gate's minimum saving; null otherwise.
   */
  dependsOnSize: { minSavingPercent: number } | null;
  /** From a `library` run: its library's run hours apply. */
  automatic: boolean;
}

export interface JobResultRow {
  jobId: string;
  /** `fingerprintKey` of the input file. */
  fingerprint: string;
  workflowId: string;
  workflowVersion: number;
  outcome: JobState;
  beforeBytes: number | null;
  afterBytes: number | null;
  estimatedBytes: number | null;
  command: string | null;
  plan: JobPlan | null;
  replacedTo: 'recycle' | 'deleted' | null;
  logPath: string | null;
  warnings: string[];
  /** Problems the plugin finish actions reported; separate from `warnings`. */
  problems: string[];
  /**
   * The probe verify read of the output, as the job page reads it (a JobProbe: no raw JSON); null
   * when nothing was verified or the job failed or was cancelled after verify. Rows written before
   * that was decided may hold the whole ProbeResult (with `raw`).
   */
  outputProbe: JsonValue | null;
  /** The original was kept because the source is damaged (decode errors it reproduces). */
  sourceDamaged: boolean;
  /**
   * `fingerprintKey` of the file the job wrote, read at its final path once it was written (the
   * replaced original, a move-copy destination); null when nothing was written or it could not
   * be read. Absent reads as null.
   */
  outputFingerprint?: string | null;
  /** Sampled content hash (engine/content-hash.ts) of the source when a real job started. */
  sourceHash?: string | null;
  /** Sampled content hash of the written file at its final path (done results). */
  outputHash?: string | null;
  createdAt: string;
}

export interface FileRow {
  id: string;
  libraryId: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  ino: number;
  dev: number;
  /** `fingerprintKey` of the identity columns. */
  fingerprint: string;
  lastProbe: JsonValue | null;
  updatedAt: string;
}

export interface RecycledRow {
  path: string;
  libraryId: string;
  jobId: string;
  sizeBytes: number;
  recycledAt: string;
}

/** Outcomes that make a later run of the same file and workflow version `already_processed`. */
export const FINAL_RESULT_OUTCOMES: readonly JobState[] = [
  'done',
  'nothing_to_do',
  'kept_original',
  'failed',
];

export type JobInsert = Pick<
  JobRow,
  | 'id'
  | 'runId'
  | 'libraryId'
  | 'fileId'
  | 'path'
  | 'workflowId'
  | 'workflowVersion'
  | 'dryRun'
  | 'testEncode'
  | 'state'
  | 'priority'
> & { reason?: string | null };

export type JobPatch = Partial<
  Pick<
    JobRow,
    | 'state'
    | 'paused'
    | 'lane'
    | 'attempt'
    | 'requeues'
    | 'encodedOn'
    | 'failedGpus'
    | 'progress'
    | 'reason'
    | 'replaceJournal'
    | 'walkPath'
    | 'startedAt'
    | 'finishedAt'
    | 'fileId'
    | 'workflowVersion'
  >
>;

interface DbJob {
  id: string;
  run_id: string;
  library_id: string;
  file_id: string | null;
  path: string;
  workflow_id: string;
  workflow_version: number;
  dry_run: number;
  test_encode: number;
  state: JobState;
  paused: number;
  priority: number;
  lane: Lane | null;
  attempt: number;
  requeues: number;
  encoded_on: string | null;
  failed_gpus: string;
  progress: string | null;
  reason: string | null;
  replace_journal: string | null;
  walk_path: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface DbJobList extends DbJob {
  library_name: string | null;
  workflow_name: string | null;
  r_outcome: JobState | null;
  r_before_bytes: number | null;
  r_after_bytes: number | null;
  r_replaced_to: 'recycle' | 'deleted' | null;
  r_source_damaged: number | null;
  r_problems_json: string | null;
  r_estimated_bytes: number | null;
  r_plan: string | null;
  run_source: 'manual' | 'library' | null;
}

interface DbResult {
  job_id: string;
  fingerprint: string;
  workflow_id: string;
  workflow_version: number;
  outcome: JobState;
  before_bytes: number | null;
  after_bytes: number | null;
  estimated_bytes: number | null;
  command: string | null;
  plan: string | null;
  replaced_to: 'recycle' | 'deleted' | null;
  log_path: string | null;
  warnings: string;
  problems_json: string;
  output_probe: string | null;
  source_damaged: number;
  output_fingerprint: string | null;
  source_hash: string | null;
  output_hash: string | null;
  created_at: string;
}

interface DbFile {
  id: string;
  library_id: string;
  path: string;
  size_bytes: number;
  mtime_ms: number;
  ino: number;
  dev: number;
  fingerprint: string;
  last_probe: string | null;
  updated_at: string;
}

interface DbRecycled {
  path: string;
  library_id: string;
  job_id: string;
  size_bytes: number;
  recycled_at: string;
}

const parseJson = <T>(s: string | null): T | null => (s === null ? null : (JSON.parse(s) as T));
/** A GPU id list that survives a corrupt cell: one bad row must not break every job read. */
const parseIdList = (s: string): string[] => {
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const toJson = (v: unknown): string | null => (v === null ? null : JSON.stringify(v));
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');
const ACTIVE_SQL = ACTIVE_JOB_STATES.map((s) => `'${s}'`).join(',');
const FINAL_SQL = FINAL_JOB_STATES.map((s) => `'${s}'`).join(',');

const toJob = (r: DbJob): JobRow => ({
  id: r.id,
  runId: r.run_id,
  libraryId: r.library_id,
  fileId: r.file_id,
  path: r.path,
  workflowId: r.workflow_id,
  workflowVersion: r.workflow_version,
  dryRun: r.dry_run !== 0,
  testEncode: r.test_encode !== 0,
  state: r.state,
  paused: r.paused !== 0,
  priority: r.priority,
  lane: r.lane,
  attempt: r.attempt,
  requeues: r.requeues,
  encodedOn: r.encoded_on,
  failedGpus: parseIdList(r.failed_gpus),
  progress: parseJson<JobProgress>(r.progress),
  reason: r.reason,
  replaceJournal: parseJson<ReplaceJournal>(r.replace_journal),
  walkPath: parseJson<WalkStep[]>(r.walk_path),
  queuedAt: r.queued_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  updatedAt: r.updated_at,
});

const toResult = (r: DbResult): JobResultRow => ({
  jobId: r.job_id,
  fingerprint: r.fingerprint,
  workflowId: r.workflow_id,
  workflowVersion: r.workflow_version,
  outcome: r.outcome,
  beforeBytes: r.before_bytes,
  afterBytes: r.after_bytes,
  estimatedBytes: r.estimated_bytes,
  command: r.command,
  plan: parseJson<JobPlan>(r.plan),
  replacedTo: r.replaced_to,
  logPath: r.log_path,
  warnings: JSON.parse(r.warnings) as string[],
  problems: JSON.parse(r.problems_json) as string[],
  outputProbe: parseJson<JsonValue>(r.output_probe),
  sourceDamaged: r.source_damaged === 1,
  outputFingerprint: r.output_fingerprint,
  sourceHash: r.source_hash,
  outputHash: r.output_hash,
  createdAt: r.created_at,
});

const toFile = (r: DbFile): FileRow => ({
  id: r.id,
  libraryId: r.library_id,
  path: r.path,
  sizeBytes: r.size_bytes,
  mtimeMs: r.mtime_ms,
  ino: r.ino,
  dev: r.dev,
  fingerprint: r.fingerprint,
  lastProbe: parseJson<JsonValue>(r.last_probe),
  updatedAt: r.updated_at,
});

const toRecycled = (r: DbRecycled): RecycledRow => ({
  path: r.path,
  libraryId: r.library_id,
  jobId: r.job_id,
  sizeBytes: r.size_bytes,
  recycledAt: r.recycled_at,
});

// ---- jobs ----

/** A new job at attempt 1; a job inserted in a final state (skipped, already_processed) is finished now. */
export function insertJob(db: Database, input: JobInsert, now: Date): JobRow {
  const ts = now.toISOString();
  db.prepare(
    `INSERT INTO jobs (id, run_id, library_id, file_id, path, workflow_id, workflow_version, dry_run,
       test_encode, state, priority, reason, queued_at, finished_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  replaceJournal: ['replace_journal', toJson],
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

export interface JobListFilter {
  runId?: string;
  libraryId?: string;
  states?: JobState[];
  /** Page size, default {@link JOB_LIST_LIMIT}. */
  limit?: number;
  /**
   * Keyset cursor: the id of the last job of the previous page. The next page continues after it
   * in list order (by its current state; an unknown id gives an empty page).
   */
  before?: string;
  /** Only jobs whose result has problems. */
  problems?: true;
  /** Only plan-only dry runs whose outcome depends on the size gate. */
  dependsOnSize?: true;
}

export const JOB_LIST_LIMIT = 200;

const LIST_SELECT = `SELECT j.*, l.name AS library_name, w.name AS workflow_name,
    r.outcome AS r_outcome, r.before_bytes AS r_before_bytes, r.after_bytes AS r_after_bytes,
    r.replaced_to AS r_replaced_to, r.source_damaged AS r_source_damaged,
    r.problems_json AS r_problems_json,
    r.estimated_bytes AS r_estimated_bytes, r.plan AS r_plan,
    (SELECT source FROM runs WHERE runs.id = j.run_id) AS run_source
  FROM jobs j
  LEFT JOIN libraries l ON l.id = j.library_id
  LEFT JOIN workflows w ON w.id = j.workflow_id
  LEFT JOIN job_results r ON r.job_id = j.id`;

const toListRow = (r: DbJobList): JobListRow => {
  // Dry runs only: the stored plan, parsed once for the summary and the size-gate outcome.
  const plan = r.dry_run !== 0 && r.r_plan !== null ? (JSON.parse(r.r_plan) as JobPlan) : null;
  return {
    ...toJob(r),
    fileName: basename(r.path),
    libraryName: r.library_name ?? '',
    workflowName: r.workflow_name ?? '',
    result:
      r.r_outcome === null
        ? null
        : {
            outcome: r.r_outcome,
            beforeBytes: r.r_before_bytes,
            afterBytes: r.r_after_bytes,
            replacedTo: r.r_replaced_to,
            sourceDamaged: r.r_source_damaged === 1,
          },
    problems: r.r_problems_json === null ? [] : (JSON.parse(r.r_problems_json) as string[]),
    estimatedBytes: r.dry_run !== 0 ? r.r_estimated_bytes : null,
    planSummary: plan ? planSummary(plan) : null,
    dependsOnSize: r.state === 'dry_run' ? (plan?.dependsOnSize ?? null) : null,
    automatic: r.run_source === 'library',
  };
};

/** SQL: a `dry_run` job whose stored plan depends on size (jobs `j`, results `r`). */
export const DEPENDS_ON_SIZE_SQL =
  "j.state = 'dry_run' AND json_extract(r.plan, '$.dependsOnSize.minSavingPercent') IS NOT NULL";

/** One job as a list row (library, workflow, result), or null. */
export function findJobListRow(db: Database, id: string): JobListRow | null {
  const r = db.prepare(`${LIST_SELECT} WHERE j.id = ?`).get(id) as DbJobList | undefined;
  return r ? toListRow(r) : null;
}

interface Cursor {
  state: JobState;
  priority: number;
  queued_at: string;
  finished_at: string | null;
  rowid: number;
}

/**
 * Jobs with their library, workflow and result, one page at a time: active jobs first
 * (priority DESC, queued_at, rowid), then final jobs (finished_at DESC, rowid DESC).
 */
export function listJobs(db: Database, filter: JobListFilter): JobListRow[] {
  const limit = filter.limit ?? JOB_LIST_LIMIT;
  if (limit <= 0 || filter.states?.length === 0) return [];
  const where: string[] = [];
  const values: (string | number)[] = [];
  if (filter.runId !== undefined) {
    where.push('j.run_id = ?');
    values.push(filter.runId);
  }
  if (filter.libraryId !== undefined) {
    where.push('j.library_id = ?');
    values.push(filter.libraryId);
  }
  if (filter.states !== undefined) {
    where.push(`j.state IN (${placeholders(filter.states.length)})`);
    values.push(...filter.states);
  }
  if (filter.problems === true) where.push('json_array_length(r.problems_json) > 0');
  if (filter.dependsOnSize === true) where.push(DEPENDS_ON_SIZE_SQL);
  let cursor: Cursor | null = null;
  if (filter.before !== undefined) {
    cursor =
      (db
        .prepare('SELECT state, priority, queued_at, finished_at, rowid FROM jobs WHERE id = ?')
        .get(filter.before) as Cursor | undefined) ?? null;
    if (cursor === null) return [];
  }

  const rows: DbJobList[] = [];
  if (cursor === null || ACTIVE_JOB_STATES.includes(cursor.state)) {
    const active = [...where, `j.state IN (${ACTIVE_SQL})`];
    const activeValues: (string | number)[] = [...values];
    if (cursor !== null) {
      active.push('(-j.priority, j.queued_at, j.rowid) > (?, ?, ?)');
      activeValues.push(-cursor.priority, cursor.queued_at, cursor.rowid);
    }
    rows.push(
      ...(db
        .prepare(
          `${LIST_SELECT} WHERE ${active.join(' AND ')}
           ORDER BY j.priority DESC, j.queued_at, j.rowid LIMIT ?`,
        )
        .all(...activeValues, limit) as DbJobList[]),
    );
  }
  if (rows.length < limit) {
    // Unary + keeps the planner off jobs_state_priority so it walks jobs_finished_at in order.
    const final = [...where, `+j.state IN (${FINAL_SQL})`];
    const finalValues: (string | number)[] = [...values];
    if (cursor !== null && !ACTIVE_JOB_STATES.includes(cursor.state)) {
      // A final job always has finished_at (CHECK in 0003).
      final.push('(j.finished_at, j.rowid) < (?, ?)');
      finalValues.push(cursor.finished_at ?? '', cursor.rowid);
    }
    rows.push(
      ...(db
        .prepare(
          `${LIST_SELECT} WHERE ${final.join(' AND ')}
           ORDER BY j.finished_at DESC, j.rowid DESC LIMIT ?`,
        )
        .all(...finalValues, limit - rows.length) as DbJobList[]),
    );
  }
  return rows.map(toListRow);
}

/** Jobs per state (every state present, zero when none). */
export function countJobsByState(
  db: Database,
  filter: { libraryId?: string; runId?: string },
): Record<JobState, number> {
  const counts = Object.fromEntries(JOB_STATES.map((s) => [s, 0])) as Record<JobState, number>;
  const where: string[] = [];
  const values: string[] = [];
  if (filter.libraryId !== undefined) {
    where.push('library_id = ?');
    values.push(filter.libraryId);
  }
  if (filter.runId !== undefined) {
    where.push('run_id = ?');
    values.push(filter.runId);
  }
  const rows = db
    .prepare(
      `SELECT state, COUNT(*) AS n FROM jobs ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY state`,
    )
    .all(...values) as { state: JobState; n: number }[];
  for (const { state, n } of rows) counts[state] = n;
  return counts;
}

/** Jobs whose result has problems, within the list's scope (run, library); no state filter. */
export function countProblems(
  db: Database,
  filter: { libraryId?: string; runId?: string },
): number {
  const where: string[] = ['json_array_length(r.problems_json) > 0'];
  const values: string[] = [];
  if (filter.libraryId !== undefined) {
    where.push('j.library_id = ?');
    values.push(filter.libraryId);
  }
  if (filter.runId !== undefined) {
    where.push('j.run_id = ?');
    values.push(filter.runId);
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs j JOIN job_results r ON r.job_id = j.id WHERE ${where.join(' AND ')}`,
    )
    .get(...values) as { n: number };
  return row.n;
}

/** Plan-only dry runs whose outcome depends on size, within the list's scope; no state filter. */
export function countDependsOnSize(
  db: Database,
  filter: { libraryId?: string; runId?: string },
): number {
  const where: string[] = [DEPENDS_ON_SIZE_SQL];
  const values: string[] = [];
  if (filter.libraryId !== undefined) {
    where.push('j.library_id = ?');
    values.push(filter.libraryId);
  }
  if (filter.runId !== undefined) {
    where.push('j.run_id = ?');
    values.push(filter.runId);
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs j JOIN job_results r ON r.job_id = j.id WHERE ${where.join(' AND ')}`,
    )
    .get(...values) as { n: number };
  return row.n;
}

/**
 * Dashboard numbers: `files` (done results), `savedBytes` (before − after of those) over results
 * created at or after `since`; `problems`: results with problems created at or after `since`; `failed`: jobs in state `failed` that finished at or after `since`
 * (a job the sweep failed has no result row); `queued` and `running` are current.
 */
export function jobStats(
  db: Database,
  since: string,
): {
  files: number;
  savedBytes: number;
  failed: number;
  queued: number;
  running: number;
  problems: number;
} {
  const r = db
    .prepare(
      `SELECT
         COALESCE(SUM(outcome = 'done'), 0) AS files,
         COALESCE(SUM(CASE WHEN outcome = 'done'
           THEN COALESCE(before_bytes, 0) - COALESCE(after_bytes, 0) ELSE 0 END), 0) AS savedBytes,
         (SELECT COUNT(*) FROM jobs WHERE state = 'failed' AND finished_at >= ?) AS failed,
         COALESCE(SUM(json_array_length(problems_json) > 0), 0) AS problems
       FROM job_results WHERE created_at >= ?`,
    )
    .get(since, since) as { files: number; savedBytes: number; failed: number; problems: number };
  const counts = countJobsByState(db, {});
  return {
    ...r,
    queued: counts.queued,
    running: RUNNING_JOB_STATES.reduce((n, s) => n + counts[s], 0),
  };
}

/** One day of the Jobs page history. */
export interface DayTotals {
  /** Before − after over `done` results, never below 0. */
  savedBytes: number;
  /** `done` results. */
  replaced: number;
  /** `kept_original` results. */
  kept: number;
  /** Source duration of `done` and `kept_original` results (the encoder's work). */
  seconds: number;
}

/**
 * Totals per day for `bounds` (N + 1 ascending ISO instants): entry `i` covers results created in
 * `[bounds[i], bounds[i + 1])`. A row counts once, on the day of its `created_at`.
 */
export function jobHistory(db: Database, bounds: string[]): DayTotals[] {
  const stmt = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN r.outcome = 'done'
         THEN COALESCE(r.before_bytes, 0) - COALESCE(r.after_bytes, 0) ELSE 0 END), 0) AS savedBytes,
       COALESCE(SUM(r.outcome = 'done'), 0) AS replaced,
       COALESCE(SUM(r.outcome = 'kept_original'), 0) AS kept,
       COALESCE(SUM(CASE WHEN r.outcome IN ('done', 'kept_original')
         THEN COALESCE(json_extract(j.probe, '$.durationSeconds'), 0) ELSE 0 END), 0) AS seconds
     FROM job_results r LEFT JOIN jobs j ON j.id = r.job_id
     WHERE r.created_at >= ? AND r.created_at < ?`,
  );
  const days: DayTotals[] = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const r = stmt.get(bounds[i] as string, bounds[i + 1] as string) as unknown as DayTotals;
    days.push({
      savedBytes: Math.max(0, r.savedBytes),
      replaced: r.replaced,
      kept: r.kept,
      seconds: r.seconds,
    });
  }
  return days;
}

/** Saved bytes and replaced files over every `done` result, and when the first result was made. */
export function allTimeSaved(db: Database): {
  savedBytes: number;
  files: number;
  since: string | null;
} {
  return db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN outcome = 'done'
           THEN COALESCE(before_bytes, 0) - COALESCE(after_bytes, 0) ELSE 0 END), 0) AS savedBytes,
         COALESCE(SUM(outcome = 'done'), 0) AS files,
         MIN(created_at) AS since
       FROM job_results`,
    )
    .get() as { savedBytes: number; files: number; since: string | null };
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

/** Jobs with a replace journal (any state): what the startup sweep settles. */
export function jobsWithReplaceJournal(db: Database): JobRow[] {
  const rows = db
    .prepare('SELECT * FROM jobs WHERE replace_journal IS NOT NULL ORDER BY rowid')
    .all() as DbJob[];
  return rows.map(toJob);
}

/** True while the job has a replace journal (a replace in flight or awaiting the sweep). */
export function hasReplaceJournal(db: Database, jobId: string): boolean {
  return (
    db.prepare('SELECT 1 FROM jobs WHERE id = ? AND replace_journal IS NOT NULL').get(jobId) !==
    undefined
  );
}

// ---- results ----

/**
 * The reason of an `already_processed` job. A `done` result's fingerprint is the original's (the
 * replacement has its own), so a match means that original is back, moved out of the recycle
 * folder by hand (C5): the job says so and how to process it again.
 */
export function alreadyProcessedReason(prior: { outcome: JobState; createdAt: string }): string {
  const base = `already ${prior.outcome} on ${prior.createdAt}`;
  return prior.outcome === 'done'
    ? `${base}; this file is the original from before then (moved back from the recycle folder?); run with force to process it again`
    : base;
}

const FINAL_RESULT_SQL = FINAL_RESULT_OUTCOMES.map((s) => `'${s}'`).join(',');

/**
 * The newest final result of a real (not dry-run) job for this file and workflow version. A dry
 * run never makes a file `already_processed`, whatever its outcome.
 */
export function findFinalRealResult(
  db: Database,
  fingerprint: string,
  workflowId: string,
  workflowVersion: number,
): { outcome: JobState; createdAt: string } | null {
  const r = db
    .prepare(
      `SELECT r.outcome AS outcome, r.created_at AS createdAt FROM job_results r
       JOIN jobs j ON j.id = r.job_id
       WHERE r.fingerprint = ? AND r.workflow_id = ? AND r.workflow_version = ?
         AND r.outcome IN (${FINAL_RESULT_SQL}) AND j.dry_run = 0
       ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`,
    )
    .get(fingerprint, workflowId, workflowVersion) as
    | { outcome: JobState; createdAt: string }
    | undefined;
  return r ?? null;
}

/** Outcomes that count as "already processed" for the Already processed node (not `failed`). */
const PROCESSED_SQL = ['done', 'nothing_to_do', 'kept_original'].map((s) => `'${s}'`).join(',');

/** A real job's result that the Already processed node counts as evidence. */
export interface ProcessedResult {
  jobId: string;
  workflowId: string;
  workflowVersion: number;
  outcome: 'done' | 'nothing_to_do' | 'kept_original';
  createdAt: string;
  /** How the file matched: it was the job's source, or it is the file the job wrote. */
  matched: 'source' | 'output';
  /** By what: the same file (fingerprint), or the same content (sampled hash). */
  by: 'fingerprint' | 'hash';
}

/**
 * The newest result of a real (not dry-run) job of `workflowId` (at `workflowVersion`, or any
 * version when null) that ended `done`, `nothing_to_do` or `kept_original` and whose source or
 * written output has this fingerprint (`by: 'fingerprint'`) or this sampled content hash
 * (`by: 'hash'`). `excludeJobId` leaves out the asking job itself.
 */
export function findProcessedResult(
  db: Database,
  q: {
    by: 'fingerprint' | 'hash';
    /** The `fingerprintKey`, or the content hash. */
    key: string;
    workflowId: string;
    workflowVersion: number | null;
    excludeJobId?: string;
  },
): ProcessedResult | null {
  const version = q.workflowVersion === null ? '' : 'AND r.workflow_version = @version';
  const [source, output] =
    q.by === 'fingerprint' ? ['fingerprint', 'output_fingerprint'] : ['source_hash', 'output_hash'];
  const select = (column: string, matched: string) =>
    `SELECT r.job_id AS jobId, r.workflow_id AS workflowId, r.workflow_version AS workflowVersion,
       r.outcome AS outcome, r.created_at AS createdAt, '${matched}' AS matched,
       '${q.by}' AS by, r.rowid AS rid
     FROM job_results r JOIN jobs j ON j.id = r.job_id
     WHERE r.${column} = @fp AND r.workflow_id = @workflowId ${version}
       AND r.outcome IN (${PROCESSED_SQL}) AND j.dry_run = 0 AND r.job_id <> @exclude`;
  const r = db
    .prepare(
      `SELECT jobId, workflowId, workflowVersion, outcome, createdAt, matched, by FROM (
         ${select(source, 'source')} UNION ALL ${select(output, 'output')}
       ) ORDER BY createdAt DESC, rid DESC LIMIT 1`,
    )
    .get({
      fp: q.key,
      workflowId: q.workflowId,
      exclude: q.excludeJobId ?? '',
      ...(q.workflowVersion === null ? {} : { version: q.workflowVersion }),
    }) as ProcessedResult | undefined;
  return r ?? null;
}

export function insertJobResult(db: Database, r: JobResultRow): void {
  db.prepare(
    `INSERT INTO job_results (job_id, fingerprint, workflow_id, workflow_version, outcome, before_bytes,
       after_bytes, estimated_bytes, command, plan, replaced_to, log_path, warnings, problems_json, output_probe,
       source_damaged, output_fingerprint, source_hash, output_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.jobId,
    r.fingerprint,
    r.workflowId,
    r.workflowVersion,
    r.outcome,
    r.beforeBytes,
    r.afterBytes,
    r.estimatedBytes,
    r.command,
    toJson(r.plan),
    r.replacedTo,
    r.logPath,
    JSON.stringify(r.warnings),
    JSON.stringify(r.problems),
    toJson(r.outputProbe),
    r.sourceDamaged ? 1 : 0,
    r.outputFingerprint ?? null,
    r.sourceHash ?? null,
    r.outputHash ?? null,
    r.createdAt,
  );
}

export function findJobResult(db: Database, jobId: string): JobResultRow | null {
  const r = db.prepare('SELECT * FROM job_results WHERE job_id = ?').get(jobId) as
    | DbResult
    | undefined;
  return r ? toResult(r) : null;
}

/** after/before of the newest `done` results of a workflow (any version), newest first. */
export function recentRatios(db: Database, workflowId: string, limit: number): number[] {
  const rows = db
    .prepare(
      `SELECT CAST(after_bytes AS REAL) / before_bytes AS ratio FROM job_results
       WHERE workflow_id = ? AND outcome = 'done' AND before_bytes > 0 AND after_bytes IS NOT NULL
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(workflowId, limit) as { ratio: number }[];
  return rows.map((r) => r.ratio);
}

// ---- trace ----

/**
 * Stores an entry at its own `seq` (the walk numbers entries in the order it makes them, across
 * attempts) and returns that seq. A seq the job already has is a programming error (throws).
 */
export function appendTrace(db: Database, jobId: string, entry: TraceEntry): number {
  db.prepare('INSERT INTO job_trace (job_id, seq, entry) VALUES (?, ?, ?)').run(
    jobId,
    entry.seq,
    JSON.stringify(entry),
  );
  return entry.seq;
}

/** The seq the job's next trace entry gets: one past the highest stored (1 for none). */
export function nextTraceSeq(db: Database, jobId: string): number {
  const { seq } = db
    .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM job_trace WHERE job_id = ?')
    .get(jobId) as { seq: number };
  return seq;
}

export function listTrace(db: Database, jobId: string): TraceEntry[] {
  const rows = db
    .prepare('SELECT entry FROM job_trace WHERE job_id = ? ORDER BY seq')
    .all(jobId) as { entry: string }[];
  return rows.map((r) => TraceEntrySchema.parse(JSON.parse(r.entry)));
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

// ---- files ----

/**
 * Inserts the file or, when the path is known, refreshes its identity (keeping its id). A null
 * `lastProbe` keeps the stored probe (a re-queue does not wipe it); a probe replaces it.
 */
export function upsertFile(
  db: Database,
  input: { libraryId: string; path: string; fingerprint: Fingerprint; lastProbe: JsonValue | null },
  now: Date,
): FileRow {
  const f = input.fingerprint;
  db.prepare(
    `INSERT INTO files (id, library_id, path, size_bytes, mtime_ms, ino, dev, fingerprint, last_probe,
       updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET library_id = excluded.library_id,
       size_bytes = excluded.size_bytes, mtime_ms = excluded.mtime_ms, ino = excluded.ino,
       dev = excluded.dev, fingerprint = excluded.fingerprint,
       last_probe = COALESCE(excluded.last_probe, files.last_probe),
       updated_at = excluded.updated_at`,
  ).run(
    crypto.randomUUID(),
    input.libraryId,
    input.path,
    f.sizeBytes,
    f.mtimeMs,
    f.ino,
    f.dev,
    fingerprintKey(f),
    toJson(input.lastProbe),
    now.toISOString(),
  );
  const r = db.prepare('SELECT * FROM files WHERE path = ?').get(input.path) as DbFile;
  return toFile(r);
}

// ---- recycled ----

/**
 * Records the original now at `row.path` in the recycle folder; returns the row it replaced, if
 * any. A row for the same path can only be stale (C5): a replace never moves an original onto a
 * taken path, so that row's original was moved back out by hand. It is replaced, not kept.
 */
export function insertRecycled(db: Database, row: RecycledRow): RecycledRow | null {
  return db.transaction(() => {
    const prior = db.prepare('SELECT * FROM recycled WHERE path = ?').get(row.path) as
      | DbRecycled
      | undefined;
    db.prepare(
      `INSERT INTO recycled (path, library_id, job_id, size_bytes, recycled_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET library_id = excluded.library_id, job_id = excluded.job_id,
         size_bytes = excluded.size_bytes, recycled_at = excluded.recycled_at`,
    ).run(row.path, row.libraryId, row.jobId, row.sizeBytes, row.recycledAt);
    return prior ? toRecycled(prior) : null;
  })();
}

/** Recycled originals, oldest first (the order retention removes them in). */
export function listRecycled(db: Database, libraryId?: string): RecycledRow[] {
  const rows = (
    libraryId === undefined
      ? db.prepare('SELECT * FROM recycled ORDER BY recycled_at, rowid').all()
      : db
          .prepare('SELECT * FROM recycled WHERE library_id = ? ORDER BY recycled_at, rowid')
          .all(libraryId)
  ) as DbRecycled[];
  return rows.map(toRecycled);
}

/** How many recycled originals there are and their total size. */
export function recycledTotals(db: Database): { files: number; bytes: number } {
  const r = db
    .prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM recycled')
    .get() as { files: number; bytes: number };
  return { files: r.files, bytes: r.bytes };
}

export function deleteRecycled(db: Database, path: string): boolean {
  return db.prepare('DELETE FROM recycled WHERE path = ?').run(path).changes > 0;
}
