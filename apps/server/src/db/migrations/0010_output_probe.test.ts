import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.ts';
import { closeDatabase, type Database, openDatabase } from '../open.ts';
import { migrations } from './index.ts';

const T = '2026-01-01T00:00:00.000Z';

const rows = (db: Database, sql: string): unknown[] => db.prepare(sql).all();

describe('migration 0010', () => {
  let dir: string;
  let backupDir: string;
  let db: Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-0010-'));
    backupDir = path.join(dir, 'backups');
    db = openDatabase(path.join(dir, 'app.sqlite'));
    migrate(db, migrations.slice(0, 9), { backupDir });
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
      `INSERT INTO jobs (id, run_id, library_id, path, workflow_id, workflow_version, dry_run, test_encode,
         state, priority, queued_at, finished_at, updated_at, probe)
       VALUES ('j1', 'r1', 'l1', '/media/a.mkv', 'w1', 1, 1, 1, 'dry_run', 0, ?, ?, ?, '{"container":"mkv"}')`,
    ).run(T, T, T);
    db.prepare(
      `INSERT INTO job_results (job_id, fingerprint, workflow_id, workflow_version, outcome, before_bytes,
         after_bytes, command, plan, replaced_to, warnings, problems_json, created_at)
       VALUES ('j1', 'fp', 'w1', 1, 'dry_run', 100, 60, 'ffmpeg -i x', '{"rewrite":true}', NULL, '["w"]', '[]', ?)`,
    ).run(T);
  });
  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps every job and result as it was and gives results an empty output probe', () => {
    const jobsBefore = rows(db, 'SELECT * FROM jobs');
    const resultsBefore = rows(db, 'SELECT * FROM job_results') as Record<string, unknown>[];

    expect(migrate(db, migrations.slice(0, 10), { backupDir }).applied).toEqual([
      '0010_output_probe',
    ]);

    expect(rows(db, 'SELECT * FROM jobs')).toEqual(jobsBefore);
    expect(rows(db, 'SELECT * FROM job_results')).toEqual(
      resultsBefore.map((r) => ({ ...r, output_probe: null })),
    );
    db.prepare('UPDATE job_results SET output_probe = \'{"container":"mkv"}\'').run();
    expect(db.prepare('SELECT output_probe FROM job_results').get()).toEqual({
      output_probe: '{"container":"mkv"}',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
