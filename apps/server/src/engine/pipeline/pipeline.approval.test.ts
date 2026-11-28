// The Approval step: a rendered and verified result parked until a person approves or rejects
// it, the expiry, the storage limit, a cancel, and a restart while it waits.
import { stat } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../../app/testing/app.ts';
import { findApproval, findJobResult, listTrace } from '../../db/repos/jobs/jobs.ts';
import { edge, mainGraph, node } from '../../workflows/testing.ts';
import {
  caps,
  configDir,
  fakeExec,
  file,
  fsOps,
  line,
  listAll,
  queue,
  replaceNode,
  row,
  settled,
  setup,
  spawner,
  t,
  toH264,
  transcodeDir,
  until,
  workflow,
} from './testing.ts';

const ELSE_URL = 'https://hooks.example.com/rejected';
const approval = (expireAfterDays = 7) => node('ap', 'core:approval', { expireAfterDays });
/** in → ev → ap; ap.pass → ro; ap.else → a notify. */
const withRejectedNotify = () =>
  mainGraph(
    [
      node('in', 'core:input-manual'),
      toH264(),
      approval(),
      replaceNode(),
      node('en', 'core:notify-webhook', { url: ELSE_URL, method: 'POST' }),
    ],
    [
      edge('in', 'ev'),
      edge('ev', 'ap'),
      edge('ap', 'ro', { from: 'pass' }),
      edge('ap', 'en', { from: 'else' }),
    ],
  );

const traceOf = (id: string, nodeId: string) =>
  listTrace(t.db, id)
    .filter((e) => e.nodeId === nodeId)
    .map((e) => [e.port, e.reason]);

/** Queues the file through `wf`, encodes 600 bytes and waits until the result is parked. */
async function parked(wf: string): Promise<string> {
  const id = await queue(file(), wf);
  await t.deps.engine.start();
  await until('spawn', () => spawner.calls.length >= 1);
  await spawner.complete({ bytes: 600 });
  await until('parked', () => findApproval(t.db, id) !== null);
  return id;
}

