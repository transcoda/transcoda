import { JOB_STATES } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrations } from '../../migrations/index.ts';
import type { Database } from '../../open.ts';
import { findJob, hasActiveJobAt, nextQueuedJobs, updateJob } from './jobs.ts';
import { countJobsByState, countProblems, findJobListRow, listJobs } from './list.ts';
import { findJobResult, insertJobResult } from './results.ts';
import type { ReplaceJournal } from './rows.ts';
import { jobStats } from './stats.ts';
import { at, fp, insertTestJob, now, result, seededDb } from './testing.ts';

let db: Database;
beforeEach(() => {
  db = seededDb();
});
afterEach(() => {
  db.close();
});
const job = (id: string, extra: Parameters<typeof insertTestJob>[2] = {}, when = now) =>
  insertTestJob(db, id, extra, when);

describe('migration 0003', () => {
  it('is the third migration', () => {
    const row = db
      .prepare("SELECT version AS v FROM schema_migrations WHERE name = '0003_engine'")
      .get();
    expect(row).toEqual({ v: 3 });
  });
});

describe('newest migration', () => {
  it('is the newest migration; jobs.probe (0004) is there', () => {
    const row = db.prepare('SELECT MAX(version) AS v, COUNT(*) AS n FROM schema_migrations').get();
    expect(row).toEqual({ v: migrations.length, n: migrations.length });
    const cols = db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('probe');
  });
});

describe('job media', () => {
  const stored = {
    kind: 'movie' as const,
    title: 'Shepherd Jr.',
    year: 1924,
    season: null,
    episode: null,
    episodeTitle: null,
    source: 'sidecar' as const,
    posterPath: '/media/tv/poster.jpg',
  };

  it('stores the media given at insert and reads NULL without', () => {
    expect(job('m1', { media: stored }).media).toEqual(stored);
    expect(findJob(db, 'm1')?.media).toEqual(stored);
    expect(job('m2').media).toBeNull();
    expect(findJob(db, 'm2')?.media).toBeNull();
    expect(findJobListRow(db, 'm1')?.media).toEqual(stored);
  });

  it('a list row without stored media parses the file name; invalid JSON does the same', () => {
    const fallback = {
      kind: 'episode',
      title: 'Starfall',
      season: 2,
      episode: 7,
      source: 'filename',
      posterPath: null,
    };
    job('n1', { path: '/media/shows/Starfall/Starfall S02E07.mkv' });
    expect(findJobListRow(db, 'n1')?.media).toMatchObject(fallback);
    job('n2', { path: '/media/shows/Starfall/Starfall S02E07.mkv' });
    db.prepare("UPDATE jobs SET media = '{not json' WHERE id = 'n2'").run();
    expect(findJob(db, 'n2')?.media).toBeNull();
    expect(findJobListRow(db, 'n2')?.media).toMatchObject(fallback);
  });

  it('reads a cell of the wrong shape as none, so the list row parses the file name', () => {
    const fallback = { kind: 'movie', title: 'The Gardener', year: 1926, source: 'filename' };
    const bad = [
      { ...stored, title: null },
      { ...stored, title: '' },
      { ...stored, kind: 'documentary' },
      { ...stored, source: 'web' },
      { ...stored, year: '1924' },
      { ...stored, season: 1.5 },
      { ...stored, episodeTitle: 7 },
      { ...stored, posterPath: 42 },
      { kind: 'movie' },
      [stored],
      'Shepherd Jr.',
    ];
    bad.forEach((cell, i) => {
      const id = `w${i}`;
      job(id, { path: '/media/movies/The Gardener (1926).mkv' });
      db.prepare('UPDATE jobs SET media = ? WHERE id = ?').run(JSON.stringify(cell), id);
      expect(findJob(db, id)?.media, JSON.stringify(cell)).toBeNull();
      expect(findJobListRow(db, id)?.media).toMatchObject(fallback);
    });
  });
});

