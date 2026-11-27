import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../open.ts';
import { insertRestore, markRestoreUndone } from '../restores.ts';
import { setJobProbe } from './jobs.ts';
import { insertJobResult, type JobResultRow } from './results.ts';
import { allTimeSaved, jobHistory, jobStats } from './stats.ts';
import { insertTestJob, now, result, seededDb } from './testing.ts';

let db: Database;
beforeEach(() => {
  db = seededDb();
});
afterEach(() => {
  db.close();
});
const job = (id: string, extra: Parameters<typeof insertTestJob>[2] = {}, when = now) =>
  insertTestJob(db, id, extra, when);

describe('job history', () => {
  /** A job with a result created at `createdAt`; `seconds` is the probed source duration. */
  function finished(id: string, createdAt: string, extra: Partial<JobResultRow>, seconds?: number) {
    job(id);
    if (seconds !== undefined) setJobProbe(db, id, { durationSeconds: seconds });
    insertJobResult(db, result(id, { createdAt, ...extra }));
  }
  const bounds = [
    '2026-10-23T04:00:00.000Z',
    '2026-10-24T04:00:00.000Z',
    '2026-10-25T04:00:00.000Z',
  ];

  it('jobHistory buckets results by the bounds it is given', () => {
    finished('a', '2026-10-24T03:59:00.000Z', {});
    finished('b', '2026-10-24T04:00:00.000Z', {});
    expect(jobHistory(db, bounds).map((d) => d.replaced)).toEqual([1, 1]);
  });

  it('counts done as replaced and saved, kept_original as kept, both as processed seconds', () => {
    const t = '2026-10-24T12:00:00.000Z';
    finished('done', t, { beforeBytes: 10_000, afterBytes: 4_000 }, 1800);
    finished('kept', t, { outcome: 'kept_original', beforeBytes: 5_000, afterBytes: 6_000 }, 600);
    finished('dry', t, { outcome: 'dry_run' }, 100);
    finished('none', t, { outcome: 'nothing_to_do' }, 100);
    finished('bad', t, { outcome: 'failed' }, 100);
    expect(jobHistory(db, bounds)[1]).toEqual({
      savedBytes: 6000,
      replaced: 1,
      kept: 1,
      seconds: 2400,
    });
  });

  it('a day whose replaced files grew saves 0, never less', () => {
    finished('grew', '2026-10-24T12:00:00.000Z', { beforeBytes: 1000, afterBytes: 3000 });
    expect(jobHistory(db, bounds)[1]?.savedBytes).toBe(0);
  });

  it('null sizes count as 0', () => {
    finished('nulls', '2026-10-24T12:00:00.000Z', { beforeBytes: null, afterBytes: 0 });
    const day = jobHistory(db, bounds)[1];
    expect(day?.savedBytes).toBe(0);
    expect(day?.seconds).toBe(0);
  });

  // Review Focus 4

  it('space saved flips with restore and undo', () => {
    const t = '2026-10-24T12:00:00.000Z';
    finished('j1', t, { beforeBytes: 1000, afterBytes: 300 });
    expect(allTimeSaved(db).savedBytes).toBe(700);
    insertRestore(db, {
      id: 'rs1',
      jobId: 'j1',
      restoredAt: t,
      restoredBy: 'u1',
      sidecarPaths: [],
    });
    expect(allTimeSaved(db)).toMatchObject({ savedBytes: 0, files: 1 });
    expect(jobStats(db, bounds[0] as string)).toMatchObject({ savedBytes: 0, files: 1 });
    expect(jobHistory(db, bounds)[1]).toMatchObject({ savedBytes: 0, replaced: 1 });
    markRestoreUndone(db, 'rs1', t, 'u1');
    expect(allTimeSaved(db).savedBytes).toBe(700);
    expect(jobStats(db, bounds[0] as string).savedBytes).toBe(700);
    expect(jobHistory(db, bounds)[1]?.savedBytes).toBe(700);
  });

  it('allTimeSaved on an empty database', () => {
    expect(allTimeSaved(db)).toEqual({ savedBytes: 0, files: 0, since: null });
  });

  it('allTimeSaved matches jobStats since the epoch', () => {
    finished('first', '2026-10-17T20:00:00.000Z', { outcome: 'dry_run' });
    finished('x', '2026-10-20T12:00:00.000Z', { beforeBytes: 900, afterBytes: 300 });
    finished('y', '2026-10-24T12:00:00.000Z', { beforeBytes: 100, afterBytes: 400 });
    finished('k', '2026-10-24T13:00:00.000Z', { outcome: 'kept_original' });
    const all = allTimeSaved(db);
    expect(all).toEqual({ savedBytes: 300, files: 2, since: '2026-10-17T20:00:00.000Z' });
    expect(all.savedBytes).toBe(jobStats(db, '1970-01-01T00:00:00.000Z').savedBytes);
  });
});
