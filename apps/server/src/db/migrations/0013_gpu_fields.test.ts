import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.ts';
import { closeDatabase, type Database, openDatabase } from '../open.ts';
import { migrations } from './index.ts';

const T = '2026-01-01T00:00:00.000Z';

describe('migration 0013', () => {
  let dir: string;
  let backupDir: string;
  let db: Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-0013-'));
    backupDir = path.join(dir, 'backups');
    db = openDatabase(path.join(dir, 'app.sqlite'));
    migrate(db, migrations.slice(0, 12), { backupDir });
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
    db.prepare(
      `INSERT INTO jobs (id, run_id, library_id, path, workflow_id, workflow_version, dry_run, test_encode, state, queued_at, updated_at)
       VALUES ('j1', 'r1', 'l1', '/media/a.mkv', 'w1', 1, 0, 0, 'queued', ?, ?)`,
    ).run(T, T);
  });
  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds encoded_on (null) and failed_gpus (empty array) to an existing job', () => {
    expect(migrate(db, migrations.slice(0, 13), { backupDir }).applied).toEqual([
      '0013_gpu_fields',
    ]);
    expect(db.prepare('SELECT encoded_on, failed_gpus FROM jobs').all()).toEqual([
      { encoded_on: null, failed_gpus: '[]' },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
