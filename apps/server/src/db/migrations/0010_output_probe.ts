import type { Migration } from '../migrate.ts';

/**
 * Each result keeps the probe of the output its job verified (`job_results.output_probe`, JSON: the
 * job page's JobProbe, without the raw ffprobe JSON; the first builds stored the whole
 * ProbeResult): what a test-encode or a real run wrote, for the job page's before/after
 * comparison. NULL when nothing was verified and on every existing row. Purely additive.
 */
export const outputProbe: Migration = {
  version: 10,
  name: '0010_output_probe',
  up(db) {
    db.exec('ALTER TABLE job_results ADD COLUMN output_probe TEXT;');
  },
};
