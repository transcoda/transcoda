import { link, mkdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Capabilities } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { Database } from '../db/open.ts';
import { findJob, insertJobResult, type JobResultRow, updateJob } from '../db/repos/jobs.ts';
import { findLibrary, insertLibrary, type LibraryRow } from '../db/repos/libraries.ts';
import { createTestDb } from '../db/test-db.ts';
import type { Logger } from '../logger.ts';
import { WorkflowService } from '../workflows/service.ts';
import { bumpV1, bumpV3, chain, node, testRegistry } from '../workflows/test-helpers.ts';
import { type EngineEvent, EngineEvents } from './events.ts';
import { fingerprintKey, fingerprintOf } from './fingerprint.ts';
import { tempDir } from './fixtures.ts';
import { type FsOps, nodeFsOps } from './fs-ops.ts';
import { type QueueInput, QueueService } from './queue-service.ts';

const caps: Capabilities = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '7.1',
  encoders: ['aac', 'libx264', 'libx265'],
  hwaccels: [],
  filters: ['pan'],
};
const HOUR_AGO = (): Date => new Date(Date.now() - 60 * 60 * 1000);

let base: string;
let root: string;
let outside: string;
let db: Database;
let workflows: WorkflowService;
let events: EngineEvents;
let published: EngineEvent[];
let onQueued: Mock<() => void>;
let svc: QueueService;
let flowId: string;
let lib: LibraryRow;

/**
 * A valid workflow (manual input → replace original) as v2, activated when `active`. With
 * `libraryId` its input is a Library input naming that library, so activating it feeds the library.
 */
function makeWorkflow(name: string, active: boolean, libraryId?: string): string {
  const { id } = workflows.create({ name, kind: 'workflow' }, 'u');
  workflows.save(
    {
      id,
      baseVersion: 1,
      graph: chain(
        'workflow',
        libraryId === undefined
          ? node('in', 'core:input-manual')
          : node('in', 'core:input-library', { libraryId }),
        node('ro', 'core:replace-original'),
      ),
    },
    'u',
  );
  if (active) expect(workflows.activate(id, 2, 'u').kind).toBe('ok');
  return id;
}

/** Saves the same valid graph again `n` times (versions 3, 4, …). */
function saveMore(id: string, n: number): void {
  for (let i = 0; i < n; i++) {
    const cur = workflows.get(id);
    if (!cur) throw new Error('no workflow');
    workflows.save({ id, baseVersion: cur.currentVersion, graph: cur.graph }, 'u');
  }
}

/** An empty media file, backdated an hour so the settle window never sees it as growing. */
async function settled(path: string): Promise<string> {
  await writeFile(path, 'x');
  await utimes(path, HOUR_AGO(), HOUR_AGO());
  return path;
}

function input(path: string, extra: Partial<QueueInput> = {}): QueueInput {
  return { path, dryRun: false, force: false, priority: 0, createdBy: 'u1', ...extra };
}

async function queued(path: string, extra: Partial<QueueInput> = {}) {
  const r = await svc.queue(input(path, extra));
  if (r.kind !== 'queued') throw new Error(`expected queued, got ${JSON.stringify(r)}`);
  return r;
}

function doneResult(jobId: string, fingerprint: string, extra: Partial<JobResultRow> = {}) {
  insertJobResult(db, {
    jobId,
    fingerprint,
    workflowId: flowId,
    workflowVersion: 2,
    outcome: 'done',
    beforeBytes: 1000,
    afterBytes: 400,
    estimatedBytes: null,
    command: null,
    plan: null,
    replacedTo: 'recycle',
    logPath: null,
    warnings: [],
    problems: [],
    outputProbe: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    ...extra,
  });
}

beforeEach(async () => {
  base = await tempDir('queue-');
  root = join(base, 'lib');
  outside = join(base, 'outside');
  await mkdir(join(root, 'Show', 'Season 1'), { recursive: true });
  await mkdir(outside, { recursive: true });
  db = createTestDb();
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  workflows = new WorkflowService({
    db,
    registry: testRegistry(),
    capabilities: () => caps,
    now: () => new Date(),
    log,
  });
  events = new EngineEvents();
  published = [];
  const publish = events.publish.bind(events);
  vi.spyOn(events, 'publish').mockImplementation((e) => {
    published.push(e);
    publish(e);
  });
  onQueued = vi.fn<() => void>();
  svc = new QueueService({
    db,
    workflows,
    events,
    now: () => new Date(),
    settleMinutes: 3,
    onQueued,
  });
  const created = await svc.createLibrary({ name: 'TV', path: root });
  if (!('id' in created)) throw new Error('library not created');
  lib = created;
  // The library's feeder: a queue without a workflowId uses it.
  flowId = makeWorkflow('Shrink', true, lib.id);
});

afterEach(async () => {
  db.close();
  await rm(base, { recursive: true, force: true });
});

