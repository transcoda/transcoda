import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.ts';
import { closeDatabase, type Database, openDatabase } from '../open.ts';
import { migrations } from './index.ts';

const T = '2026-01-01T00:00:00.000Z';
const U = '2026-01-05T00:00:00.000Z';
const LIB = 'core:input-library';
const MANUAL = 'core:input-manual';
const WEBHOOK = 'core:input-webhook';

/** A graph whose trigger `in` sits at {10, 20} with edge e1 from in.file to the `fin` node. */
function graph(trigger: string, libraryId?: string): string {
  return JSON.stringify({
    formatVersion: 1,
    kind: 'workflow',
    nodes: [
      {
        id: 'in',
        type: trigger,
        typeVersion: 1,
        settings: libraryId === undefined ? {} : { libraryId },
        position: { x: 10, y: 20 },
        label: 'Start here',
      },
      {
        id: 'fin',
        type: 'core:keep-original',
        typeVersion: 1,
        settings: {},
        position: { x: 200, y: 20 },
      },
    ],
    edges: [{ id: 'e1', from: { node: 'in', port: 'file' }, to: { node: 'fin', port: 'file' } }],
    groups: [],
  });
}

const twoTriggers = JSON.stringify({
  formatVersion: 1,
  kind: 'workflow',
  nodes: [
    { id: 'a', type: MANUAL, typeVersion: 1, settings: {}, position: { x: 0, y: 0 } },
    { id: 'b', type: WEBHOOK, typeVersion: 1, settings: {}, position: { x: 0, y: 50 } },
  ],
  edges: [],
  groups: [],
});

interface WfSeed {
  id: string;
  versions: string[];
  active?: number;
  deleted?: boolean;
}

function seedWorkflow(db: Database, w: WfSeed): void {
  db.prepare(
    `INSERT INTO workflows (id, kind, name, current_version, created_at, updated_at, deleted_at)
     VALUES (?, 'workflow', ?, ?, ?, ?, ?)`,
  ).run(w.id, w.id, w.versions.length, T, T, w.deleted ? U : null);
  w.versions.forEach((g, i) => {
    db.prepare(
      `INSERT INTO workflow_versions (workflow_id, version, graph, format_version, note, created_by, created_at)
       VALUES (?, ?, ?, 1, ?, 'u', ?)`,
    ).run(w.id, i + 1, g, `note ${i + 1}`, T);
  });
  if (w.active !== undefined) {
    db.prepare(
      "UPDATE workflows SET active_version = ?, activated_at = ?, activated_by = 'u' WHERE id = ?",
    ).run(w.active, T, w.id);
  }
}

