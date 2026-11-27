import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { QUEUE_FILES_MAX } from '@transcoda/contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { fingerprintKey } from '../../db/repos/files.ts';
import { nextQueuedJobs, updateJob } from '../../db/repos/jobs/jobs.ts';
import { insertLibrary } from '../../db/repos/libraries.ts';
import { fingerprintOf } from '../files/fingerprint.ts';
import { HELD_BY_ANOTHER_RUN, type QueueFilesInput } from './queue-service.ts';
import {
  base,
  cancelQueued,
  db,
  doneResult,
  flowId,
  lib,
  makeWorkflow,
  onQueued,
  outside,
  published,
  queued,
  root,
  saveMore,
  settled,
  svc,
  useQueueService,
} from './testing/queue-service.ts';

useQueueService();

describe('QueueService.queueFiles', () => {
  let show: string;
  let a: string;
  let b: string;

  beforeEach(async () => {
    show = join(root, 'Show');
    a = await settled(join(show, 'Skyward (1941).mkv'));
    b = await settled(join(show, 'Shepherd Jr. (1924).mkv'));
  });

  function filesInput(extra: Partial<QueueFilesInput> = {}): QueueFilesInput {
    return {
      libraryId: lib.id,
      paths: [a],
      workflowId: flowId,
      dryRun: false,
      force: false,
      priority: 0,
      start: 'now',
      createdBy: 'u1',
      ...extra,
    };
  }

  function previewInput(extra: Partial<QueueFilesInput> = {}) {
    const { libraryId, paths, workflowId, dryRun } = filesInput(extra);
    return { libraryId, paths, workflowId, dryRun };
  }

  async function queuedFiles(extra: Partial<QueueFilesInput> = {}) {
    const r = await svc.queueFiles(filesInput(extra));
    if (r.kind !== 'queued') throw new Error(`expected queued, got ${JSON.stringify(r)}`);
    return r;
  }

  /** Marks the only job of a run of `path` done by v2 of the feeder, then frees the file. */
  async function doneByV2(path: string): Promise<void> {
    const job = (await queued(path)).jobs[0];
    if (!job) throw new Error('no job');
    updateJob(db, job.id, { state: 'done' }, new Date());
    doneResult(job.id, fingerprintKey(await fingerprintOf(path)));
    cancelQueued();
  }

  const count = (table: 'jobs' | 'runs' | 'files'): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const rowCounts = () => ({ jobs: count('jobs'), runs: count('runs'), files: count('files') });

  it('queues the files as one manual run of the active version', async () => {
    const r = await queuedFiles({ paths: [a, b], priority: 3 });
    expect(r.run).toMatchObject({
      libraryId: lib.id,
      workflowId: flowId,
      source: 'manual',
      workflowVersion: 2,
      dryRun: false,
      testEncode: false,
      force: false,
      createdBy: 'u1',
      // More than one file: the run names the library root.
      requestedPath: root,
    });
    expect(r.jobs.map((j) => [j.path, j.state, j.priority, j.runId])).toEqual([
      [a, 'queued', 3, r.run.id],
      [b, 'queued', 3, r.run.id],
    ]);
    expect(r.jobs.every((j) => j.fileId !== null && !j.testEncode)).toBe(true);
    expect(svc.listRuns(10)).toHaveLength(1);
    expect(onQueued).toHaveBeenCalledTimes(1);
    expect(published.filter((e) => e.type === 'run.changed')).toEqual([
      { type: 'run.changed', runId: r.run.id },
    ]);
    // One file: the run names that file.
    cancelQueued();
    expect((await queuedFiles({ paths: [b] })).run.requestedPath).toBe(b);
  });

  it("start 'runHours' writes a library run, for a dry run too", async () => {
    const real = await queuedFiles({ paths: [a], start: 'runHours' });
    expect(real.run).toMatchObject({ source: 'library', dryRun: false });
    const dry = await queuedFiles({ paths: [b], start: 'runHours', dryRun: true });
    expect(dry.run).toMatchObject({ source: 'library', dryRun: true });
    // 'now' stays manual, for a dry run too.
    expect((await queuedFiles({ paths: [b], dryRun: true })).run.source).toBe('manual');
  });

  it('a runHours run waits while its library is held; a run started now does not', async () => {
    const held = await queuedFiles({ paths: [a], start: 'runHours' });
    const now = await queuedFiles({ paths: [b], start: 'now' });
    const ids = (heldIds: string[]) => nextQueuedJobs(db, 10, heldIds).map((j) => j.id);
    expect(ids([lib.id])).toEqual([now.jobs[0]?.id]);
    expect(ids([])).toEqual([held.jobs[0]?.id, now.jobs[0]?.id]);
  });

  it('a file this workflow already handled is already_processed; force queues it', async () => {
    await doneByV2(a);
    const r = await queuedFiles({ paths: [a, b] });
    expect(r.jobs.map((j) => [j.path, j.state])).toEqual([
      [a, 'already_processed'],
      [b, 'queued'],
    ]);
    expect(r.jobs[0]?.reason).toMatch(/Process again/);
    cancelQueued();
    const forced = await queuedFiles({ paths: [a], force: true });
    expect(forced.run.force).toBe(true);
    expect(forced.jobs.map((j) => [j.path, j.state, j.reason])).toEqual([[a, 'queued', null]]);
  });

  it('a file a real job of another run holds is skipped as held by another run', async () => {
    const other = await queued(a);
    expect(other.jobs[0]?.state).toBe('queued');
    const r = await queuedFiles({ paths: [a] });
    expect(r.jobs[0]).toMatchObject({ path: a, state: 'skipped', reason: HELD_BY_ANOTHER_RUN });
    // Force does not take a file from another real job either.
    const forced = await queuedFiles({ paths: [a], force: true });
    expect(forced.jobs[0]).toMatchObject({ state: 'skipped', reason: HELD_BY_ANOTHER_RUN });
    // A dry run only reads the file: it is not held.
    expect((await queuedFiles({ paths: [a], dryRun: true })).jobs[0]?.state).toBe('queued');
  });

  it('a real run without an active version becomes a dry run of the newest (note no active version)', async () => {
    const draft = makeWorkflow('Draft', false);
    saveMore(draft, 1);
    const r = await queuedFiles({ paths: [a], workflowId: draft });
    expect(r.run).toMatchObject({
      workflowId: draft,
      workflowVersion: 3,
      dryRun: true,
      note: 'no active version',
      source: 'manual',
    });
    expect(r.jobs.every((j) => j.dryRun)).toBe(true);
  });

  it('a dry run plans the newest version', async () => {
    saveMore(flowId, 1);
    const r = await queuedFiles({ paths: [a], dryRun: true });
    expect(r.run).toMatchObject({ workflowVersion: 3, dryRun: true, note: null });
    expect(r.jobs[0]).toMatchObject({ workflowVersion: 3, dryRun: true, state: 'queued' });
    // A real run still takes the active version, not the newest.
    expect((await queuedFiles({ paths: [b] })).run.workflowVersion).toBe(2);
  });

  it('a path outside the library is refused; a vanished file is skipped', async () => {
    const stray = await settled(join(outside, 'The Gardener (1926).mkv'));
    for (const [paths, offending] of [
      [[a, stray], stray],
      [['/etc/passwd'], '/etc/passwd'],
      [['Show/a.mkv'], 'Show/a.mkv'],
    ] as const) {
      expect(await svc.queueFiles(filesInput({ paths: [...paths] }))).toEqual({
        kind: 'path-rejected',
        reason: 'outside library root',
        path: offending,
      });
    }
    expect(rowCounts()).toEqual({ jobs: 0, runs: 0, files: 0 });
    expect(onQueued).not.toHaveBeenCalled();

    const gone = await settled(join(show, 'Nocturne of the Quiet Moon (1968).mkv'));
    await rm(gone);
    const r = await queuedFiles({ paths: [a, gone] });
    expect(r.jobs.map((j) => [j.path, j.state, j.reason])).toEqual([
      [a, 'queued', null],
      [gone, 'skipped', 'unreadable'],
    ]);
  });

  it('a file in the recycle folder or a symlink out of the root is skipped, not queued', async () => {
    await mkdir(join(root, '.transcoda-recycle'));
    const recycled = await settled(join(root, '.transcoda-recycle', 'old.mkv'));
    await settled(join(outside, 'secret.mkv'));
    const leak = join(show, 'leak.mkv');
    await symlink(join(outside, 'secret.mkv'), leak);
    const r = await queuedFiles({ paths: [a, recycled, leak] });
    expect(r.jobs.map((j) => [j.path, j.state, j.reason])).toEqual([
      [a, 'queued', null],
      [recycled, 'skipped', 'in recycle folder'],
      [leak, 'skipped', 'symlink escapes root'],
    ]);
  });

  it('files named through a symlink to the root count as inside it, one job per real file', async () => {
    const alias = join(base, 'alias');
    await symlink(root, alias);
    const viaAlias = join(alias, 'Show', 'Skyward (1941).mkv');
    const r = await queuedFiles({
      paths: [viaAlias, a, join(alias, 'Show', 'Shepherd Jr. (1924).mkv')],
    });
    expect(r.jobs.map((j) => [j.path, j.state])).toEqual([
      [a, 'queued'],
      [b, 'queued'],
    ]);
  });

  it('a library stored by a symlink takes paths under either form of its root', async () => {
    const films = join(base, 'films');
    await mkdir(films);
    const alias = join(base, 'films-alias');
    await symlink(films, alias);
    insertLibrary(
      db,
      { id: 'l2', name: 'Films', path: alias, recycleFolder: null, processHardlinked: false },
      new Date(),
    );
    const f = await settled(join(films, 'The Gardener (1926).mkv'));
    const g = await settled(join(films, 'Shepherd Jr. (1924).mkv'));
    const r = await queuedFiles({
      libraryId: 'l2',
      paths: [join(alias, 'The Gardener (1926).mkv'), g],
    });
    expect(r.run).toMatchObject({ libraryId: 'l2', requestedPath: films });
    expect(r.jobs.map((j) => [j.path, j.state])).toEqual([
      [f, 'queued'],
      [g, 'queued'],
    ]);
    // A file of the other library is outside this one.
    expect(await svc.queueFiles(filesInput({ libraryId: 'l2', paths: [a] }))).toEqual({
      kind: 'path-rejected',
      reason: 'outside library root',
      path: a,
    });
  });

  it('an unknown or deleted library is not found; too many paths are refused', async () => {
    expect(await svc.queueFiles(filesInput({ libraryId: 'nope' }))).toEqual({
      kind: 'path-rejected',
      reason: 'not found',
    });
    expect(await svc.queueFiles(filesInput({ paths: [] }))).toEqual({
      kind: 'path-rejected',
      reason: 'not found',
    });
    const many = Array.from({ length: QUEUE_FILES_MAX + 1 }, (_, i) => join(show, `f${i}.mkv`));
    expect(await svc.queueFiles(filesInput({ paths: many }))).toEqual({
      kind: 'path-rejected',
      reason: 'too many files',
      path: lib.path,
    });
    expect(await svc.previewFiles(previewInput({ paths: many }))).toEqual({
      kind: 'path-rejected',
      reason: 'too many files',
      path: lib.path,
    });
    expect(await svc.queueFiles(filesInput({ libraryId: 'nope', paths: many }))).toEqual({
      kind: 'path-rejected',
      reason: 'not found',
    });
    expect(await svc.queueFiles(filesInput({ workflowId: 'nope' }))).toEqual({
      kind: 'workflow-missing',
    });
    expect(svc.deleteLibrary(lib.id)).toBe('ok');
    expect(await svc.queueFiles(filesInput())).toEqual({
      kind: 'path-rejected',
      reason: 'not found',
    });
    expect(await svc.previewFiles(previewInput())).toEqual({
      kind: 'path-rejected',
      reason: 'not found',
    });
    expect(rowCounts()).toEqual({ jobs: 0, runs: 0, files: 0 });
  });

  it('previewFiles counts without writing anything', async () => {
    // a: new; b: done by v2; c: held by a queued real job; d: deleted from disk
    await doneByV2(b);
    const c = await settled(join(show, 'The Gardener (1926).mkv'));
    await queued(c);
    const d = await settled(join(show, 'Nocturne of the Quiet Moon (1968).mkv'));
    await rm(d);
    const calls = onQueued.mock.calls.length;
    const events = published.length;
    const before = rowCounts();

    const preview = await svc.previewFiles(previewInput({ paths: [a, b, c, d] }));
    expect(preview).toEqual({
      kind: 'preview',
      willRun: 1,
      alreadyHandled: 1,
      heldByAnotherRun: 1,
      skipped: 1,
      workflowVersion: 2,
      dryRun: false,
    });
    expect(rowCounts()).toEqual(before);
    expect(onQueued.mock.calls.length).toBe(calls);
    expect(published.length).toBe(events);

    // The run itself lands on the same counts.
    const r = await queuedFiles({ paths: [a, b, c, d] });
    expect(r.jobs.map((j) => [j.path, j.state])).toEqual([
      [a, 'queued'],
      [b, 'already_processed'],
      [c, 'skipped'],
      [d, 'skipped'],
    ]);
    expect(r.jobs[2]?.reason).toBe(HELD_BY_ANOTHER_RUN);
  });

  it('a dry-run preview counts already handled for that version only', async () => {
    await doneByV2(b);
    // The dry run plans v2: b was handled by v2.
    expect(await svc.previewFiles(previewInput({ paths: [a, b], dryRun: true }))).toMatchObject({
      kind: 'preview',
      willRun: 1,
      alreadyHandled: 1,
      workflowVersion: 2,
      dryRun: true,
    });
    // The newest is v3 now: b was never handled by it.
    saveMore(flowId, 1);
    expect(await svc.previewFiles(previewInput({ paths: [a, b], dryRun: true }))).toEqual({
      kind: 'preview',
      willRun: 2,
      alreadyHandled: 0,
      heldByAnotherRun: 0,
      skipped: 0,
      workflowVersion: 3,
      dryRun: true,
    });
    // A real preview still takes the active v2 and its history at any version.
    expect(await svc.previewFiles(previewInput({ paths: [a, b] }))).toMatchObject({
      willRun: 1,
      alreadyHandled: 1,
      workflowVersion: 2,
      dryRun: false,
    });
  });

  it('a real preview without an active version reports the dry run of the newest', async () => {
    const draft = makeWorkflow('Draft', false);
    expect(await svc.previewFiles(previewInput({ workflowId: draft }))).toEqual({
      kind: 'preview',
      willRun: 1,
      alreadyHandled: 0,
      heldByAnotherRun: 0,
      skipped: 0,
      workflowVersion: 2,
      dryRun: true,
    });
  });
});