describe('QueueService.queue', () => {
  it('a folder: one job per media file, skipped files with their reasons, counts reconcile', async () => {
    const season = join(root, 'Show', 'Season 1');
    await settled(join(season, 'e1.mkv'));
    await settled(join(season, 'e2.mp4'));
    await settled(join(root, 'Show', 'special.ts'));
    await settled(join(season, 'notes.txt'));
    await writeFile(join(season, 'e3.mkv'), 'x'); // fresh: still growing
    await settled(join(season, 'e4.mkv'));
    await link(join(season, 'e4.mkv'), join(outside, 'seed.mkv')); // hardlinked

    const r = await queued(join(root, 'Show'), { priority: 5 });
    expect(r.run).toMatchObject({
      libraryId: lib.id,
      workflowId: flowId,
      workflowVersion: 2,
      requestedPath: join(root, 'Show'),
      dryRun: false,
      force: false,
      createdBy: 'u1',
    });
    const byName = Object.fromEntries(
      r.jobs.map((j) => [j.path.slice(root.length + 1), [j.state, j.reason]]),
    );
    expect(byName).toEqual({
      'Show/Season 1/e1.mkv': ['queued', null],
      'Show/Season 1/e2.mp4': ['queued', null],
      'Show/Season 1/e3.mkv': ['skipped', 'still growing'],
      'Show/Season 1/e4.mkv': ['skipped', 'hardlinked'],
      'Show/special.ts': ['queued', null],
    });
    expect(r.jobs.every((j) => j.priority === 5 && j.runId === r.run.id)).toBe(true);
    expect(r.jobs.filter((j) => j.state === 'queued').every((j) => j.fileId !== null)).toBe(true);

    const summary = svc.runSummary(r.run.id);
    expect(summary?.counts).toMatchObject({ total: 5, queued: 3, in_progress: 0, skipped: 2 });
    expect(summary).toMatchObject({ workflowName: 'Shrink', libraryName: 'TV' });
    expect(published.filter((e) => e.type === 'run.changed')).toEqual([
      { type: 'run.changed', runId: r.run.id },
    ]);
    expect(onQueued).toHaveBeenCalledTimes(1);
  });

  it('a single file: one job; a non-media file is skipped as not media', async () => {
    const file = await settled(join(root, 'Show', 'a.mkv'));
    const txt = await settled(join(root, 'Show', 'a.txt'));
    expect((await queued(file)).jobs.map((j) => [j.path, j.state])).toEqual([[file, 'queued']]);
    expect((await queued(txt)).jobs.map((j) => [j.state, j.reason])).toEqual([
      ['skipped', 'not media'],
    ]);
  });

  it('fileOnly: a folder is refused as not a file and queues nothing; a file queues as usual', async () => {
    const file = await settled(join(root, 'Show', 'a.mkv'));
    expect(await svc.queue(input(join(root, 'Show'), { fileOnly: true }))).toEqual({
      kind: 'path-rejected',
      reason: 'not a file',
    });
    expect(await svc.queue(input(root, { fileOnly: true, dryRun: true }))).toEqual({
      kind: 'path-rejected',
      reason: 'not a file',
    });
    expect(svc.listRuns(10)).toHaveLength(0);
    expect(onQueued).not.toHaveBeenCalled();
    expect((await queued(file, { fileOnly: true })).jobs.map((j) => j.path)).toEqual([file]);
  });

  it('a file through a symlinked root is queued under its realpath', async () => {
    const alias = join(base, 'alias');
    await symlink(root, alias);
    await settled(join(root, 'Show', 'a.mkv'));
    const r = await queued(join(alias, 'Show', 'a.mkv'));
    expect(r.jobs.map((j) => [j.path, j.state])).toEqual([[join(root, 'Show', 'a.mkv'), 'queued']]);
  });

  it('in a folder, a symlink that escapes the root is skipped; one into the root is deduplicated', async () => {
    await settled(join(outside, 'secret.mkv'));
    const real = await settled(join(root, 'Show', 'a.mkv'));
    await symlink(join(outside, 'secret.mkv'), join(root, 'Show', 'link.mkv'));
    await symlink(real, join(root, 'Show', 'alias.mkv'));
    const r = await queued(join(root, 'Show'));
    expect(r.jobs.map((j) => [j.path.slice(root.length + 1), j.state, j.reason])).toEqual([
      ['Show/a.mkv', 'queued', null],
      ['Show/link.mkv', 'skipped', 'symlink escapes root'],
    ]);
  });

  it('rejects a path outside every library, a missing path and an escaping symlink', async () => {
    await settled(join(outside, 'secret.mkv'));
    await symlink(join(outside, 'secret.mkv'), join(root, 'link.mkv'));
    expect(await svc.queue(input('/etc/passwd'))).toEqual({
      kind: 'path-rejected',
      reason: 'outside library root',
    });
    expect(await svc.queue(input(join(root, 'nope.mkv')))).toEqual({
      kind: 'path-rejected',
      reason: 'not found',
    });
    expect(await svc.queue(input(join(root, 'link.mkv')))).toEqual({
      kind: 'path-rejected',
      reason: 'symlink escapes root',
    });
    expect(await svc.queue(input(join(root, '.transcoda-recycle')))).toEqual({
      kind: 'path-rejected',
      reason: 'not found',
    });
    await mkdir(join(root, '.transcoda-recycle'));
    expect(await svc.queue(input(join(root, '.transcoda-recycle')))).toEqual({
      kind: 'path-rejected',
      reason: 'in recycle folder',
    });
    // A file in there is rejected the same way (final review M4), not a run with a skipped job.
    await writeFile(join(root, '.transcoda-recycle', 'old.mkv'), 'x');
    expect(await svc.queue(input(join(root, '.transcoda-recycle', 'old.mkv')))).toEqual({
      kind: 'path-rejected',
      reason: 'in recycle folder',
    });
    expect(onQueued).not.toHaveBeenCalled();
  });

  it('history: a file with a final result for this version is already_processed; force queues it again', async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    await settled(join(root, 'Show', 'b.mkv'));
    const first = await queued(join(root, 'Show'));
    const jobA = first.jobs.find((j) => j.path === a);
    if (!jobA) throw new Error('no job for a.mkv');
    updateJob(db, jobA.id, { state: 'done' }, new Date());
    doneResult(jobA.id, fingerprintKey(await fingerprintOf(a)));

    const second = await queued(join(root, 'Show'));
    expect(second.jobs.map((j) => [j.path.slice(root.length + 1), j.state, j.reason])).toEqual([
      [
        'Show/a.mkv',
        'already_processed',
        // C5: a `done` result's fingerprint is the original's, so a match is that original, back.
        'already done on 2026-10-01T10:00:00.000Z; this file is the original from before then (moved back from the recycle folder?); run with force to process it again',
      ],
      ['Show/b.mkv', 'queued', null],
    ]);
    expect(svc.runSummary(second.run.id)?.counts).toMatchObject({
      total: 2,
      already_processed: 1,
      queued: 1,
      in_progress: 0,
    });
    // The already-processed row shows the file's recorded size; it has no result.
    expect(svc.runSummary(second.run.id)?.files[0]).toMatchObject({
      state: 'already_processed',
      beforeBytes: (await stat(a)).size,
      afterBytes: null,
    });

    const forced = await queued(join(root, 'Show'), { force: true });
    expect(forced.run.force).toBe(true);
    expect(forced.jobs.map((j) => j.state)).toEqual(['queued', 'queued']);
  });

  it('history: a failed result is final, a dry-run result never is, another version never is', async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    const fp = fingerprintKey(await fingerprintOf(a));
    const dry = await queued(a, { dryRun: true });
    const dryJob = dry.jobs[0];
    if (!dryJob) throw new Error('no job');
    updateJob(db, dryJob.id, { state: 'failed' }, new Date());
    doneResult(dryJob.id, fp, { outcome: 'failed' });
    expect((await queued(a)).jobs.map((j) => j.state)).toEqual(['queued']);

    const real = await queued(a);
    const realJob = real.jobs[0];
    if (!realJob) throw new Error('no job');
    updateJob(db, realJob.id, { state: 'failed' }, new Date());
    doneResult(realJob.id, fp, { outcome: 'failed', workflowVersion: 1 });
    expect((await queued(a)).jobs.map((j) => j.state)).toEqual(['queued']);

    const third = await queued(a);
    const thirdJob = third.jobs[0];
    if (!thirdJob) throw new Error('no job');
    updateJob(db, thirdJob.id, { state: 'failed' }, new Date());
    doneResult(thirdJob.id, fp, { outcome: 'failed', createdAt: '2026-10-02T00:00:00.000Z' });
    expect((await queued(a)).jobs.map((j) => [j.state, j.reason])).toEqual([
      ['already_processed', 'already failed on 2026-10-02T00:00:00.000Z'],
    ]);
  });

  it('real: pins the active version even when newer versions exist', async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    saveMore(flowId, 2);
    expect(workflows.get(flowId)?.currentVersion).toBe(4);
    const r = await queued(a);
    expect(r.run).toMatchObject({ workflowVersion: 2, dryRun: false, note: null });
    expect(r.jobs.map((j) => [j.workflowVersion, j.dryRun])).toEqual([[2, false]]);
  });

  it('real with nothing active: a dry run of the newest, noted on the run', async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    const idle = makeWorkflow('Idle', false);
    saveMore(idle, 1);
    const r = await queued(a, { workflowId: idle });
    expect(r.run).toMatchObject({ workflowVersion: 3, dryRun: true, note: 'no active version' });
    expect(r.jobs.map((j) => [j.workflowVersion, j.dryRun])).toEqual([[3, true]]);
  });

  it("testEncode: 'if-single-file' test-encodes a file, never a folder; true does a folder; absent never", async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    await settled(join(root, 'Show', 'b.mkv'));
    const flags = (r: Awaited<ReturnType<typeof queued>>) => [
      r.run.testEncode,
      r.jobs.map((j) => j.testEncode),
    ];
    expect(flags(await queued(a, { dryRun: true, testEncode: 'if-single-file' }))).toEqual([
      true,
      [true],
    ]);
    const folder = join(root, 'Show');
    expect(flags(await queued(folder, { dryRun: true, testEncode: 'if-single-file' }))).toEqual([
      false,
      [false, false],
    ]);
    expect(flags(await queued(folder, { dryRun: true, testEncode: true }))).toEqual([
      true,
      [true, true],
    ]);
    expect(flags(await queued(a, { dryRun: true }))).toEqual([false, [false]]);
    expect(flags(await queued(a, { dryRun: true, testEncode: false }))).toEqual([false, [false]]);
  });

  it('testEncode: a real request that becomes a dry run (nothing active) never test-encodes', async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    const idle = makeWorkflow('Idle', false);
    const r = await queued(a, { workflowId: idle, testEncode: 'if-single-file' });
    expect(r.run).toMatchObject({ dryRun: true, note: 'no active version', testEncode: false });
    expect(r.jobs.map((j) => j.testEncode)).toEqual([false]);
    const real = await queued(a, { testEncode: true, force: true });
    expect(real.run).toMatchObject({ dryRun: false, testEncode: false });
  });

  it('real on a blocked active version is refused with its issues; nothing is queued', async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    const before = svc.listRuns(100).length;
    // The active version stops being runnable once its node gets a behaviour migration.
    const old = new WorkflowService({
      db,
      registry: testRegistry(bumpV1()),
      capabilities: () => caps,
      now: () => new Date(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const { id } = old.create({ name: 'Bumpy', kind: 'workflow' }, 'u');
    old.save(
      {
        id,
        baseVersion: 1,
        graph: chain(
          'workflow',
          node('in', 'core:input-manual'),
          node('b', 'test:bump', { level: 2 }, { typeVersion: 1 }),
          node('ro', 'core:replace-original'),
        ),
      },
      'u',
    );
    expect(old.activate(id, 2, 'u').kind).toBe('ok');
    const newer = new WorkflowService({
      db,
      registry: testRegistry(bumpV3()),
      capabilities: () => caps,
      now: () => new Date(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const queueNew = new QueueService({
      db,
      workflows: newer,
      events,
      now: () => new Date(),
      settleMinutes: 3,
      onQueued,
    });
    const refused = await queueNew.queue(input(a, { workflowId: id }));
    expect(refused.kind).toBe('workflow-invalid');
    if (refused.kind === 'workflow-invalid') {
      expect(refused.issues.some((i) => i.code === 'NODE_OUTDATED')).toBe(true);
    }
    expect(svc.listRuns(100)).toHaveLength(before);
    expect(onQueued).not.toHaveBeenCalled();
  });

  it('dry: pins the newest by default or the chosen version; unknown versions and other workflows are refused', async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    saveMore(flowId, 2);
    expect((await queued(a, { dryRun: true })).run).toMatchObject({
      workflowVersion: 4,
      dryRun: true,
      note: null,
    });
    const chosen = await queued(a, { dryRun: true, workflowVersion: 2 });
    expect(chosen.run).toMatchObject({ workflowVersion: 2, dryRun: true });
    expect(chosen.jobs.map((j) => j.workflowVersion)).toEqual([2]);
    expect(await svc.queue(input(a, { dryRun: true, workflowVersion: 9 }))).toEqual({
      kind: 'version-missing',
    });
    expect(await svc.queue(input(a, { dryRun: true, workflowVersion: 0 }))).toEqual({
      kind: 'version-missing',
    });
    const { id: subId } = workflows.create({ name: 'Sub', kind: 'subworkflow' }, 'u');
    expect(
      await svc.queue(input(a, { dryRun: true, workflowId: subId, workflowVersion: 1 })),
    ).toEqual({
      kind: 'workflow-missing',
    });
    // A version number that exists only on another workflow is not found here.
    const other = makeWorkflow('Other', true);
    saveMore(other, 3);
    expect(
      await svc.queue(input(a, { dryRun: true, workflowId: flowId, workflowVersion: 5 })),
    ).toEqual({
      kind: 'version-missing',
    });
    expect(onQueued).toHaveBeenCalledTimes(2);
  });

  it('history keys on the resolved version: a v2 result does not block a real run after v3 is activated', async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    const first = await queued(a);
    const job = first.jobs[0];
    if (!job) throw new Error('no job');
    updateJob(db, job.id, { state: 'done' }, new Date());
    doneResult(job.id, fingerprintKey(await fingerprintOf(a)));
    expect((await queued(a)).jobs[0]?.state).toBe('already_processed');
    saveMore(flowId, 1);
    expect(workflows.activate(flowId, 3, 'u').kind).toBe('ok');
    const next = await queued(a);
    expect(next.run.workflowVersion).toBe(3);
    expect(next.jobs.map((j) => [j.state, j.workflowVersion])).toEqual([['queued', 3]]);
  });

  it("run files carry each job's workflow version", async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    const r = await queued(a);
    expect(svc.runSummary(r.run.id)?.files.map((f) => f.workflowVersion)).toEqual([2]);
  });

  it('feeder: without a workflowId a real queue pins its active version, a dry one its newest or the chosen version', async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    // v1 is the empty version `create` writes; v2 is active, v3 and v4 newer drafts.
    saveMore(flowId, 2);
    expect(workflows.get(flowId)?.currentVersion).toBe(4);
    const real = await queued(a);
    expect(real.run).toMatchObject({
      workflowId: flowId,
      workflowVersion: 2,
      dryRun: false,
      note: null,
    });
    const dry = await queued(a, { dryRun: true });
    expect(dry.run).toMatchObject({ workflowId: flowId, workflowVersion: 4, dryRun: true });
    const chosen = await queued(a, { dryRun: true, workflowVersion: 3 });
    expect(chosen.run).toMatchObject({ workflowId: flowId, workflowVersion: 3, dryRun: true });
  });

  it('source: a real run the feeder chose is a library run (run hours apply); one naming its workflow or a dry run is manual', async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    expect((await queued(a)).run.source).toBe('library');
    expect((await queued(root)).run.source).toBe('library');
    expect((await queued(a, { workflowId: flowId, force: true })).run.source).toBe('manual');
    expect((await queued(a, { dryRun: true })).run.source).toBe('manual');
  });

  it('feeder: an explicit inactive workflowId on a fed library still queues that workflow, real → dry with the note', async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    const idle = makeWorkflow('Idle', false);
    const r = await queued(a, { workflowId: idle });
    expect(r.run).toMatchObject({
      workflowId: idle,
      workflowVersion: 2,
      dryRun: true,
      note: 'no active version',
    });
  });

  it('feeder: a library nobody feeds, or whose feeder was deactivated, is no-feeding-workflow for real and dry queues', async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    const otherRoot = join(base, 'films');
    await mkdir(otherRoot, { recursive: true });
    const films = await svc.createLibrary({ name: 'Films', path: otherRoot });
    if (!('id' in films)) throw new Error('library not created');
    const b = await settled(join(otherRoot, 'b.mkv'));
    expect(await svc.queue(input(b))).toEqual({ kind: 'no-feeding-workflow' });
    expect(await svc.queue(input(b, { dryRun: true }))).toEqual({ kind: 'no-feeding-workflow' });
    workflows.deactivate(flowId);
    expect(await svc.queue(input(a))).toEqual({ kind: 'no-feeding-workflow' });
    expect(await svc.queue(input(a, { dryRun: true }))).toEqual({ kind: 'no-feeding-workflow' });
    expect(onQueued).not.toHaveBeenCalled();
  });

  it('workflow resolution: no feeder, missing, invalid', async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    workflows.deactivate(flowId);
    expect(await svc.queue(input(a))).toEqual({ kind: 'no-feeding-workflow' });
    expect(await svc.queue(input(a, { workflowId: 'nope' }))).toEqual({
      kind: 'workflow-missing',
    });
    const { id: subId } = workflows.create({ name: 'Sub', kind: 'subworkflow' }, 'u');
    expect(await svc.queue(input(a, { workflowId: subId }))).toEqual({
      kind: 'workflow-missing',
    });
    const { id: emptyId } = workflows.create({ name: 'Empty', kind: 'workflow' }, 'u');
    const invalid = await svc.queue(input(a, { workflowId: emptyId }));
    expect(invalid.kind).toBe('workflow-invalid');
    if (invalid.kind === 'workflow-invalid') expect(invalid.issues.length).toBeGreaterThan(0);
    expect(onQueued).not.toHaveBeenCalled();
  });

  it('an empty folder is a run with no jobs', async () => {
    const r = await queued(join(root, 'Show', 'Season 1'));
    expect(r.jobs).toEqual([]);
    expect(svc.runSummary(r.run.id)?.counts.total).toBe(0);
  });
});

