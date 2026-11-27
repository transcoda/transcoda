import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../open.ts';
import { findJob, updateJob } from './jobs.ts';
import { claimRestoreJournal, hasFileJournal, jobsWithRestoreJournal } from './journals.ts';
import type { ReplaceJournal, RestoreJournal } from './rows.ts';
import { insertTestJob, now, seededDb } from './testing.ts';

let db: Database;
beforeEach(() => {
  db = seededDb();
});
afterEach(() => {
  db.close();
});
const job = (id: string, extra: Parameters<typeof insertTestJob>[2] = {}, when = now) =>
  insertTestJob(db, id, extra, when);

describe('journals', () => {
  it('claimRestoreJournal refuses while either journal is set; hasFileJournal sees both', () => {
    const j: RestoreJournal = {
      direction: 'restore',
      restoreId: 's1',
      libraryRoot: '/media',
      moves: [{ from: '/media/tv/r.mkv', to: '/media/tv/.rb/r.mkv', role: 'output' }],
      next: 0,
    };
    job('r');
    expect(hasFileJournal(db, 'r')).toBe(false);
    expect(claimRestoreJournal(db, 'r', j)).toBe(true);
    expect(claimRestoreJournal(db, 'r', j)).toBe(false);
    expect(findJob(db, 'r')?.restoreJournal).toEqual(j);
    expect(hasFileJournal(db, 'r')).toBe(true);
    expect(jobsWithRestoreJournal(db).map((x) => x.id)).toEqual(['r']);
    updateJob(db, 'r', { restoreJournal: null }, now);
    expect(jobsWithRestoreJournal(db)).toEqual([]);

    job('p');
    updateJob(db, 'p', { replaceJournal: { step: 'checking' } as unknown as ReplaceJournal }, now);
    expect(claimRestoreJournal(db, 'p', j)).toBe(false);
    expect(hasFileJournal(db, 'p')).toBe(true);
  });
});
