import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../open.ts';
import { updateJob } from './jobs.ts';
import { alreadyProcessedReason, findPriorRun, findProcessedResult } from './prior-runs.ts';
import { insertJobResult, type JobResultRow } from './results.ts';
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

describe('prior runs', () => {
  it('findPriorRun: a processed result of any version wins, as source or output; failed only at the same version', () => {
    const real = (id: string, r: Partial<JobResultRow>, extra: { dryRun?: boolean } = {}) => {
      job(id, { workflowVersion: r.workflowVersion ?? 1, ...extra });
      updateJob(db, id, { state: r.outcome ?? 'done' }, at(1));
      insertJobResult(db, result(id, { createdAt: '2026-10-01T10:00:00.000Z', ...r }));
    };
    real('d', { fingerprint: 'src', outputFingerprint: 'out' });
    real('f', { fingerprint: 'bad', outcome: 'failed' });
    real('dry', { fingerprint: 'dry' }, { dryRun: true });
    expect(findPriorRun(db, 'src', 'w1', 2)).toEqual({
      outcome: 'done',
      workflowVersion: 1,
      createdAt: '2026-10-01T10:00:00.000Z',
      matched: 'source',
    });
    expect(findPriorRun(db, 'out', 'w1', 2)).toMatchObject({
      workflowVersion: 1,
      matched: 'output',
    });
    expect(findPriorRun(db, 'bad', 'w1', 1)).toMatchObject({
      outcome: 'failed',
      workflowVersion: 1,
    });
    expect(findPriorRun(db, 'bad', 'w1', 2)).toBeNull();
    expect(findPriorRun(db, 'dry', 'w1', 1)).toBeNull();
    // A dry run's check stays with its own version.
    expect(findPriorRun(db, 'src', 'w1', 2, { sameVersion: true })).toBeNull();
    expect(findPriorRun(db, 'src', 'w1', 1, { sameVersion: true })).toMatchObject({
      workflowVersion: 1,
    });
  });

  it('alreadyProcessedReason names the version and points to Process again', () => {
    const at = '2026-10-01T10:00:00.000Z';
    expect(
      alreadyProcessedReason({
        outcome: 'nothing_to_do',
        workflowVersion: 2,
        createdAt: at,
        matched: 'source',
      }),
    ).toBe(`already nothing_to_do by v2 on ${at}; use Process again to run it anyway`);
    expect(
      alreadyProcessedReason({
        outcome: 'done',
        workflowVersion: 2,
        createdAt: at,
        matched: 'source',
      }),
    ).toBe(
      `already done by v2 on ${at}; this file is the original from before then (moved back from the recycle folder?); use Process again to run it anyway`,
    );
    expect(
      alreadyProcessedReason({
        outcome: 'done',
        workflowVersion: 1,
        createdAt: at,
        matched: 'output',
      }),
    ).toBe(
      `already done by v1 on ${at}; this file is what that job wrote; use Process again to run it anyway`,
    );
    expect(
      alreadyProcessedReason({
        outcome: 'failed',
        workflowVersion: 3,
        createdAt: at,
        matched: 'source',
      }),
    ).toBe(`already failed by v3 on ${at}; use Process again to run it anyway`);
  });

  it('findProcessedResult matches the source or the written file, real jobs and counted outcomes only', () => {
    const real = (id: string, r: Partial<JobResultRow>, when: Date) => {
      job(id, { workflowVersion: r.workflowVersion ?? 1 });
      updateJob(db, id, { state: r.outcome ?? 'done' }, when);
      insertJobResult(db, result(id, { ...r, createdAt: when.toISOString() }));
    };
    real(
      'src',
      { fingerprint: 'k1', sourceHash: 'h1', outcome: 'nothing_to_do', workflowVersion: 1 },
      at(1),
    );
    real(
      'out',
      { fingerprint: 'k0', outputFingerprint: 'k2', outputHash: 'h2', workflowVersion: 3 },
      at(2),
    );
    real('bad', { fingerprint: 'k3', outcome: 'failed' }, at(3));
    job('dry', { dryRun: true });
    updateJob(db, 'dry', { state: 'kept_original' }, at(4));
    insertJobResult(db, result('dry', { fingerprint: 'k4', outcome: 'kept_original' }));

    const q = (key: string, workflowVersion: number | null, extra = {}) =>
      findProcessedResult(db, {
        by: 'fingerprint',
        key,
        workflowId: 'w1',
        workflowVersion,
        ...extra,
      });
    const h = (key: string, workflowVersion: number | null = null) =>
      findProcessedResult(db, { by: 'hash', key, workflowId: 'w1', workflowVersion });
    expect(q('k1', null)).toEqual({
      jobId: 'src',
      workflowId: 'w1',
      workflowVersion: 1,
      outcome: 'nothing_to_do',
      createdAt: at(1).toISOString(),
      matched: 'source',
      by: 'fingerprint',
    });
    // The same by content hash, source or output; a fingerprint is never a hash.
    expect(h('h1')).toMatchObject({ jobId: 'src', matched: 'source', by: 'hash' });
    expect(h('h2', 3)).toMatchObject({ jobId: 'out', matched: 'output', by: 'hash' });
    expect(h('h2', 2)).toBeNull();
    expect(h('k1')).toBeNull();
    expect(q('h1', null)).toBeNull();
    expect(q('k2', null)).toMatchObject({ jobId: 'out', matched: 'output', workflowVersion: 3 });
    expect(q('k2', 3)).toMatchObject({ jobId: 'out' });
    expect(q('k2', 2)).toBeNull();
    expect(q('k1', 1)).toMatchObject({ jobId: 'src' });
    // failed and dry runs never count; another workflow and the asking job neither.
    expect(q('k3', null)).toBeNull();
    expect(q('k4', null)).toBeNull();
    expect(
      findProcessedResult(db, {
        by: 'fingerprint',
        key: 'k1',
        workflowId: 'w2',
        workflowVersion: null,
      }),
    ).toBeNull();
    expect(q('k1', null, { excludeJobId: 'src' })).toBeNull();
  });
});