describe('QueueService libraries', () => {
  it('stores the realpath without a trailing slash', async () => {
    const other = join(base, 'movies');
    await mkdir(other);
    const alias = join(base, 'movies-alias');
    await symlink(other, alias);
    const created = await svc.createLibrary({ name: 'Movies', path: `${alias}/` });
    expect(created).toMatchObject({
      name: 'Movies',
      path: other,
      recycleFolder: null,
      processHardlinked: false,
      verifyFullDecode: false,
    });
  });

  it('verifyFullDecode defaults to false, is set on create and patched on update', async () => {
    expect(lib.verifyFullDecode).toBe(false);
    const other = join(base, 'movies');
    await mkdir(other);
    const created = await svc.createLibrary({ name: 'M', path: other, verifyFullDecode: true });
    expect(created).toMatchObject({ verifyFullDecode: true });
    expect(svc.updateLibrary(lib.id, { verifyFullDecode: true })).toMatchObject({
      verifyFullDecode: true,
    });
    expect(findLibrary(db, lib.id)?.verifyFullDecode).toBe(true);
    expect(svc.updateLibrary(lib.id, { verifyFullDecode: false })).toMatchObject({
      verifyFullDecode: false,
    });
  });

  it('run hours: none by default, set on create, patched on update and cleared; a change ticks the scheduler', async () => {
    const night = {
      enabled: true,
      perDay: false,
      every: [0, 1, 22, 23],
      days: [[], [], [], [], [], [], []],
    };
    expect(lib.runHours).toBeNull();
    const other = join(base, 'movies');
    await mkdir(other);
    expect(await svc.createLibrary({ name: 'M', path: other, runHours: night })).toMatchObject({
      runHours: night,
    });
    onQueued.mockClear();
    expect(svc.updateLibrary(lib.id, { name: 'Renamed' })).toMatchObject({ runHours: null });
    expect(onQueued).not.toHaveBeenCalled();
    expect(svc.updateLibrary(lib.id, { runHours: night })).toMatchObject({ runHours: night });
    expect(findLibrary(db, lib.id)?.runHours).toEqual(night);
    expect(onQueued).toHaveBeenCalledTimes(1);
    expect(svc.updateLibrary(lib.id, { runHours: null })).toMatchObject({ runHours: null });
  });

  it('rejects a recycle folder equal to, containing or outside the root (final review M6)', async () => {
    const other = join(base, 'movies');
    await mkdir(other);
    const problem = {
      kind: 'path-invalid',
      reason: 'the recycle folder must be a folder inside the library root',
    };
    for (const recycleFolder of ['.', other, base, '..', join(base, 'elsewhere'), '/tmp']) {
      expect(
        await svc.createLibrary({ name: 'M', path: other, recycleFolder }),
        recycleFolder,
      ).toEqual(problem);
      expect(svc.updateLibrary(lib.id, { recycleFolder }), recycleFolder).toEqual(problem);
    }
    expect(findLibrary(db, lib.id)?.recycleFolder).toBeNull();
    expect(
      await svc.createLibrary({ name: 'M', path: other, recycleFolder: '.bin' }),
    ).toMatchObject({ recycleFolder: join(other, '.bin') });
    expect(svc.updateLibrary(lib.id, { recycleFolder: join(root, 'bin') })).toMatchObject({
      recycleFolder: join(root, 'bin'),
    });
  });

  it('rejects a missing path, a file, and nested roots', async () => {
    const file = await settled(join(base, 'file.mkv'));
    expect(await svc.createLibrary({ name: 'X', path: join(base, 'nope') })).toEqual({
      kind: 'path-invalid',
      reason: 'not found',
    });
    expect(await svc.createLibrary({ name: 'X', path: file })).toEqual({
      kind: 'path-invalid',
      reason: 'not a directory',
    });
    expect(await svc.createLibrary({ name: 'X', path: join(root, 'Show') })).toMatchObject({
      kind: 'overlaps',
      other: { id: lib.id },
    });
    expect(await svc.createLibrary({ name: 'X', path: base })).toMatchObject({
      kind: 'overlaps',
      other: { id: lib.id },
    });
    expect(await svc.createLibrary({ name: 'X', path: root })).toMatchObject({
      kind: 'overlaps',
      other: { id: lib.id },
    });
  });

  it('updates a library; unknown ids are null', () => {
    expect(svc.updateLibrary(lib.id, { name: 'Shows', processHardlinked: true })).toMatchObject({
      id: lib.id,
      name: 'Shows',
      processHardlinked: true,
    });
    expect(svc.updateLibrary('nope', { name: 'x' })).toBeNull();
  });

  it('delete is busy while a job is active, then soft-deletes', async () => {
    await settled(join(root, 'Show', 'a.mkv'));
    const r = await queued(join(root, 'Show'));
    expect(svc.deleteLibrary(lib.id)).toBe('busy');
    for (const j of r.jobs) updateJob(db, j.id, { state: 'cancelled' }, new Date());
    expect(svc.deleteLibrary(lib.id)).toBe('ok');
    expect(findLibrary(db, lib.id)?.deletedAt).not.toBeNull();
    expect(svc.deleteLibrary(lib.id)).toBe('not-found');
    expect(svc.deleteLibrary('nope')).toBe('not-found');
  });
});

