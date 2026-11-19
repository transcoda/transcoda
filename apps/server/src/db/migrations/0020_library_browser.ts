import type { Migration } from '../migrate.ts';

/**
 * The library browser: `files.gone_at` (set by a folder listing that no longer finds the file,
 * cleared when it is seen again) and the indexes its lists read. Purely additive; older rows read
 * NULL, meaning present.
 */
export const libraryBrowser: Migration = {
  version: 20,
  name: '0020_library_browser',
  up(db) {
    db.exec(`
      ALTER TABLE files ADD COLUMN gone_at TEXT;
      CREATE INDEX jobs_file_queued ON jobs(file_id, queued_at);
      CREATE INDEX files_library_gone ON files(library_id, gone_at);
    `);
  },
};
