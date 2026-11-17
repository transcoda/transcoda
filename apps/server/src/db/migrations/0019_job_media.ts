import type { Migration } from '../migrate.ts';

/**
 * The job's media info (`StoredJobMedia` as JSON: title, year, episode, poster path), read from
 * the file's sidecar files or its name when the job is queued. Purely additive; older rows read
 * NULL and the list falls back to parsing the file name.
 */
export const jobMedia: Migration = {
  version: 19,
  name: '0019_job_media',
  up(db) {
    db.exec('ALTER TABLE jobs ADD COLUMN media TEXT;');
  },
};
