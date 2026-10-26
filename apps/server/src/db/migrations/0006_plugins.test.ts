import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.ts';
import { closeDatabase, type Database, openDatabase } from '../open.ts';
import { migrations } from './index.ts';

const T = '2026-01-01T00:00:00.000Z';
const U = '2026-01-05T00:00:00.000Z';

/** A database as Jan's is: migrated through 0005 and holding real data before 0006 runs. */
function seedThrough0005(db: Database): void {
  db.prepare(
    `INSERT INTO workflows (id, kind, name, current_version, created_at, updated_at)
     VALUES ('w1', 'workflow', 'Shrink', 2, ?, ?)`,
  ).run(T, U);
  for (const v of [1, 2]) {
    db.prepare(
      `INSERT INTO workflow_versions (workflow_id, version, graph, format_version, note, created_by, created_at)
       VALUES ('w1', ?, ?, 1, ?, 'u', ?)`,
    ).run(v, `{"v":${v}}`, `note ${v}`, T);
  }
  db.prepare(
    "UPDATE workflows SET active_version = 2, activated_at = ?, activated_by = 'u' WHERE id = 'w1'",
  ).run(U);
  db.prepare(
    `INSERT INTO libraries (id, name, path, default_workflow_id, created_at, updated_at)
     VALUES ('l1', 'Lib', '/media', 'w1', ?, ?)`,
  ).run(T, T);
  db.prepare(
    `INSERT INTO runs (id, library_id, workflow_id, workflow_version, requested_path, dry_run, force, created_by, created_at)
     VALUES ('r1', 'l1', 'w1', 2, '/media', 0, 0, 'u', ?)`,
  ).run(T);
  for (const [id, state] of [
    ['j1', 'done'],
    ['j2', 'failed'],
    ['j3', 'nothing_to_do'],
  ] as const) {
    db.prepare(
      `INSERT INTO jobs (id, run_id, library_id, path, workflow_id, workflow_version, dry_run, state, priority,
         queued_at, finished_at, updated_at)
       VALUES (?, 'r1', 'l1', ?, 'w1', 2, 0, ?, 0, ?, ?, ?)`,
    ).run(id, `/media/${id}.mkv`, state, T, U, U);
    db.prepare(
      `INSERT INTO job_results (job_id, fingerprint, workflow_id, workflow_version, outcome, before_bytes,
         after_bytes, command, replaced_to, warnings, created_at)
       VALUES (?, ?, 'w1', 2, ?, 100, 60, 'ffmpeg -i x', 'recycle', ?, ?)`,
    ).run(id, `fp-${id}`, state, JSON.stringify([`warn ${id}`]), U);
    db.prepare('INSERT INTO job_trace (job_id, seq, entry) VALUES (?, 1, ?)').run(id, '{"seq":1}');
  }
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('queue.paused', 'true', ?)",
  ).run(T);
}

const rows = (db: Database, sql: string): unknown[] => db.prepare(sql).all();

describe('migration 0006', () => {
  let dir: string;
  let backupDir: string;
  let db: Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-0006-'));
    backupDir = path.join(dir, 'backups');
    db = openDatabase(path.join(dir, 'app.sqlite'));
    migrate(db, migrations.slice(0, 5), { backupDir });
    seedThrough0005(db);
  });
  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps every existing row byte for byte and gives job results an empty problems list', () => {
    const tables = [
      'workflows',
      'workflow_versions',
      'libraries',
      'runs',
      'jobs',
      'job_trace',
      'settings',
    ];
    const before = Object.fromEntries(tables.map((t) => [t, rows(db, `SELECT * FROM ${t}`)]));
    const resultsBefore = rows(db, 'SELECT * FROM job_results ORDER BY job_id');
    expect(resultsBefore).toHaveLength(3);

    const result = migrate(db, migrations.slice(0, 6), { backupDir });
    expect(result.applied).toEqual(['0006_plugins']);

    for (const t of tables) expect(rows(db, `SELECT * FROM ${t}`)).toEqual(before[t]);
    const resultsAfter = rows(db, 'SELECT * FROM job_results ORDER BY job_id');
    expect(resultsAfter).toEqual(
      (resultsBefore as Record<string, unknown>[]).map((r) => ({ ...r, problems_json: '[]' })),
    );
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('creates the three plugin tables, empty, with foreign keys on', () => {
    migrate(db, migrations, { backupDir });
    for (const t of ['plugins', 'plugin_settings', 'plugin_catalogs']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    }
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('deleting a plugin removes its settings row', () => {
    migrate(db, migrations, { backupDir });
    db.prepare(
      `INSERT INTO plugins (name, version, sha256, manifest_json, nodes_json, installed_at, updated_at)
       VALUES ('p', '1.0.0', 'x', '{}', '[]', ?, ?)`,
    ).run(T, T);
    db.prepare(
      "INSERT INTO plugin_settings (plugin_name, settings_json, updated_at) VALUES ('p', '{}', ?)",
    ).run(T);
    db.prepare("DELETE FROM plugins WHERE name = 'p'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM plugin_settings').get()).toEqual({ n: 0 });
  });
});