describe('job GPU fields', () => {
  it('reads a corrupt failed_gpus cell as an empty list', () => {
    job('g');
    db.prepare("UPDATE jobs SET failed_gpus = 'not json' WHERE id = 'g'").run();
    expect(findJob(db, 'g')?.failedGpus).toEqual([]);
    expect(findJobListRow(db, 'g')).toBeTruthy();
  });

  it('reads corrupt warnings and problems_json cells as empty lists', () => {
    job('bad');
    updateJob(db, 'bad', { state: 'done', finishedAt: now.toISOString() }, now);
    insertJobResult(db, result('bad', { warnings: ['w'], problems: ['p'] }));
    db.prepare(
      "UPDATE job_results SET warnings = 'not json', problems_json = '{' WHERE job_id = 'bad'",
    ).run();
    expect(findJobResult(db, 'bad')).toMatchObject({ warnings: [], problems: [] });
    expect(findJobListRow(db, 'bad')?.problems).toEqual([]);
    expect(listJobs(db, {}).map((r) => r.id)).toEqual(['bad']);
    // The SQL reads of problems_json (filter, count, stats) treat the corrupt cell as no problems.
    expect(listJobs(db, { problems: true })).toEqual([]);
    expect(countProblems(db, {})).toBe(0);
    expect(jobStats(db, at(-60).toISOString()).problems).toBe(0);
    // Only text entries count, as the row reader keeps only strings; an object is no list.
    for (const cell of ['[null]', '[1, {}]', '{"a": "b"}']) {
      db.prepare('UPDATE job_results SET problems_json = ? WHERE job_id = ?').run(cell, 'bad');
      expect(findJobListRow(db, 'bad')?.problems).toEqual([]);
      expect(listJobs(db, { problems: true })).toEqual([]);
      expect(countProblems(db, {})).toBe(0);
      expect(jobStats(db, at(-60).toISOString()).problems).toBe(0);
    }
    db.prepare('UPDATE job_results SET problems_json = ? WHERE job_id = ?').run(
      '[null, "p"]',
      'bad',
    );
    expect(listJobs(db, { problems: true }).map((r) => r.id)).toEqual(['bad']);
    expect(countProblems(db, {})).toBe(1);
  });

  it('start empty and round-trip encodedOn and failedGpus through updateJob', () => {
    expect(job('g')).toMatchObject({ encodedOn: null, failedGpus: [] });
    const updated = updateJob(
      db,
      'g',
      { encodedOn: 'GPU 1', failedGpus: ['nvidia:0', 'intel:0000:07:00.0'] },
      at(1),
    );
    expect(updated).toMatchObject({
      encodedOn: 'GPU 1',
      failedGpus: ['nvidia:0', 'intel:0000:07:00.0'],
    });
    expect(findJobListRow(db, 'g')).toMatchObject({ encodedOn: 'GPU 1' });
    expect(updateJob(db, 'g', { encodedOn: null, failedGpus: [] }, at(2))).toMatchObject({
      encodedOn: null,
      failedGpus: [],
    });
  });
});

