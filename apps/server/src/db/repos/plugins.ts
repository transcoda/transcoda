import type { NodeMetadata } from '@transcoda/sdk';
import type { HostReady, JsonValue, PluginManifest } from '@transcoda/shared';
import type { Database } from '../open.ts';

export type TriggerMetadata = HostReady['triggers'][number];

export interface PluginIntegration {
  settingsSchema: JsonValue;
  allowedOrigins: string[];
  /** Rows written before the host reported them have neither. */
  id?: string | undefined;
  title?: string | undefined;
  requires?: { product: string; minVersion: string } | null | undefined;
}

export interface PluginRow {
  name: string;
  version: string;
  enabled: boolean;
  catalogUrl: string | null;
  sha256: string;
  manifest: PluginManifest;
  nodes: NodeMetadata[];
  integration: PluginIntegration | null;
  triggers: TriggerMetadata[];
  /** Id of the key that verified the bundle at install; null: installed unsigned. */
  signedBy: string | null;
  installedAt: string;
  updatedAt: string;
}

export interface PluginLastTest {
  ok: boolean;
  /** Why a failed test failed; absent on rows written before it was kept. */
  kind?: 'unreachable' | 'unauthorized' | 'wrong-product' | 'too-old' | 'other' | undefined;
  message: string;
  at: string;
  version?: string;
  warnings?: string[];
}

export interface PluginSettingsRow {
  pluginName: string;
  /** As stored: secrets are `{ $enc }` objects. */
  settings: JsonValue;
  updatedAt: string;
  lastTest: PluginLastTest | null;
}

interface DbPlugin {
  name: string;
  version: string;
  enabled: number;
  catalog_url: string | null;
  sha256: string;
  manifest_json: string;
  nodes_json: string;
  integration_json: string | null;
  triggers_json: string;
  signed_by: string | null;
  installed_at: string;
  updated_at: string;
}

interface DbPluginSettings {
  plugin_name: string;
  settings_json: string;
  updated_at: string;
  last_test_json: string | null;
}

const toPlugin = (r: DbPlugin): PluginRow => ({
  name: r.name,
  version: r.version,
  enabled: r.enabled !== 0,
  catalogUrl: r.catalog_url,
  sha256: r.sha256,
  manifest: JSON.parse(r.manifest_json) as PluginManifest,
  nodes: JSON.parse(r.nodes_json) as NodeMetadata[],
  integration:
    r.integration_json === null ? null : (JSON.parse(r.integration_json) as PluginIntegration),
  triggers: JSON.parse(r.triggers_json) as TriggerMetadata[],
  signedBy: r.signed_by,
  installedAt: r.installed_at,
  updatedAt: r.updated_at,
});

export type PluginInsert = Omit<PluginRow, 'installedAt' | 'updatedAt'>;
export type PluginPatch = Partial<
  Pick<
    PluginRow,
    | 'version'
    | 'enabled'
    | 'catalogUrl'
    | 'sha256'
    | 'manifest'
    | 'nodes'
    | 'integration'
    | 'triggers'
    | 'signedBy'
  >
>;