describe('QueueService runs', () => {
  it('runSummary gives a dry run file its estimate and plan summary, and never a real run file', async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    const b = await settled(join(root, 'Show', 'b.mkv'));
    const plan = {
      container: { from: 'mkv', to: 'mkv' },
      rewrite: true,
      streams: [
        {
          index: 0,
          type: 'video' as const,
          codec: 'h264',
          language: null,
          title: null,
          isOriginalLanguage: false,
          default: { before: true, after: true },
          forced: false,
          action: 'convert' as const,
          note: 'h264 → hevc',
        },
      ],
    };
    const dry = await queued(join(root, 'Show'), { dryRun: true });
    const jobA = dry.jobs.find((j) => j.path === a);
    const jobB = dry.jobs.find((j) => j.path === b);
    if (!jobA || !jobB) throw new Error('no jobs');
    updateJob(db, jobA.id, { state: 'dry_run' }, new Date());
    doneResult(jobA.id, fingerprintKey(await fingerprintOf(a)), {
      outcome: 'dry_run',
      afterBytes: null,
      estimatedBytes: 640,
      plan,
    });
    updateJob(db, jobB.id, { state: 'dry_run' }, new Date());
    doneResult(jobB.id, fingerprintKey(await fingerprintOf(b)), {
      outcome: 'dry_run',
      afterBytes: null,
    });
    const files = svc.runSummary(dry.run.id)?.files ?? [];
    expect(files.find((f) => f.jobId === jobA.id)).toMatchObject({
      beforeBytes: 1000,
      afterBytes: null,
      estimatedBytes: 640,
      planSummary: 'convert 1 video track',
    });
    // An old row without a stored estimate or plan: null, not a guess.
    expect(files.find((f) => f.jobId === jobB.id)).toMatchObject({
      estimatedBytes: null,
      planSummary: null,
    });

    const real = await queued(a, { force: true });
    const realJob = real.jobs[0];
    if (!realJob) throw new Error('no job');
    updateJob(db, realJob.id, { state: 'done' }, new Date());
    doneResult(realJob.id, fingerprintKey(await fingerprintOf(a)), { estimatedBytes: 500, plan });
    expect(svc.runSummary(real.run.id)?.files[0]).toMatchObject({
      estimatedBytes: null,
      planSummary: null,
    });
  });

  it('runSummary lists every file with state, reason and sizes; listRuns is newest first', async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    await writeFile(join(root, 'Show', 'b.mkv'), 'x'); // still growing
    const r = await queued(join(root, 'Show'));
    const jobA = r.jobs.find((j) => j.path === a);
    if (!jobA) throw new Error('no job');
    updateJob(db, jobA.id, { state: 'done' }, new Date());
    doneResult(jobA.id, fingerprintKey(await fingerprintOf(a)));

    const detail = svc.runSummary(r.run.id);
    expect(detail?.files).toEqual([
      {
        jobId: jobA.id,
        fileName: 'a.mkv',
        filePath: a,
        state: 'done',
        reason: null,
        beforeBytes: 1000,
        afterBytes: 400,
        replacedTo: 'recycle',
        workflowVersion: 2,
        estimatedBytes: null,
        planSummary: null,
        dependsOnSize: null,
      },
      {
        jobId: expect.any(String),
        fileName: 'b.mkv',
        filePath: join(root, 'Show', 'b.mkv'),
        state: 'skipped',
        reason: 'still growing',
        beforeBytes: null,
        afterBytes: null,
        replacedTo: null,
        workflowVersion: 2,
        estimatedBytes: null,
        planSummary: null,
        dependsOnSize: null,
      },
    ]);
    expect(detail?.counts).toMatchObject({ total: 2, done: 1, skipped: 1, beforeBytes: 1000 });
    expect(svc.runSummary('nope')).toBeNull();

    const later = await queued(a, { force: true });
    const runs = svc.listRuns(10);
    expect(runs.map((s) => s.run.id)).toEqual([later.run.id, r.run.id]);
    expect(runs[0]).toMatchObject({ workflowName: 'Shrink', libraryName: 'TV' });
    expect(runs[0]).not.toHaveProperty('files');
    expect(svc.listRuns(1)).toHaveLength(1);
  });
});

