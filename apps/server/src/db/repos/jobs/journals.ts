import type { Database } from '../../open.ts';
import { type DbJob, type JobRow, type RestoreJournal, toJob, toJson } from './rows.ts';

// The replace and restore journals on a job row: one file operation per job at a time.

/** Jobs with a replace journal (any state): what the startup sweep settles. */
export function jobsWithReplaceJournal(db: Database): JobRow[] {
  const rows = db
    .prepare('SELECT * FROM jobs WHERE replace_journal IS NOT NULL ORDER BY rowid')
    .all() as DbJob[];
  return rows.map(toJob);
}

/** Jobs with a restore journal (any state): what the startup sweep rolls back. */
export function jobsWithRestoreJournal(db: Database): JobRow[] {
  const rows = db
    .prepare('SELECT * FROM jobs WHERE restore_journal IS NOT NULL ORDER BY rowid')
    .all() as DbJob[];
  return rows.map(toJob);
}

/**
 * Starts a restore: sets the job's restore journal only when neither journal is set (one file
 * operation per job at a time). False when another one holds the job.
 */
export function claimRestoreJournal(db: Database, jobId: string, journal: RestoreJournal): boolean {
  return (
    db
      .prepare(
        `UPDATE jobs SET restore_journal = ? WHERE id = ?
         AND restore_journal IS NULL AND replace_journal IS NULL`,
      )
      .run(toJson(journal), jobId).changes > 0
  );
}

/** True while the job has either journal (a replace or a restore in flight or awaiting the sweep). */
export function hasFileJournal(db: Database, jobId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM jobs WHERE id = ?
         AND (replace_journal IS NOT NULL OR restore_journal IS NOT NULL)`,
      )
      .get(jobId) !== undefined
  );
}

/** True while the job has a replace journal (a replace in flight or awaiting the sweep). */
export function hasReplaceJournal(db: Database, jobId: string): boolean {
  return (
    db.prepare('SELECT 1 FROM jobs WHERE id = ? AND replace_journal IS NOT NULL').get(jobId) !==
    undefined
  );
}
