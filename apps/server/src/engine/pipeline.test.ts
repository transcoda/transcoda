import { stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../app/test-app.ts';
import { findJob, findJobResult, insertJob, insertJobResult, listTrace } from '../db/repos/jobs.ts';
import { nodeFsOps } from '../platform/fs-ops.ts';
import { edge, mainGraph, node } from '../workflows/test-helpers.ts';
import { modelFromProbe } from './build-model.ts';
import { contentHash } from './content-hash.ts';
import { fingerprintKey, fingerprintOf } from './fingerprint.ts';
import { laneFor } from './pipeline-plan.ts';
import {
  base,
  caps,
  configDir,
  fake,
  fakeExec,
  file,
  fsOps,
  lib,
  line,
  listAll,
  published,
  queue,
  replaceNode,
  root,
  row,
  SECRET,
  settled,
  setup,
  spawner,
  states,
  TestSpawner,
  t,
  toH264,
  transcodeDir,
  until,
  workflow,
} from './pipeline-test-harness.ts';
import type { RunnerProcess, SpawnOptions } from './process.ts';
import { probeOf, withStream } from './test-helpers.ts';

describe('pipeline', () => {
  it('nothing to do: identity model ends nothing_to_do after building, no lane, file untouched', async () => {
    const wf = workflow(line(node('in', 'core:input-manual'), node('ro', 'core:replace-original')));
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'nothing_to_do', lane: null, reason: 'already as planned' });
    expect(states(id)).toEqual(['probing', 'deciding', 'building', 'nothing_to_do']);
    expect(spawner.calls).toEqual([]);
    expect(findJobResult(t.db, id)).toMatchObject({
      outcome: 'nothing_to_do',
      plan: { rewrite: false },
    });
    expect((await stat(file())).size).toBe(1000);
  });

  it('a changed model on a path without replace/move ends kept_original "path never writes the result" without spawning ffmpeg', async () => {
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        toH264(),
        node('sg', 'core:size-gate', { minSavingPercent: 10 }),
      ),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({
      state: 'kept_original',
      reason: 'path never writes the result',
    });
    expect(spawner.calls).toEqual([]);
    // The trace shows the build.
    expect(listTrace(t.db, id).map((e) => [e.nodeId, e.phase])).toEqual([
      ['in', 'pass'],
      ['ev', 'build'],
      ['render-1', 'finish'],
      ['sg', 'finish'],
    ]);
  });

  it('dry run: ends dry_run with the rendered command, a per-stream plan (drop/convert/keep, default before/after, isOriginalLanguage), an estimate from history and the owner warning; nothing written', async () => {
    await t.deps.engine.stop();
    const uid = (await stat(file())).uid;
    await setup({ puid: uid + 1 });
    fake.sourceProbe = probeOf(
      [
        { type: 'video', codec: 'hevc', default: true },
        { type: 'audio', codec: 'aac', language: 'fra', default: true },
        { type: 'audio', codec: 'aac', language: 'jpn' },
        { type: 'audio', codec: 'aac', language: 'eng' },
      ],
      { sizeBytes: 1000 },
    );
    const graph = mainGraph(
      [
        node('in', 'core:input-manual'),
        node('lang', 'test:original-language'),
        node('kl', 'core:keep-languages', { languages: ['en'] }),
        toH264(),
        node('ro', 'core:replace-original'),
      ],
      [
        edge('in', 'kl'),
        edge('lang', 'kl', { from: 'language', to: 'language' }),
        edge('kl', 'ev'),
        edge('ev', 'ro'),
      ],
    );
    const wf = workflow(graph);
    // History: one done result of this workflow at half the size.
    const prior = insertJob(
      t.db,
      {
        id: 'prior',
        runId: (await t.deps.engine.queue
          .queue({
            path: file(),
            workflowId: wf,
            dryRun: true,
            force: true,
            priority: 0,
            createdBy: 'u',
          })
          .then((r) => (r.kind === 'queued' ? r.run.id : ''))) as string,
        libraryId: lib.id,
        fileId: null,
        path: '/elsewhere.mkv',
        workflowId: wf,
        workflowVersion: 2,
        dryRun: false,
        testEncode: false,
        state: 'done',
        priority: 0,
      },
      t.clock.now(),
    );
    insertJobResult(t.db, {
      jobId: prior.id,
      fingerprint: 'x',
      workflowId: wf,
      workflowVersion: 2,
      outcome: 'done',
      beforeBytes: 2000,
      afterBytes: 1000,
      estimatedBytes: null,
      command: null,
      plan: null,
      replacedTo: 'recycle',
      logPath: null,
      warnings: [],
      problems: [],
      outputProbe: null,
      sourceDamaged: false,
      createdAt: t.clock.now().toISOString(),
    });
    const before = await listAll(base);
    const id = await queue(file(), wf, { dryRun: true });
    await t.deps.engine.start();
    const job = await settled(id);
    expect(job.state).toBe('dry_run');
    const result = findJobResult(t.db, id);
    expect(result?.command).toMatch(/^ffmpeg -loglevel level\+warning .*-c:0 libx264/);
    expect(result?.estimatedBytes).toBe(500);
    expect(result?.warnings).toEqual([`owner would change from ${uid} to ${uid + 1}`]);
    expect(result?.plan?.streams).toEqual([
      expect.objectContaining({ index: 0, type: 'video', codec: 'h264', action: 'convert' }),
      expect.objectContaining({
        index: 1,
        language: 'fra',
        action: 'drop',
        isOriginalLanguage: false,
        default: { before: true, after: false },
      }),
      expect.objectContaining({
        index: 2,
        language: 'jpn',
        action: 'keep',
        isOriginalLanguage: true,
        default: { before: false, after: true },
      }),
      expect.objectContaining({ index: 3, language: 'eng', action: 'keep' }),
    ]);
    expect(result?.plan?.streams[0]?.note).toMatch(/^convert hevc→h264 \(libx264/);
    // The output's tracks in output order (what the preview and the job page's player read).
    expect(result?.plan?.output).toEqual([
      { type: 'video', codec: 'h264', sourceIndex: 0, bitDepth: 8 },
      { type: 'audio', codec: 'aac', sourceIndex: 2 },
      { type: 'audio', codec: 'aac', sourceIndex: 3 },
    ]);
    expect(spawner.calls).toEqual([]);
    // Nothing written: no temp dir, no log dir, the library as it was.
    expect(await listAll(base)).toEqual(before);
  });

  it('dry run: Remove duplicate audio after Encode audio drops the copy made from the lesser source, and the plan says why', async () => {
    fake.sourceProbe = probeOf(
      [
        { type: 'video', codec: 'hevc', default: true },
        { type: 'audio', codec: 'truehd', language: 'eng', default: true },
        { type: 'audio', codec: 'ac3', language: 'eng' },
      ],
      { sizeBytes: 1000 },
    );
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        node('ea', 'core:encode-audio', { mode: 'reencode', downmixTo: 'stereo' }),
        node('dd', 'core:remove-duplicate-audio'),
        node('ro', 'core:replace-original'),
      ),
    );
    const id = await queue(file(), wf, { dryRun: true });
    await t.deps.engine.start();
    expect((await settled(id)).state).toBe('dry_run');
    expect(listTrace(t.db, id).find((e) => e.nodeId === 'dd')?.reason).toBe(
      'dropped audio #2: same as audio #1 (AAC 2.0 English)',
    );
    const result = findJobResult(t.db, id);
    expect(result?.plan?.streams.map((s) => [s.index, s.action, s.default.after, s.note])).toEqual([
      [0, 'keep', true, ''],
      [1, 'convert', true, 'convert truehd→aac (aac 160k 2ch)'],
      [2, 'drop', false, 'same as audio #1 (AAC 2.0 English)'],
    ]);
    const maps = (result?.command ?? '').match(/-map \S+/g);
    expect(maps).toEqual(['-map 0:0', '-map 0:1']);
  });

  it('full run: queued→probing→deciding→building→encoding→verifying→replacing→done; before/after bytes; recycle has the original; trace complete', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    expect(row(id).state).toBe('queued');
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    expect(spawner.calls[0]?.args.slice(0, 2)).toEqual(['-loglevel', 'level+warning']);
    expect(spawner.calls[0]?.logPath).toBe(join(configDir, 'logs', 'jobs', `${id}.attempt-1.log`));
    expect(row(id)).toMatchObject({ state: 'encoding', lane: 'encode' });
    spawner.emitProgress({ outTimeSeconds: 30, speed: 2, fps: 50, sizeBytes: 300 });
    expect(row(id).progress).toMatchObject({ percent: 50, etaSeconds: 15 });
    await spawner.complete({ bytes: 600 });
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'done', reason: null, lane: null, progress: null });
    expect(states(id)).toEqual([
      'probing',
      'deciding',
      'building',
      'encoding',
      'verifying',
      'replacing',
      'done',
    ]);
    expect(findJobResult(t.db, id)).toMatchObject({
      outcome: 'done',
      beforeBytes: 1000,
      afterBytes: 600,
      replacedTo: 'recycle',
      plan: { rewrite: true },
    });
    expect((await stat(file())).size).toBe(600);
    expect((await stat(join(root, '.transcoda-recycle', 'Show', 'a.mkv'))).size).toBe(1000);
    // The replaced file is known by its own fingerprint and content hash; the source by its hash.
    const result = findJobResult(t.db, id);
    expect(result?.outputFingerprint).toBe(fingerprintKey(await fingerprintOf(file())));
    expect(result?.outputFingerprint).not.toBe(result?.fingerprint);
    expect(result?.outputHash).toBe(await contentHash(file()));
    expect(result?.sourceHash).toBe(
      await contentHash(join(root, '.transcoda-recycle', 'Show', 'a.mkv')),
    );
    expect(result?.sourceHash).toMatch(/^v1:1000:/);
    expect(result?.outputHash).toMatch(/^v1:600:/);
    // Outputs are written as before: no metadata of Transcoda's own.
    expect(spawner.calls[0]?.args.some((a) => a.startsWith('TRANSCODA'))).toBe(false);
    const trace = listTrace(t.db, id);
    expect(trace.map((e) => [e.nodeId, e.phase])).toEqual([
      ['in', 'pass'],
      ['ev', 'build'],
      ['render-1', 'finish'],
      ['ro', 'finish'],
      // After verify: Render says the file left by Done.
      ['render-1', 'finish'],
    ]);
    expect(trace.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(trace.at(-1)).toMatchObject({
      port: 'done',
      reason: 'Render: encoded and verified \u2192 Done',
    });
    expect(job.walkPath).toEqual([
      { workflowPath: [], nodeId: 'in', port: 'file' },
      { workflowPath: [], nodeId: 'ev', port: 'file' },
      { workflowPath: [], nodeId: 'render-1', port: 'done' },
      { workflowPath: [], nodeId: 'ro', port: 'file' },
    ]);
    // The probe was written to the file row; temp removed.
    expect(t.deps.engine.jobDetail(id)?.probe).toMatchObject({ container: 'mkv' });
    expect(await listAll(transcodeDir)).toEqual([]);
    const changed = published.filter((e) => e.type === 'job.changed' && e.jobId === id);
    expect(changed.some((e) => e.type === 'job.changed' && e.currentNode?.nodeId === 'ro')).toBe(
      true,
    );
  });

  it('size gate below threshold → kept_original and the temp output removed', async () => {
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        toH264(),
        node('sg', 'core:size-gate', { minSavingPercent: 50 }),
        node('ro', 'core:replace-original'),
      ),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 900 });
    expect(await settled(id)).toMatchObject({
      state: 'kept_original',
      reason: 'saved only 10.0%, below 50%',
    });
    expect(findJobResult(t.db, id)).toMatchObject({ afterBytes: 900, replacedTo: null });
    expect(await listAll(transcodeDir)).toEqual([]);
    expect((await stat(file())).size).toBe(1000);
  });

  it('verify failure → attempt 2 → failed on the second failure; original untouched', async () => {
    fake.brokenOutput = true;
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('first spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('second spawn', () => spawner.calls.length === 2);
    expect(row(id)).toMatchObject({ attempt: 2 });
    await spawner.complete({ bytes: 600 });
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', failureCode: 'verify', attempt: 2 });
    expect(job.reason).toMatch(/^verify: duration: output #0 \(video #0\) ends early/);
    expect(states(id)).toContain('queued');
    expect((await stat(file())).size).toBe(1000);
    expect(await listAll(join(root))).toEqual(['/Show', '/Show/a.mkv']);
    // Trace entries keep their attempt; seq continues across attempts.
    const trace = listTrace(t.db, id);
    expect(trace.map((e) => [e.attempt, e.seq])).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
      [1, 4],
      [2, 5],
      [2, 6],
      [2, 7],
      [2, 8],
      [2, 9],
    ]);
    // The retried attempt 1 says nothing; the final failure is told on the Render, whose work
    // (encode and verify) failed.
    expect(trace.filter((e) => e.reason.startsWith('failed:'))).toEqual([
      expect.objectContaining({ attempt: 2, nodeId: 'render-1', workflowPath: [] }),
    ]);
    expect(trace.at(-1)?.reason).toBe(`failed: ${job.reason}`);
  });

  it('an encode that crashes partway fails the job and its Render: the trace says failed with the reason, Replace never ran', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    for (const n of [1, 2]) {
      await until(`spawn ${n}`, () => spawner.calls.length === n);
      // Killed mid-encode: some output written, then ffmpeg exits non-zero.
      await spawner.complete({ bytes: 300, code: 137, stderr: ['Killed'] });
    }
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', failureCode: 'encode', attempt: 2 });
    const trace = listTrace(t.db, id).filter((e) => e.attempt === 2);
    const failed = trace.filter((e) => e.reason.startsWith('failed:'));
    expect(failed).toEqual([
      expect.objectContaining({
        nodeId: 'render-1',
        workflowPath: [],
        phase: 'finish',
        port: null,
        reason: `failed: ${job.reason}`,
      }),
    ]);
    // Replace's only entry is the walk's plan; nothing says it ran.
    expect(trace.filter((e) => e.nodeId === 'ro').map((e) => e.reason)).toHaveLength(1);
    expect((await stat(file())).size).toBe(1000);
  });

  it('fingerprint change before replace → requeued once, then failed "file changed during processing"', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    const touch = async (n: number) => {
      const when = new Date(Date.now() - n * 60_000);
      await utimes(file(), when, when);
    };
    await until('first spawn', () => spawner.calls.length === 1);
    await touch(10);
    await spawner.complete({ bytes: 600 });
    await until('second spawn', () => spawner.calls.length === 2);
    expect(row(id)).toMatchObject({ requeues: 1, attempt: 1 });
    await touch(20);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({
      state: 'failed',
      failureCode: 'source_changed',
      reason: 'file changed during processing',
    });
    expect((await stat(file())).size).toBe(1000);
    expect(await listAll(transcodeDir)).toEqual([]);
  });

  it('cancel during encoding → cancelled, temp removed; cancel during replacing → done with reason "canceled too late"', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    expect(t.deps.engine.scheduler.cancelJob(id)).toBe('ok');
    expect(await settled(id)).toMatchObject({ state: 'cancelled' });
    expect(spawner.signals).toEqual(['SIGKILL']);
    expect(await listAll(transcodeDir)).toEqual([]);
    expect(findJobResult(t.db, id)?.outcome).toBe('cancelled');
    // The Render was at work: its trace says canceled (not failed, not done).
    expect(listTrace(t.db, id).at(-1)).toMatchObject({
      nodeId: 'render-1',
      reason: 'canceled: the job was canceled during this step',
    });
    expect(listTrace(t.db, id).some((e) => e.reason.startsWith('failed:'))).toBe(false);

    // Cancelled while the replacement is being written beside the original: too late.
    await t.deps.engine.stop();
    let cancelId = '';
    await setup({
      fs: {
        ...fsOps,
        copyFile: async (src, dst) => {
          if (dst.endsWith('.tmp')) t.deps.engine.scheduler.cancelJob(cancelId);
          return nodeFsOps.copyFile(src, dst);
        },
      },
    });
    const wf2 = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    await writeFile(join(root, 'Show', 'b.mkv'), Buffer.alloc(1000, 7));
    cancelId = await queue(join(root, 'Show', 'b.mkv'), wf2);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    expect(await settled(cancelId)).toMatchObject({
      state: 'done',
      reason: 'canceled too late',
    });
    expect((await stat(join(root, 'Show', 'b.mkv'))).size).toBe(600);
  });

  it('shutdown during encoding → process killed, no job update, temp dir left in place; a following engine.start() sweeps it: requeued once', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    const before = row(id);
    await t.deps.engine.stop();
    expect(spawner.signals).toEqual(['SIGKILL']);
    expect(row(id)).toEqual(before);
    expect(row(id).state).toBe('encoding');
    expect(await listAll(transcodeDir)).toEqual([`/${id}`]);

    // A restart over the same database: the sweep requeues it once; the queue stays paused.
    t.db
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('queue.paused', 'true', '')")
      .run();
    const db = t.db;
    const app2 = createTestApp({
      db,
      config: { configDir, transcodeDir },
      capabilities: caps,
      spawner: new TestSpawner(),
      fsOps,
      exec: fakeExec,
    });
    const sweep = await app2.deps.engine.start();
    try {
      expect(sweep.interrupted).toEqual([id]);
      expect(findJob(db, id)).toMatchObject({
        state: 'queued',
        requeues: 1,
        reason: 'interrupted',
      });
      expect(await listAll(transcodeDir)).toEqual([]);
    } finally {
      await app2.deps.engine.stop();
    }
  });

  /** v2 (active) ends nothing_to_do; the v3 it gets saved as ends kept_original. */
  const savedV3 = (wf: string): void => {
    const saved = t.deps.workflows.save(
      {
        id: wf,
        baseVersion: 2,
        graph: line(
          node('in', 'core:input-manual'),
          toH264(),
          node('sg', 'core:size-gate', { minSavingPercent: 10 }),
        ),
      },
      'u',
    );
    expect(saved.version).toBe(3);
  };
  const v2Workflow = (): string =>
    workflow(line(node('in', 'core:input-manual'), node('ro', 'core:replace-original')));
  /** job.changed events of the job published while it was probing. */
  const probingEvents = (id: string): number =>
    published.filter((e) => e.type === 'job.changed' && e.jobId === id && e.state === 'probing')
      .length;

  /** A final real result of version `version` for the file (as a finished earlier job). */
  async function priorDone(wf: string, runOf: string, version: number): Promise<void> {
    const prior = insertJob(
      t.db,
      {
        id: `prior-${version}`,
        runId: row(runOf).runId,
        libraryId: lib.id,
        fileId: null,
        path: '/elsewhere.mkv',
        workflowId: wf,
        workflowVersion: version,
        dryRun: false,
        testEncode: false,
        state: 'done',
        priority: 0,
      },
      t.clock.now(),
    );
    insertJobResult(t.db, {
      jobId: prior.id,
      fingerprint: fingerprintKey(await fingerprintOf(file())),
      workflowId: wf,
      workflowVersion: version,
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
      createdAt: '2026-10-01T10:00:00.000Z',
    });
  }

  it('a real job queued under v2 that starts after v3 was activated runs v3 and its result says v3', async () => {
    const wf = v2Workflow();
    const id = await queue(file(), wf);
    expect(row(id).workflowVersion).toBe(2);
    savedV3(wf);
    expect(t.deps.workflows.activate(wf, 3, 'u').kind).toBe('ok');
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'kept_original', workflowVersion: 3 });
    expect(findJobResult(t.db, id)).toMatchObject({ outcome: 'kept_original', workflowVersion: 3 });
    expect(listTrace(t.db, id).map((e) => e.nodeId)).toEqual(['in', 'ev', 'render-1', 'sg']);
    // The re-pin was published before the file was probed.
    expect(probingEvents(id)).toBeGreaterThanOrEqual(2);
  });

  it('the same file with a final real v3 result ends already_processed and its result row carries v3', async () => {
    const wf = v2Workflow();
    const id = await queue(file(), wf);
    savedV3(wf);
    expect(t.deps.workflows.activate(wf, 3, 'u').kind).toBe('ok');
    await priorDone(wf, id, 3);
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({
      state: 'already_processed',
      reason:
        'already done by v3 on 2026-10-01T10:00:00.000Z; this file is the original from before then (moved back from the recycle folder?); use Process again to run it anyway',
      workflowVersion: 3,
    });
    expect(findJobResult(t.db, id)).toMatchObject({
      outcome: 'already_processed',
      workflowVersion: 3,
    });
    expect(spawner.calls).toEqual([]);
  });

  it('a job re-pinned to v3 on start is already_processed when v2 processed the file', async () => {
    const wf = v2Workflow();
    const id = await queue(file(), wf);
    savedV3(wf);
    expect(t.deps.workflows.activate(wf, 3, 'u').kind).toBe('ok');
    await priorDone(wf, id, 2);
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({
      state: 'already_processed',
      reason:
        'already done by v2 on 2026-10-01T10:00:00.000Z; this file is the original from before then (moved back from the recycle folder?); use Process again to run it anyway',
      workflowVersion: 3,
    });
    expect(spawner.calls).toEqual([]);
  });

  it('a job that waited in the queue is already_processed when another job processed the file meanwhile', async () => {
    const wf = v2Workflow();
    const id = await queue(file(), wf);
    await priorDone(wf, id, 2);
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'already_processed', workflowVersion: 2 });
    expect(spawner.calls).toEqual([]);
  });

  it("a retried job isn't stopped by its own earlier failure at the same version", async () => {
    const wf = v2Workflow();
    const id = await queue(file(), wf);
    insertJobResult(t.db, {
      jobId: id,
      fingerprint: fingerprintKey(await fingerprintOf(file())),
      workflowId: wf,
      workflowVersion: 2,
      outcome: 'failed',
      beforeBytes: 1000,
      afterBytes: null,
      estimatedBytes: null,
      command: null,
      plan: null,
      replacedTo: null,
      logPath: null,
      warnings: [],
      problems: [],
      outputProbe: null,
      sourceDamaged: false,
      createdAt: '2026-10-01T10:00:00.000Z',
    });
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'nothing_to_do', workflowVersion: 2 });
  });

  it("a forced run's re-pinned job ignores the v3 history and runs", async () => {
    const wf = v2Workflow();
    const id = await queue(file(), wf, { force: true });
    savedV3(wf);
    expect(t.deps.workflows.activate(wf, 3, 'u').kind).toBe('ok');
    await priorDone(wf, id, 3);
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'kept_original', workflowVersion: 3 });
  });

  it('a dry-run job keeps its version after another is activated; a real job on the active version is not re-pinned', async () => {
    const wf = v2Workflow();
    const dry = await queue(file(), wf, { dryRun: true });
    expect(row(dry).workflowVersion).toBe(2);
    savedV3(wf);
    expect(t.deps.workflows.activate(wf, 3, 'u').kind).toBe('ok');
    const real = await queue(file(), wf);
    expect(row(real).workflowVersion).toBe(3);
    await t.deps.engine.start();
    expect(await settled(dry)).toMatchObject({ state: 'nothing_to_do', workflowVersion: 2 });
    expect(await settled(real)).toMatchObject({ state: 'kept_original', workflowVersion: 3 });
    expect(probingEvents(dry)).toBe(1);
    expect(probingEvents(real)).toBe(1);
  });

  it('activating another version during a v2 encode does not re-pin the running job', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    t.deps.workflows.save(
      {
        id: wf,
        baseVersion: 2,
        graph: line(node('in', 'core:input-manual'), node('ro', 'core:replace-original')),
      },
      'u',
    );
    expect(t.deps.workflows.activate(wf, 3, 'u').kind).toBe('ok');
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'done', workflowVersion: 2 });
    expect(findJobResult(t.db, id)?.workflowVersion).toBe(2);
  });

  it('workflow invalid at job start → failed "workflow invalid"; deactivated before start → skipped "workflow is not active"', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    // The pinned version breaks before the job starts (an unknown node type).
    const stored = t.db
      .prepare('SELECT graph FROM workflow_versions WHERE workflow_id = ? AND version = 2')
      .get(wf) as { graph: string };
    const graph = JSON.parse(stored.graph) as WorkflowGraph;
    graph.nodes.push(node('ghost', 'test:no-such-node'));
    t.db
      .prepare('UPDATE workflow_versions SET graph = ? WHERE workflow_id = ? AND version = 2')
      .run(JSON.stringify(graph), wf);
    await t.deps.engine.start();
    const job = await settled(id);
    expect(job.state).toBe('failed');
    expect(job.failureCode).toBe('workflow');
    expect(job.reason).toMatch(/^workflow invalid: \d+ error\(s\)$/);
    expect(job.attempt).toBe(1);
    expect(spawner.calls).toEqual([]);

    const wf2 = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    t.deps.engine.scheduler.pauseQueue();
    const id2 = await queue(file(), wf2);
    expect(row(id2).dryRun).toBe(false);
    expect(t.deps.workflows.deactivate(wf2).kind).toBe('ok');
    t.deps.engine.scheduler.resumeQueue();
    expect(await settled(id2)).toMatchObject({
      state: 'skipped',
      reason: 'workflow is not active',
    });
    expect(spawner.calls).toEqual([]);
  });

  it('lane: video convert → encode; audio-only convert or remux → quick', () => {
    const probe = probeOf([{ type: 'video', codec: 'h264' }, { type: 'audio' }]);
    const model = modelFromProbe(probe);
    expect(laneFor(withStream(model, 0, { mode: 'convert', codec: 'hevc' }), probe)).toBe('encode');
    expect(laneFor(withStream(model, 1, { mode: 'convert', codec: 'aac' }), probe)).toBe('quick');
    expect(laneFor({ ...model, container: 'mp4' }, probe)).toBe('quick');
    // A cover is never encoded.
    const covered = probeOf([{ type: 'video', attachedPic: true, codec: 'png' }]);
    expect(laneFor(withStream(modelFromProbe(covered), 0, { mode: 'convert' }), covered)).toBe(
      'quick',
    );
  });

  it('notify failure is a warning, not a failure (and the URL is never stored)', async () => {
    const url = `https://hooks.example.com/notify/${SECRET}?key=${SECRET}`;
    const fetchMock = vi.fn(async () => {
      throw new TypeError(`fetch failed for ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        toH264(),
        node('ro', 'core:replace-original'),
        node('nw', 'core:notify-webhook', { url, method: 'POST' }),
      ),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'done' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(body).toMatchObject({ jobId: id, outcome: 'done', beforeBytes: 1000, afterBytes: 600 });
    expect(findJobResult(t.db, id)?.warnings).toEqual([
      'notify https://hooks.example.com/… failed: fetch failed for https://hooks.example.com/…',
    ]);
    // The warning is tied to the webhook's node (the job page badges it); the job detail has it.
    const nodeProblems = [
      {
        workflowPath: [],
        nodeId: 'nw',
        severity: 'warning',
        message:
          'notify https://hooks.example.com/… failed: fetch failed for https://hooks.example.com/…',
      },
    ];
    expect(findJobResult(t.db, id)?.nodeProblems).toEqual(nodeProblems);
    expect(t.deps.engine.jobDetail(id)?.result?.nodeProblems).toEqual(nodeProblems);
    // It did not fail the node: no failed entry on its trace.
    expect(
      listTrace(t.db, id).filter((e) => e.nodeId === 'nw' && e.reason.startsWith('failed:')),
    ).toEqual([]);
    const stored = JSON.stringify([
      t.db.prepare('SELECT * FROM jobs').all(),
      t.db.prepare('SELECT * FROM job_results').all(),
      t.db.prepare('SELECT * FROM job_trace').all(),
      published,
    ]);
    expect(stored).not.toContain(SECRET);
    vi.unstubAllGlobals();
  });
});

describe('pipeline: failure codes', () => {
  const toReplace = () => workflow(line(node('in', 'core:input-manual'), toH264(), replaceNode()));

  it('a deleted workflow fails the job with workflow', async () => {
    const wf = toReplace();
    t.deps.engine.scheduler.pauseQueue();
    const id = await queue(file(), wf);
    t.db
      .prepare('UPDATE workflows SET deleted_at = ? WHERE id = ?')
      .run(new Date().toISOString(), wf);
    await t.deps.engine.start();
    t.deps.engine.scheduler.resumeQueue();
    expect(await settled(id)).toMatchObject({
      state: 'failed',
      failureCode: 'workflow',
      reason: 'workflow missing',
    });
  });

  it('a file that cannot be stat-ed fails with source_unreadable', async () => {
    await t.deps.engine.stop();
    let armed = false;
    const plain = fsOps;
    await setup({
      fs: {
        ...plain,
        stat: async (p) => {
          if (armed && p === file()) throw Object.assign(new Error('injected'), { code: 'EIO' });
          return plain.stat(p);
        },
      },
    });
    const id = await queue(file(), toReplace());
    armed = true;
    await t.deps.engine.start();
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', failureCode: 'source_unreadable' });
    expect(job.reason).toBe('cannot read the file: injected');
  });

  it('ffmpeg that cannot start fails with encode after its retry', async () => {
    const spawn = spawner.spawn.bind(spawner);
    spawner.spawn = (f: string, a: string[], o: SpawnOptions): RunnerProcess => {
      const proc = spawn(f, a, o);
      const done = Promise.reject(new Error('spawn ffmpeg ENOENT'));
      // Read more than once (the stall guard too); each reader sees the rejection.
      done.catch(() => {});
      return { ...proc, done };
    };
    const id = await queue(file(), toReplace());
    await t.deps.engine.start();
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', failureCode: 'encode', attempt: 2 });
    expect(job.reason).toBe('ffmpeg could not start: spawn ffmpeg ENOENT');
  });

  it('an unexpected throw before anything is written fails with internal', async () => {
    await t.deps.engine.stop();
    const plain = fsOps;
    await setup({
      fs: {
        ...plain,
        // The job's own temp dir under the transcode dir.
        mkdir: async (p) => {
          if (p.startsWith(`${transcodeDir}/`) && !p.slice(transcodeDir.length + 1).includes('/'))
            throw new Error('injected');
          return plain.mkdir(p);
        },
      },
    });
    const id = await queue(file(), toReplace());
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({
      state: 'failed',
      failureCode: 'internal',
      reason: 'internal error: injected',
    });
  });

  it('a job that ends any other way has no code; Retry failed clears the code with the reason', async () => {
    fake.brokenOutput = true;
    const id = await queue(file(), toReplace());
    await t.deps.engine.start();
    await until('first spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('second spawn', () => spawner.calls.length === 2);
    // The retry after the first verify failure is not a failure yet.
    expect(row(id).failureCode).toBeNull();
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'failed', failureCode: 'verify' });

    fake.brokenOutput = false;
    t.deps.engine.scheduler.pauseQueue();
    expect(t.deps.engine.queue.retryFailed()).toEqual({ retried: 1 });
    expect(row(id)).toMatchObject({ state: 'queued', reason: null, failureCode: null });
    t.deps.engine.scheduler.resumeQueue();
    await until('third spawn', () => spawner.calls.length === 3);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'done', failureCode: null });
  });
});
