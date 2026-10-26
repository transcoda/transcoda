import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backupDatabase,
  describeBackups,
  findBackupFile,
  listBackups,
  pruneBackups,
} from './backup.ts';
import { closeDatabase, openDatabase } from './open.ts';

describe('backup', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('backupDatabase creates a readable copy', () => {
    const db = openDatabase(path.join(dir, "it's.sqlite"));
    db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('hello')");
    const out = backupDatabase(db, path.join(dir, "back'ups"), new Date(2026, 9, 16, 17, 5, 9), 3);
    expect(path.basename(out)).toBe('transcoda-20261016-170509-v3.sqlite');
    const copy = new Database(out, { readonly: true });
    expect(copy.prepare('SELECT v FROM t').get()).toEqual({ v: 'hello' });
    copy.close();
    closeDatabase(db);
  });

  it('pruneBackups keeps the 5 newest', () => {
    const names = Array.from({ length: 7 }, (_, i) => `transcoda-2026101${i}-120000-v1.sqlite`);
    for (const n of names) fs.writeFileSync(path.join(dir, n), '');
    const deleted = pruneBackups(dir, 5);
    expect(deleted.map((p) => path.basename(p)).sort()).toEqual(names.slice(0, 2));
    expect(fs.readdirSync(dir).sort()).toEqual(names.slice(2));
  });

  it('names build-change and manual backups with a suffix, same stamp format', () => {
    const db = openDatabase(':memory:');
    const at = new Date(2026, 9, 21, 18, 0, 1);
    expect(path.basename(backupDatabase(db, dir, at, 7, 'build'))).toBe(
      'transcoda-20261021-180001-v7-build.sqlite',
    );
    expect(path.basename(backupDatabase(db, dir, at, 7, 'manual'))).toBe(
      'transcoda-20261021-180001-v7-manual.sqlite',
    );
    closeDatabase(db);
  });

  it('a second backup within the same second gets a counter instead of failing', () => {
    const db = openDatabase(':memory:');
    const at = new Date(2026, 9, 21, 18, 0, 1);
    const a = backupDatabase(db, dir, at, 7);
    const b = backupDatabase(db, dir, at, 7);
    const c = backupDatabase(db, dir, at, 7);
    expect(path.basename(a)).toBe('transcoda-20261021-180001-v7.sqlite');
    expect(path.basename(b)).toBe('transcoda-20261021-180001-v7-2.sqlite');
    expect(path.basename(c)).toBe('transcoda-20261021-180001-v7-3.sqlite');
    expect(listBackups(dir).map((n) => n)).toEqual([a, b, c].map((p) => path.basename(p)));
    closeDatabase(db);
  });

  it('listBackups orders by time, then by counter, across reasons', () => {
    const names = [
      'transcoda-20261021-180001-v7-build-2.sqlite',
      'transcoda-20261020-090000-v7.sqlite',
      'transcoda-20261021-180001-v7-build.sqlite',
      'transcoda-20261021-180002-v7-manual.sqlite',
      'transcoda-20261019-235959-v6.sqlite',
    ];
    for (const n of names) fs.writeFileSync(path.join(dir, n), '');
    fs.writeFileSync(path.join(dir, 'transcoda.sqlite'), '');
    expect(listBackups(dir)).toEqual([
      'transcoda-20261019-235959-v6.sqlite',
      'transcoda-20261020-090000-v7.sqlite',
      'transcoda-20261021-180001-v7-build.sqlite',
      'transcoda-20261021-180001-v7-build-2.sqlite',
      'transcoda-20261021-180002-v7-manual.sqlite',
    ]);
    pruneBackups(dir, 1);
    expect(listBackups(dir)).toEqual([
      'transcoda-20261020-090000-v7.sqlite',
      'transcoda-20261021-180001-v7-build-2.sqlite',
      'transcoda-20261021-180002-v7-manual.sqlite',
    ]);
  });

  it('prunes per reason: manual or build backups never evict a migration backup', () => {
    const migration = 'transcoda-20261001-120000-v6.sqlite';
    fs.writeFileSync(path.join(dir, migration), '');
    const manual = Array.from(
      { length: 6 },
      (_, i) => `transcoda-2026101${i}-120000-v7-manual.sqlite`,
    );
    const build = Array.from(
      { length: 6 },
      (_, i) => `transcoda-2026101${i}-130000-v7-build.sqlite`,
    );
    for (const n of [...manual, ...build]) fs.writeFileSync(path.join(dir, n), '');
    const deleted = pruneBackups(dir, 5).map((p) => path.basename(p));
    expect(deleted.sort()).toEqual([build[0], manual[0]].sort());
    expect(listBackups(dir)).toContain(migration);
    expect(listBackups(dir)).toHaveLength(11);
  });

  it('writes to a .part file first; a failed backup leaves nothing behind and rethrows', () => {
    const db = openDatabase(':memory:');
    const at = new Date(2026, 9, 21, 18, 0, 1);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    try {
      expect(() => backupDatabase(db, dir, at, 7, 'manual')).toThrow('disk full');
      expect(rename.mock.calls[0]?.[0]).toMatch(
        /transcoda-20261021-180001-v7-manual\.sqlite\.part$/,
      );
    } finally {
      rename.mockRestore();
    }
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(listBackups(dir)).toEqual([]);
    // A leftover .part from a crash is never listed and does not block the next backup.
    fs.writeFileSync(path.join(dir, 'transcoda-20261021-180001-v7-manual.sqlite.part'), 'junk');
    expect(listBackups(dir)).toEqual([]);
    const out = backupDatabase(db, dir, at, 7, 'manual');
    expect(path.basename(out)).toBe('transcoda-20261021-180001-v7-manual.sqlite');
    expect(fs.readdirSync(dir)).toEqual(['transcoda-20261021-180001-v7-manual.sqlite']);
    closeDatabase(db);
  });

  it('describeBackups gives name, size, time and reason, newest first, never a path', () => {
    fs.writeFileSync(path.join(dir, 'transcoda-20261020-090000-v7.sqlite'), 'abc');
    fs.writeFileSync(path.join(dir, 'transcoda-20261021-180001-v7-build.sqlite'), 'abcdef');
    fs.writeFileSync(path.join(dir, 'transcoda-20261021-180002-v7-manual-2.sqlite'), '');
    const out = describeBackups(dir);
    expect(out).toEqual([
      {
        name: 'transcoda-20261021-180002-v7-manual-2.sqlite',
        size: 0,
        createdAt: new Date(2026, 9, 21, 18, 0, 2).toISOString(),
        reason: 'manual',
      },
      {
        name: 'transcoda-20261021-180001-v7-build.sqlite',
        size: 6,
        createdAt: new Date(2026, 9, 21, 18, 0, 1).toISOString(),
        reason: 'build',
      },
      {
        name: 'transcoda-20261020-090000-v7.sqlite',
        size: 3,
        createdAt: new Date(2026, 9, 20, 9, 0, 0).toISOString(),
        reason: 'migration',
      },
    ]);
    expect(describeBackups(path.join(dir, 'missing'))).toEqual([]);
  });

  it('findBackupFile opens the file itself (O_NOFOLLOW) and sizes it from fstat', () => {
    const name = 'transcoda-20261021-180001-v7-build.sqlite';
    fs.writeFileSync(path.join(dir, name), 'abcdef');
    const found = findBackupFile(dir, name);
    if (!found) throw new Error('expected the file');
    try {
      expect(found.size).toBe(6);
      expect(fs.readFileSync(found.fd, 'utf8')).toBe('abcdef');
    } finally {
      fs.closeSync(found.fd);
    }
  });

  it('findBackupFile refuses a symlink at open, even one that passed the name checks', () => {
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'secret');
    const name = 'transcoda-20261021-180001-v7-build.sqlite';
    fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(dir, name));
    const open = vi.spyOn(fs, 'openSync');
    try {
      expect(findBackupFile(dir, name)).toBeNull();
      expect(open).toHaveBeenCalledOnce();
      const flags = open.mock.calls[0]?.[1] as number;
      expect(flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
      expect(open.mock.results[0]?.type).toBe('throw');
    } finally {
      open.mockRestore();
    }
  });

  it('findBackupFile closes the fd when the target is not a regular file', () => {
    const name = 'transcoda-20261021-180001-v7-build.sqlite';
    fs.mkdirSync(path.join(dir, name));
    const close = vi.spyOn(fs, 'closeSync');
    try {
      expect(findBackupFile(dir, name)).toBeNull();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
    }
  });
});
