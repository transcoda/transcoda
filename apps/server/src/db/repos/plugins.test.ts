import type { PluginManifest } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrations } from '../migrations/index.ts';
import type { Database } from '../open.ts';
import { createTestDb } from '../test-db.ts';
import { insertJob, insertJobResult, type JobResultRow, listJobs } from './jobs.ts';
import {
  addCatalog,
  deletePlugin,
  findPlugin,
  findPluginSettings,
  insertPlugin,
  listCatalogs,
  listPlugins,
  type PluginInsert,
  removeCatalog,
  setLastTest,
  updatePlugin,
  upsertPluginSettings,
} from './plugins.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const later = new Date('2026-01-02T00:00:00.000Z');

const manifest = (name: string): PluginManifest => ({
  name,
  version: '1.0.0',
  sdk: '^1',
  nodes: ['hello'],
  integration: null,
  triggers: [],
  hooks: [],
});

function plugin(name: string, extra: Partial<PluginInsert> = {}): PluginInsert {
  return {
    name,
    version: '1.0.0',
    enabled: true,
    catalogUrl: 'file:///catalog.json',
    sha256: 'ab'.repeat(32),
    manifest: manifest(name),
    nodes: [
      {
        type: `${name}:hello`,
        title: 'Hello',
        description: 'Says hello',
        icon: 'hand',
        settings: { type: 'object' },
        inputs: [],
        outputs: [],
      } as unknown as PluginInsert['nodes'][number],
    ],
    integration: {
      settingsSchema: { type: 'object' },
      allowedOrigins: ['https://api.example.com'],
    },
    triggers: [],
    signedBy: null,
    ...extra,
  };
}

let db: Database;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  db.close();
});

describe('migration 0006', () => {
  it('is the last migration and creates the tables', () => {
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({
      n: migrations.length,
    });
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['plugins', 'plugin_settings', 'plugin_catalogs']),
    );
  });
});

