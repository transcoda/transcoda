import type { Migration } from '../migrate.ts';

/**
 * What Already processed recognises a file by, besides the source fingerprint:
 * - `output_fingerprint`: the `fingerprintKey` of the file a job wrote, at its final path (the
 *   replaced original, or the move-copy destination);
 * - `source_hash` / `output_hash`: the sampled content hash (engine/content-hash.ts) of the source
 *   when the job started and of the written file, which match an identical copy at any path.
 * Purely additive; older rows and jobs that wrote nothing read null.
 */
export const outputFingerprint: Migration = {
  version: 15,
  name: '0015_output_fingerprint',
  up(db) {
    db.exec(`
ALTER TABLE job_results ADD COLUMN output_fingerprint TEXT;
ALTER TABLE job_results ADD COLUMN source_hash TEXT;
ALTER TABLE job_results ADD COLUMN output_hash TEXT;
CREATE INDEX job_results_output_lookup
  ON job_results(output_fingerprint, workflow_id, workflow_version)
  WHERE output_fingerprint IS NOT NULL;
CREATE INDEX job_results_source_hash_lookup
  ON job_results(source_hash, workflow_id, workflow_version)
  WHERE source_hash IS NOT NULL;
CREATE INDEX job_results_output_hash_lookup
  ON job_results(output_hash, workflow_id, workflow_version)
  WHERE output_hash IS NOT NULL;
`);
  },
};