describe('QueueService.browse', () => {
  beforeEach(async () => {
    await mkdir(join(root, '.transcoda-recycle'));
    await mkdir(join(root, 'Movies'));
    await settled(join(root, 'b.mkv'));
    await settled(join(root, 'a.mp4'));
    await settled(join(root, 'notes.txt'));
    await settled(join(root, 'x.mkv.transcoda-1.tmp'));
    await settled(join(root, '.transcoda-2.tmp'));
    await settled(join(outside, 'secret.mkv'));
    await symlink(outside, join(root, 'escape'));
    await symlink(join(outside, 'secret.mkv'), join(root, 'leak.mkv'));
  });

  it('lists dirs and media files at the root, hiding recycle, temp and escaping symlinks', async () => {
    const r = await svc.browse(lib.id, '');
    if (typeof r === 'string' || 'kind' in r) throw new Error('browse failed');
    expect(r.dirs).toEqual(['Movies', 'Show']);
    expect(r.files.map((f) => f.name)).toEqual(['a.mp4', 'b.mkv']);
    expect(r.files[0]).toEqual({ name: 'a.mp4', sizeBytes: 1, mtime: expect.any(String) });
  });

  it('lists a subfolder', async () => {
    await settled(join(root, 'Show', 'Season 1', 'e1.mkv'));
    expect(await svc.browse(lib.id, 'Show/Season 1')).toEqual({
      dirs: [],
      files: [{ name: 'e1.mkv', sizeBytes: 1, mtime: expect.any(String) }],
    });
    expect(await svc.browse(lib.id, 'Show/')).toEqual({ dirs: ['Season 1'], files: [] });
  });

  it('rejects paths that leave the root and the recycle folder; unknown is not-found', async () => {
    expect(await svc.browse(lib.id, '../outside')).toEqual({
      kind: 'path-rejected',
      reason: 'outside library root',
    });
    expect(await svc.browse(lib.id, '../../../../../etc')).toEqual({
      kind: 'path-rejected',
      reason: 'outside library root',
    });
    expect(await svc.browse(lib.id, '/etc')).toEqual({
      kind: 'path-rejected',
      reason: 'outside library root',
    });
    expect(await svc.browse(lib.id, 'escape')).toEqual({
      kind: 'path-rejected',
      reason: 'symlink escapes root',
    });
    expect(await svc.browse(lib.id, '.transcoda-recycle')).toEqual({
      kind: 'path-rejected',
      reason: 'in recycle folder',
    });
    expect(await svc.browse(lib.id, 'nope')).toBe('not-found');
    expect(await svc.browse(lib.id, 'b.mkv')).toBe('not-found');
    expect(await svc.browse('nope', '')).toBe('not-found');
  });
});

