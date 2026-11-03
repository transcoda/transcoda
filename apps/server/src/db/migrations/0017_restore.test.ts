import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.ts';
import { closeDatabase, type Database, openDatabase } from '../open.ts';
import { migrations } from './index.ts';

const T = '2026-01-01T00:00:00.000Z';

describe('migration 0017', () => {
  let dir: string;
  let db: Database;
  const backupDir = () => path.join(dir, 'backups');
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-0017-'));
    db = openDatabase(path.join(dir, 'app.sqlite'));
    migrate(db, migrations.slice(0, 16), { backupDir: backupDir() });
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
    const job = db.prepare(
      `INSERT INTO jobs (id, run_id, library_id, path, workflow_id, workflow_version, dry_run, test_encode, state, queued_at, finished_at, updated_at)
       VALUES (?, 'r1', 'l1', '/media/Show/a.mkv', 'w1', 1, 0, 0, 'done', ?, ?, ?)`,
    );
    job.run('j0', T, T, T);
    job.run('j1', T, T, T);
    const recycled = db.prepare(
      `INSERT INTO recycled (path, library_id, job_id, size_bytes, recycled_at) VALUES (?, 'l1', ?, 1, ?)`,
    );
    recycled.run('/media/.transcoda-recycle/Show/a.mkv', 'j1', T);
    recycled.run('/media/.transcoda-recycle/Show/a.mkv.1', 'j0', T);
    recycled.run('/media/.transcoda-recycle/Show/a.de.srt.1', 'j1', T);
  });
  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("backfills kind and original path: the job's own file name (or name.N) is the original, anything else a sidecar beside it", () => {
    migrate(db, migrations, { backupDir: backupDir() });
    expect(
      db.prepare('SELECT path, kind, original_path, restore_id FROM recycled ORDER BY path').all(),
    ).toEqual([
      {
        path: '/media/.transcoda-recycle/Show/a.de.srt.1',
        kind: 'sidecar',
        original_path: '/media/Show/a.de.srt',
        restore_id: null,
      },
      {
        path: '/media/.transcoda-recycle/Show/a.mkv',
        kind: 'original',
        original_path: '/media/Show/a.mkv',
        restore_id: null,
      },
      {
        path: '/media/.transcoda-recycle/Show/a.mkv.1',
        kind: 'original',
        original_path: '/media/Show/a.mkv',
        restore_id: null,
      },
    ]);
    expect(() => db.prepare("UPDATE recycled SET kind = 'other'").run()).toThrow();
  });

  it('allows one active restore per job', () => {
    migrate(db, migrations, { backupDir: backupDir() });
    const add = db.prepare(
      `INSERT INTO restores (id, job_id, restored_at, restored_by) VALUES (?, 'j1', ?, 'u')`,
    );
    add.run('s1', T);
    expect(() => add.run('s2', T)).toThrow();
    db.prepare("UPDATE restores SET undone_at = ?, undone_by = 'u' WHERE id = 's1'").run(T);
    expect(() => add.run('s2', T)).not.toThrow();
  });
});
