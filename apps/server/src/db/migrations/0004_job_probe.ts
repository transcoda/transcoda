import type { Migration } from '../migrate.ts';

/**
 * Each job keeps the probe it was planned from (`jobs.probe`, JSON). `files.last_probe` follows the
 * file, so after a replace an older job's plan would be read against the new file's streams.
 */
export const jobProbe: Migration = {
  version: 4,
  name: '0004_job_probe',
  up(db) {
    db.exec('ALTER TABLE jobs ADD COLUMN probe TEXT;');
  },
};