describe('jobs', () => {
  it('insertJob/updateJob round-trip progress and replaceJournal JSON', () => {
    expect(job('a')).toMatchObject({
      state: 'queued',
      paused: false,
      lane: null,
      attempt: 1,
      requeues: 0,
      progress: null,
      replaceJournal: null,
      finishedAt: null,
    });
    const progress = {
      percent: 50,
      outTimeSeconds: 12.5,
      speed: 1.5,
      fps: null,
      sizeBytes: 1000,
      etaSeconds: 30,
    };
    const replaceJournal: ReplaceJournal = {
      step: 'moving_original',
      originalPath: '/media/tv/a.mkv',
      tmpPath: '/media/tv/.transcoda-a.tmp',
      outputPath: '/transcode/a/out.mkv',
      copyPath: '/media/tv/.recycle/a.mkv',
      libraryRoot: '/media/tv',
      fingerprint: fp,
      outputBytes: 60,
    };
    const updated = updateJob(
      db,
      'a',
      { state: 'encoding', lane: 'encode', progress, replaceJournal },
      at(1),
    );
    expect(updated).toMatchObject({ state: 'encoding', lane: 'encode', progress, replaceJournal });
    expect(findJob(db, 'a')).toEqual(updated);
    expect(updateJob(db, 'a', { progress: null, replaceJournal: null }, at(2))).toMatchObject({
      progress: null,
      replaceJournal: null,
      updatedAt: at(2).toISOString(),
    });
    expect(updateJob(db, 'nope', { state: 'done' }, now)).toBeNull();
  });

  it('updateJob stamps finished_at when a job becomes final, once per finish', () => {
    job('a');
    expect(updateJob(db, 'a', { state: 'encoding' }, at(1))?.finishedAt).toBeNull();
    expect(updateJob(db, 'a', { state: 'failed' }, at(2))?.finishedAt).toBe(at(2).toISOString());
    expect(updateJob(db, 'a', { state: 'failed', reason: 'x' }, at(3))?.finishedAt).toBe(
      at(2).toISOString(),
    );
    updateJob(db, 'a', { state: 'queued', attempt: 2 }, at(4));
    expect(updateJob(db, 'a', { state: 'done' }, at(5))?.finishedAt).toBe(at(5).toISOString());
    expect(
      updateJob(db, 'a', { state: 'cancelled', finishedAt: at(9).toISOString() }, at(6))
        ?.finishedAt,
    ).toBe(at(9).toISOString());
  });

  it('accepts every JOB_STATES value (drift guard for the frozen list in 0003)', () => {
    for (const state of JOB_STATES) job(`s-${state}`, { state });
    expect(Object.values(countJobsByState(db, {})).every((n) => n === 1)).toBe(true);
    for (const state of JOB_STATES) insertJobResult(db, result(`s-${state}`, { outcome: state }));
  });

  it('CHECK constraints reject bad states, outcomes, flags and a final job without finished_at', () => {
    job('a');
    const constraint = expect.objectContaining({ code: 'SQLITE_CONSTRAINT_CHECK' });
    expect(() => db.prepare("UPDATE jobs SET state = 'bogus' WHERE id = 'a'").run()).toThrow(
      constraint,
    );
    expect(() =>
      insertJobResult(db, result('a', { outcome: 'bogus' as unknown as 'done' })),
    ).toThrow(constraint);
    expect(() => db.prepare("UPDATE jobs SET paused = 2 WHERE id = 'a'").run()).toThrow(constraint);
    expect(() => db.prepare("UPDATE runs SET force = 5 WHERE id = 'r1'").run()).toThrow(constraint);
    expect(() =>
      db.prepare("UPDATE libraries SET process_hardlinked = -1 WHERE id = 'l1'").run(),
    ).toThrow(constraint);
    expect(() =>
      db.prepare("UPDATE libraries SET verify_full_decode = 2 WHERE id = 'l1'").run(),
    ).toThrow(constraint);
    expect(() => db.prepare("UPDATE jobs SET state = 'done' WHERE id = 'a'").run()).toThrow(
      constraint,
    );
  });

  it('nextQueuedJobs skips paused jobs and orders by priority', () => {
    job('a', { priority: 0 });
    job('b', { priority: 3 });
    job('c', { priority: 9 });
    updateJob(db, 'c', { paused: true }, at(1));
    expect(nextQueuedJobs(db, 10).map((j) => j.id)).toEqual(['b', 'a']);
    expect(nextQueuedJobs(db, 1).map((j) => j.id)).toEqual(['b']);
  });

  it('hasActiveJobAt sees a queued or running job at the path only', () => {
    job('q');
    expect(hasActiveJobAt(db, '/media/tv/q.mkv')).toBe(true);
    updateJob(db, 'q', { state: 'done', finishedAt: now.toISOString() }, now);
    expect(hasActiveJobAt(db, '/media/tv/q.mkv')).toBe(false);
    expect(hasActiveJobAt(db, '/media/tv/other.mkv')).toBe(false);
  });
});
