import { basename, dirname, join } from 'node:path';
import type { Migration } from '../migrate.ts';

/**
 * Restore original. `recycled` learns what each entry is (`kind`): a job's replaced `original`, a
 * `sidecar` it recycled after the replace, or Transcoda's output moved there by a restore
 * (`restored-output`); where it came from (`original_path`); and which restore put it there
 * (`restore_id`). `jobs.restore_journal` is a restore in flight, like `replace_journal`;
 * `restores` records each restore and its undo, one active restore per job.
 *
 * Existing rows are filled in from their job's path: the job's own file name, or that name with a
 * recycle suffix `.N`, is the original; anything else is a sidecar that sat beside it.
 */
export const restore: Migration = {
  version: 17,
  name: '0017_restore',
  up(db) {
    db.exec(`
ALTER TABLE recycled ADD COLUMN kind TEXT NOT NULL DEFAULT 'original'
  CHECK (kind IN ('original', 'sidecar', 'restored-output'));
ALTER TABLE recycled ADD COLUMN original_path TEXT;
ALTER TABLE recycled ADD COLUMN restore_id TEXT;
CREATE INDEX recycled_job ON recycled(job_id);
ALTER TABLE jobs ADD COLUMN restore_journal TEXT;
CREATE TABLE restores (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  restored_at TEXT NOT NULL,
  restored_by TEXT NOT NULL,
  sidecar_paths TEXT NOT NULL DEFAULT '[]',
  undone_at TEXT,
  undone_by TEXT
);
CREATE UNIQUE INDEX restores_active ON restores(job_id) WHERE undone_at IS NULL;
`);
    const rows = db
      .prepare(
        `SELECT r.path AS path, j.path AS jobPath FROM recycled r
         LEFT JOIN jobs j ON j.id = r.job_id`,
      )
      .all() as { path: string; jobPath: string | null }[];
    const set = db.prepare('UPDATE recycled SET kind = ?, original_path = ? WHERE path = ?');
    for (const { path, jobPath } of rows) {
      if (jobPath === null) continue;
      const name = basename(path);
      const own = basename(jobPath);
      const isOriginal =
        name === own ||
        (name.startsWith(`${own}.`) && /^[1-9]\d*$/.test(name.slice(own.length + 1)));
      if (isOriginal) set.run('original', jobPath, path);
      else set.run('sidecar', join(dirname(jobPath), name.replace(/\.[1-9]\d*$/, '')), path);
    }
  },
};
