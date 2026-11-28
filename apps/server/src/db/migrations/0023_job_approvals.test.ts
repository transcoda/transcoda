import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.ts';
import { closeDatabase, type Database, openDatabase } from '../open.ts';
import { migrations } from './index.ts';

const T = '2026-01-01T00:00:00.000Z';

describe('migration 0023', () => {
  let dir: string;
  let backupDir: string;
  let db: Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-0023-'));
    backupDir = path.join(dir, 'backups');
    db = openDatabase(path.join(dir, 'app.sqlite'));
    migrate(db, migrations.slice(0, 22), { backupDir });
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
      `INSERT INTO jobs (id, run_id, library_id, path, workflow_id, workflow_version, dry_run, test_encode, state, reason, queued_at, updated_at)
       VALUES ('j1', 'r1', 'l1', '/media/a.mkv', 'w1', 1, 0, 0, 'verifying', NULL, ?, ?)`,
    ).run(T, T);
  });
  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const park = () =>
    db
      .prepare(
        `INSERT INTO job_approvals (job_id, node_id, parked_at, expires_at, before_bytes, after_bytes, plan, output_probe)
         VALUES ('j1', 'ap', ?, ?, 1000, 600, NULL, NULL)`,
      )
      .run(T, T);

  it('adds job_approvals, empty, and leaves the jobs as they were', () => {
    expect(migrate(db, migrations.slice(0, 23), { backupDir }).applied).toEqual([
      '0023_job_approvals',
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM job_approvals').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT id, state FROM jobs').all()).toEqual([
      { id: 'j1', state: 'verifying' },
    ]);
    park();
    expect(db.prepare('SELECT job_id, after_bytes FROM job_approvals').all()).toEqual([
      { job_id: 'j1', after_bytes: 600 },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('holds one row per job, for a job that exists, and drops it with the job', () => {
    migrate(db, migrations.slice(0, 23), { backupDir });
    park();
    expect(park).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO job_approvals (job_id, node_id, parked_at, expires_at, before_bytes, after_bytes)
           VALUES ('nope', 'ap', ?, ?, 1, 1)`,
        )
        .run(T, T),
    ).toThrow(/FOREIGN KEY/);
    db.prepare("DELETE FROM jobs WHERE id = 'j1'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM job_approvals').get()).toEqual({ n: 0 });
  });
});
