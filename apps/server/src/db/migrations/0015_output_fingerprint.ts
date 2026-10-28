import type { Migration } from '../migrate.ts';

/**
 * The fingerprint (`fingerprintKey`) of the file a job wrote, at its final path: the replaced
 * original, or the move-copy destination. Already processed recognises a file as this output.
 * Purely additive; older rows and jobs that wrote nothing read null.
 */
export const outputFingerprint: Migration = {
  version: 15,
  name: '0015_output_fingerprint',
  up(db) {
    db.exec(`
ALTER TABLE job_results ADD COLUMN output_fingerprint TEXT;
CREATE INDEX job_results_output_lookup
  ON job_results(output_fingerprint, workflow_id, workflow_version)
  WHERE output_fingerprint IS NOT NULL;
`);
  },
};
