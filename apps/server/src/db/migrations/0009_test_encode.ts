import type { Migration } from '../migrate.ts';

/**
 * Test-encode dry runs: the flag on runs and jobs (0 on every existing row), a note on why a
 * job's test output was not kept or was removed early, and the kept test outputs (one per job, gone
 * with it). Purely additive.
 */
export const testEncode: Migration = {
  version: 9,
  name: '0009_test_encode',
  up(db) {
    db.exec(`
ALTER TABLE runs ADD COLUMN test_encode INTEGER NOT NULL DEFAULT 0 CHECK (test_encode IN (0, 1));
ALTER TABLE jobs ADD COLUMN test_encode INTEGER NOT NULL DEFAULT 0 CHECK (test_encode IN (0, 1));
ALTER TABLE jobs ADD COLUMN test_output_note TEXT;
CREATE TABLE test_outputs (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  container TEXT NOT NULL CHECK (container IN ('mkv', 'mp4')),
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  kept_until TEXT NOT NULL
);
CREATE INDEX test_outputs_kept_until ON test_outputs (kept_until);
`);
  },
};
