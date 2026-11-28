import { basename } from 'node:path';
import {
  ACTIVE_JOB_STATES,
  JOB_STATES,
  type JobPlan,
  type JobState,
  parseFileName,
  planSummary,
  type StoredJobMedia,
} from '@transcoda/shared';
import type { Database } from '../../open.ts';
import {
  ACTIVE_SQL,
  type DbJob,
  FINAL_SQL,
  type JobRow,
  parseStringList,
  placeholders,
  toJob,
} from './rows.ts';

// The Jobs list: list rows (a job with its library, workflow and result), paging and counts.

export interface JobListRow extends Omit<JobRow, 'media'> {
  /** The stored media, or what the file name says when there is none (or it can't be read). */
  media: StoredJobMedia;
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
    /** A restore of the original is in effect (not undone). */
    restored: boolean;
  } | null;
  /** The result's problems (empty when none or no result). */
  problems: string[];
  /** Dry runs only: the estimated output size; null for a real run or a row without one. */
  estimatedBytes: number | null;
  /** Dry runs only: {@link planSummary} of the stored plan; null without one. */
  planSummary: string | null;
  /** A `dry_run` whose size gate runs after encoding (#41): its minimum saving, else null. */
  dependsOnSize: { minSavingPercent: number } | null;
  /** From a `library` run: its library's run hours apply. */
  automatic: boolean;
  /** A rendered result parked by an Approval step, waiting for a person; null otherwise. */
  approval: JobListApproval | null;
}

export interface JobListApproval {
  parkedAt: string;
  expiresAt: string;
  beforeBytes: number;
  afterBytes: number;
}

interface DbJobList extends DbJob {
  library_name: string | null;
  workflow_name: string | null;
  r_outcome: JobState | null;
  r_before_bytes: number | null;
  r_after_bytes: number | null;
  r_replaced_to: 'recycle' | 'deleted' | null;
  r_source_damaged: number | null;
  r_restored: number;
  r_problems_json: string | null;
  r_estimated_bytes: number | null;
  r_plan: string | null;
  run_source: 'manual' | 'library' | null;
  a_parked_at: string | null;
  a_expires_at: string | null;
  a_before_bytes: number | null;
  a_after_bytes: number | null;
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
  /** Only jobs whose result waits for approval. */
  awaitingApproval?: true;
  /** true: only dry runs (plan-only and test encodes); false: only real runs. */
  dryRun?: boolean;
}

/** The list's scope: what it and its counts cover (the state filter and paging do not apply). */
export interface JobListScope {
  libraryId?: string;
  runId?: string;
  /** true: only dry runs; false: only real runs. */
  dryRun?: boolean;
}

/** The scope's SQL conditions on jobs `alias` (empty alias: the bare `jobs` table). */
function scopeWhere(
  scope: JobListScope,
  alias: string,
): { where: string[]; values: (string | number)[] } {
  const col = (c: string) => (alias ? `${alias}.${c}` : c);
  const where: string[] = [];
  const values: (string | number)[] = [];
  if (scope.runId !== undefined) {
    where.push(`${col('run_id')} = ?`);
    values.push(scope.runId);
  }
  if (scope.libraryId !== undefined) {
    where.push(`${col('library_id')} = ?`);
    values.push(scope.libraryId);
  }
  if (scope.dryRun !== undefined) {
    where.push(`${col('dry_run')} = ?`);
    values.push(scope.dryRun ? 1 : 0);
  }
  return { where, values };
}

export const JOB_LIST_LIMIT = 200;

const LIST_SELECT = `SELECT j.*, l.name AS library_name, w.name AS workflow_name,
    r.outcome AS r_outcome, r.before_bytes AS r_before_bytes, r.after_bytes AS r_after_bytes,
    r.replaced_to AS r_replaced_to, r.source_damaged AS r_source_damaged,
    r.problems_json AS r_problems_json,
    r.estimated_bytes AS r_estimated_bytes, r.plan AS r_plan,
    EXISTS (SELECT 1 FROM restores x WHERE x.job_id = j.id AND x.undone_at IS NULL) AS r_restored,
    (SELECT source FROM runs WHERE runs.id = j.run_id) AS run_source,
    a.parked_at AS a_parked_at, a.expires_at AS a_expires_at,
    a.before_bytes AS a_before_bytes, a.after_bytes AS a_after_bytes
  FROM jobs j
  LEFT JOIN libraries l ON l.id = j.library_id
  LEFT JOIN workflows w ON w.id = j.workflow_id
  LEFT JOIN job_results r ON r.job_id = j.id
  LEFT JOIN job_approvals a ON a.job_id = j.id`;

