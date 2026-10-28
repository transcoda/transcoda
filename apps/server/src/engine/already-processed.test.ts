import { emptyGraph, type JobState } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/open.ts';
import { insertJob, insertJobResult, updateJob } from '../db/repos/jobs.ts';
import { insertLibrary } from '../db/repos/libraries.ts';
import { insertRun } from '../db/repos/runs.ts';
import { insertWorkflow } from '../db/repos/workflows.ts';
import { createTestDb } from '../db/test-db.ts';
import { type AlreadyProcessedSubject, alreadyProcessed } from './already-processed.ts';

const now = new Date('2026-10-28T15:00:00.000Z');
const SAVE = 'w-save';
const CLEAN = 'w-clean';
const FILE = '3:9:600:1';
const HASH = 'v1:600:abc';

let db: Database;
let n = 0;
/** How often the subject's content hash was asked for. */
let hashed = 0;

/** A finished job of `workflowId@version` with the given source and output identities. */
function result(o: {
  workflowId?: string;
  version?: number;
  outcome?: JobState;
  fingerprint?: string;
  output?: string | null;
  sourceHash?: string | null;
  outputHash?: string | null;
  dryRun?: boolean;
}): string {
  n += 1;
  const id = `j${n}`;
  insertJob(
    db,
    {
      id,
      runId: 'r1',
      libraryId: 'l1',
      fileId: null,
      path: '/media/a.mkv',
      workflowId: o.workflowId ?? SAVE,
      workflowVersion: o.version ?? 3,
      dryRun: o.dryRun ?? false,
      testEncode: false,
      state: 'queued',
      priority: 0,
    },
    now,
  );
  const outcome = o.outcome ?? 'done';
  updateJob(db, id, { state: outcome }, now);
  insertJobResult(db, {
    jobId: id,
    fingerprint: o.fingerprint ?? 'other',
    workflowId: o.workflowId ?? SAVE,
    workflowVersion: o.version ?? 3,
    outcome,
    beforeBytes: 1000,
    afterBytes: 600,
    estimatedBytes: null,
    command: null,
    plan: null,
    replacedTo: null,
    logPath: null,
    warnings: [],
    problems: [],
    outputProbe: null,
    sourceDamaged: false,
    outputFingerprint: o.output ?? null,
    sourceHash: o.sourceHash ?? null,
    outputHash: o.outputHash ?? null,
    createdAt: now.toISOString(),
  });
  return id;
}

const subject = (jobWorkflowId = SAVE, hash: string | null = HASH): AlreadyProcessedSubject => ({
  db,
  jobId: 'asking',
  jobWorkflowId,
  fingerprint: FILE,
  contentHash: async () => {
    hashed += 1;
    return hash;
  },
});
const ask = (
  s: AlreadyProcessedSubject,
  workflowId: string | null = null,
  version: number | null = null,
) => alreadyProcessed(s, { workflowId, version });

