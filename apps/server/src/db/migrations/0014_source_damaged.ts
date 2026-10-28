import type { Migration } from '../migrate.ts';

/**
 * Results of jobs that kept the original because the source is damaged (decode errors the source
 * reproduces): the UI shows them as "Damaged source". Purely additive; older rows read false.
 */
export const sourceDamaged: Migration = {
  version: 14,
  name: '0014_source_damaged',
  up(db) {
    db.exec('ALTER TABLE job_results ADD COLUMN source_damaged INTEGER NOT NULL DEFAULT 0;');
  },
};
