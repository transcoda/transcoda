import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.ts';
import { closeDatabase, type Database, openDatabase } from '../open.ts';
import { migrations } from './index.ts';

const T = '2026-01-01T00:00:00.000Z';

describe('migration 0007', () => {
  let dir: string;
  let backupDir: string;
  let db: Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-0007-'));
    backupDir = path.join(dir, 'backups');
    db = openDatabase(path.join(dir, 'app.sqlite'));
    migrate(db, migrations.slice(0, 6), { backupDir });
    db.prepare(
      `INSERT INTO plugins (name, version, sha256, manifest_json, nodes_json, installed_at, updated_at)
       VALUES ('p', '1.0.0', 'x', '{}', '[]', ?, ?)`,
    ).run(T, T);
    db.prepare('INSERT INTO plugin_catalogs (url, added_at) VALUES (?, ?)').run(
      'https://c.example/i.json',
      T,
    );
  });
  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds signed_by and signing_keys, NULL on every existing row, and keeps the rows', () => {
    const result = migrate(db, migrations.slice(0, 7), { backupDir });
    expect(result.applied).toEqual(['0007_signing_blocklist']);
    expect(db.prepare('SELECT name, version, signed_by FROM plugins').all()).toEqual([
      { name: 'p', version: '1.0.0', signed_by: null },
    ]);
    expect(db.prepare('SELECT url, signing_keys FROM plugin_catalogs').all()).toEqual([
      { url: 'https://c.example/i.json', signing_keys: null },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
