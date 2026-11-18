import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.ts';
import { closeDatabase, type Database, openDatabase } from '../open.ts';
import { migrations } from './index.ts';

const T = '2026-01-01T00:00:00.000Z';

describe('migration 0020', () => {
  let dir: string;
  let backupDir: string;
  let db: Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-0020-'));
    backupDir = path.join(dir, 'backups');
    db = openDatabase(path.join(dir, 'app.sqlite'));
    migrate(db, migrations.slice(0, 19), { backupDir });
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
      `INSERT INTO files (id, library_id, path, size_bytes, mtime_ms, ino, dev, fingerprint, updated_at)
       VALUES ('f1', 'l1', '/media/a.mkv', 1, 1, 1, 1, 'k', ?)`,
    ).run(T);
  });
  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds a nullable gone_at (existing rows read NULL) and the two indexes', () => {
    expect(migrate(db, migrations.slice(0, 20), { backupDir }).applied).toEqual([
      '0020_library_browser',
    ]);
    const col = (
      db.prepare('PRAGMA table_info(files)').all() as { name: string; notnull: number }[]
    ).find((c) => c.name === 'gone_at');
    expect(col).toMatchObject({ name: 'gone_at', notnull: 0 });
    expect(db.prepare("SELECT gone_at FROM files WHERE id = 'f1'").get()).toEqual({
      gone_at: null,
    });
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['jobs_file_queued', 'files_library_gone']));
    expect(names).not.toContain('jobs_media_title');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('the file/queued index serves a per-file latest-job lookup', () => {
    migrate(db, migrations.slice(0, 20), { backupDir });
    const plan = JSON.stringify(
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM jobs WHERE file_id = 'f1' ORDER BY queued_at DESC LIMIT 1",
        )
        .all(),
    );
    expect(plan).toContain('jobs_file_queued');
  });
});
