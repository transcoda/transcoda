import { RUNNING_JOB_STATES } from '@transcoda/shared';
import type { Database } from '../../open.ts';
import { countJobsByState, problemCountSql } from './list.ts';

// Totals over job results: the dashboard numbers and the Jobs page history.

/** A restore still in effect for the result row `alias`: its file is the original again, so it saved nothing. */
export const ACTIVE_RESTORE_SQL = (alias: string): string =>
  `SELECT 1 FROM restores x WHERE x.job_id = ${alias}.job_id AND x.undone_at IS NULL`;

/**
 * Dashboard numbers: `files` (done results), `savedBytes` (before − after of those, unless restored) over results
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
         COALESCE(SUM(CASE WHEN outcome = 'done' AND NOT EXISTS (${ACTIVE_RESTORE_SQL('job_results')})
           THEN COALESCE(before_bytes, 0) - COALESCE(after_bytes, 0) ELSE 0 END), 0) AS savedBytes,
         (SELECT COUNT(*) FROM jobs WHERE state = 'failed' AND finished_at >= ?) AS failed,
         COALESCE(SUM(${problemCountSql('problems_json')} > 0), 0) AS problems
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
       COALESCE(SUM(CASE WHEN r.outcome = 'done' AND NOT EXISTS (${ACTIVE_RESTORE_SQL('r')})
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
         COALESCE(SUM(CASE WHEN outcome = 'done' AND NOT EXISTS (${ACTIVE_RESTORE_SQL('job_results')})
           THEN COALESCE(before_bytes, 0) - COALESCE(after_bytes, 0) ELSE 0 END), 0) AS savedBytes,
         COALESCE(SUM(outcome = 'done'), 0) AS files,
         MIN(created_at) AS since
       FROM job_results`,
    )
    .get() as { savedBytes: number; files: number; since: string | null };
}
