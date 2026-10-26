import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.ts';
import { closeDatabase, type Database, openDatabase } from '../open.ts';
import { migrations } from './index.ts';

const T = '2026-01-01T00:00:00.000Z';

describe('migration 0011', () => {
  let dir: string;
  let backupDir: string;
  let db: Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-0011-'));
    backupDir = path.join(dir, 'backups');
    db = openDatabase(path.join(dir, 'app.sqlite'));
    migrate(db, migrations.slice(0, 10), { backupDir });
    db.prepare(
      `INSERT INTO workflows (id, kind, name, current_version, created_at, updated_at)
       VALUES ('w1', 'workflow', 'Shrink', 1, ?, ?)`,
    ).run(T, T);
    db.prepare(
      `INSERT INTO libraries (id, name, path, created_at, updated_at)
       VALUES ('l1', 'Lib', '/media', ?, ?)`,
    ).run(T, T);
    db.prepare(
      `INSERT INTO runs (id, library_id, workflow_id, workflow_version, requested_path, dry_run, force, created_by, created_at)
       VALUES ('r1', 'l1', 'w1', 1, '/media', 0, 0, 'u', ?)`,
    ).run(T);
  });
  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves every library unrestricted and every run manual', () => {
    expect(migrate(db, migrations.slice(0, 11), { backupDir }).applied).toEqual(['0011_run_hours']);
    expect(db.prepare('SELECT id, run_hours FROM libraries').all()).toEqual([
      { id: 'l1', run_hours: null },
    ]);
    expect(db.prepare('SELECT id, source FROM runs').all()).toEqual([
      { id: 'r1', source: 'manual' },
    ]);
    expect(() => db.prepare("UPDATE runs SET source = 'cron' WHERE id = 'r1'").run()).toThrow();
    db.prepare("UPDATE runs SET source = 'library' WHERE id = 'r1'").run();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
