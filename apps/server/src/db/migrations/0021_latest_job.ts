import type { Migration } from '../migrate.ts';

/**
 * The job states that never count as a file's latest job while a real job that is not one of
 * them exists (a dry run never does either). Shared by the backfill and the triggers.
 */
const NOT_COUNTED = "'skipped','already_processed','cancelled'";

/**
 * The latest job of the file whose id is `fileId` (an SQL expression): the newest (queued_at,
 * then rowid) real job that is not skipped, already_processed or cancelled, else the newest job of
 * any kind; NULL when the file has none. The rule the library listing ranked jobs by before 21.
 */
export const latestJobOfSql = (fileId: string): string =>
  `(SELECT j.id FROM jobs j WHERE j.file_id = ${fileId}
    ORDER BY (j.dry_run = 0 AND j.state NOT IN (${NOT_COUNTED})) DESC, j.queued_at DESC, j.rowid DESC
    LIMIT 1)`;

/**
 * `files.latest_job_id`: each file's latest job ({@link latestJobOfSql}), stored so the library
 * lists join on it instead of ranking every job of the library. Backfilled for every file.
 *
 * Triggers on `jobs` keep it current on every write that can change which job is latest, by
 * whatever path it comes (the repos, the engine, raw SQL): a job inserted, deleted, moved to
 * another file, or changing `dry_run`, `queued_at` or whether its state counts. They recompute the
 * file's latest job from its jobs (through `jobs_file_queued`) instead of comparing with the stored
 * one, so out-of-order inserts and deletes come out the same as the query. A later migration that
 * rebuilds `jobs` or `files` must create them again (0021's test checks they exist after all
 * migrations).
 */
export const latestJob: Migration = {
  version: 21,
  name: '0021_latest_job',
  up(db) {
    db.exec(`
      ALTER TABLE files ADD COLUMN latest_job_id TEXT;
      UPDATE files SET latest_job_id = ${latestJobOfSql('files.id')};

      CREATE TRIGGER jobs_latest_insert AFTER INSERT ON jobs
      WHEN NEW.file_id IS NOT NULL
      BEGIN
        UPDATE files SET latest_job_id = ${latestJobOfSql('files.id')} WHERE id = NEW.file_id;
      END;

      CREATE TRIGGER jobs_latest_delete AFTER DELETE ON jobs
      WHEN OLD.file_id IS NOT NULL
      BEGIN
        UPDATE files SET latest_job_id = ${latestJobOfSql('files.id')} WHERE id = OLD.file_id;
      END;

      CREATE TRIGGER jobs_latest_update AFTER UPDATE OF file_id, dry_run, queued_at, state ON jobs
      WHEN OLD.file_id IS NOT NEW.file_id
        OR OLD.dry_run IS NOT NEW.dry_run
        OR OLD.queued_at IS NOT NEW.queued_at
        OR (OLD.state IN (${NOT_COUNTED})) IS NOT (NEW.state IN (${NOT_COUNTED}))
      BEGIN
        UPDATE files SET latest_job_id = ${latestJobOfSql('files.id')}
        WHERE id IN (OLD.file_id, NEW.file_id);
      END;
    `);
  },
};
