import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../open.ts';
import { findJob, insertJobResult, updateJob } from './jobs/jobs.ts';
import { at, insertTestJob, now, result, seededDb } from './jobs/testing.ts';
import { insertRun, listRuns, runCounts } from './runs.ts';

let db: Database;
beforeEach(() => {
  db = seededDb();
});
afterEach(() => {
  db.close();
});
const job = (id: string, extra: Parameters<typeof insertTestJob>[2] = {}, when = now) =>
  insertTestJob(db, id, extra, when);

describe('runs', () => {
  it('runCounts reconciles states, counts queued apart from running, and sums bytes of done jobs', () => {
    job('q');
    job('d');
    updateJob(db, 'd', { state: 'done' }, at(1));
    insertJobResult(db, result('d'));
    job('s', { state: 'skipped', reason: 'outside library root' });
    job('e');
    updateJob(db, 'e', { state: 'encoding' }, at(1));
    expect(runCounts(db, 'r1')).toEqual({
      done: 1,
      nothing_to_do: 0,
      kept_original: 0,
      failed: 0,
      cancelled: 0,
      dry_run: 0,
      skipped: 1,
      already_processed: 0,
      queued: 1,
      in_progress: 1,
      total: 4,
      beforeBytes: 100,
      afterBytes: 60,
      dependsOnSize: 0,
    });
    expect(findJob(db, 's')).toMatchObject({ reason: 'outside library root' });
    expect(findJob(db, 's')?.finishedAt).toBe(now.toISOString());
  });

  it('listRuns is newest first', () => {
    insertRun(
      db,
      {
        id: 'r2',
        libraryId: 'l1',
        workflowId: 'w1',
        workflowVersion: 1,
        requestedPath: '/media/tv/a.mkv',
        dryRun: true,
        testEncode: false,
        force: true,
        createdBy: 'u',
      },
      at(1),
    );
    expect(listRuns(db, { limit: 10 }).map((r) => [r.id, r.dryRun])).toEqual([
      ['r2', true],
      ['r1', false],
    ]);
  });
});

describe('run notes and job re-pinning', () => {
  it('runs store and return note; updateJob can re-pin workflowVersion', () => {
    const base = {
      libraryId: 'l1',
      workflowId: 'w1',
      workflowVersion: 1,
      requestedPath: '/media/tv',
      dryRun: true,
      testEncode: false,
      force: false,
      createdBy: 'u',
    };
    expect(insertRun(db, { ...base, id: 'rn', note: 'try the new audio rule' }, at(1)).note).toBe(
      'try the new audio rule',
    );
    expect(insertRun(db, { ...base, id: 'rm' }, at(2)).note).toBeNull();
    expect(listRuns(db, { limit: 10 }).map((r) => [r.id, r.note])).toEqual([
      ['rm', null],
      ['rn', 'try the new audio rule'],
      ['r1', null],
    ]);
    job('p');
    expect(updateJob(db, 'p', { workflowVersion: 3 }, at(1))).toMatchObject({ workflowVersion: 3 });
    expect(findJob(db, 'p')?.workflowVersion).toBe(3);
  });
});
