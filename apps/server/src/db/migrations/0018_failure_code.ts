import type { Migration } from '../migrate.ts';

/**
 * Why a failed job failed, as a code (`FAILURE_CODES`): the metrics count failures by it, the job's
 * `reason` stays the sentence the UI shows. Purely additive; older rows read NULL ("unknown").
 */
export const failureCode: Migration = {
  version: 18,
  name: '0018_failure_code',
  up(db) {
    db.exec('ALTER TABLE jobs ADD COLUMN failure_code TEXT;');
  },
};