function seedLibrary(
  db: Database,
  id: string,
  name: string,
  defaultWorkflowId: string | null,
  deleted = false,
): void {
  db.prepare(
    `INSERT INTO libraries (id, name, path, default_workflow_id, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, `/media/${id}`, defaultWorkflowId, T, T, deleted ? U : null);
}

const WORKFLOWS: WfSeed[] = [
  { id: 'bound', versions: [graph(LIB, 'A')], active: 1 },
  { id: 'manual', versions: [graph(MANUAL), graph(MANUAL)], active: 2 },
  { id: 'draft', versions: [graph(MANUAL), graph(MANUAL), graph(WEBHOOK)], active: 2 },
  { id: 'inactive', versions: [graph(MANUAL)] },
  { id: 'shared', versions: [graph(MANUAL)], active: 1 },
  { id: 'nodewins', versions: [graph(LIB, 'F2')], active: 1 },
  { id: 'loser', versions: [graph(LIB, 'G')], active: 1 },
  { id: 'keeper', versions: [graph(MANUAL)], active: 1 },
  { id: 'Alpha', versions: [graph(LIB, 'H')], active: 1 },
  { id: 'Beta', versions: [graph(LIB, 'H')], active: 1 },
  { id: 'unconvertible', versions: ['{not json'], active: 1 },
  { id: 'twotriggers', versions: [twoTriggers], active: 1 },
  { id: 'orphanlib', versions: [graph(MANUAL)], active: 1 },
  { id: 'gone', versions: [graph(MANUAL)], active: 1, deleted: true },
];

function seed(db: Database): void {
  for (const w of WORKFLOWS) seedWorkflow(db, w);
  seedLibrary(db, 'A', 'A-name', 'bound');
  seedLibrary(db, 'B', 'B-name', 'manual');
  seedLibrary(db, 'C', 'C-name', 'draft');
  seedLibrary(db, 'D', 'D-name', 'inactive');
  seedLibrary(db, 'Movies', 'Movies', 'shared');
  seedLibrary(db, 'Anime', 'Anime', 'shared');
  seedLibrary(db, 'F1', 'F1-name', 'nodewins');
  seedLibrary(db, 'F2', 'F2-name', null);
  seedLibrary(db, 'G', 'G-name', 'keeper');
  seedLibrary(db, 'H', 'H-name', null);
  seedLibrary(db, 'U', 'U-name', 'unconvertible');
  seedLibrary(db, 'U2', 'U2-name', 'twotriggers');
  // a soft-deleted library with a default, and a library whose default is a soft-deleted workflow
  seedLibrary(db, 'X', 'X-name', 'orphanlib', true);
  seedLibrary(db, 'Y', 'Y-name', 'gone');
  db.prepare(
    `INSERT INTO runs (id, library_id, workflow_id, workflow_version, requested_path, dry_run, force, created_by, created_at)
     VALUES ('r1', 'A', 'bound', 1, '/media/A', 0, 0, 'u', ?)`,
  ).run(T);
  db.prepare(
    `INSERT INTO jobs (id, run_id, library_id, path, workflow_id, workflow_version, dry_run, state, queued_at, updated_at)
     VALUES ('j1', 'r1', 'A', '/media/A/x.mkv', 'bound', 1, 0, 'queued', ?, ?)`,
  ).run(T, T);
}

interface WfRow {
  current_version: number;
  active_version: number | null;
  activated_at: string | null;
  activated_by: string | null;
  active_library_id: string | null;
  updated_at: string;
}

const NOTICES = [
  'D-name has no workflow now: its default, inactive, has no active version. Activate inactive v2 to feed D-name.',
  'F1-name has no workflow now: its default, nodewins, has a Library input that takes files from F2-name.',
  'Movies has no workflow now: its default, shared, takes files from Anime instead. Add a Library input to a workflow for Movies.',
  'U2-name has no workflow now: its default, twotriggers, could not be switched to a Library input. Add one to twotriggers by hand.',
  'U-name has no workflow now: its default, unconvertible, could not be switched to a Library input. Add one to unconvertible by hand.',
  'Beta was deactivated: its Library input takes files from H-name, which Alpha already feeds.',
  'loser was deactivated: its Library input takes files from G-name, which keeper already feeds.',
];

describe('migration 0008', () => {
  let dir: string;
  let backupDir: string;
  let db: Database;
  let lines: string[];

  const wf = (id: string): WfRow =>
    db
      .prepare(
        'SELECT current_version, active_version, activated_at, activated_by, active_library_id, updated_at FROM workflows WHERE id = ?',
      )
      .get(id) as WfRow;
  const versions = (
    id: string,
  ): { version: number; graph: string; note: string | null; created_by: string }[] =>
    db
      .prepare(
        'SELECT version, graph, note, created_by FROM workflow_versions WHERE workflow_id = ? ORDER BY version',
      )
      .all(id) as { version: number; graph: string; note: string | null; created_by: string }[];
  // biome-ignore lint/suspicious/noExplicitAny: parsed test JSON
  const node = (id: string, version: number): any =>
    JSON.parse(versions(id).find((v) => v.version === version)?.graph ?? 'null').nodes[0];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-0008-'));
    backupDir = path.join(dir, 'backups');
    db = openDatabase(path.join(dir, 'app.sqlite'));
    migrate(db, migrations.slice(0, 7), { backupDir });
    seed(db);
    lines = [];
    migrate(db, migrations.slice(0, 8), { backupDir, log: (m) => lines.push(m) });
  });
  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('binds a default whose active Library input already names its library, with no new version', () => {
    expect(wf('bound')).toMatchObject({
      current_version: 1,
      active_version: 1,
      activated_by: 'u',
      active_library_id: 'A',
    });
    expect(versions('bound')).toHaveLength(1);
  });

  it('swaps a Manual trigger into a Library input as a new active version', () => {
    const row = wf('manual');
    expect(row).toMatchObject({
      current_version: 3,
      active_version: 3,
      activated_by: 'system:migration',
      active_library_id: 'B',
    });
    expect(row.activated_at).not.toBe(T);
    expect(row.updated_at).toBe(row.activated_at);
    const v3 = versions('manual')[2];
    expect(v3).toMatchObject({
      version: 3,
      note: 'Library input set to B-name (from its default workflow)',
      created_by: 'system:migration',
    });
    const g = JSON.parse(v3?.graph ?? '{}');
    expect(g.nodes[0]).toEqual({
      id: 'in',
      type: LIB,
      typeVersion: 1,
      settings: { libraryId: 'B' },
      position: { x: 10, y: 20 },
      label: 'Start here',
    });
    expect(g.nodes[1].id).toBe('fin');
    expect(g.edges).toEqual([
      { id: 'e1', from: { node: 'in', port: 'file' }, to: { node: 'fin', port: 'file' } },
    ]);
    // the old versions are untouched
    expect(versions('manual')[1]?.graph).toBe(graph(MANUAL));
  });

  it('keeps a newer draft newest: swap(active) is activated, swap(draft) follows it', () => {
    expect(wf('draft')).toMatchObject({
      current_version: 5,
      active_version: 4,
      active_library_id: 'C',
    });
    expect(node('draft', 4)).toMatchObject({ type: LIB, settings: { libraryId: 'C' } });
    expect(node('draft', 5)).toMatchObject({ type: LIB, settings: { libraryId: 'C' } });
    // v4 comes from the active v2 (Manual), v5 from the draft v3 (Webhook): same shape here
    expect(versions('draft').map((v) => v.version)).toEqual([1, 2, 3, 4, 5]);
  });

  it('gives an inactive default a swapped newest version, activates nothing and leaves a notice', () => {
    expect(wf('inactive')).toMatchObject({
      current_version: 2,
      active_version: null,
      active_library_id: null,
    });
    expect(node('inactive', 2)).toMatchObject({ type: LIB, settings: { libraryId: 'D' } });
    expect(NOTICES[0]).toContain('inactive v2');
  });

  it('a shared default binds to the first library by name', () => {
    expect(wf('shared')).toMatchObject({ active_library_id: 'Anime', current_version: 2 });
    expect(node('shared', 2)).toMatchObject({ settings: { libraryId: 'Anime' } });
  });

  it('the node wins: a default whose Library input names another free library feeds that one', () => {
    expect(wf('nodewins')).toMatchObject({
      active_library_id: 'F2',
      current_version: 1,
      active_version: 1,
    });
  });

  it("a library's default keeps it; another workflow naming it is deactivated", () => {
    expect(wf('keeper')).toMatchObject({ active_library_id: 'G', active_version: 2 });
    expect(wf('loser')).toMatchObject({
      active_version: null,
      activated_at: null,
      activated_by: null,
      active_library_id: null,
      current_version: 1,
    });
    expect(wf('Alpha')).toMatchObject({ active_library_id: 'H', active_version: 1 });
    expect(wf('Beta')).toMatchObject({ active_version: null, active_library_id: null });
  });

  it('leaves a default with no recognisable trigger as it is', () => {
    for (const id of ['unconvertible', 'twotriggers']) {
      expect(wf(id)).toMatchObject({
        current_version: 1,
        active_version: 1,
        activated_by: 'u',
        active_library_id: null,
        updated_at: T,
      });
      expect(versions(id)).toHaveLength(1);
    }
  });

  it('ignores soft-deleted libraries and soft-deleted default workflows', () => {
    expect(wf('orphanlib')).toMatchObject({
      current_version: 1,
      active_version: 1,
      active_library_id: null,
    });
    expect(wf('gone')).toMatchObject({ current_version: 1, active_library_id: null });
    for (const n of NOTICES) {
      expect(n).not.toMatch(/X-name|Y-name/);
    }
  });

  it('drops libraries.default_workflow_id and keeps every reference intact', () => {
    const cols = (db.prepare('PRAGMA table_info(libraries)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual([
      'id',
      'name',
      'path',
      'recycle_folder',
      'process_hardlinked',
      'verify_full_decode',
      'created_at',
      'updated_at',
      'deleted_at',
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM libraries').get()).toEqual({ n: 14 });
    expect(
      db
        .prepare(
          'SELECT r.id AS run, j.id AS job, l.name AS lib FROM runs r JOIN jobs j ON j.run_id = r.id JOIN libraries l ON l.id = r.library_id',
        )
        .all(),
    ).toEqual([{ run: 'r1', job: 'j1', lib: 'A-name' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('libraries_live_path', 'workflows_active_library') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: 'libraries_live_path' }, { name: 'workflows_active_library' }]);
    // the references to libraries are still enforced
    expect(() => db.prepare("DELETE FROM libraries WHERE id = 'A'").run()).toThrow(/FOREIGN KEY/);
  });

  it('allows one live workflow per library', () => {
    const insert = (id: string, deleted: string | null) =>
      db
        .prepare(
          `INSERT INTO workflows (id, kind, name, current_version, created_at, updated_at, deleted_at, active_library_id)
           VALUES (?, 'workflow', ?, 1, ?, ?, ?, 'B')`,
        )
        .run(id, id, T, T, deleted);
    expect(() => insert('second', null)).toThrow(/UNIQUE/);
    expect(() => insert('ghost', U)).not.toThrow();
  });

  it('records the notices in a settings row and the log, in order', () => {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'libraries.migrationNotices'")
      .get() as { value: string };
    expect(JSON.parse(row.value)).toEqual(NOTICES);
    expect(lines.filter((l) => l.startsWith('Migration 0008: '))).toEqual(
      NOTICES.map((n) => `Migration 0008: ${n}`),
    );
  });
});

describe('migration 0008 on a database without libraries', () => {
  it('writes no settings row and logs no notice', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-0008-'));
    const db = openDatabase(path.join(dir, 'app.sqlite'));
    const backupDir = path.join(dir, 'backups');
    migrate(db, migrations.slice(0, 7), { backupDir });
    seedWorkflow(db, { id: 'solo', versions: [graph(LIB, 'nowhere')], active: 1 });
    const lines: string[] = [];
    migrate(db, migrations.slice(0, 8), { backupDir, log: (m) => lines.push(m) });
    expect(db.prepare('SELECT COUNT(*) AS n FROM settings').get()).toEqual({ n: 0 });
    expect(lines.filter((l) => l.startsWith('Migration 0008'))).toEqual([]);
    expect(
      db.prepare("SELECT active_library_id, active_version FROM workflows WHERE id = 'solo'").get(),
    ).toEqual({ active_library_id: null, active_version: 1 });
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('migration 0008 notices for libraries phase 2 binds', () => {
  it('rewords "no active version" and drops other phase-1 notices for a library an active Library input claims', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-0008-'));
    const db = openDatabase(path.join(dir, 'app.sqlite'));
    const backupDir = path.join(dir, 'backups');
    migrate(db, migrations.slice(0, 7), { backupDir });
    // old: an inactive default of K; feeder: active, its Library input names K.
    seedWorkflow(db, { id: 'old', versions: [graph(MANUAL)] });
    seedWorkflow(db, { id: 'feeder', versions: [graph(LIB, 'K')], active: 1 });
    // pair: an active default of P1 and P2 (P1 binds, P2 would be "takes files from P1 instead");
    // claimer's active Library input names P2.
    seedWorkflow(db, { id: 'pair', versions: [graph(MANUAL)], active: 1 });
    seedWorkflow(db, { id: 'claimer', versions: [graph(LIB, 'P2')], active: 1 });
    seedLibrary(db, 'K', 'K-name', 'old');
    seedLibrary(db, 'P1', 'P1-name', 'pair');
    seedLibrary(db, 'P2', 'P2-name', 'pair');
    const lines: string[] = [];
    migrate(db, migrations.slice(0, 8), { backupDir, log: (m) => lines.push(m) });
    const binding = (id: string) =>
      (
        db.prepare('SELECT active_library_id FROM workflows WHERE id = ?').get(id) as {
          active_library_id: string | null;
        }
      ).active_library_id;
    expect(binding('feeder')).toBe('K');
    expect(binding('claimer')).toBe('P2');
    expect(binding('pair')).toBe('P1');
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'libraries.migrationNotices'")
      .get() as { value: string };
    expect(JSON.parse(row.value)).toEqual([
      'K-name is fed by feeder (its Library input). Its old default, old, has no active version; its newest version v2 also takes files from K-name.',
    ]);
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
