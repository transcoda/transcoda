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

let db: Database;
let n = 0;

/** A finished job of `workflowId@version` whose source was `fingerprint` (and wrote `output`). */
function result(o: {
  workflowId?: string;
  version?: number;
  outcome?: JobState;
  fingerprint?: string;
  output?: string | null;
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
    createdAt: now.toISOString(),
  });
  return id;
}

const subject = (tag?: string, jobWorkflowId = SAVE): AlreadyProcessedSubject => ({
  db,
  jobId: 'asking',
  jobWorkflowId,
  fingerprint: FILE,
  probe: { raw: { format: tag === undefined ? {} : { tags: { TRANSCODA: tag } } } },
});
const ask = (
  s: AlreadyProcessedSubject,
  workflowId: string | null = null,
  version: number | null = null,
) => alreadyProcessed(s, { workflowId, version });

beforeEach(() => {
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
const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

describe('already processed', () => {
  it('no: nothing recorded and no tag', () => {
    expect(ask(subject())).toEqual({
      processed: false,
      reason: 'not processed by Save space',
      findings: { workflowId: SAVE, version: null, evidence: null },
    });
    expect(ask(subject(), CLEAN, 2).reason).toBe('not processed by Clean audio v2');
  });

  it('yes by output fingerprint: this file is what the job wrote', () => {
    const id = result({ output: FILE });
    expect(ask(subject())).toEqual({
      processed: true,
      reason: `done by Save space v3 on ${day} (this file is its output)`,
      findings: {
        workflowId: SAVE,
        version: null,
        evidence: 'result',
        matched: 'output',
        jobId: id,
        outcome: 'done',
        processedVersion: 3,
        at: now.toISOString(),
      },
    });
  });

  it('yes by source fingerprint: nothing to do, kept original, or a done original that is back', () => {
    result({ fingerprint: FILE, outcome: 'nothing_to_do', version: 1 });
    expect(ask(subject()).reason).toBe(`nothing to do for Save space v1 on ${day}`);
    result({ fingerprint: FILE, outcome: 'kept_original', version: 2 });
    expect(ask(subject(), null, 2).reason).toBe(`original kept by Save space v2 on ${day}`);
    result({ fingerprint: FILE, outcome: 'done', version: 4 });
    expect(ask(subject(), null, 4)).toMatchObject({
      processed: true,
      reason: `done by Save space v4 on ${day} (this file is its original)`,
      findings: { matched: 'source' },
    });
  });

  it('yes by tag, at that version if one is set; any case of the key', () => {
    expect(ask(subject(`${CLEAN}@1,${SAVE}@2`))).toMatchObject({
      processed: true,
      reason: 'tagged by Save space v2',
      findings: { evidence: 'tag', processedVersion: 2 },
    });
    expect(ask(subject(`${SAVE}@2`), null, 2).processed).toBe(true);
    expect(ask(subject(`${SAVE}@2`), null, 3).processed).toBe(false);
    const lower = {
      ...subject(),
      probe: { raw: { format: { tags: { transcoda: `${SAVE}@5` } } } },
    };
    expect(ask(lower).reason).toBe('tagged by Save space v5');
  });

  it('any version vs a specific version', () => {
    result({ output: FILE, version: 3 });
    expect(ask(subject(), null, null).processed).toBe(true);
    expect(ask(subject(), null, 3).processed).toBe(true);
    expect(ask(subject(), null, 2)).toMatchObject({
      processed: false,
      reason: 'not processed by Save space v2',
    });
  });

  it('another workflow vs this one: "This workflow" is the workflow the job runs', () => {
    result({ workflowId: CLEAN, version: 1, output: FILE });
    // The job runs Save space: its own history has nothing.
    expect(ask(subject()).processed).toBe(false);
    expect(ask(subject(), CLEAN).reason).toBe(
      `done by Clean audio v1 on ${day} (this file is its output)`,
    );
    // A job of Clean audio asking about "This workflow".
    expect(ask(subject(undefined, CLEAN)).processed).toBe(true);
    expect(ask(subject(`${CLEAN}@1`)).processed).toBe(false);
    // A recorded result says more than the tag: it wins.
    expect(ask(subject(`${CLEAN}@1`), CLEAN).findings).toMatchObject({ evidence: 'result' });
  });

  it('failed jobs and dry runs never count', () => {
    result({ fingerprint: FILE, outcome: 'failed' });
    result({ output: FILE, outcome: 'failed' });
    result({ fingerprint: FILE, outcome: 'kept_original', dryRun: true });
    result({ fingerprint: FILE, outcome: 'dry_run', dryRun: true });
    expect(ask(subject())).toMatchObject({ processed: false });
  });

  it('a deleted or unknown workflow is named by its id and answers no', () => {
    expect(ask(subject(), 'gone', 1).reason).toBe('not processed by gone v1');
  });
});
