import type { Migration } from '../migrate.ts';

/**
 * GPU fields on jobs: the label of the slot that ran the encode (NULL until one did) and the GPU
 * ids the encode already failed on (a JSON array, empty at the start). Purely additive, no backfill.
 */
export const gpuFields: Migration = {
  version: 13,
  name: '0013_gpu_fields',
  up(db) {
    db.exec(`
ALTER TABLE jobs ADD COLUMN encoded_on TEXT;
ALTER TABLE jobs ADD COLUMN failed_gpus TEXT NOT NULL DEFAULT '[]';
`);
  },
};
