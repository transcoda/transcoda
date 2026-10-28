import { emptyGraph, JOB_STATES, type TraceEntry } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { migrations } from '../migrations/index.ts';
import type { Database } from '../open.ts';
import { createTestDb } from '../test-db.ts';
import {
  allTimeSaved,
  appendTrace,
  countJobsByState,
  deleteRecycled,
  findFinalRealResult,
  findJob,
  findJobListRow,
  findJobResult,
  insertJob,
  insertJobResult,
  insertRecycled,
  type JobResultRow,
  jobHistory,
  jobStats,
  listJobs,
  listRecycled,
  listTrace,
  nextQueuedJobs,
  nextTraceSeq,
  type ReplaceJournal,
  recentRatios,
  setJobProbe,
  updateJob,
  upsertFile,
} from './jobs.ts';
import {
  clearMigrationNotices,
  findLibrary,
  insertLibrary,
  listLibraries,
  listMigrationNotices,
  softDeleteLibrary,
  updateLibrary,
} from './libraries.ts';
import { insertRun, listRuns, runCounts } from './runs.ts';
import { getSettingOr, SETTING_DEFAULTS, SETTING_KEYS, setSetting } from './settings.ts';
import { insertWorkflow } from './workflows.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const at = (min: number) => new Date(now.getTime() + min * 60_000);
const fp = { sizeBytes: 100, mtimeMs: 1, ino: 2, dev: 3, nlink: 1 };

function job(id: string, extra: Partial<Parameters<typeof insertJob>[1]> = {}, when = now) {
  return insertJob(
    db,
    {
      id,
      runId: 'r1',
      libraryId: 'l1',
      fileId: null,
      path: `/media/tv/${id}.mkv`,
      workflowId: 'w1',
      workflowVersion: 1,
      dryRun: false,
      testEncode: false,
      state: 'queued',
      priority: 0,
      ...extra,
    },
    when,
  );
}

function result(jobId: string, extra: Partial<JobResultRow> = {}): JobResultRow {
  return {
    jobId,
    fingerprint: 'k1',
    workflowId: 'w1',
    workflowVersion: 1,
    outcome: 'done',
    beforeBytes: 100,
    afterBytes: 60,
    estimatedBytes: null,
    command: null,
    plan: null,
    replacedTo: 'recycle',
    logPath: null,
    warnings: [],
    problems: [],
    outputProbe: null,
    sourceDamaged: false,
    createdAt: now.toISOString(),
    ...extra,
  };
}

let db: Database;
beforeEach(() => {
  db = createTestDb();
  insertWorkflow(
    db,
    { id: 'w1', kind: 'workflow', name: 'Shrink', graph: emptyGraph('workflow'), createdBy: 'u' },
    now,
  );
  insertLibrary(
    db,
    {
      id: 'l1',
      name: 'TV',
      path: '/media/tv',
      recycleFolder: null,
      processHardlinked: false,
    },
    now,
  );
  insertRun(
    db,
    {
      id: 'r1',
      libraryId: 'l1',
      workflowId: 'w1',
      workflowVersion: 1,
      requestedPath: '/media/tv',
      dryRun: false,
      testEncode: false,
      force: false,
      createdBy: 'u',
    },
    now,
  );
});
afterEach(() => {
  db.close();
});

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

describe('source damaged results', () => {
  it('a result stores and reads back sourceDamaged, on the result and the list row', () => {
    job('dmg');
    updateJob(db, 'dmg', { state: 'kept_original', finishedAt: at(1).toISOString() }, at(1));
    insertJobResult(
      db,
      result('dmg', {
        outcome: 'kept_original',
        afterBytes: null,
        replacedTo: null,
        sourceDamaged: true,
      }),
    );
    job('ok');
    insertJobResult(db, result('ok'));
    expect(findJobResult(db, 'dmg')?.sourceDamaged).toBe(true);
    expect(findJobResult(db, 'ok')?.sourceDamaged).toBe(false);
    expect(findJobListRow(db, 'dmg')?.result).toMatchObject({
      outcome: 'kept_original',
      sourceDamaged: true,
    });
    expect(findJobListRow(db, 'ok')?.result?.sourceDamaged).toBe(false);
  });
});

