import { ACTIVE_JOB_STATES, type JobState, RUN_OUTCOME_KEYS } from '@transcoda/shared';
import type { Database } from '../open.ts';
import { DEPENDS_ON_SIZE_SQL } from './jobs.ts';

export interface RunRow {
  id: string;
  libraryId: string;
  workflowId: string;
  workflowVersion: number;
  requestedPath: string;
  dryRun: boolean;
  /** Dry runs only: every job encodes, verifies and measures for real, then stops before the first write. */
  testEncode: boolean;
  force: boolean;
  createdBy: string;
  /** `library`: the library's feeder chose the workflow (its run hours apply); else `manual`. */
  source: RunSource;
  note: string | null;
  createdAt: string;
}

export type RunSource = 'manual' | 'library';

export type RunCounts = Record<(typeof RUN_OUTCOME_KEYS)[number], number> & {
  total: number;
  beforeBytes: number;
  afterBytes: number;
  /** The part of `dry_run` whose size gate decides after encoding (#41). */
  dependsOnSize: number;
};

interface DbRun {
  id: string;
  library_id: string;
  workflow_id: string;
  workflow_version: number;
  requested_path: string;
  dry_run: number;
  test_encode: number;
  force: number;
  created_by: string;
  source: RunSource;
  note: string | null;
  created_at: string;
}

const toRun = (r: DbRun): RunRow => ({
  id: r.id,
  libraryId: r.library_id,
  workflowId: r.workflow_id,
  workflowVersion: r.workflow_version,
  requestedPath: r.requested_path,
  dryRun: r.dry_run !== 0,
  testEncode: r.test_encode !== 0,
  force: r.force !== 0,
  createdBy: r.created_by,
  source: r.source,
  note: r.note,
  createdAt: r.created_at,
});

export function insertRun(
  db: Database,
  input: Omit<RunRow, 'createdAt' | 'note' | 'source'> & {
    note?: string | null;
    /** Default `manual`. */
    source?: RunSource;
  },
  now: Date,
): RunRow {
  const createdAt = now.toISOString();
  const source = input.source ?? 'manual';
  db.prepare(
    `INSERT INTO runs (id, library_id, workflow_id, workflow_version, requested_path, dry_run, test_encode,
       force, created_by, source, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.libraryId,
    input.workflowId,
    input.workflowVersion,
    input.requestedPath,
    input.dryRun ? 1 : 0,
    input.testEncode ? 1 : 0,
    input.force ? 1 : 0,
    input.createdBy,
    source,
    input.note ?? null,
    createdAt,
  );
  return { ...input, source, note: input.note ?? null, createdAt };
}

export function findRun(db: Database, id: string): RunRow | null {
  const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as DbRun | undefined;
  return r ? toRun(r) : null;
}

/** Newest first. */
export function listRuns(db: Database, opts: { limit: number }): RunRow[] {
  const rows = db
    .prepare('SELECT * FROM runs ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(opts.limit) as DbRun[];
  return rows.map(toRun);
}

/**
 * Jobs of a run per outcome; a queued job counts as `queued` and every other active state as
 * `in_progress`, so the keys sum to `total`. Bytes are summed over the results of `done` jobs.
 */
export function runCounts(db: Database, runId: string): RunCounts {
  const counts = Object.fromEntries(RUN_OUTCOME_KEYS.map((k) => [k, 0])) as RunCounts;
  counts.total = 0;
  const rows = db
    .prepare('SELECT state, COUNT(*) AS n FROM jobs WHERE run_id = ? GROUP BY state')
    .all(runId) as { state: JobState; n: number }[];
  for (const { state, n } of rows) {
    // Every final state is a RUN_OUTCOME_KEYS key.
    const key =
      state === 'queued'
        ? 'queued'
        : ACTIVE_JOB_STATES.includes(state)
          ? 'in_progress'
          : (state as (typeof RUN_OUTCOME_KEYS)[number]);
    counts[key] += n;
    counts.total += n;
  }
  const bytes = db
    .prepare(
      `SELECT COALESCE(SUM(r.before_bytes), 0) AS beforeBytes, COALESCE(SUM(r.after_bytes), 0) AS afterBytes
       FROM jobs j JOIN job_results r ON r.job_id = j.id
       WHERE j.run_id = ? AND j.state = 'done' AND r.outcome = 'done'`,
    )
    .get(runId) as { beforeBytes: number; afterBytes: number };
  counts.beforeBytes = bytes.beforeBytes;
  counts.afterBytes = bytes.afterBytes;
  counts.dependsOnSize = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs j JOIN job_results r ON r.job_id = j.id
         WHERE j.run_id = ? AND ${DEPENDS_ON_SIZE_SQL}`,
      )
      .get(runId) as { n: number }
  ).n;
  return counts;
}