export function insertPlugin(db: Database, row: PluginInsert, now: Date): PluginRow {
  const ts = now.toISOString();
  db.prepare(
    `INSERT INTO plugins (name, version, enabled, catalog_url, sha256, manifest_json, nodes_json,
       integration_json, triggers_json, signed_by, installed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.name,
    row.version,
    row.enabled ? 1 : 0,
    row.catalogUrl,
    row.sha256,
    JSON.stringify(row.manifest),
    JSON.stringify(row.nodes),
    row.integration === null ? null : JSON.stringify(row.integration),
    JSON.stringify(row.triggers),
    row.signedBy,
    ts,
    ts,
  );
  const found = findPlugin(db, row.name);
  if (!found) throw new Error(`plugin ${row.name} vanished after insert`);
  return found;
}

export function findPlugin(db: Database, name: string): PluginRow | null {
  const r = db.prepare('SELECT * FROM plugins WHERE name = ?').get(name) as DbPlugin | undefined;
  return r ? toPlugin(r) : null;
}

/** All plugins by name. */
export function listPlugins(db: Database): PluginRow[] {
  return (db.prepare('SELECT * FROM plugins ORDER BY name').all() as DbPlugin[]).map(toPlugin);
}

const PATCH_COLUMNS: Record<keyof PluginPatch, [string, (v: never) => unknown]> = {
  version: ['version', (v: string) => v],
  enabled: ['enabled', (v: boolean) => (v ? 1 : 0)],
  catalogUrl: ['catalog_url', (v: string | null) => v],
  sha256: ['sha256', (v: string) => v],
  manifest: ['manifest_json', (v: PluginManifest) => JSON.stringify(v)],
  nodes: ['nodes_json', (v: NodeMetadata[]) => JSON.stringify(v)],
  integration: [
    'integration_json',
    (v: PluginIntegration | null) => (v === null ? null : JSON.stringify(v)),
  ],
  triggers: ['triggers_json', (v: TriggerMetadata[]) => JSON.stringify(v)],
  signedBy: ['signed_by', (v: string | null) => v],
};

export function updatePlugin(
  db: Database,
  name: string,
  patch: PluginPatch,
  now: Date,
): PluginRow | null {
  const sets = ['updated_at = ?'];
  const values: unknown[] = [now.toISOString()];
  for (const key of Object.keys(PATCH_COLUMNS) as (keyof PluginPatch)[]) {
    if (patch[key] === undefined) continue;
    const [column, encode] = PATCH_COLUMNS[key];
    sets.push(`${column} = ?`);
    values.push((encode as (v: unknown) => unknown)(patch[key]));
  }
  const info = db
    .prepare(`UPDATE plugins SET ${sets.join(', ')} WHERE name = ?`)
    .run(...values, name);
  return info.changes === 0 ? null : findPlugin(db, name);
}

/** Boots in a row that started `name` and then died (the crash-loop guard); 0 when none. */
export function startAttempts(db: Database, name: string): number {
  const row = db
    .prepare('SELECT attempts FROM plugin_start_attempts WHERE plugin_name = ?')
    .get(name) as { attempts: number } | undefined;
  return row?.attempts ?? 0;
}

export function setStartAttempts(db: Database, name: string, attempts: number): void {
  if (attempts <= 0) {
    db.prepare('DELETE FROM plugin_start_attempts WHERE plugin_name = ?').run(name);
    return;
  }
  db.prepare(
    `INSERT INTO plugin_start_attempts (plugin_name, attempts) VALUES (?, ?)
     ON CONFLICT(plugin_name) DO UPDATE SET attempts = excluded.attempts`,
  ).run(name, attempts);
}

/** The server got past the stable mark, or stopped cleanly: no plugin is to blame for anything. */
export function clearStartAttempts(db: Database): void {
  db.prepare('DELETE FROM plugin_start_attempts').run();
}

/** Deletes the plugin; its settings row goes with it (ON DELETE CASCADE). */
export function deletePlugin(db: Database, name: string): boolean {
  return db.prepare('DELETE FROM plugins WHERE name = ?').run(name).changes > 0;
}

// ---- settings ----

const toSettings = (r: DbPluginSettings): PluginSettingsRow => ({
  pluginName: r.plugin_name,
  settings: JSON.parse(r.settings_json) as JsonValue,
  updatedAt: r.updated_at,
  lastTest: r.last_test_json === null ? null : (JSON.parse(r.last_test_json) as PluginLastTest),
});

/** Stores the sealed settings; a stored last test result is kept. */
export function upsertPluginSettings(
  db: Database,
  name: string,
  settings: JsonValue,
  now: Date,
): void {
  db.prepare(
    `INSERT INTO plugin_settings (plugin_name, settings_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(plugin_name) DO UPDATE SET settings_json = excluded.settings_json,
       updated_at = excluded.updated_at`,
  ).run(name, JSON.stringify(settings), now.toISOString());
}

export function findPluginSettings(db: Database, name: string): PluginSettingsRow | null {
  const r = db.prepare('SELECT * FROM plugin_settings WHERE plugin_name = ?').get(name) as
    | DbPluginSettings
    | undefined;
  return r ? toSettings(r) : null;
}

/**
 * Records the last connection test; false when the plugin has no settings row. A test is not a
 * settings change, so `updated_at` stays (`_now` is kept for call-site symmetry).
 */
export function setLastTest(
  db: Database,
  name: string,
  lastTest: PluginLastTest,
  _now: Date,
): boolean {
  return (
    db
      .prepare('UPDATE plugin_settings SET last_test_json = ? WHERE plugin_name = ?')
      .run(JSON.stringify(lastTest), name).changes > 0
  );
}

// ---- catalogs ----

export function listCatalogs(db: Database): Array<{ url: string; signingKeys: string | null }> {
  return (
    db.prepare('SELECT url, signing_keys FROM plugin_catalogs ORDER BY added_at, rowid').all() as {
      url: string;
      signing_keys: string | null;
    }[]
  ).map((r) => ({ url: r.url, signingKeys: r.signing_keys }));
}

/** Adds a catalog; adding a known URL keeps its row and its keys unless new keys are given (unpin: remove, then add). */
export function addCatalog(db: Database, url: string, signingKeys: string | null, now: Date): void {
  db.prepare(
    `INSERT INTO plugin_catalogs (url, added_at, signing_keys) VALUES (?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET signing_keys = COALESCE(excluded.signing_keys, signing_keys)`,
  ).run(url, now.toISOString(), signingKeys);
}

export function removeCatalog(db: Database, url: string): boolean {
  return db.prepare('DELETE FROM plugin_catalogs WHERE url = ?').run(url).changes > 0;
}
