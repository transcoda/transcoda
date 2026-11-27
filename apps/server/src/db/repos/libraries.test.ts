import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../open.ts';
import { at, now, seededDb } from './jobs/testing.ts';
import {
  clearMigrationNotices,
  findLibrary,
  insertLibrary,
  listLibraries,
  listMigrationNotices,
  softDeleteLibrary,
  updateLibrary,
} from './libraries.ts';
import { setSetting } from './settings.ts';

let db: Database;
beforeEach(() => {
  db = seededDb();
});
afterEach(() => {
  db.close();
});

describe('libraries', () => {
  it('migration notices: [] without the settings row, its array with one; clearing removes the row', () => {
    expect(listMigrationNotices(db)).toEqual([]);
    setSetting(db, 'libraries.migrationNotices', ['one', 'two'], now);
    expect(listMigrationNotices(db)).toEqual(['one', 'two']);
    clearMigrationNotices(db);
    expect(listMigrationNotices(db)).toEqual([]);
    expect(
      db.prepare("SELECT 1 FROM settings WHERE key = 'libraries.migrationNotices'").get(),
    ).toBeUndefined();
  });

  it('listLibraries ignores deleted libraries', () => {
    insertLibrary(
      db,
      {
        id: 'l0',
        name: 'Media',
        path: '/media',
        recycleFolder: '/media/.rb',
        processHardlinked: true,
      },
      now,
    );
    expect(
      listLibraries(db)
        .map((l) => l.id)
        .sort(),
    ).toEqual(['l0', 'l1']);
    expect(softDeleteLibrary(db, 'l0', at(1))).toBe(true);
    expect(listLibraries(db).map((l) => l.id)).toEqual(['l1']);
  });

  it('updateLibrary patches fields and bumps updatedAt', () => {
    const l = updateLibrary(db, 'l1', { name: 'Shows', processHardlinked: true }, at(5));
    expect(l).toMatchObject({
      name: 'Shows',
      processHardlinked: true,
      updatedAt: at(5).toISOString(),
    });
    expect(findLibrary(db, 'l1')?.name).toBe('Shows');
    expect(updateLibrary(db, 'nope', { name: 'x' }, now)).toBeNull();
    expect(updateLibrary(db, 'l1', { verifyFullDecode: true }, at(5))?.verifyFullDecode).toBe(true);
    expect(findLibrary(db, 'l1')).toMatchObject({ name: 'Shows', verifyFullDecode: true });
    softDeleteLibrary(db, 'l1', at(6));
    expect(updateLibrary(db, 'l1', { name: 'Gone' }, at(7))).toBeNull();
    expect(findLibrary(db, 'l1')?.name).toBe('Shows');
  });

  it('stores paths without a trailing slash; a live path is unique, a deleted one can be re-added', () => {
    const lib = {
      name: 'Films',
      recycleFolder: null,
      processHardlinked: false,
    };
    expect(insertLibrary(db, { ...lib, id: 'f1', path: '/media/films/' }, now).path).toBe(
      '/media/films',
    );
    expect(findLibrary(db, 'f1')?.path).toBe('/media/films');
    // verifyFullDecode defaults to false and round-trips when set.
    expect(findLibrary(db, 'f1')?.verifyFullDecode).toBe(false);
    expect(
      insertLibrary(db, { ...lib, id: 'vd1', path: '/media/docs', verifyFullDecode: true }, now)
        .verifyFullDecode,
    ).toBe(true);
    expect(findLibrary(db, 'vd1')?.verifyFullDecode).toBe(true);
    expect(() => insertLibrary(db, { ...lib, id: 'f2', path: '/media/films' }, now)).toThrow(
      expect.objectContaining({ code: 'SQLITE_CONSTRAINT_UNIQUE' }),
    );
    softDeleteLibrary(db, 'f1', at(1));
    insertLibrary(db, { ...lib, id: 'f3', path: '/media/films//' }, at(2));
    expect(findLibrary(db, 'f3')?.path).toBe('/media/films');
  });
});
