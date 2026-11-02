import type { Migration } from '../migrate.ts';

/**
 * `watch_folder`: the library's folder is watched for new files, which starts its catch-up scan
 * early (the timed scan still runs either way). On for every existing library. Purely additive.
 */
export const libraryWatch: Migration = {
  version: 16,
  name: '0016_library_watch',
  up(db) {
    db.exec(`
ALTER TABLE libraries ADD COLUMN watch_folder INTEGER NOT NULL DEFAULT 1 CHECK (watch_folder IN (0, 1));
`);
  },
};
