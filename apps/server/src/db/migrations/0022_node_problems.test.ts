import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.ts';
import { closeDatabase, type Database, openDatabase } from '../open.ts';
import { findJobResult } from '../repos/jobs.ts';
import { migrations } from './index.ts';

const T = '2026-01-01T00:00:00.000Z';

describe('migration 0022', () => {
  let dir: string;
  let backupDir: string;
  let db: Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-0022-'));
    backupDir = path.join(dir, 'backups');
    db = openDatabase(path.join(dir, 'app.sqlite'));
    migrate(db, migrations.slice(0, 21), { backupDir });
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
       VALUES ('j1', 'r1', 'l1', '/media/a.mkv', 'w1', 1, 0, 0, 'done', NULL, ?, ?, ?)`,
    ).run(T, T, T);
    db.prepare(
      `INSERT INTO job_results (job_id, fingerprint, workflow_id, workflow_version, outcome, warnings, problems_json, created_at)
       VALUES ('j1', 'k', 'w1', 1, 'done', '["notify https://hooks.example/… failed: fetch failed"]', '[]', ?)`,
    ).run(T);
  });
  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds node_problems_json; an older result reads no node problems (no badge)', () => {
    expect(migrate(db, migrations.slice(0, 22), { backupDir }).applied).toEqual([
      '0022_node_problems',
    ]);
    expect(findJobResult(db, 'j1')).toMatchObject({
      warnings: ['notify https://hooks.example/… failed: fetch failed'],
      nodeProblems: [],
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it("adds the column in place: 0021's triggers on jobs survive, and job_results keeps its rows", () => {
    migrate(db, migrations, { backupDir });
    const triggers = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(triggers).toEqual(
      expect.arrayContaining(['jobs_latest_delete', 'jobs_latest_insert', 'jobs_latest_update']),
    );
    expect(findJobResult(db, 'j1')?.nodeProblems).toEqual([]);
  });

  it('reads a corrupt cell, or a bad entry in it, as no node problem', () => {
    migrate(db, migrations.slice(0, 22), { backupDir });
    db.prepare("UPDATE job_results SET node_problems_json = 'nope' WHERE job_id = 'j1'").run();
    expect(findJobResult(db, 'j1')?.nodeProblems).toEqual([]);
    const good = { workflowPath: [], nodeId: 'n1', severity: 'warning', message: 'm' };
    db.prepare('UPDATE job_results SET node_problems_json = ? WHERE job_id = ?').run(
      JSON.stringify([{ nodeId: 3 }, good]),
      'j1',
    );
    expect(findJobResult(db, 'j1')?.nodeProblems).toEqual([good]);
  });
});
