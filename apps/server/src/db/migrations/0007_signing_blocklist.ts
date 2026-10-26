import type { Migration } from '../migrate.ts';

/**
 * Signing: the id of the key that verified an installed bundle (NULL: installed unsigned) and the
 * signing keys a custom catalog was added with, `<id>:<hex>[,...]` verbatim (NULL: unsigned).
 * Purely additive.
 */
export const signingBlocklist: Migration = {
  version: 7,
  name: '0007_signing_blocklist',
  up(db) {
    db.exec(`
ALTER TABLE plugins ADD COLUMN signed_by TEXT;
ALTER TABLE plugin_catalogs ADD COLUMN signing_keys TEXT;
`);
  },
};
