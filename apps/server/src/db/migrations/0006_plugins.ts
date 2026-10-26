import type { Migration } from '../migrate.ts';

/**
 * Installed plugins, their settings (secrets stored as `{ "$enc": … }` objects), the catalogs the
 * admin added, and the problems a finished job carries (separate from `warnings`). Purely
 * additive: every existing row survives, `job_results` only gains a defaulted column.
 */
export const plugins: Migration = {
  version: 6,
  name: '0006_plugins',
  up(db) {
    db.exec(`
CREATE TABLE plugins (
  name TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  catalog_url TEXT,
  sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  nodes_json TEXT NOT NULL,
  integration_json TEXT,
  triggers_json TEXT NOT NULL DEFAULT '[]',
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE plugin_settings (
  plugin_name TEXT PRIMARY KEY REFERENCES plugins(name) ON DELETE CASCADE,
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_test_json TEXT
);
CREATE TABLE plugin_catalogs (
  url TEXT PRIMARY KEY,
  added_at TEXT NOT NULL
);
ALTER TABLE job_results ADD COLUMN problems_json TEXT NOT NULL DEFAULT '[]';
`);
  },
};
