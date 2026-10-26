import type { Migration } from '../migrate.ts';

/**
 * The crash-loop guard: how many boots in a row started a plugin and then died (no clean stop, never
 * reached the stable mark). Purely additive; a missing row means none.
 */
export const pluginStartAttempts: Migration = {
  version: 12,
  name: '0012_plugin_start_attempts',
  up(db) {
    db.exec(`
CREATE TABLE plugin_start_attempts (
  plugin_name TEXT PRIMARY KEY REFERENCES plugins(name) ON DELETE CASCADE,
  attempts INTEGER NOT NULL
);
`);
  },
};
