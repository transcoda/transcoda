import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../open.ts';
import { markFolderListing, upsertFile } from './files.ts';
import { at, fp, now, seededDb } from './jobs/testing.ts';
import { insertLibrary } from './libraries.ts';

let db: Database;
beforeEach(() => {
  db = seededDb();
});
afterEach(() => {
  db.close();
});

describe('upsertFile', () => {
  it('upsertFile inserts then updates by path, keeping the id', () => {
    const f = upsertFile(
      db,
      { libraryId: 'l1', path: '/media/tv/a.mkv', fingerprint: fp, lastProbe: null },
      now,
    );
    expect(f).toMatchObject({ sizeBytes: 100, fingerprint: '3:2:100:1', lastProbe: null });
    const g = upsertFile(
      db,
      {
        libraryId: 'l1',
        path: '/media/tv/a.mkv',
        fingerprint: { ...fp, sizeBytes: 50 },
        lastProbe: { ok: true },
      },
      at(1),
    );
    expect(g).toMatchObject({ id: f.id, sizeBytes: 50, lastProbe: { ok: true } });
    // A re-queue of the same file writes no probe: the stored one stays.
    const h = upsertFile(
      db,
      {
        libraryId: 'l1',
        path: '/media/tv/a.mkv',
        fingerprint: { ...fp, sizeBytes: 50 },
        lastProbe: null,
      },
      at(2),
    );
    expect(h).toMatchObject({ id: f.id, sizeBytes: 50, lastProbe: { ok: true } });
    // A changed file queued without a probe: the stored probe was of the previous file.
    const k = upsertFile(
      db,
      { libraryId: 'l1', path: '/media/tv/a.mkv', fingerprint: fp, lastProbe: null },
      at(3),
    );
    expect(k).toMatchObject({ id: f.id, sizeBytes: 100, lastProbe: null });
  });
});

describe('markFolderListing', () => {
  const goneAt = (path: string): string | null =>
    (db.prepare('SELECT gone_at FROM files WHERE path = ?').get(path) as { gone_at: string | null })
      .gone_at;
  const seed = (path: string): void => {
    upsertFile(db, { libraryId: 'l1', path, fingerprint: fp, lastProbe: null }, now);
  };
  const A = '/media/tv/A/a.mkv';
  const B = '/media/tv/A/b.mkv';
  const C = '/media/tv/B/c.mkv';
  const D = '/media/tv/A2/d.mkv';
  beforeEach(() => {
    for (const p of [A, B, C, D]) seed(p);
  });

  it('marks rows under the folder that the listing lacks, and clears listed ones', () => {
    db.prepare('UPDATE files SET gone_at = ? WHERE path = ?').run(at(-5).toISOString(), B);
    expect(
      markFolderListing(db, { libraryId: 'l1', folder: '/media/tv', paths: [B, C, D] }, now),
    ).toEqual({ gone: 1, back: 1 });
    expect(goneAt(A)).toBe(now.toISOString());
    expect(goneAt(B)).toBeNull();
    expect(goneAt(C)).toBeNull();
  });

  it('a sub-folder listing leaves files outside it alone', () => {
    markFolderListing(db, { libraryId: 'l1', folder: '/media/tv/A', paths: [] }, now);
    expect(goneAt(C)).toBeNull();
    expect(goneAt(A)).toBe(now.toISOString());
    expect(goneAt(B)).toBe(now.toISOString());
  });

  it('a folder name that is a prefix of a sibling does not reach the sibling', () => {
    markFolderListing(db, { libraryId: 'l1', folder: '/media/tv/A', paths: [] }, now);
    expect(goneAt(D)).toBeNull();
  });

  it('% and _ in a folder name are literal', () => {
    seed('/media/tv/50%/e.mkv');
    seed('/media/tv/50x/f.mkv');
    markFolderListing(db, { libraryId: 'l1', folder: '/media/tv/50%', paths: [] }, now);
    expect(goneAt('/media/tv/50%/e.mkv')).toBe(now.toISOString());
    expect(goneAt('/media/tv/50x/f.mkv')).toBeNull();
  });

  it('keeps the first gone time on a second listing', () => {
    markFolderListing(db, { libraryId: 'l1', folder: '/media/tv', paths: [B, C, D] }, now);
    expect(
      markFolderListing(db, { libraryId: 'l1', folder: '/media/tv', paths: [B, C, D] }, at(10)),
    ).toEqual({ gone: 0, back: 0 });
    expect(goneAt(A)).toBe(now.toISOString());
  });

  it('leaves files under an unlisted sub-folder alone', () => {
    markFolderListing(
      db,
      { libraryId: 'l1', folder: '/media/tv', paths: [C, D], unlisted: ['/media/tv/A'] },
      now,
    );
    expect(goneAt(A)).toBeNull();
    expect(goneAt(B)).toBeNull();
  });

  it('leaves rows written since the listing started alone', () => {
    // A is seeded at `now`; B is queued (written) after a listing that began at at(5).
    upsertFile(db, { libraryId: 'l1', path: B, fingerprint: fp, lastProbe: null }, at(6));
    expect(
      markFolderListing(
        db,
        { libraryId: 'l1', folder: '/media/tv', paths: [C, D], startedAt: at(5) },
        at(7),
      ),
    ).toEqual({ gone: 1, back: 0 });
    expect(goneAt(A)).toBe(at(7).toISOString());
    expect(goneAt(B)).toBeNull();
  });

  it("never touches another library's rows", () => {
    insertLibrary(
      db,
      {
        id: 'l2',
        name: 'Films',
        path: '/media/films',
        recycleFolder: null,
        processHardlinked: false,
      },
      now,
    );
    upsertFile(
      db,
      { libraryId: 'l2', path: '/media/tv/A/x.mkv', fingerprint: fp, lastProbe: null },
      now,
    );
    markFolderListing(db, { libraryId: 'l1', folder: '/media/tv', paths: [] }, now);
    expect(goneAt('/media/tv/A/x.mkv')).toBeNull();
  });

  it('upsertFile clears gone_at', () => {
    markFolderListing(db, { libraryId: 'l1', folder: '/media/tv', paths: [] }, now);
    expect(goneAt(A)).toBe(now.toISOString());
    const f = upsertFile(db, { libraryId: 'l1', path: A, fingerprint: fp, lastProbe: null }, at(1));
    expect(f.goneAt).toBeNull();
    expect(goneAt(A)).toBeNull();
  });
});
