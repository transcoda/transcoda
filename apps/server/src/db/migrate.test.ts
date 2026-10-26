import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Migration, migrate, SchemaTooNewError } from './migrate.ts';
import { closeDatabase, openDatabase } from './open.ts';

const m1: Migration = {
  version: 1,
  name: '0001_a',
  up: (db) => {
    db.exec('CREATE TABLE a (id INTEGER)');
  },
};
const m2: Migration = {
  version: 2,
  name: '0002_b',
  up: (db) => {
    db.exec('CREATE TABLE b (id INTEGER)');
  },
};

const tableExists = (db: Database, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;

describe('migrate', () => {
  let dir: string;
  let backupDir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-'));
    backupDir = path.join(dir, 'backups');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('applies all migrations on an empty db and records them', () => {
    const db = openDatabase(':memory:');
    const result = migrate(db, [m1, m2], { backupDir });
    expect(result).toEqual({ from: 0, to: 2, applied: ['0001_a', '0002_b'], backupFile: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 2 });
    closeDatabase(db);
  });

  it("passes migrate's log to each migration's up", () => {
    const db = openDatabase(':memory:');
    const lines: string[] = [];
    const talky: Migration = {
      version: 1,
      name: '0001_talky',
      up: (_db, log) => {
        log('hello from up');
      },
    };
    migrate(db, [talky], { backupDir, log: (m) => lines.push(m) });
    expect(lines).toContain('hello from up');
    // without a log, up still gets a callable one
    const quiet = openDatabase(':memory:');
    expect(() => migrate(quiet, [talky], { backupDir })).not.toThrow();
    closeDatabase(db);
    closeDatabase(quiet);
  });

  it('is idempotent', () => {
    const db = openDatabase(':memory:');
    migrate(db, [m1, m2], { backupDir });
    const again = migrate(db, [m1, m2], { backupDir });
    expect(again).toEqual({ from: 2, to: 2, applied: [], backupFile: null });
    closeDatabase(db);
  });

  it('applies only pending migrations and backs up first', () => {
    const db = openDatabase(path.join(dir, 'app.sqlite'));
    migrate(db, [m1], { backupDir });
    const result = migrate(db, [m1, m2], { backupDir });
    expect(result.applied).toEqual(['0002_b']);
    expect(result.backupFile).toMatch(/transcoda-\d{8}-\d{6}-v1\.sqlite$/);
    expect(fs.existsSync(result.backupFile as string)).toBe(true);
    closeDatabase(db);
  });

  it('SchemaTooNewError points at the newest migration backup, else the newest of any kind', () => {
    const tooNew = () => {
      const db = openDatabase(':memory:');
      db.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (99, 'future', 'now')",
      );
      try {
        migrate(db, [m1, m2], { backupDir });
        throw new Error('expected SchemaTooNewError');
      } catch (e) {
        expect(e).toBeInstanceOf(SchemaTooNewError);
        return (e as SchemaTooNewError).backupHint;
      } finally {
        closeDatabase(db);
      }
    };
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'transcoda-20261021-180000-v99-manual.sqlite'), '');
    expect(tooNew()).toBe(path.join(backupDir, 'transcoda-20261021-180000-v99-manual.sqlite'));
    fs.writeFileSync(path.join(backupDir, 'transcoda-20261020-090000-v2.sqlite'), '');
    fs.writeFileSync(path.join(backupDir, 'transcoda-20261021-190000-v99-build.sqlite'), '');
    expect(tooNew()).toBe(path.join(backupDir, 'transcoda-20261020-090000-v2.sqlite'));
  });

  it('throws SchemaTooNewError when db is ahead', () => {
    const db = openDatabase(path.join(dir, 'app.sqlite'));
    migrate(db, [m1], { backupDir });
    const { backupFile } = migrate(db, [m1, m2], { backupDir });
    db.prepare("INSERT INTO schema_migrations VALUES (99, 'future', 'now')").run();
    let error: unknown;
    try {
      migrate(db, [m1, m2], { backupDir });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SchemaTooNewError);
    expect((error as Error).message).toContain(path.basename(backupFile as string));
    closeDatabase(db);

    const fresh = openDatabase(':memory:');
    fresh.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (99, 'future', 'now')",
    );
    expect(() => migrate(fresh, [m1], { backupDir: path.join(dir, 'empty') })).toThrow(
      /no backup found/,
    );
    closeDatabase(fresh);
  });

  it('rejects non-contiguous migrations', () => {
    const db = openDatabase(':memory:');
    const m3: Migration = { ...m2, version: 3, name: '0003_c' };
    expect(() => migrate(db, [m1, m3], { backupDir })).toThrow();
    expect(tableExists(db, 'a')).toBe(false);
    expect(tableExists(db, 'schema_migrations')).toBe(false);
    closeDatabase(db);
  });

  it('a failing migration leaves earlier ones applied and later ones not', () => {
    const db = openDatabase(':memory:');
    const bad: Migration = {
      version: 2,
      name: '0002_bad',
      up: (d) => {
        d.exec('CREATE TABLE b (id INTEGER)');
        throw new Error('boom');
      },
    };
    const m3: Migration = {
      version: 3,
      name: '0003_c',
      up: (d) => d.exec('CREATE TABLE c (id INTEGER)'),
    };
    expect(() => migrate(db, [m1, bad, m3], { backupDir })).toThrow('boom');
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }]);
    expect(tableExists(db, 'b')).toBe(false);
    expect(tableExists(db, 'c')).toBe(false);
    closeDatabase(db);
  });

  it('a migration with foreignKeys off runs with the pragma off and on again afterwards; violations it leaves roll it back', () => {
    const db = openDatabase(':memory:');
    let seen: unknown;
    const off: Migration = {
      ...m2,
      foreignKeys: 'off',
      up: (d) => {
        seen = d.pragma('foreign_keys', { simple: true });
        d.exec('CREATE TABLE b (id INTEGER)');
      },
    };
    migrate(db, [m1, off], { backupDir });
    expect(seen).toBe(0);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    closeDatabase(db);

    const db2 = openDatabase(':memory:');
    const bad: Migration = {
      ...m2,
      foreignKeys: 'off',
      up: (d) => {
        d.exec(
          'CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (p INTEGER REFERENCES parent(id)); INSERT INTO child VALUES (7)',
        );
      },
    };
    expect(() => migrate(db2, [m1, bad], { backupDir })).toThrow(/foreign key violations/);
    expect(db2.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }]);
    expect(tableExists(db2, 'child')).toBe(false);
    expect(db2.pragma('foreign_keys', { simple: true })).toBe(1);
    closeDatabase(db2);
  });

  it('violations that exist before a foreignKeys-off migration are reported as such, not blamed on it', () => {
    const db = openDatabase(':memory:');
    migrate(db, [m1], { backupDir });
    db.pragma('foreign_keys = OFF');
    db.exec(
      'CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (p INTEGER REFERENCES parent(id)); INSERT INTO child VALUES (7)',
    );
    db.pragma('foreign_keys = ON');
    let ran = false;
    const off: Migration = {
      ...m2,
      foreignKeys: 'off',
      up: () => {
        ran = true;
      },
    };
    expect(() => migrate(db, [m1, off], { backupDir })).toThrow(
      /database has foreign key violations before migration .*child rowid 1.*restore the backup/,
    );
    expect(ran).toBe(false);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    closeDatabase(db);
  });
});