describe('QueueService with a library row stored by a symlink', () => {
  it('accepts its files and reports the library', async () => {
    const other = join(base, 'films');
    await mkdir(other);
    const alias = join(base, 'films-alias');
    await symlink(other, alias);
    insertLibrary(
      db,
      {
        id: 'l2',
        name: 'Films',
        path: alias,
        recycleFolder: null,
        processHardlinked: false,
      },
      new Date(),
    );
    const f = await settled(join(other, 'f.mkv'));
    const r = await queued(join(alias, 'f.mkv'), { workflowId: flowId });
    expect(r.run.libraryId).toBe('l2');
    expect(r.jobs.map((j) => j.path)).toEqual([f]);
  });
});

describe('QueueService disk access goes through FsOps (final review M10)', () => {
  it('the folder listing and the read check use the injected FsOps', async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    const b = await settled(join(root, 'Show', 'b.mkv'));
    const listed: string[] = [];
    const fs: FsOps = {
      ...nodeFsOps,
      readdir: async (p) => {
        listed.push(p);
        return nodeFsOps.readdir(p);
      },
      canRead: async (p) => {
        if (p === b) throw Object.assign(new Error('injected'), { code: 'EACCES' });
        return nodeFsOps.canRead(p);
      },
    };
    const faulty = new QueueService({
      db,
      workflows,
      events,
      now: () => new Date(),
      fs,
      onQueued: () => {},
    });
    const r = await faulty.queue(input(join(root, 'Show')));
    if (r.kind !== 'queued') throw new Error(JSON.stringify(r));
    expect(listed).toContain(join(root, 'Show'));
    expect(r.jobs.map((j) => [j.path, j.state, j.reason])).toEqual([
      [a, 'queued', null],
      [b, 'skipped', 'unreadable'],
    ]);
  });
});

