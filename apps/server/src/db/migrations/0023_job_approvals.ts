import type { Migration } from '../migrate.ts';

/**
 * Results waiting for a person's approval (the Approval finish step): one row per job while its
 * rendered and verified output is parked, with when it expires, its sizes, and the plan and output
 * probe the job page shows meanwhile (the job has no result row yet). Gone with the job. Purely
 * additive.
 */
export const jobApprovals: Migration = {
  version: 23,
  name: '0023_job_approvals',
  up(db) {
    db.exec(`
CREATE TABLE job_approvals (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  parked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  before_bytes INTEGER NOT NULL,
  after_bytes INTEGER NOT NULL,
  plan TEXT,
  output_probe TEXT
);
CREATE INDEX job_approvals_expires_at ON job_approvals (expires_at);
`);
  },
};
