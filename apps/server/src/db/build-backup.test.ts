import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Sqlite from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { listBackups } from './backup.ts';
import { backupOnBuildChange, hashBuildFile, LAST_BUILD_ID_KEY } from './build-backup.ts';
import { closeDatabase, type Database } from './open.ts';
import { getSetting, setSetting } from './repos/settings.ts';
import { createTestDb } from './test-db.ts';

const at = new Date(2026, 9, 21, 18, 0, 1);

describe('hashBuildFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-build-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is a short sha256 of the file, changing with its content', () => {
    const file = path.join(dir, 'main.js');
    fs.writeFileSync(file, 'console.log(1)');
    const a = hashBuildFile(file);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(hashBuildFile(file)).toBe(a);
    fs.writeFileSync(file, 'console.log(2)');
    expect(hashBuildFile(file)).not.toBe(a);
  });

  it('a missing file → null', () => {
    expect(hashBuildFile(path.join(dir, 'nope.js'))).toBeNull();
  });
});

describe('backupOnBuildChange', () => {
  let dir: string;
  let db: Database;
  const log = vi.fn<(m: string) => void>();
  const stored = () => getSetting(db, LAST_BUILD_ID_KEY, z.string());
  const run = (
    buildId: string,
    over: { existedBefore?: boolean; migrationBackup?: boolean } = {},
  ) =>
    backupOnBuildChange(db, {
      backupDir: dir,
      buildId,
      existedBefore: over.existedBefore ?? true,
      migrationBackup: over.migrationBackup ?? false,
      now: () => at,
      log,
    });

  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-build-')), 'backups');
    db = createTestDb();
    log.mockReset();
  });
  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it('a brand-new database stores the id and takes no backup', () => {
    expect(run('aaa', { existedBefore: false }).backupFile).toBeNull();
    expect(stored()).toBe('aaa');
    expect(listBackups(dir)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('an existing database with no stored id is backed up once (an install from before this check)', () => {
    const r = run('aaa');
    expect(r.backupFile && path.basename(r.backupFile)).toBe(
      'transcoda-20261021-180001-v13-build.sqlite',
    );
    expect(stored()).toBe('aaa');
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toMatch(/^Build changed \(none → aaa\); backed up database to /);
  });

  it('the same build takes no backup', () => {
    setSetting(db, LAST_BUILD_ID_KEY, 'aaa', at);
    expect(run('aaa').backupFile).toBeNull();
    expect(listBackups(dir)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('a different build is backed up before the new id is stored', () => {
    setSetting(db, LAST_BUILD_ID_KEY, 'aaa', at);
    const r = run('bbb');
    expect(r).toMatchObject({ previous: 'aaa' });
    expect(listBackups(dir)).toEqual(['transcoda-20261021-180001-v13-build.sqlite']);
    expect(stored()).toBe('bbb');
    expect(log.mock.calls[0]?.[0]).toMatch(/^Build changed \(aaa → bbb\); backed up database to /);
    // The backup holds the old id: restoring it and starting this build backs up again.
    const copy = new Sqlite(r.backupFile as string, { readonly: true });
    expect(copy.prepare('SELECT value FROM settings WHERE key = ?').get(LAST_BUILD_ID_KEY)).toEqual(
      {
        value: '"aaa"',
      },
    );
    copy.close();
  });

  it('no second backup when the migration just took one; the id is still stored', () => {
    setSetting(db, LAST_BUILD_ID_KEY, 'aaa', at);
    expect(run('bbb', { migrationBackup: true }).backupFile).toBeNull();
    expect(listBackups(dir)).toEqual([]);
    expect(stored()).toBe('bbb');
  });

  it('keeps 5 build backups and never prunes a migration backup for one', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcoda-20261001-120000-v6.sqlite'), '');
    for (let i = 0; i < 5; i++)
      fs.writeFileSync(path.join(dir, `transcoda-2026101${i}-120000-v7-build.sqlite`), '');
    setSetting(db, LAST_BUILD_ID_KEY, 'aaa', at);
    run('bbb');
    expect(listBackups(dir)).toEqual([
      'transcoda-20261001-120000-v6.sqlite',
      'transcoda-20261011-120000-v7-build.sqlite',
      'transcoda-20261012-120000-v7-build.sqlite',
      'transcoda-20261013-120000-v7-build.sqlite',
      'transcoda-20261014-120000-v7-build.sqlite',
      'transcoda-20261021-180001-v13-build.sqlite',
    ]);
  });
});