const toListRow = (r: DbJobList): JobListRow => {
  // Dry runs only: the stored plan, parsed once for the summary and the size-gate outcome.
  const plan = r.dry_run !== 0 && r.r_plan !== null ? (JSON.parse(r.r_plan) as JobPlan) : null;
  const job = toJob(r);
  return {
    ...job,
    media: job.media ?? parseFileName(r.path),
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
            restored: r.r_restored === 1,
          },
    problems: r.r_problems_json === null ? [] : parseStringList(r.r_problems_json),
    estimatedBytes: r.dry_run !== 0 ? r.r_estimated_bytes : null,
    planSummary: plan ? planSummary(plan) : null,
    dependsOnSize: r.state === 'dry_run' ? (plan?.dependsOnSize ?? null) : null,
    automatic: r.run_source === 'library',
    approval:
      r.a_parked_at === null
        ? null
        : {
            parkedAt: r.a_parked_at,
            expiresAt: r.a_expires_at ?? r.a_parked_at,
            beforeBytes: r.a_before_bytes ?? 0,
            afterBytes: r.a_after_bytes ?? 0,
          },
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

/** The jobs as list rows, in the order of `ids`; unknown ids are left out. */
export function listJobListRows(db: Database, ids: readonly string[]): JobListRow[] {
  if (ids.length === 0) return [];
  const found = db
    .prepare(`${LIST_SELECT} WHERE j.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids)) as DbJobList[];
  const byId = new Map(found.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    return r ? [toListRow(r)] : [];
  });
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
/**
 * A problems_json column's problem count in SQL, matching `parseStringList`: only the text entries of
 * a valid array count, so a corrupt cell, a non-array or non-string entries count as no problems.
 */
export const problemCountSql = (col: string): string =>
  `CASE WHEN json_valid(${col}) AND json_type(${col}) = 'array'
     THEN (SELECT COUNT(*) FROM json_each(${col}) WHERE json_each.type = 'text') ELSE 0 END`;

export function listJobs(db: Database, filter: JobListFilter): JobListRow[] {
  const limit = filter.limit ?? JOB_LIST_LIMIT;
  if (limit <= 0 || filter.states?.length === 0) return [];
  const { where, values } = scopeWhere(filter, 'j');
  if (filter.states !== undefined) {
    where.push(`j.state IN (${placeholders(filter.states.length)})`);
    values.push(...filter.states);
  }
  if (filter.problems === true) where.push(`${problemCountSql('r.problems_json')} > 0`);
  if (filter.dependsOnSize === true) where.push(DEPENDS_ON_SIZE_SQL);
  if (filter.awaitingApproval === true) where.push('a.job_id IS NOT NULL');
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
export function countJobsByState(db: Database, filter: JobListScope): Record<JobState, number> {
  const counts = Object.fromEntries(JOB_STATES.map((s) => [s, 0])) as Record<JobState, number>;
  const { where, values } = scopeWhere(filter, '');
  const rows = db
    .prepare(
      `SELECT state, COUNT(*) AS n FROM jobs ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY state`,
    )
    .all(...values) as { state: JobState; n: number }[];
  for (const { state, n } of rows) counts[state] = n;
  return counts;
}

/** Jobs whose result has problems, within the list's scope (run, library); no state filter. */
export function countProblems(db: Database, filter: JobListScope): number {
  const scope = scopeWhere(filter, 'j');
  const where = [`${problemCountSql('r.problems_json')} > 0`, ...scope.where];
  const values = scope.values;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs j JOIN job_results r ON r.job_id = j.id WHERE ${where.join(' AND ')}`,
    )
    .get(...values) as { n: number };
  return row.n;
}

/** Plan-only dry runs whose outcome depends on size, within the list's scope; no state filter. */
export function countDependsOnSize(db: Database, filter: JobListScope): number {
  const scope = scopeWhere(filter, 'j');
  const where = [DEPENDS_ON_SIZE_SQL, ...scope.where];
  const values = scope.values;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs j JOIN job_results r ON r.job_id = j.id WHERE ${where.join(' AND ')}`,
    )
    .get(...values) as { n: number };
  return row.n;
}

/** Jobs whose result waits for approval, within the list's scope; no state filter. */
export function countAwaitingApproval(db: Database, filter: JobListScope): number {
  const scope = scopeWhere(filter, 'j');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs j JOIN job_approvals a ON a.job_id = j.id${
        scope.where.length > 0 ? ` WHERE ${scope.where.join(' AND ')}` : ''
      }`,
    )
    .get(...scope.values) as { n: number };
  return row.n;
}