beforeEach(() => {
  hashed = 0;
  db = createTestDb();
  for (const [id, name] of [
    [SAVE, 'Save space'],
    [CLEAN, 'Clean audio'],
  ] as const) {
    insertWorkflow(
      db,
      { id, kind: 'workflow', name, graph: emptyGraph('workflow'), createdBy: 'u' },
      now,
    );
  }
  insertLibrary(
    db,
    { id: 'l1', name: 'L', path: '/media', recycleFolder: null, processHardlinked: false },
    now,
  );
  insertRun(
    db,
    {
      id: 'r1',
      libraryId: 'l1',
      workflowId: SAVE,
      workflowVersion: 3,
      requestedPath: '/media',
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

/** The server's calendar day of `now`, as the reasons write it. */
const pad = (x: number) => String(x).padStart(2, '0');
const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

describe('already processed', () => {
  it('no: nothing recorded (the hash was looked up too)', async () => {
    expect(await ask(subject())).toEqual({
      processed: false,
      reason: 'not processed by Save space',
      findings: { workflowId: SAVE, version: null, hashed: true },
    });
    expect((await ask(subject(), CLEAN, 2)).reason).toBe('not processed by Clean audio v2');
    // A file that cannot be hashed is a No too.
    expect(await ask(subject(SAVE, null))).toMatchObject({
      processed: false,
      findings: { hashed: false },
    });
  });

  it('yes by output fingerprint, without hashing the file', async () => {
    const id = result({ output: FILE, outputHash: HASH });
    expect(await ask(subject())).toEqual({
      processed: true,
      reason: `done by Save space v3 on ${day} (this file is its output)`,
      findings: {
        workflowId: SAVE,
        version: null,
        evidence: 'fingerprint',
        matched: 'output',
        jobId: id,
        outcome: 'done',
        processedVersion: 3,
        at: now.toISOString(),
      },
    });
    expect(hashed).toBe(0);
  });

  it('yes by source fingerprint: nothing to do, kept original, or a done original that is back', async () => {
    result({ fingerprint: FILE, outcome: 'nothing_to_do', version: 1 });
    expect((await ask(subject())).reason).toBe(`nothing to do for Save space v1 on ${day}`);
    result({ fingerprint: FILE, outcome: 'kept_original', version: 2 });
    expect((await ask(subject(), null, 2)).reason).toBe(`original kept by Save space v2 on ${day}`);
    result({ fingerprint: FILE, outcome: 'done', version: 4 });
    expect(await ask(subject(), null, 4)).toMatchObject({
      processed: true,
      reason: `done by Save space v4 on ${day} (this file is its original)`,
      findings: { matched: 'source', evidence: 'fingerprint' },
    });
    expect(hashed).toBe(0);
  });

  it('yes by content hash when no fingerprint matched: a copy of the output, or of a source', async () => {
    result({ output: 'elsewhere', outputHash: HASH, version: 2 });
    expect(await ask(subject())).toMatchObject({
      processed: true,
      reason: `done by Save space v2 on ${day} (same content as its output)`,
      findings: { evidence: 'hash', matched: 'output', processedVersion: 2 },
    });
    expect(hashed).toBe(1);
    result({ workflowId: CLEAN, sourceHash: HASH, outcome: 'nothing_to_do', version: 1 });
    expect((await ask(subject(), CLEAN)).reason).toBe(
      `nothing to do for Clean audio v1 on ${day} (same content as the file it checked)`,
    );
    result({ workflowId: CLEAN, sourceHash: HASH, version: 2 });
    expect((await ask(subject(), CLEAN, 2)).reason).toBe(
      `done by Clean audio v2 on ${day} (same content as its original)`,
    );
  });

  it('any version vs a specific version, by fingerprint and by hash', async () => {
    result({ output: FILE, version: 3 });
    result({ outputHash: HASH, version: 5 });
    expect((await ask(subject(), null, null)).processed).toBe(true);
    expect((await ask(subject(), null, 3)).findings).toMatchObject({ evidence: 'fingerprint' });
    expect((await ask(subject(), null, 5)).findings).toMatchObject({ evidence: 'hash' });
    expect(await ask(subject(), null, 2)).toMatchObject({
      processed: false,
      reason: 'not processed by Save space v2',
    });
  });

  it('another workflow vs this one: "This workflow" is the workflow the job runs', async () => {
    result({ workflowId: CLEAN, version: 1, output: FILE });
    // The job runs Save space: its own history has nothing.
    expect((await ask(subject())).processed).toBe(false);
    expect((await ask(subject(), CLEAN)).reason).toBe(
      `done by Clean audio v1 on ${day} (this file is its output)`,
    );
    // A job of Clean audio asking about "This workflow".
    expect((await ask(subject(CLEAN))).processed).toBe(true);
  });

  it('failed jobs and dry runs never count, by fingerprint or by hash', async () => {
    result({ fingerprint: FILE, sourceHash: HASH, outcome: 'failed' });
    result({ output: FILE, outputHash: HASH, outcome: 'failed' });
    result({ fingerprint: FILE, sourceHash: HASH, outcome: 'kept_original', dryRun: true });
    result({ fingerprint: FILE, sourceHash: HASH, outcome: 'dry_run', dryRun: true });
    expect(await ask(subject())).toMatchObject({ processed: false });
  });

  it('a deleted or unknown workflow is named by its id and answers no', async () => {
    expect((await ask(subject(), 'gone', 1)).reason).toBe('not processed by gone v1');
  });
});
