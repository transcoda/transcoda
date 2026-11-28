import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../open.ts';
import { insertRestore, markRestoreUndone } from '../restores.ts';
import { insertApproval } from './approvals.ts';
import { updateJob } from './jobs.ts';
import {
  countAwaitingApproval,
  countDependsOnSize,
  countJobsByState,
  countProblems,
  findJobListRow,
  listJobs,
} from './list.ts';
import { insertJobResult } from './results.ts';
import { jobStats } from './stats.ts';
import { at, insertTestJob, now, result, seededDb } from './testing.ts';

let db: Database;
beforeEach(() => {
  db = seededDb();
});
afterEach(() => {
  db.close();
});
const job = (id: string, extra: Parameters<typeof insertTestJob>[2] = {}, when = now) =>
  insertTestJob(db, id, extra, when);

describe('listJobs', () => {
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

  it('listJobs and its counts take a dry-run scope: only dry runs, or only real runs', () => {
    job('real');
    job('fin', {}, at(1));
    updateJob(db, 'fin', { state: 'done', finishedAt: at(3).toISOString() }, at(3));
    insertJobResult(db, result('fin'));
    job('dry', { dryRun: true }, at(5));
    expect(listJobs(db, { dryRun: true }).map((r) => r.id)).toEqual(['dry']);
    expect(listJobs(db, { dryRun: false }).map((r) => r.id)).toEqual(['real', 'fin']);
    expect(countJobsByState(db, { dryRun: true })).toMatchObject({ queued: 1, done: 0 });
    expect(countJobsByState(db, { dryRun: false })).toMatchObject({ queued: 1, done: 1 });
    expect(countProblems(db, { dryRun: true })).toBe(0);
    expect(countDependsOnSize(db, { dryRun: false })).toBe(0);
  });

  it('listJobs: a job waiting for approval carries its parked result, filters and counts', () => {
    job('wait', { state: 'verifying' });
    job('other', { state: 'verifying' }, at(1));
    insertApproval(db, {
      jobId: 'wait',
      nodeId: 'ap',
      parkedAt: at(2).toISOString(),
      expiresAt: at(9).toISOString(),
      beforeBytes: 1000,
      afterBytes: 600,
      plan: null,
      outputProbe: null,
    });
    expect(findJobListRow(db, 'wait')?.approval).toEqual({
      parkedAt: at(2).toISOString(),
      expiresAt: at(9).toISOString(),
      beforeBytes: 1000,
      afterBytes: 600,
    });
    expect(findJobListRow(db, 'other')?.approval).toBeNull();
    expect(listJobs(db, { awaitingApproval: true }).map((r) => r.id)).toEqual(['wait']);
    expect(countAwaitingApproval(db, {})).toBe(1);
    expect(countAwaitingApproval(db, { dryRun: true })).toBe(0);
  });

  it('listJobs: a job whose original is restored says so until the restore is undone', () => {
    job('rs');
    updateJob(db, 'rs', { state: 'done' }, now);
    insertJobResult(db, result('rs'));
    expect(listJobs(db, {})[0]?.result).toMatchObject({ restored: false });
    insertRestore(db, {
      id: 'rs1',
      jobId: 'rs',
      restoredAt: now.toISOString(),
      restoredBy: 'u1',
      sidecarPaths: [],
    });
    expect(listJobs(db, {})[0]?.result).toMatchObject({ restored: true });
    markRestoreUndone(db, 'rs1', now.toISOString(), 'u1');
    expect(listJobs(db, {})[0]?.result).toMatchObject({ restored: false });
  });
});