describe('plugins repo', () => {
  it('round-trips manifest, nodes and integration JSON', () => {
    const row = insertPlugin(db, plugin('example'), now);
    expect(row).toMatchObject({
      name: 'example',
      enabled: true,
      installedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    expect(findPlugin(db, 'example')).toEqual(row);
    expect(row.manifest).toEqual(manifest('example'));
    expect(row.integration?.allowedOrigins).toEqual(['https://api.example.com']);
    expect(findPlugin(db, 'nope')).toBeNull();
  });

  it('stores a null integration and lists by name', () => {
    insertPlugin(db, plugin('zeta', { integration: null }), now);
    insertPlugin(db, plugin('alpha'), now);
    expect(listPlugins(db).map((p) => p.name)).toEqual(['alpha', 'zeta']);
    expect(findPlugin(db, 'zeta')?.integration).toBeNull();
  });

  it('updates only the patched fields and stamps updatedAt', () => {
    insertPlugin(db, plugin('example'), now);
    const up = updatePlugin(
      db,
      'example',
      { enabled: false, version: '1.1.0', integration: null },
      later,
    );
    expect(up).toMatchObject({
      enabled: false,
      version: '1.1.0',
      integration: null,
      sha256: 'ab'.repeat(32),
      installedAt: now.toISOString(),
      updatedAt: later.toISOString(),
    });
    expect(updatePlugin(db, 'nope', { enabled: false }, later)).toBeNull();
  });

  it('deletePlugin cascades its settings', () => {
    insertPlugin(db, plugin('example'), now);
    upsertPluginSettings(db, 'example', { url: 'x' }, now);
    expect(deletePlugin(db, 'example')).toBe(true);
    expect(findPluginSettings(db, 'example')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM plugin_settings').get()).toEqual({ n: 0 });
    expect(deletePlugin(db, 'example')).toBe(false);
  });

  it('upserts settings keeping the last test, and records the last test', () => {
    insertPlugin(db, plugin('example'), now);
    expect(setLastTest(db, 'example', { ok: true, message: 'm', at: 'x' }, now)).toBe(false);
    upsertPluginSettings(db, 'example', { url: 'a', apiKey: { $enc: 'zzz' } }, now);
    expect(findPluginSettings(db, 'example')?.lastTest).toBeNull();
    const test = { ok: false, message: 'refused', at: later.toISOString(), warnings: ['w'] };
    expect(setLastTest(db, 'example', test, later)).toBe(true);
    expect(findPluginSettings(db, 'example')?.updatedAt).toBe(now.toISOString());
    upsertPluginSettings(db, 'example', { url: 'b' }, later);
    expect(findPluginSettings(db, 'example')).toEqual({
      pluginName: 'example',
      settings: { url: 'b' },
      updatedAt: later.toISOString(),
      lastTest: test,
    });
  });

  it('adding a catalog twice is one row', () => {
    addCatalog(db, 'https://c.example/catalog.json', null, now);
    addCatalog(db, 'https://c.example/catalog.json', null, later);
    expect(listCatalogs(db)).toEqual([
      { url: 'https://c.example/catalog.json', signingKeys: null },
    ]);
  });

  it('adding a known url with keys stores them; adding it without keys keeps them', () => {
    const key = `k1:${'ab'.repeat(32)}`;
    addCatalog(db, 'https://c.example/catalog.json', null, now);
    addCatalog(db, 'https://c.example/catalog.json', key, later);
    expect(listCatalogs(db)).toEqual([{ url: 'https://c.example/catalog.json', signingKeys: key }]);
    addCatalog(db, 'https://c.example/catalog.json', null, later);
    expect(listCatalogs(db)[0]?.signingKeys).toBe(key);
    // unpinning is remove, then add
    removeCatalog(db, 'https://c.example/catalog.json');
    addCatalog(db, 'https://c.example/catalog.json', null, later);
    expect(listCatalogs(db)[0]?.signingKeys).toBeNull();
  });

  it('signedBy round-trips through insert and update', () => {
    expect(insertPlugin(db, plugin('a', { signedBy: 'k1' }), now).signedBy).toBe('k1');
    expect(findPlugin(db, 'a')?.signedBy).toBe('k1');
    expect(updatePlugin(db, 'a', { signedBy: null }, later)?.signedBy).toBeNull();
    expect(updatePlugin(db, 'a', { signedBy: 'k2' }, later)?.signedBy).toBe('k2');
  });
});

describe('job result problems', () => {
  const result = (jobId: string, problems: string[]): JobResultRow => ({
    jobId,
    fingerprint: `fp-${jobId}`,
    workflowId: 'w1',
    workflowVersion: 1,
    outcome: 'done',
    beforeBytes: 100,
    afterBytes: 60,
    estimatedBytes: null,
    command: null,
    plan: null,
    replacedTo: null,
    logPath: null,
    warnings: ['kept'],
    problems,
    outputProbe: null,
    createdAt: now.toISOString(),
  });

  it('stores problems apart from warnings and filters the list by them', () => {
    db.prepare(
      `INSERT INTO workflows (id, kind, name, current_version, created_at, updated_at)
       VALUES ('w1', 'workflow', 'W', 1, ?, ?)`,
    ).run(now.toISOString(), now.toISOString());
    db.prepare(
      `INSERT INTO libraries (id, name, path, created_at, updated_at) VALUES ('l1', 'L', '/m', ?, ?)`,
    ).run(now.toISOString(), now.toISOString());
    db.prepare(
      `INSERT INTO runs (id, library_id, workflow_id, workflow_version, requested_path, dry_run, force, created_by, created_at)
       VALUES ('r1', 'l1', 'w1', 1, '/m', 0, 0, 'u', ?)`,
    ).run(now.toISOString());
    for (const id of ['clean', 'problem']) {
      insertJob(
        db,
        {
          id,
          runId: 'r1',
          libraryId: 'l1',
          fileId: null,
          path: `/m/${id}.mkv`,
          workflowId: 'w1',
          workflowVersion: 1,
          dryRun: false,
          testEncode: false,
          state: 'done',
          priority: 0,
        },
        now,
      );
    }
    insertJobResult(db, result('clean', []));
    insertJobResult(db, result('problem', ['sonarr: refused']));

    const all = listJobs(db, {});
    expect(all.find((j) => j.id === 'problem')?.problems).toEqual(['sonarr: refused']);
    expect(all.find((j) => j.id === 'clean')?.problems).toEqual([]);
    expect(listJobs(db, { problems: true }).map((j) => j.id)).toEqual(['problem']);
  });
});
