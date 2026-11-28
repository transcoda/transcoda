import { emptyGraph } from '@transcoda/shared';
import type { Database } from '../../open.ts';
import { createTestDb } from '../../testing.ts';
import { insertLibrary } from '../libraries.ts';
import { insertRun } from '../runs.ts';
import { insertWorkflow } from '../workflows.ts';
import { insertJob } from './jobs.ts';
import type { JobResultRow } from './results.ts';
import type { JobInsert } from './rows.ts';

// Shared setup for the repository tests that need jobs: a database with workflow `w1`, library
// `l1` (/media/tv) and run `r1`, and builders for job and result rows.

export const now = new Date('2026-01-01T00:00:00.000Z');
export const at = (min: number) => new Date(now.getTime() + min * 60_000);
export const fp = { sizeBytes: 100, mtimeMs: 1, ino: 2, dev: 3, nlink: 1 };

/** A test database holding workflow `w1`, library `l1` and run `r1`. */
export function seededDb(): Database {
  const db = createTestDb();
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
  return db;
}

/** A queued job `id` of run `r1` at `/media/tv/<id>.mkv`. */
export function insertTestJob(
  db: Database,
  id: string,
  extra: Partial<JobInsert> = {},
  when = now,
) {
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

/** A `done` result of job `jobId` that saved 40 of 100 bytes. */
export function result(jobId: string, extra: Partial<JobResultRow> = {}): JobResultRow {
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
    nodeProblems: [],
    outputProbe: null,
    sourceDamaged: false,
    outputFingerprint: null,
    sourceHash: null,
    outputHash: null,
    createdAt: now.toISOString(),
    ...extra,
  };
}