describe('QueueService.retryFailed', () => {
  it('requeues failed real jobs as one more attempt and wakes the queue; a file with a newer job, a dry run and a done job stay', async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    const b = await settled(join(root, 'Show', 'b.mkv'));
    const run = await queued(join(root, 'Show'));
    const jobA = run.jobs.find((j) => j.path === a);
    const jobB = run.jobs.find((j) => j.path === b);
    if (!jobA || !jobB) throw new Error('no jobs');
    updateJob(db, jobA.id, { state: 'failed', attempt: 2, reason: 'ffmpeg exited 1' }, new Date());
    updateJob(db, jobB.id, { state: 'done' }, new Date());
    const dry = await queued(a, { dryRun: true });
    // The dry run is newer than the failed job of a: a has a newer job, so it is left alone…
    updateJob(db, dry.jobs[0]?.id ?? '', { state: 'failed' }, new Date());
    onQueued.mockClear();
    expect(svc.retryFailed()).toEqual({ retried: 0 });
    expect(onQueued).not.toHaveBeenCalled();
    // …until the dry run is gone from the picture: a newer failed real job is the one retried.
    db.prepare('DELETE FROM jobs WHERE id = ?').run(dry.jobs[0]?.id ?? '');
    expect(svc.retryFailed()).toEqual({ retried: 1 });
    expect(findJob(db, jobA.id)).toMatchObject({
      state: 'queued',
      attempt: 3,
      reason: null,
      finishedAt: null,
    });
    expect(findJob(db, jobB.id)?.state).toBe('done');
    expect(onQueued).toHaveBeenCalledTimes(1);
  });

  it('a retried job starts with no failed GPUs', async () => {
    const run = await queued(await settled(join(root, 'Show', 'a.mkv')));
    const id = run.jobs[0]?.id ?? '';
    updateJob(db, id, { state: 'failed', failedGpus: ['nvidia:0'] }, new Date());
    expect(svc.retryFailed()).toEqual({ retried: 1 });
    expect(findJob(db, id)).toMatchObject({ state: 'queued', attempt: 2, failedGpus: [] });
  });
});