describe('job GPU fields', () => {
  it('reads a corrupt failed_gpus cell as an empty list', () => {
    job('g');
    db.prepare("UPDATE jobs SET failed_gpus = 'not json' WHERE id = 'g'").run();
    expect(findJob(db, 'g')?.failedGpus).toEqual([]);
    expect(findJobListRow(db, 'g')).toBeTruthy();
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
      recycling: true,
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

  it('listJobs: active by priority then queued_at, final last, with joined names and result', () => {
    job('low', { priority: 0 }, now);
    job('high', { priority: 5 }, at(1));
    job('fin', {}, now);
    updateJob(db, 'fin', { state: 'done', finishedAt: at(3).toISOString() }, at(3));
    insertJobResult(db, result('fin'));
    const rows = listJobs(db, {});
    expect(rows.map((r) => r.id)).toEqual(['high', 'low', 'fin']);
    expect(rows[2]).toMatchObject({
      fileName: 'fin.mkv',
      libraryName: 'TV',
      workflowName: 'Shrink',
      result: { outcome: 'done', beforeBytes: 100, afterBytes: 60, replacedTo: 'recycle' },
    });
    expect(rows[0]?.result).toBeNull();
    expect(listJobs(db, { states: ['done'] }).map((r) => r.id)).toEqual(['fin']);
    expect(listJobs(db, { limit: 1 }).map((r) => r.id)).toEqual(['high']);
    expect(listJobs(db, { libraryId: 'other' })).toEqual([]);
    expect(listJobs(db, { states: [] })).toEqual([]);

    const counts = countJobsByState(db, {});
    expect(counts).toMatchObject({ queued: 2, done: 1, failed: 0 });
    expect(Object.keys(counts)).toHaveLength(15);
    expect(countJobsByState(db, { libraryId: 'other' }).queued).toBe(0);
    // The list's scope filters apply to the counts too (final review M12).
    expect(countJobsByState(db, { runId: 'r1' })).toEqual(counts);
    expect(countJobsByState(db, { runId: 'nope' }).queued).toBe(0);
    expect(countJobsByState(db, { runId: 'r1', libraryId: 'other' }).queued).toBe(0);

    job('enc');
    updateJob(db, 'enc', { state: 'encoding' }, at(4));
    job('bad');
    updateJob(db, 'bad', { state: 'failed' }, at(4));
    insertJobResult(db, result('bad', { outcome: 'failed', afterBytes: null, replacedTo: null }));
    insertJobResult(db, result('enc', { createdAt: '2025-01-01T00:00:00.000Z' }));
    // A job the sweep failed has no result row; it is still a failed job (final review M13).
    job('swept');
    updateJob(db, 'swept', { state: 'failed', reason: 'original restored' }, at(4));
    expect(jobStats(db, now.toISOString())).toEqual({
      files: 1,
      savedBytes: 40,
      failed: 2,
      queued: 2,
      running: 1,
      problems: 0,
    });
  });

  it('listJobs: a dry run carries its estimate and plan summary; real runs and old rows carry null', () => {
    const plan = {
      container: { from: 'mkv', to: 'mkv' },
      rewrite: true,
      streams: [
        {
          index: 0,
          type: 'subtitle' as const,
          codec: 'subrip',
          language: 'fr',
          title: null,
          isOriginalLanguage: false,
          default: { before: false, after: false },
          forced: false,
          action: 'drop' as const,
          note: '',
        },
      ],
    };
    job('dry', { dryRun: true }, now);
    updateJob(db, 'dry', { state: 'dry_run', finishedAt: at(1).toISOString() }, at(1));
    insertJobResult(
      db,
      result('dry', { outcome: 'dry_run', afterBytes: null, estimatedBytes: 66, plan }),
    );
    job('dry-old', { dryRun: true }, now);
    updateJob(db, 'dry-old', { state: 'dry_run', finishedAt: at(2).toISOString() }, at(2));
    insertJobResult(db, result('dry-old', { outcome: 'dry_run', afterBytes: null }));
    job('real', {}, now);
    updateJob(db, 'real', { state: 'done', finishedAt: at(3).toISOString() }, at(3));
    // Never reported for a real run, even if the row happens to hold one.
    insertJobResult(db, result('real', { estimatedBytes: 55, plan }));
    job('waiting', { dryRun: true }, now);
    const by = Object.fromEntries(listJobs(db, {}).map((r) => [r.id, r]));
    expect(by.dry).toMatchObject({ estimatedBytes: 66, planSummary: 'drop 1 subtitle track' });
    expect(by['dry-old']).toMatchObject({ estimatedBytes: null, planSummary: null });
    expect(by.real).toMatchObject({ estimatedBytes: null, planSummary: null });
    expect(by.waiting).toMatchObject({ estimatedBytes: null, planSummary: null });
    expect(findJobListRow(db, 'dry')).toMatchObject({ estimatedBytes: 66 });
  });

  it('listJobs pages with an id cursor through active then final jobs, ties included', () => {
    job('q1', { priority: 1 });
    job('q2', { priority: 1 });
    job('q3', { priority: 7 });
    for (const id of ['f1', 'f2', 'f3', 'f4']) {
      job(id);
      updateJob(db, id, { state: 'done' }, at(5)); // same finished_at for all four
    }
    const expected = ['q3', 'q1', 'q2', 'f4', 'f3', 'f2', 'f1'];
    expect(listJobs(db, {}).map((r) => r.id)).toEqual(expected);
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const rows = listJobs(db, before === undefined ? { limit: 2 } : { limit: 2, before });
      if (rows.length === 0) break;
      expect(rows.length).toBeLessThanOrEqual(2);
      seen.push(...rows.map((r) => r.id));
      before = rows.at(-1)?.id;
    }
    expect(seen).toEqual(expected);
    expect(listJobs(db, { before: 'f1' })).toEqual([]);
    expect(listJobs(db, { before: 'missing' })).toEqual([]);
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

  it('findJobResult reads a result; recentRatios uses done results only', () => {
    job('a');
    job('b');
    job('c');
    insertJobResult(db, result('a', { outcome: 'failed', createdAt: at(1).toISOString() }));
    insertJobResult(db, result('b', { outcome: 'done', createdAt: at(2).toISOString() }));
    insertJobResult(db, result('c', { outcome: 'dry_run', createdAt: at(3).toISOString() }));
    expect(findJobResult(db, 'b')).toEqual(result('b', { createdAt: at(2).toISOString() }));
    expect(recentRatios(db, 'w1', 20)).toEqual([0.6]);
  });

  it('appendTrace stores each entry at its own seq; listTrace returns them in seq order', () => {
    job('a');
    const entry = (nodeId: string, seq: number): TraceEntry => ({
      seq,
      attempt: 1,
      nodeId,
      workflowPath: [],
      phase: 'decide',
      port: 'yes',
      reason: 'why',
      findings: { language: 'jpn' },
      startedAt: now.toISOString(),
      endedAt: now.toISOString(),
    });
    expect(nextTraceSeq(db, 'a')).toBe(1);
    expect(appendTrace(db, 'a', entry('n2', 2))).toBe(2);
    expect(appendTrace(db, 'a', entry('n1', 1))).toBe(1);
    expect(listTrace(db, 'a').map((e) => e.nodeId)).toEqual(['n1', 'n2']);
    expect(nextTraceSeq(db, 'a')).toBe(3);
    expect(() => appendTrace(db, 'a', entry('dup', 2))).toThrow();
  });

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
    // A re-queue writes no probe: the stored one stays.
    const h = upsertFile(
      db,
      { libraryId: 'l1', path: '/media/tv/a.mkv', fingerprint: fp, lastProbe: null },
      at(2),
    );
    expect(h).toMatchObject({ id: f.id, sizeBytes: 100, lastProbe: { ok: true } });
  });

  it('recycled rows insert, list and delete', () => {
    const row = {
      path: '/media/tv/.rb/a.mkv',
      libraryId: 'l1',
      jobId: 'a',
      sizeBytes: 100,
      recycledAt: now.toISOString(),
    };
    insertRecycled(db, row);
    expect(listRecycled(db)).toEqual([row]);
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
    expect(insertRecycled(db, first)).toBeNull();
    expect(insertRecycled(db, second)).toEqual(first);
    expect(listRecycled(db)).toEqual([second]);
  });
});

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

  it('findFinalRealResult finds the newest final result of a real job for that file and version only', () => {
    job('real');
    updateJob(db, 'real', { state: 'done' }, at(1));
    insertJobResult(db, result('real'));
    job('dry', { dryRun: true });
    updateJob(db, 'dry', { state: 'dry_run' }, at(1));
    insertJobResult(db, result('dry', { outcome: 'dry_run', workflowVersion: 2 }));
    expect(findFinalRealResult(db, 'k1', 'w1', 1)).toEqual({
      outcome: 'done',
      createdAt: now.toISOString(),
    });
    expect(findFinalRealResult(db, 'k1', 'w1', 2)).toBeNull();
    expect(findFinalRealResult(db, 'other', 'w1', 1)).toBeNull();
  });
});

describe('settings', () => {
  it('getSettingOr falls back to the default and reads a stored value', () => {
    expect(getSettingOr(db, SETTING_KEYS.queuePaused, z.boolean(), false)).toBe(false);
    expect(SETTING_DEFAULTS).toEqual({
      queuePaused: false,
      recycleRetentionDays: 7,
      recycleMaxFreePercent: 25,
      serverName: null,
      theme: 'system',
      pluginCallTimeoutMs: 30_000,
      testEncodeKeepHours: 2,
      encodeDevice: 'auto',
      gpuOrder: [],
    });
    setSetting(db, SETTING_KEYS.queuePaused, true, now);
    expect(getSettingOr(db, SETTING_KEYS.queuePaused, z.boolean(), false)).toBe(true);
  });
});
