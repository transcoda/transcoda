import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.ts';
import { closeDatabase, type Database, openDatabase } from '../open.ts';
import { migrations } from './index.ts';

const T = '2026-01-01T00:00:00.000Z';
const U = '2026-01-05T00:00:00.000Z';

interface Seed {
  id: string;
  kind: string;
  mode: string;
  current: number;
  needsReview?: number;
  deletedAt?: string | null;
  versions: number[];
}

const SEEDS: Seed[] = [
  { id: 'on', kind: 'workflow', mode: 'enabled', current: 3, versions: [1, 2, 3] },
  { id: 'dry', kind: 'workflow', mode: 'dry-run', current: 2, versions: [1, 2] },
  {
    id: 'flagged',
    kind: 'workflow',
    mode: 'enabled',
    current: 2,
    needsReview: 1,
    versions: [1, 2],
  },
  { id: 'sub', kind: 'subworkflow', mode: 'enabled', current: 1, versions: [1] },
  { id: 'gone', kind: 'workflow', mode: 'enabled', current: 1, deletedAt: U, versions: [1] },
  { id: 'orphan', kind: 'workflow', mode: 'enabled', current: 4, versions: [1, 2, 3] },
];

function seedOld(db: Database): void {
  for (const w of SEEDS) {
    db.prepare(
      `INSERT INTO workflows (id, kind, name, mode, current_version, needs_review, review_note, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      w.id,
      w.kind,
      w.id,
      w.mode,
      w.current,
      w.needsReview ?? 0,
      'note',
      T,
      U,
      w.deletedAt ?? null,
    );
    for (const v of w.versions) {
      db.prepare(
        `INSERT INTO workflow_versions (workflow_id, version, graph, format_version, note, created_by, created_at)
         VALUES (?, ?, ?, 1, ?, 'u', ?)`,
      ).run(w.id, v, `{"v":${v}}`, `note ${v}`, T);
    }
  }
  db.prepare(
    `INSERT INTO libraries (id, name, path, default_workflow_id, created_at, updated_at)
     VALUES ('l1', 'Lib', '/media', 'on', ?, ?)`,
  ).run(T, T);
  db.prepare(
    `INSERT INTO runs (id, library_id, workflow_id, workflow_version, requested_path, dry_run, force, created_by, created_at)
     VALUES ('r1', 'l1', 'on', 2, '/media', 0, 0, 'u', ?)`,
  ).run(T);
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('workflow_review_acks', '{}', ?), ('other', '1', ?)",
  ).run(T, T);
}

const columns = (db: Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe('migration 0005', () => {
  let dir: string;
  let backupDir: string;
  let db: Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-0005-'));
    backupDir = path.join(dir, 'backups');
    db = openDatabase(path.join(dir, 'app.sqlite'));
    migrate(db, migrations.slice(0, 4), { backupDir });
    seedOld(db);
    // up to this migration: 0008 later drops libraries.default_workflow_id
    migrate(db, migrations.slice(0, 5), { backupDir });
  });
  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('maps enabled → active current version by system:migration, everything else → not active', () => {
    const rows = db
      .prepare('SELECT id, active_version, activated_at, activated_by FROM workflows ORDER BY id')
      .all();
    const none = { active_version: null, activated_at: null, activated_by: null };
    expect(rows).toEqual([
      { id: 'dry', ...none },
      { id: 'flagged', ...none },
      { id: 'gone', active_version: 1, activated_at: U, activated_by: 'system:migration' },
      { id: 'on', active_version: 3, activated_at: U, activated_by: 'system:migration' },
      { id: 'orphan', ...none },
      { id: 'sub', ...none },
    ]);
  });

  it('drops mode, needs_review and review_note, keeps every version row, recreates the index, adds runs.note, deletes the acks row', () => {
    expect(columns(db, 'workflows')).toEqual([
      'id',
      'kind',
      'name',
      'current_version',
      'active_version',
      'activated_at',
      'activated_by',
      'created_at',
      'updated_at',
      'deleted_at',
    ]);
    const total = SEEDS.reduce((n, w) => n + w.versions.length, 0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get()).toEqual({ n: total });
    for (const w of SEEDS) {
      const got = db
        .prepare(
          'SELECT version, graph, note FROM workflow_versions WHERE workflow_id = ? ORDER BY version',
        )
        .all(w.id);
      expect(got).toEqual(
        w.versions.map((v) => ({ version: v, graph: `{"v":${v}}`, note: `note ${v}` })),
      );
    }
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'workflows_deleted_at'",
        )
        .all(),
    ).toHaveLength(1);
    expect(columns(db, 'runs')).toContain('note');
    expect(db.prepare('SELECT key FROM settings').all()).toEqual([{ key: 'other' }]);
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({
      v: 5,
    });
  });

  it('keeps the workflows rows themselves (name, current version, dates, deleted_at)', () => {
    const row = db.prepare("SELECT * FROM workflows WHERE id = 'orphan'").get();
    expect(row).toMatchObject({
      id: 'orphan',
      kind: 'workflow',
      name: 'orphan',
      current_version: 4,
      created_at: T,
      updated_at: U,
      deleted_at: null,
    });
    expect(db.prepare("SELECT deleted_at FROM workflows WHERE id = 'gone'").get()).toEqual({
      deleted_at: U,
    });
  });

  it('rows referenced by libraries.default_workflow_id and runs.workflow_id survive the rebuild and still resolve', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(
      db
        .prepare(
          `SELECT l.id AS lib, w.name AS wf FROM libraries l JOIN workflows w ON w.id = l.default_workflow_id`,
        )
        .all(),
    ).toEqual([{ lib: 'l1', wf: 'on' }]);
    expect(
      db
        .prepare(
          'SELECT r.id AS run, w.id AS wf, r.note AS note FROM runs r JOIN workflows w ON w.id = r.workflow_id',
        )
        .all(),
    ).toEqual([{ run: 'r1', wf: 'on', note: null }]);
    // the references are still enforced against the rebuilt table
    expect(() => db.prepare("DELETE FROM workflows WHERE id = 'on'").run()).toThrow();
  });

  it('the schema refuses an active sub-workflow and a dangling active version', () => {
    const set = (id: string, v: number | null, at: string | null, by: string | null) =>
      db
        .prepare(
          'UPDATE workflows SET active_version = ?, activated_at = ?, activated_by = ? WHERE id = ?',
        )
        .run(v, at, by, id);
    expect(() => set('sub', 1, 'x', 'u')).toThrow(/CHECK/);
    expect(() => set('on', 99, 'x', 'u')).toThrow(/FOREIGN KEY/);
    expect(() => set('on', 2, null, 'u')).toThrow(/CHECK/);
    expect(() => set('on', 2, 'x', null)).toThrow(/CHECK/);
    expect(() => set('on', null, 'x', 'u')).toThrow(/CHECK/);
    expect(() => set('on', 2, 'x', 'u')).not.toThrow();
  });

  it('a fresh database gets the same schema', () => {
    const fresh = openDatabase(':memory:');
    migrate(fresh, migrations.slice(0, 5), { backupDir });
    for (const t of ['workflows', 'runs']) {
      expect(fresh.prepare(`PRAGMA table_info(${t})`).all()).toEqual(
        db.prepare(`PRAGMA table_info(${t})`).all(),
      );
    }
    expect(fresh.prepare('PRAGMA foreign_key_list(workflows)').all()).toEqual(
      db.prepare('PRAGMA foreign_key_list(workflows)').all(),
    );
    closeDatabase(fresh);
  });
});
