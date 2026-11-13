import { emptyGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../open.ts';
import { createTestDb } from '../test-db.ts';
import {
  insertJob,
  insertJobResult,
  insertRecycled,
  type JobResultRow,
  setJobProbe,
  updateJob,
  upsertFile,
} from './jobs.ts';
import { insertLibrary, softDeleteLibrary } from './libraries.ts';
import { metricsTotals } from './metrics.ts';
import { insertRestore, markRestoreUndone } from './restores.ts';
import { insertRun } from './runs.ts';
import { insertWorkflow } from './workflows.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const at = (min: number) => new Date(now.getTime() + min * 60_000);

let db: Database;

function library(id: string, name: string) {
  insertLibrary(
    db,
    { id, name, path: `/media/${id}`, recycleFolder: null, processHardlinked: false },
    now,
  );
  insertRun(
    db,
    {
      id: `run-${id}`,
      libraryId: id,
      workflowId: 'w1',
      workflowVersion: 1,
      requestedPath: `/media/${id}`,
      dryRun: false,
      testEncode: false,
      force: false,
      createdBy: 'u',
    },
    now,
  );
}

function job(id: string, libraryId: string, patch: Parameters<typeof updateJob>[2] = {}) {
  insertJob(
    db,
    {
      id,
      runId: `run-${libraryId}`,
      libraryId,
      fileId: null,
      path: `/media/${libraryId}/${id}.mkv`,
      workflowId: 'w1',
      workflowVersion: 1,
      dryRun: false,
      testEncode: false,
      state: 'queued',
      priority: 0,
    },
    now,
  );
  if (Object.keys(patch).length > 0) updateJob(db, id, patch, at(1));
}

function result(jobId: string, extra: Partial<JobResultRow> = {}): void {
  insertJobResult(db, {
    jobId,
    fingerprint: `k-${jobId}`,
    workflowId: 'w1',
    workflowVersion: 1,
    outcome: 'done',
    beforeBytes: 1000,
    afterBytes: 600,
    estimatedBytes: null,
    command: null,
    plan: null,
    replacedTo: 'recycle',
    logPath: null,
    warnings: [],
    problems: [],
    outputProbe: null,
    sourceDamaged: false,
    outputFingerprint: null,
    sourceHash: null,
    outputHash: null,
    createdAt: at(2).toISOString(),
    ...extra,
  });
}

beforeEach(() => {
  db = createTestDb();
  insertWorkflow(
    db,
    { id: 'w1', kind: 'workflow', name: 'Shrink', graph: emptyGraph('workflow'), createdBy: 'u' },
    now,
  );
});
afterEach(() => db.close());

describe('metricsTotals', () => {
  it('is empty with no libraries', () => {
    expect(metricsTotals(db)).toEqual({
      libraries: [],
      active: [],
      finished: [],
      perLibrary: [],
      runs: [],
    });
  });

  it('lists live libraries by name with zero totals', () => {
    library('l1', 'Movies');
    expect(metricsTotals(db).libraries).toEqual([{ id: 'l1', name: 'Movies' }]);
    expect(metricsTotals(db).perLibrary).toEqual([
      {
        libraryId: 'l1',
        retries: 0,
        sourceBytes: 0,
        outputBytes: 0,
        savedBytes: 0,
        mediaSeconds: 0,
        recycleBytes: 0,
        recycleFiles: 0,
        files: 0,
      },
    ]);
    expect(metricsTotals(db).runs).toEqual([{ libraryId: 'l1', source: 'manual', runs: 1 }]);
  });

  it('counts unfinished jobs by state and lane, with how many of them are paused', () => {
    library('l1', 'Movies');
    job('q1', 'l1');
    job('q2', 'l1', { paused: true });
    job('e1', 'l1', { state: 'encoding', lane: 'encode' });
    job('done', 'l1', { state: 'done' });
    expect(metricsTotals(db).active).toEqual([
      { libraryId: 'l1', state: 'encoding', lane: 'encode', jobs: 1, paused: 0 },
      { libraryId: 'l1', state: 'queued', lane: null, jobs: 2, paused: 1 },
    ]);
  });

  it('counts finished jobs by outcome and sums retries (attempts beyond the first)', () => {
    library('l1', 'Movies');
    job('a', 'l1', { state: 'done', attempt: 3 });
    job('b', 'l1', { state: 'failed', attempt: 2, reason: 'x' });
    job('c', 'l1', { state: 'done' });
    const t = metricsTotals(db);
    expect(t.finished).toEqual([
      { libraryId: 'l1', outcome: 'done', jobs: 2 },
      { libraryId: 'l1', outcome: 'failed', jobs: 1 },
    ]);
    expect(t.perLibrary[0]?.retries).toBe(3);
  });

  it('sums bytes over replaced files only, leaves out restored ones, and counts media seconds of done and kept', () => {
    library('l1', 'Movies');
    job('a', 'l1', { state: 'done' });
    result('a');
    setJobProbe(db, 'a', { durationSeconds: 3600 });
    job('kept', 'l1', { state: 'kept_original' });
    result('kept', { outcome: 'kept_original', beforeBytes: 500, afterBytes: 700 });
    setJobProbe(db, 'kept', { durationSeconds: 60 });
    job('r', 'l1', { state: 'done' });
    result('r');
    insertRestore(db, {
      id: 'rs',
      jobId: 'r',
      restoredAt: at(3).toISOString(),
      restoredBy: 'u',
      sidecarPaths: [],
    });
    const lib = () => metricsTotals(db).perLibrary[0];
    expect(lib()).toMatchObject({
      sourceBytes: 1000,
      outputBytes: 600,
      savedBytes: 400,
      mediaSeconds: 3660,
    });
    markRestoreUndone(db, 'rs', at(4).toISOString(), 'u');
    expect(lib()).toMatchObject({ sourceBytes: 2000, outputBytes: 1200, savedBytes: 800 });
  });

  it('counts recycle files and bytes and known files per library', () => {
    library('l1', 'Movies');
    const base = { libraryId: 'l1', jobId: 'a', recycledAt: now.toISOString() };
    insertRecycled(db, { ...base, path: '/media/l1/.rb/a.mkv', sizeBytes: 300 });
    insertRecycled(db, { ...base, path: '/media/l1/.rb/b.mkv', sizeBytes: 200 });
    upsertFile(
      db,
      {
        libraryId: 'l1',
        path: '/media/l1/a.mkv',
        fingerprint: { sizeBytes: 1, mtimeMs: 1, ino: 1, dev: 1, nlink: 1 },
        lastProbe: null,
      },
      now,
    );
    expect(metricsTotals(db).perLibrary[0]).toMatchObject({
      recycleBytes: 500,
      recycleFiles: 2,
      files: 1,
    });
  });

  it('leaves out a deleted library everywhere', () => {
    library('l1', 'Movies');
    library('l2', 'Old');
    job('x', 'l2', { state: 'done' });
    job('y', 'l2');
    softDeleteLibrary(db, 'l2', at(5));
    const t = metricsTotals(db);
    expect(t.libraries.map((l) => l.id)).toEqual(['l1']);
    expect(t.active).toEqual([]);
    expect(t.finished).toEqual([]);
    expect(t.perLibrary.map((l) => l.libraryId)).toEqual(['l1']);
    expect(t.runs.map((r) => r.libraryId)).toEqual(['l1']);
  });
});