describe('pipeline: approval', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parks the verified result without touching the original, then Approve replaces it', async () => {
    const wf = workflow(line(node('in', 'core:input-manual'), toH264(), approval(), replaceNode()));
    const id = await parked(wf);
    expect(row(id)).toMatchObject({ state: 'verifying', reason: 'waiting for approval' });
    expect(findApproval(t.db, id)).toMatchObject({
      nodeId: 'ap',
      parkedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-08T00:00:00.000Z',
      beforeBytes: 1000,
      afterBytes: 600,
      plan: expect.objectContaining({ container: { from: 'mkv', to: 'mkv' } }),
      outputProbe: expect.objectContaining({ sizeBytes: 600 }),
    });
    expect((await stat(file())).size).toBe(1000);
    expect(await listAll(transcodeDir)).not.toEqual([]);
    // Nothing runs for it while it waits: its lane is free for the next file.
    expect(t.deps.engine.scheduler.status().lanes).toEqual({ encode: null, quick: null });
    expect(traceOf(id, 'ap').at(-1)).toEqual([
      null,
      'Approval: waiting for a person, at most 7 days',
    ]);

    expect(t.deps.engine.approve(id, 'alice')).toBe('ok');
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'done', reason: null });
    expect((await stat(file())).size).toBe(600);
    expect(findApproval(t.db, id)).toBeNull();
    expect(traceOf(id, 'ap').at(-1)).toEqual(['pass', 'Approval: approved by alice']);
    expect(await listAll(transcodeDir)).toEqual([]);
    // Answered once: a second answer finds nothing waiting.
    expect(t.deps.engine.approve(id, 'alice')).toBe('not-waiting');
    expect(t.deps.engine.reject(id, 'alice')).toBe('not-waiting');
  });

  it('Reject discards the result, keeps the original and runs only the steps behind Rejected', async () => {
    const id = await parked(workflow(withRejectedNotify()));
    expect(t.deps.engine.reject(id, 'alice')).toBe('ok');
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'kept_original', reason: 'rejected by alice' });
    expect((await stat(file())).size).toBe(1000);
    expect(await listAll(transcodeDir)).toEqual([]);
    expect(findApproval(t.db, id)).toBeNull();
    expect(findJobResult(t.db, id)).toMatchObject({
      outcome: 'kept_original',
      afterBytes: 600,
      replacedTo: null,
    });
    expect(fetchMock.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual([ELSE_URL]);
    expect(traceOf(id, 'ap').at(-1)).toEqual(['else', 'Approval: rejected by alice']);
    // The walk now runs through Rejected.
    expect(row(id).walkPath?.map((s) => [s.nodeId, s.port])).toEqual([
      ['in', 'file'],
      ['ev', 'file'],
      ['render-1', 'done'],
      ['ap', 'else'],
      ['en', 'file'],
    ]);
  });

  it('a result nobody answers in time is rejected when it expires', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), approval(1), replaceNode()),
    );
    const id = await parked(wf);
    t.clock.advance(24 * 3_600_000 - 1);
    expect(t.deps.engine.expireApprovals()).toBe(0);
    expect(row(id).state).toBe('verifying');
    t.clock.advance(1);
    expect(t.deps.engine.expireApprovals()).toBe(1);
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'kept_original', reason: 'not approved within 1 day' });
    expect((await stat(file())).size).toBe(1000);
    expect(await listAll(transcodeDir)).toEqual([]);
    expect(traceOf(id, 'ap').at(-1)).toEqual(['else', 'Approval: not approved within 1 day']);
  });

  it('a result that would go past the storage limit is not parked: the job fails, the original stays', async () => {
    await t.deps.engine.stop();
    await setup({ approvalMaxBytes: 599 });
    const wf = workflow(line(node('in', 'core:input-manual'), toH264(), approval(), replaceNode()));
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length >= 1);
    await spawner.complete({ bytes: 600 });
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', failureCode: 'workflow' });
    expect(job.reason).toBe(
      'approval: results waiting for approval would take more than 599 B; this one was discarded',
    );
    expect(findApproval(t.db, id)).toBeNull();
    expect((await stat(file())).size).toBe(1000);
    expect(await listAll(transcodeDir)).toEqual([]);
  });

  it('a cancel while it waits discards the result and keeps the original', async () => {
    const wf = workflow(line(node('in', 'core:input-manual'), toH264(), approval(), replaceNode()));
    const id = await parked(wf);
    expect(t.deps.engine.scheduler.cancelJob(id)).toBe('ok');
    const job = await settled(id);
    expect(job.state).toBe('cancelled');
    expect(findApproval(t.db, id)).toBeNull();
    expect((await stat(file())).size).toBe(1000);
    expect(await listAll(transcodeDir)).toEqual([]);
  });

  it('a test-encode dry run measures and stops before the approval: nothing is parked', async () => {
    const wf = workflow(line(node('in', 'core:input-manual'), toH264(), approval(), replaceNode()));
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length >= 1);
    await spawner.complete({ bytes: 600 });
    const job = await settled(id);
    expect(job.state).toBe('dry_run');
    expect(findApproval(t.db, id)).toBeNull();
    expect((await stat(file())).size).toBe(1000);
  });

  describe('a restart while it waits', () => {
    let t2: TestApp | null = null;
    afterEach(async () => {
      await t2?.deps.engine.stop();
      t2 = null;
    });

    it('discards the parked result and fails the job; the original is untouched', async () => {
      const wf = workflow(
        line(node('in', 'core:input-manual'), toH264(), approval(), replaceNode()),
      );
      const id = await parked(wf);
      await t.deps.engine.stop();
      // A shutdown writes nothing: the job still waits, its result is still on disk.
      expect(row(id).state).toBe('verifying');
      expect(findApproval(t.db, id)).not.toBeNull();
      expect(await listAll(transcodeDir)).not.toEqual([]);

      t2 = createTestApp({
        db: t.db,
        config: { configDir, transcodeDir },
        capabilities: caps,
        fsOps,
        exec: fakeExec,
      });
      const sweep = await t2.deps.engine.start();
      expect(sweep.interrupted).toContain(id);
      expect(row(id)).toMatchObject({
        state: 'failed',
        failureCode: 'interrupted',
        reason:
          'the server restarted while the result waited for approval; the result was discarded and the original is untouched',
      });
      expect(findApproval(t.db, id)).toBeNull();
      expect((await stat(file())).size).toBe(1000);
      expect(await listAll(transcodeDir)).toEqual([]);
      expect(traceOf(id, 'ap').at(-1)).toEqual([
        null,
        'failed: the server restarted while waiting for approval',
      ]);
    });
  });
});
