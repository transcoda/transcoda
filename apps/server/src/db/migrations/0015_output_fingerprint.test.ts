import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.ts';
import { closeDatabase, type Database, openDatabase } from '../open.ts';
import { migrations } from './index.ts';

const T = '2026-01-01T00:00:00.000Z';

describe('migration 0015', () => {
  let dir: string;
  let backupDir: string;
  let db: Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-0015-'));
    backupDir = path.join(dir, 'backups');
    db = openDatabase(path.join(dir, 'app.sqlite'));
    migrate(db, migrations.slice(0, 14), { backupDir });
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
    db.prepare(
      `INSERT INTO job_results (job_id, fingerprint, workflow_id, workflow_version, outcome, before_bytes,
         after_bytes, command, plan, replaced_to, warnings, problems_json, created_at)
       VALUES ('j1', 'fp', 'w1', 1, 'done', 100, 50, NULL, NULL, 'recycle', '[]', '[]', ?)`,
    ).run(T);
  });
  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds output_fingerprint (null) to an existing result, with its lookup index', () => {
    expect(migrate(db, migrations.slice(0, 15), { backupDir }).applied).toEqual([
      '0015_output_fingerprint',
    ]);
    expect(db.prepare('SELECT output_fingerprint FROM job_results').all()).toEqual([
      { output_fingerprint: null },
    ]);
    const index = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'job_results_output_lookup'",
      )
      .get() as { sql: string } | undefined;
    expect(index?.sql).toContain('output_fingerprint, workflow_id, workflow_version');
    db.prepare("UPDATE job_results SET output_fingerprint = '1:2:3:4' WHERE job_id = 'j1'").run();
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT job_id FROM job_results
         WHERE output_fingerprint = '1:2:3:4' AND workflow_id = 'w1'`,
      )
      .all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join('\n')).toContain('job_results_output_lookup');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
