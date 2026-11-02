import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.ts';
import { closeDatabase, type Database, openDatabase } from '../open.ts';
import { migrations } from './index.ts';

const T = '2026-01-01T00:00:00.000Z';

describe('migration 0016', () => {
  let dir: string;
  let db: Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-0016-'));
    db = openDatabase(path.join(dir, 'app.sqlite'));
    migrate(db, migrations.slice(0, 15), { backupDir: path.join(dir, 'backups') });
    db.prepare(
      `INSERT INTO libraries (id, name, path, created_at, updated_at)
       VALUES ('l1', 'Lib', '/media', ?, ?)`,
    ).run(T, T);
  });
  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('turns watching on for every existing library and accepts only 0 or 1', () => {
    migrate(db, migrations, { backupDir: path.join(dir, 'backups') });
    const row = db.prepare('SELECT watch_folder FROM libraries WHERE id = ?').get('l1');
    expect(row).toEqual({ watch_folder: 1 });
    expect(() =>
      db.prepare("UPDATE libraries SET watch_folder = 2 WHERE id = 'l1'").run(),
    ).toThrow();
  });
});
