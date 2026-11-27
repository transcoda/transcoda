import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../open.ts';
import { now, seededDb } from './jobs/testing.ts';
import {
  deleteRecycled,
  findRecycled,
  insertRecycled,
  listRecycled,
  listRecycledForJob,
} from './recycled.ts';

let db: Database;
beforeEach(() => {
  db = seededDb();
});
afterEach(() => {
  db.close();
});

describe('recycled', () => {
  it('recycled rows insert, list and delete', () => {
    const row = {
      path: '/media/tv/.rb/a.mkv',
      libraryId: 'l1',
      jobId: 'a',
      sizeBytes: 100,
      recycledAt: now.toISOString(),
    };
    insertRecycled(db, row);
    const stored = { ...row, kind: 'original', originalPath: null, restoreId: null };
    expect(listRecycled(db)).toEqual([stored]);
    expect(listRecycled(db, 'other')).toEqual([]);
    expect(deleteRecycled(db, row.path)).toBe(true);
    expect(listRecycled(db, 'l1')).toEqual([]);
  });

  it('a second original recycled to the same path replaces the stale row and returns it (C5)', () => {
    // The first original was moved back out of the recycle folder by hand; its row stayed.
    const first = {
      path: '/media/tv/.rb/a.mkv',
      libraryId: 'l1',
      jobId: 'a',
      sizeBytes: 100,
      recycledAt: now.toISOString(),
    };
    const second = {
      ...first,
      jobId: 'b',
      sizeBytes: 250,
      recycledAt: new Date(now.getTime() + 60_000).toISOString(),
    };
    const plain = { kind: 'original', originalPath: null, restoreId: null };
    expect(insertRecycled(db, first)).toBeNull();
    expect(insertRecycled(db, second)).toEqual({ ...first, ...plain });
    expect(listRecycled(db)).toEqual([{ ...second, ...plain }]);
  });

  it('insertRecycled keeps kind and original path, also on conflict; findRecycled and listRecycledForJob', () => {
    const base = { libraryId: 'l1', jobId: 'a', sizeBytes: 1, recycledAt: now.toISOString() };
    insertRecycled(db, { ...base, path: '/media/tv/.rb/a.mkv', originalPath: '/media/tv/a.mkv' });
    insertRecycled(db, {
      ...base,
      path: '/media/tv/.rb/a.de.srt',
      kind: 'sidecar',
      originalPath: '/media/tv/a.de.srt',
    });
    insertRecycled(db, {
      ...base,
      path: '/media/tv/.rb/a.mkv',
      kind: 'restored-output',
      originalPath: '/media/tv/a.mkv',
      restoreId: 's1',
    });
    expect(findRecycled(db, '/media/tv/.rb/a.mkv')).toMatchObject({
      kind: 'restored-output',
      originalPath: '/media/tv/a.mkv',
      restoreId: 's1',
    });
    expect(findRecycled(db, '/nope')).toBeNull();
    expect(
      listRecycledForJob(db, 'a')
        .map((r) => r.kind)
        .sort(),
    ).toEqual(['restored-output', 'sidecar']);
  });
});
