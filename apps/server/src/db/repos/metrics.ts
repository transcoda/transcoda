// Aggregates behind `/metrics` and `system.status`: counts and sums per live library, never a
// path or a job. Deleted libraries are left out of every list.
import { ACTIVE_JOB_STATES, type JobState, type Lane } from '@transcoda/shared';
import type { Database } from '../open.ts';
import { ACTIVE_RESTORE_SQL } from './jobs.ts';
import type { RunSource } from './runs.ts';

export interface MetricsTotals {
  libraries: { id: string; name: string }[];
  /** Unfinished jobs per state and lane; `paused` of them paused. */
  active: { libraryId: string; state: JobState; lane: Lane | null; jobs: number; paused: number }[];
  /** Finished jobs per final state, all time. */
  finished: { libraryId: string; outcome: JobState; jobs: number }[];
  perLibrary: {
    libraryId: string;
    /** Attempts beyond the first, over every job. */
    retries: number;
    /** Over `done` results whose original was not restored. */
    sourceBytes: number;
    outputBytes: number;
    savedBytes: number;
    /** Probed source duration of `done` and `kept_original` results. */
    mediaSeconds: number;
    recycleBytes: number;
    recycleFiles: number;
    /** Files Transcoda has seen in the library. */
    files: number;
  }[];
  runs: { libraryId: string; source: RunSource; runs: number }[];
}

const ACTIVE_SQL = ACTIVE_JOB_STATES.map((s) => `'${s}'`).join(',');
const LIVE = 'IN (SELECT id FROM libraries WHERE deleted_at IS NULL)';

export function metricsTotals(db: Database): MetricsTotals {
  const libraries = db
    .prepare('SELECT id, name FROM libraries WHERE deleted_at IS NULL ORDER BY name, id')
    .all() as MetricsTotals['libraries'];

  const active = db
    .prepare(
      `SELECT library_id AS libraryId, state, lane, COUNT(*) AS jobs, COALESCE(SUM(paused), 0) AS paused
       FROM jobs WHERE state IN (${ACTIVE_SQL}) AND library_id ${LIVE}
       GROUP BY library_id, state, lane ORDER BY library_id, state, lane`,
    )
    .all() as MetricsTotals['active'];

  const finished = db
    .prepare(
      `SELECT library_id AS libraryId, state AS outcome, COUNT(*) AS jobs
       FROM jobs WHERE state NOT IN (${ACTIVE_SQL}) AND library_id ${LIVE}
       GROUP BY library_id, state ORDER BY library_id, state`,
    )
    .all() as MetricsTotals['finished'];

  const perLibrary = db
    .prepare(
      `SELECT l.id AS libraryId,
         (SELECT COALESCE(SUM(attempt - 1), 0) FROM jobs WHERE library_id = l.id) AS retries,
         COALESCE(b.sourceBytes, 0) AS sourceBytes,
         COALESCE(b.outputBytes, 0) AS outputBytes,
         COALESCE(b.savedBytes, 0) AS savedBytes,
         COALESCE(b.mediaSeconds, 0) AS mediaSeconds,
         (SELECT COALESCE(SUM(size_bytes), 0) FROM recycled WHERE library_id = l.id) AS recycleBytes,
         (SELECT COUNT(*) FROM recycled WHERE library_id = l.id) AS recycleFiles,
         (SELECT COUNT(*) FROM files WHERE library_id = l.id) AS files
       FROM libraries l
       LEFT JOIN (
         SELECT j.library_id AS libraryId,
           SUM(CASE WHEN r.outcome = 'done' AND NOT EXISTS (${ACTIVE_RESTORE_SQL('r')})
             THEN COALESCE(r.before_bytes, 0) ELSE 0 END) AS sourceBytes,
           SUM(CASE WHEN r.outcome = 'done' AND NOT EXISTS (${ACTIVE_RESTORE_SQL('r')})
             THEN COALESCE(r.after_bytes, 0) ELSE 0 END) AS outputBytes,
           SUM(CASE WHEN r.outcome = 'done' AND NOT EXISTS (${ACTIVE_RESTORE_SQL('r')})
             THEN COALESCE(r.before_bytes, 0) - COALESCE(r.after_bytes, 0) ELSE 0 END) AS savedBytes,
           SUM(CASE WHEN r.outcome IN ('done', 'kept_original')
             THEN COALESCE(json_extract(j.probe, '$.durationSeconds'), 0) ELSE 0 END) AS mediaSeconds
         FROM job_results r JOIN jobs j ON j.id = r.job_id
         GROUP BY j.library_id
       ) b ON b.libraryId = l.id
       WHERE l.deleted_at IS NULL ORDER BY l.name, l.id`,
    )
    .all() as MetricsTotals['perLibrary'];

  const runs = db
    .prepare(
      `SELECT library_id AS libraryId, source, COUNT(*) AS runs FROM runs
       WHERE library_id ${LIVE} GROUP BY library_id, source ORDER BY library_id, source`,
    )
    .all() as MetricsTotals['runs'];

  return { libraries, active, finished, perLibrary, runs };
}
