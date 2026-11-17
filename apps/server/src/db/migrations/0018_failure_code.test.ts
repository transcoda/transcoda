import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.ts';
import { closeDatabase, type Database, openDatabase } from '../open.ts';
import { findJob } from '../repos/jobs.ts';
import { migrations } from './index.ts';

const T = '2026-01-01T00:00:00.000Z';

describe('migration 0018', () => {
  let dir: string;
  let backupDir: string;
  let db: Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-0018-'));
    backupDir = path.join(dir, 'backups');
    db = openDatabase(path.join(dir, 'app.sqlite'));
    migrate(db, migrations.slice(0, 17), { backupDir });
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
      `INSERT INTO jobs (id, run_id, library_id, path, workflow_id, workflow_version, dry_run, test_encode, state, reason, queued_at, finished_at, updated_at)
       VALUES ('j1', 'r1', 'l1', '/media/a.mkv', 'w1', 1, 0, 0, 'failed', 'ffmpeg exited 1', ?, ?, ?)`,
    ).run(T, T, T);
  });
  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds failure_code, NULL for a job that failed before it', () => {
    expect(migrate(db, migrations.slice(0, 18), { backupDir }).applied).toEqual([
      '0018_failure_code',
    ]);
    expect(findJob(db, 'j1')).toMatchObject({
      state: 'failed',
      reason: 'ffmpeg exited 1',
      failureCode: null,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
