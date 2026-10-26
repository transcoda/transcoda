import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.ts';
import { closeDatabase, type Database, openDatabase } from '../open.ts';
import { migrations } from './index.ts';

const T = '2026-01-01T00:00:00.000Z';

describe('migration 0009', () => {
  let dir: string;
  let backupDir: string;
  let db: Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-0009-'));
    backupDir = path.join(dir, 'backups');
    db = openDatabase(path.join(dir, 'app.sqlite'));
    migrate(db, migrations.slice(0, 8), { backupDir });
    db.prepare(
      `INSERT INTO workflows (id, kind, name, current_version, created_at, updated_at)
       VALUES ('w1', 'workflow', 'Shrink', 1, ?, ?)`,
    ).run(T, T);
    db.prepare(
      `INSERT INTO workflow_versions (workflow_id, version, graph, format_version, note, created_by, created_at)
       VALUES ('w1', 1, '{}', 1, NULL, 'u', ?)`,
    ).run(T);
    db.prepare(
      `INSERT INTO libraries (id, name, path, created_at, updated_at)
       VALUES ('l1', 'Lib', '/media', ?, ?)`,
    ).run(T, T);
    db.prepare(
      `INSERT INTO runs (id, library_id, workflow_id, workflow_version, requested_path, dry_run, force, created_by, created_at)
       VALUES ('r1', 'l1', 'w1', 1, '/media', 1, 0, 'u', ?)`,
    ).run(T);
    db.prepare(
      `INSERT INTO jobs (id, run_id, library_id, path, workflow_id, workflow_version, dry_run, state, priority,
         queued_at, updated_at)
       VALUES ('j1', 'r1', 'l1', '/media/a.mkv', 'w1', 1, 1, 'queued', 0, ?, ?)`,
    ).run(T, T);
  });
  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const keep = (container: string) =>
    db
      .prepare(
        `INSERT INTO test_outputs (job_id, file_name, container, size_bytes, created_at, kept_until)
         VALUES ('j1', ?, ?, 10, ?, ?)`,
      )
      .run(`j1.${container}`, container, T, T);

  it('adds test_encode (0 on every existing row), test_output_note (NULL) and test_outputs', () => {
    expect(migrate(db, migrations.slice(0, 9), { backupDir }).applied).toEqual([
      '0009_test_encode',
    ]);
    expect(db.prepare('SELECT id, test_encode FROM runs').all()).toEqual([
      { id: 'r1', test_encode: 0 },
    ]);
    expect(db.prepare('SELECT id, test_encode, test_output_note FROM jobs').all()).toEqual([
      { id: 'j1', test_encode: 0, test_output_note: null },
    ]);
    expect(() => db.prepare("UPDATE runs SET test_encode = 2 WHERE id = 'r1'").run()).toThrow();
    expect(() => db.prepare("UPDATE jobs SET test_encode = 2 WHERE id = 'j1'").run()).toThrow();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('test_outputs takes only mkv or mp4 and goes with its job', () => {
    migrate(db, migrations.slice(0, 9), { backupDir });
    expect(() => keep('avi')).toThrow();
    keep('mkv');
    expect(db.prepare('SELECT job_id, container FROM test_outputs').all()).toEqual([
      { job_id: 'j1', container: 'mkv' },
    ]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.prepare("DELETE FROM jobs WHERE id = 'j1'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM test_outputs').get()).toEqual({ n: 0 });
  });
});
