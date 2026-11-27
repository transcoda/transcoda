import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../open.ts';
import { insertTestJob, now, seededDb } from './jobs/testing.ts';
import { findActiveRestore, findRestore, insertRestore, markRestoreUndone } from './restores.ts';

let db: Database;
beforeEach(() => {
  db = seededDb();
});
afterEach(() => {
  db.close();
});
const job = (id: string, extra: Parameters<typeof insertTestJob>[2] = {}, when = now) =>
  insertTestJob(db, id, extra, when);

describe('restores', () => {
  it('restores: insert, find the active one, mark it undone', () => {
    job('s');
    insertRestore(db, {
      id: 's1',
      jobId: 's',
      restoredAt: now.toISOString(),
      restoredBy: 'u1',
      sidecarPaths: ['/media/tv/s.de.srt'],
    });
    expect(findActiveRestore(db, 's')).toEqual({
      id: 's1',
      jobId: 's',
      restoredAt: now.toISOString(),
      restoredBy: 'u1',
      sidecarPaths: ['/media/tv/s.de.srt'],
      sidecarKeys: {},
      undoneAt: null,
      undoneBy: null,
    });
    expect(markRestoreUndone(db, 's1', now.toISOString(), 'u2')).toBe(true);
    expect(markRestoreUndone(db, 's1', now.toISOString(), 'u2')).toBe(false);
    expect(findActiveRestore(db, 's')).toBeNull();
    expect(findRestore(db, 's1')).toMatchObject({ undoneBy: 'u2' });
  });

  it("restores: the subtitle files' keys round-trip; a row of the first form (a plain array) still reads", () => {
    job('k');
    insertRestore(db, {
      id: 'k1',
      jobId: 'k',
      restoredAt: now.toISOString(),
      restoredBy: 'u1',
      sidecarPaths: ['/media/tv/k.de.srt'],
      sidecarKeys: { '/media/tv/k.de.srt': '1:2:3:4' },
    });
    expect(findRestore(db, 'k1')).toMatchObject({
      sidecarPaths: ['/media/tv/k.de.srt'],
      sidecarKeys: { '/media/tv/k.de.srt': '1:2:3:4' },
    });
    db.prepare('UPDATE restores SET sidecar_paths = ? WHERE id = ?').run(
      '["/media/tv/k.de.srt"]',
      'k1',
    );
    expect(findRestore(db, 'k1')).toMatchObject({
      sidecarPaths: ['/media/tv/k.de.srt'],
      sidecarKeys: {},
    });
  });
});
