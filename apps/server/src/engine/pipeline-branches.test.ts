import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineNode, type FinishRunContext, type FinishRunResult } from '@transcoda/sdk';
import type { NodeInstance } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { findJobResult, type JobRow, listTrace } from '../db/repos/jobs.ts';
import { filePort } from '../nodes/core/common.ts';
import { bareGraph, edge, node } from '../workflows/test-helpers.ts';
import {
  execCalls,
  execSignals,
  fake,
  file,
  listAll,
  queue,
  replaceNode,
  root,
  runOnce,
  settled,
  setup,
  spawner,
  t,
  toH264,
  transcodeDir,
  until,
  workflow,
} from './pipeline-test-harness.ts';
import { probeOf } from './test-helpers.ts';

describe('pipeline: damaged sources (Render’s Damaged)', () => {
  const URL = 'https://hooks.example.com/damaged';
  const SOURCE = { kind: 'plugin', name: 'example', version: '1.0.0' } as const;
  const LFE = '[dca @ 0x55d0] [error] Invalid LFE scale factor index';
  let fetchMock: ReturnType<typeof vi.fn>;
  let runCalls: FinishRunContext[];
  let runImpl: (ctx: FinishRunContext) => Promise<FinishRunResult>;
  const replaceDamaged = defineNode({
    type: 'test:replace-damaged',
    version: 1,
    kind: 'finish',
    finishPhase: 'library-manager',
    damagedOnly: true,
    title: 'Replace damaged file',
    description: 'A damagedOnly plugin finish node.',
    icon: 'bell',
    inputs: [filePort],
    outputs: [],
    settings: z.object({}),
    async finish() {
      return {
        actions: [{ kind: 'plugin', description: 'replace damaged', required: true }],
        reason: 'would ask for a new copy',
      };
    },
    async run(ctx) {
      runCalls.push(ctx);
      return runImpl(ctx);
    },
  });
  const notify = (id = 'nw') => node(id, 'core:notify-webhook', { url: URL, method: 'POST' });
  /** in → `act` → Render `r`; Done → `done` (chained); Damaged → each of `damaged`. */
  const rendered = (
    o: {
      qualityCheck?: boolean;
      act?: NodeInstance;
      done?: NodeInstance[];
      damaged?: NodeInstance[];
    } = {},
  ): string => {
    const act = o.act ?? toH264();
    const done = o.done ?? [replaceNode()];
    const damaged = o.damaged ?? [node('rd', 'test:replace-damaged'), notify()];
    const nodes = [
      node('in', 'core:input-manual'),
      act,
      node('r', 'core:render', { qualityCheck: o.qualityCheck ?? true }),
      ...done,
      ...damaged,
    ];
    const edges = [
      edge('in', act.id),
      edge(act.id, 'r'),
      ...done.map((n, i) =>
        i === 0 ? edge('r', n.id, { from: 'done' }) : edge((done[i - 1] as NodeInstance).id, n.id),
      ),
      ...damaged.map((n) => edge('r', n.id, { from: 'damaged' })),
    ];
    return workflow(bareGraph(nodes, edges));
  };
  const traceOf = (id: string, nodeId: string) =>
    listTrace(t.db, id)
      .filter((e) => e.nodeId === nodeId)
      .map((e) => [e.phase, e.port, e.reason]);
  const calledUrls = () => fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
  const body = (i: number) =>
    JSON.parse(String((fetchMock.mock.calls[i] as unknown as [string, RequestInit])[1].body));
  /** Source decodes at a spot report the dca error (the source really is damaged there). */
  const sourceSpotsSayLfe = () => {
    fake.execHook = async (f, args) => {
      if (f === 'ffmpeg' && args.includes('-ss') && args.join(' ').includes(` -i ${root}`)) {
        throw Object.assign(new Error('Command failed'), {
          code: 1,
          stderr: '[dca @ 0x1] Invalid LFE scale factor index\n',
        });
      }
      return null;
    };
  };
  const dtsSource = () =>
    probeOf(
      [
        { type: 'video', codec: 'hevc', default: true },
        { type: 'audio', codec: 'dts', language: 'eng', default: true },
      ],
      { sizeBytes: 1000 },
    );
  /** One encode that reports the dca error mid-file; returns the final row. */
  const damagedRun = async (id: string): Promise<JobRow> => {
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600, at: 30, stderr: [LFE] });
    return settled(id);
  };

  beforeEach(async () => {
    fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    runCalls = [];
    runImpl = async () => ({ ok: true, message: 'Radarr: blocklisted the release and searched' });
    fake.sourceProbe = dtsSource();
    fake.outputProbe = probeOf(
      [
        { type: 'video', codec: 'h264', default: true },
        { type: 'audio', codec: 'dts', language: 'eng', default: true },
      ],
      { sizeBytes: 600 },
    );
    await t.deps.engine.stop();
    await setup({ extra: [{ def: replaceDamaged, source: SOURCE }] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('confirmed source damage with Quality check on → runs the Damaged steps and ends kept_original + sourceDamaged', async () => {
    sourceSpotsSayLfe();
    const id = await queue(file(), rendered());
    expect(await damagedRun(id)).toMatchObject({
      state: 'kept_original',
      reason: 'source has decode errors; nothing was replaced',
      attempt: 1,
    });
    expect(spawner.calls).toHaveLength(1);
    expect(findJobResult(t.db, id)).toMatchObject({
      outcome: 'kept_original',
      sourceDamaged: true,
      replacedTo: null,
    });
    expect(calledUrls()).toEqual([URL]);
    expect(body(0)).toMatchObject({
      outcome: 'kept_original',
      reason: 'source has decode errors; nothing was replaced',
      beforeBytes: 1000,
      afterBytes: 1000,
      replacedTo: null,
    });
    expect(runCalls).toHaveLength(1);
    const ctx = runCalls[0] as FinishRunContext;
    expect(ctx).toMatchObject({
      outcome: 'damaged',
      originalPath: file(),
      newPath: file(),
      beforeBytes: 1000,
      afterBytes: 1000,
      replacedTo: null,
      containerChanged: false,
      gate: null,
    });
    expect(ctx.damage?.reason).toMatch(/Invalid LFE scale factor index/);
    expect(ctx.damage?.reason).not.toMatch(/^(decode-sample|source):/);
    expect(traceOf(id, 'r').at(-1)).toEqual([
      'finish',
      'damaged',
      expect.stringMatching(/^Render: source is damaged \(.*Invalid LFE.*\) → Damaged$/),
    ]);
    // The plugin's own answer is on the trace.
    expect(traceOf(id, 'rd').at(-1)).toEqual([
      'finish',
      null,
      'Radarr: blocklisted the release and searched',
    ]);
    expect(t.deps.engine.jobDetail(id)?.path).toEqual([
      { workflowPath: [], nodeId: 'in', port: 'file' },
      { workflowPath: [], nodeId: 'ev', port: 'file' },
      { workflowPath: [], nodeId: 'r', port: 'damaged' },
      { workflowPath: [], nodeId: 'rd', port: null },
      { workflowPath: [], nodeId: 'nw', port: 'file' },
    ]);
    expect(t.deps.engine.listJobs({}).jobs.find((j) => j.id === id)?.result).toMatchObject({
      sourceDamaged: true,
    });
    expect((await stat(file())).size).toBe(1000);
    expect(await listAll(transcodeDir)).toEqual([]);
  });

  it('verify source-damaged takes the same Damaged path', async () => {
    // Every decode fails, the output's and the source's alike: the source is what is damaged.
    fake.execHook = async (f, args) => {
      if (f === 'ffmpeg' && !args.includes('image2')) {
        throw Object.assign(new Error('Command failed'), {
          code: 1,
          stderr: '[dca @ 0x1] Invalid LFE scale factor index\n',
        });
      }
      return null;
    };
    const id = await queue(file(), rendered());
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length >= 1);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({
      state: 'kept_original',
      reason: 'source has decode errors; nothing was replaced',
      attempt: 1,
    });
    expect(findJobResult(t.db, id)?.sourceDamaged).toBe(true);
    expect(runCalls.map((c) => c.outcome)).toEqual(['damaged']);
    expect(runCalls[0]?.damage?.reason).toMatch(/Invalid LFE scale factor index/);
    expect(calledUrls()).toEqual([URL]);
    expect(traceOf(id, 'r').at(-1)?.[1]).toBe('damaged');
    expect((await stat(file())).size).toBe(1000);
  });

  it('Quality check off: today’s kept_original, sourceDamaged true, no Damaged step runs', async () => {
    sourceSpotsSayLfe();
    const id = await queue(file(), rendered({ qualityCheck: false, damaged: [] }));
    expect(await damagedRun(id)).toMatchObject({
      state: 'kept_original',
      reason: 'source has decode errors; nothing was replaced',
    });
    expect(findJobResult(t.db, id)?.sourceDamaged).toBe(true);
    expect(runCalls).toEqual([]);
    expect(calledUrls()).toEqual([]);
    expect(traceOf(id, 'r').map((e) => e[1])).not.toContain('damaged');
  });

  it('output errors never take Damaged: retried once, then failed', async () => {
    const id = await queue(file(), rendered());
    await t.deps.engine.start();
    const stderr = ['[libx264 @ 0x9] [error] malloc of size 1 failed'];
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600, stderr });
    await until('second spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 600, stderr });
    expect(await settled(id)).toMatchObject({ state: 'failed', failureCode: 'encode', attempt: 2 });
    expect(findJobResult(t.db, id)?.sourceDamaged).toBe(false);
    expect(runCalls).toEqual([]);
    expect(calledUrls()).toEqual([]);
  });

  it('source errors the source does not reproduce never take Damaged', async () => {
    // The confirming decodes read clean: not damage, whatever the encode said.
    const id = await queue(file(), rendered());
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600, at: 30, stderr: [LFE] });
    await until('second spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 600, at: 30, stderr: [LFE] });
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', failureCode: 'encode', attempt: 2 });
    expect(job.reason).toMatch(
      /^encode reported source decode errors the source does not reproduce/,
    );
    expect(runCalls).toEqual([]);
    expect(calledUrls()).toEqual([]);
  });

  it('an I/O error or a killed ffmpeg (a timeout) never takes Damaged, even with source-side lines', async () => {
    sourceSpotsSayLfe();
    const id = await queue(file(), rendered());
    await t.deps.engine.start();
    const stderr = [
      '[in#0/matroska,webm @ 0x1] [error] Error during demuxing: Input/output error',
      LFE,
    ];
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600, stderr, code: 1 });
    await until('second spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 600, stderr, code: 1 });
    // ffmpeg exited after a read error: counted as the source, not the encoder.
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', failureCode: 'source_unreadable', attempt: 2 });
    expect(job.reason).toMatch(/^encode could not read the source: .*Input\/output error/);
    expect(findJobResult(t.db, id)?.sourceDamaged).toBe(false);
    expect(runCalls).toEqual([]);
    expect(calledUrls()).toEqual([]);
  });

  it('a NAS read error mid-encode never takes Damaged, even when the confirming read fails too', async () => {
    // The confirming decodes hit the same share: they fail with the read error, not a decode error.
    fake.execHook = async (f, args) => {
      if (f === 'ffmpeg' && args.includes('-ss') && args.join(' ').includes(` -i ${root}`)) {
        throw Object.assign(new Error('Command failed'), {
          code: 1,
          stderr: '[in#0/matroska,webm @ 0x1] Error during demuxing: Input/output error\n',
        });
      }
      return null;
    };
    const id = await queue(file(), rendered());
    await t.deps.engine.start();
    for (const stderr of [
      ['[in#0/matroska,webm @ 0x1] [error] Error during demuxing: Input/output error'],
      ['[in#0/matroska,webm @ 0x1] [error] Error during demuxing: Input/output error', LFE],
    ]) {
      await until('spawn', () => spawner.calls.length === (stderr.length === 1 ? 1 : 2));
      await spawner.complete({ bytes: 600, at: 30, stderr });
    }
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', failureCode: 'source_unreadable', attempt: 2 });
    expect(job.reason).toMatch(/^encode could not read the source: .*Input\/output error/);
    expect(findJobResult(t.db, id)?.sourceDamaged).toBe(false);
    expect(runCalls).toEqual([]);
    expect(calledUrls()).toEqual([]);
  });

  it('a demuxer error mid-encode with no decoder error never takes Damaged', async () => {
    sourceSpotsSayLfe();
    const id = await queue(file(), rendered());
    await t.deps.engine.start();
    const stderr = ['[in#0/matroska,webm @ 0x1] [error] 0x00 at pos 300606 invalid as first byte'];
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600, at: 30, stderr });
    await until('second spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 600, at: 30, stderr });
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', failureCode: 'source_unreadable', attempt: 2 });
    expect(job.reason).toMatch(/^encode reported source read errors: \[in#0/);
    expect(findJobResult(t.db, id)?.sourceDamaged).toBe(false);
    expect(runCalls).toEqual([]);
  });

  it('a confirming read that times out never takes Damaged', async () => {
    fake.execHook = async (f, args) => {
      if (f === 'ffmpeg' && args.includes('-ss') && args.join(' ').includes(` -i ${root}`)) {
        throw Object.assign(new Error('Command failed: ffmpeg'), {
          killed: true,
          signal: 'SIGKILL',
          code: null,
        });
      }
      return null;
    };
    const id = await queue(file(), rendered());
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600, at: 30, stderr: [LFE] });
    await until('second spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 600, at: 30, stderr: [LFE] });
    expect(await settled(id)).toMatchObject({ state: 'failed', failureCode: 'encode', attempt: 2 });
    expect(findJobResult(t.db, id)?.sourceDamaged).toBe(false);
    expect(runCalls).toEqual([]);
  });

  it('a cover copy that times out never takes Damaged: it fails the job', async () => {
    fake.sourceProbe = probeOf(
      [
        { type: 'video', codec: 'h264', default: true },
        { type: 'audio', codec: 'dts', language: 'eng', default: true },
        { type: 'video', codec: 'png', attachedPic: true },
      ],
      { container: 'mp4', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', sizeBytes: 1000 },
    );
    fake.execHook = async (_f, args) => {
      if (args.includes('image2')) {
        throw Object.assign(new Error('Command failed: ffmpeg …'), { killed: true });
      }
      return null;
    };
    await writeFile(join(root, 'Show', 'c.mp4'), Buffer.alloc(1000, 7));
    const wf = rendered({ act: node('rm', 'core:remux', { container: 'mkv' }) });
    const id = await queue(join(root, 'Show', 'c.mp4'), wf);
    await t.deps.engine.start();
    const job = await settled(id);
    expect(job.state).toBe('failed');
    expect(job.failureCode).toBe('encode');
    expect(job.reason).toMatch(/cover \(video #2\) out of the file took longer than/);
    expect(findJobResult(t.db, id)?.sourceDamaged).toBe(false);
    expect(runCalls).toEqual([]);
    expect(calledUrls()).toEqual([]);
  });

  it('a verify failure the source does not share never takes Damaged', async () => {
    fake.brokenOutput = true;
    const id = await queue(file(), rendered());
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('second spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 600 });
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', failureCode: 'verify', attempt: 2 });
    expect(job.reason).toMatch(/^verify: /);
    expect(runCalls).toEqual([]);
    expect(calledUrls()).toEqual([]);
  });

  it('Done unconnected, Damaged wired: the file is still rendered; a good file ends kept_original "path never writes the result"', async () => {
    const id = await queue(file(), rendered({ done: [] }));
    expect(await runOnce(id)).toMatchObject({
      state: 'kept_original',
      reason: 'path never writes the result',
    });
    expect(spawner.calls).toHaveLength(1);
    expect(findJobResult(t.db, id)).toMatchObject({ sourceDamaged: false, afterBytes: 600 });
    expect(runCalls).toEqual([]);
    expect(calledUrls()).toEqual([]);
    expect((await stat(file())).size).toBe(1000);
  });

  it('Done unconnected, Damaged wired: a damaged file takes Damaged', async () => {
    sourceSpotsSayLfe();
    const id = await queue(file(), rendered({ done: [] }));
    expect(await damagedRun(id)).toMatchObject({ state: 'kept_original' });
    expect(findJobResult(t.db, id)?.sourceDamaged).toBe(true);
    expect(runCalls).toHaveLength(1);
  });

  it('a plan-only dry run lists the Damaged side', async () => {
    const id = await queue(file(), rendered({ damaged: [notify()] }), {
      dryRun: true,
      testEncode: false,
    });
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'dry_run' });
    expect(spawner.calls).toEqual([]);
    expect(traceOf(id, 'r').at(-1)).toEqual([
      'finish',
      null,
      'Render: decides while encoding; if the source is damaged: Notify webhook',
    ]);
    expect(t.deps.engine.jobDetail(id)?.path).toEqual([
      { workflowPath: [], nodeId: 'in', port: 'file' },
      { workflowPath: [], nodeId: 'ev', port: 'file' },
      { workflowPath: [], nodeId: 'r', port: null },
      { workflowPath: [], nodeId: 'ro', port: 'file' },
      { workflowPath: [], nodeId: 'nw', port: 'file' },
    ]);
    expect(findJobResult(t.db, id)?.sourceDamaged).toBe(false);
    expect(calledUrls()).toEqual([]);
  });

  it('a plan-only dry run of a path that never writes still lists the Damaged side', async () => {
    const id = await queue(file(), rendered({ done: [], damaged: [notify()] }), {
      dryRun: true,
      testEncode: false,
    });
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({
      state: 'kept_original',
      reason: 'path never writes the result',
    });
    expect(spawner.calls).toEqual([]);
    expect(traceOf(id, 'r').at(-1)).toEqual([
      'finish',
      null,
      'Render: decides while encoding; if the source is damaged: Notify webhook',
    ]);
    expect(t.deps.engine.jobDetail(id)?.path.map((s) => [s.nodeId, s.port])).toEqual([
      ['in', 'file'],
      ['ev', 'file'],
      ['r', null],
      ['nw', 'file'],
    ]);
    expect(calledUrls()).toEqual([]);
  });

  it('a test-encode dry run that finds damage ends kept_original + sourceDamaged without running any step', async () => {
    sourceSpotsSayLfe();
    const id = await queue(file(), rendered(), { dryRun: true, testEncode: true });
    expect(await damagedRun(id)).toMatchObject({
      state: 'kept_original',
      reason: 'source has decode errors; nothing was replaced',
    });
    expect(findJobResult(t.db, id)?.sourceDamaged).toBe(true);
    expect(runCalls).toEqual([]);
    expect(calledUrls()).toEqual([]);
    expect(traceOf(id, 'r').at(-1)?.[1]).toBe('damaged');
  });

  it('the Render node traces port "done" after a successful verify', async () => {
    const id = await queue(file(), rendered());
    expect(await runOnce(id)).toMatchObject({ state: 'done' });
    expect(findJobResult(t.db, id)?.sourceDamaged).toBe(false);
    expect(traceOf(id, 'r').at(-1)).toEqual([
      'finish',
      'done',
      'Render: encoded and verified → Done',
    ]);
    expect(runCalls).toEqual([]);
    expect(calledUrls()).toEqual([]);
  });

  it('a stop during the Damaged steps is a warning and the job still ends kept_original', async () => {
    sourceSpotsSayLfe();
    let entered = false;
    runImpl = () => {
      entered = true;
      return new Promise<FinishRunResult>(() => {});
    };
    const id = await queue(file(), rendered());
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600, at: 30, stderr: [LFE] });
    await until('plugin step runs', () => entered);
    t.deps.engine.scheduler.cancelJob(id);
    expect(await settled(id)).toMatchObject({
      state: 'kept_original',
      reason: 'source has decode errors; nothing was replaced',
    });
    expect(findJobResult(t.db, id)?.warnings).toContain(
      'cancel before the remaining finish actions',
    );
    expect(findJobResult(t.db, id)?.sourceDamaged).toBe(true);
    expect(calledUrls()).toEqual([]);
  });

  describe('Check source', () => {
    /** in → cs; OK → encode → Render → Replace; Damaged → Replace damaged file, Notify. */
    const checked = (): string =>
      workflow(
        bareGraph(
          [
            node('in', 'core:input-manual'),
            node('cs', 'core:check-source'),
            toH264(),
            node('r', 'core:render'),
            replaceNode(),
            node('rd', 'test:replace-damaged'),
            notify(),
          ],
          [
            edge('in', 'cs'),
            edge('cs', 'ev', { from: 'ok' }),
            edge('ev', 'r'),
            edge('r', 'ro', { from: 'done' }),
            edge('cs', 'rd', { from: 'damaged' }),
            edge('cs', 'nw', { from: 'damaged' }),
          ],
        ),
      );
    const isPass = (args: string[]) => args.includes('level+error');
    const passes = () => execCalls.filter((c) => isPass(c.slice(1)));
    /**
     * The pass answers with the dca error (exit 0, as ffmpeg does for decode errors); the locating
     * pass puts it 30 s into the DTS stream.
     */
    const lfeAt30 = async (_f: string, args: string[]) => {
      if (isPass(args)) return { stdout: '', stderr: `${LFE}\n` };
      if (!args.includes('level+info')) return null;
      const mark = (t: number) => `[ashowinfo@s1 @ 0x9] [info] n:0 pts:0 pts_time:${t}`;
      return { stdout: '', stderr: [mark(0), mark(30), LFE, mark(31)].join('\n') };
    };
    /** As {@link lfeAt30}, and the confirming decode at that spot reproduces it. */
    const passFindsLfe = () => {
      fake.sourceSpotsDamaged = true;
      fake.execHook = lfeAt30;
    };

    it('Check source damaged → the Damaged steps run in prepare, the job ends kept_original + sourceDamaged, ffmpeg never encodes', async () => {
      passFindsLfe();
      const id = await queue(file(), checked());
      await t.deps.engine.start();
      expect(await settled(id)).toMatchObject({
        state: 'kept_original',
        reason: 'source is damaged: audio #1 (DTS): Invalid LFE scale factor index',
      });
      expect(spawner.calls).toEqual([]);
      expect(passes()).toHaveLength(1);
      const args = passes()[0] ?? [];
      // Without "Decode video too" only the audio is read (by index; the video is not mapped).
      expect(args.filter((_, i) => args[i - 1] === '-map')).toEqual(['0:1']);
      expect(args).toContain(file());
      expect(findJobResult(t.db, id)).toMatchObject({ sourceDamaged: true, replacedTo: null });
      expect(runCalls).toHaveLength(1);
      expect(runCalls[0]).toMatchObject({
        outcome: 'damaged',
        newPath: file(),
        afterBytes: 1000,
        beforeBytes: 1000,
        damage: {
          reason: 'audio #1 (DTS): Invalid LFE scale factor index',
          stream: 'audio #1 (DTS)',
        },
      });
      expect(calledUrls()).toEqual([URL]);
      expect(body(0)).toMatchObject({
        outcome: 'kept_original',
        reason: 'source is damaged: audio #1 (DTS): Invalid LFE scale factor index',
      });
      expect(traceOf(id, 'cs').at(-1)).toEqual([
        'decide',
        'damaged',
        'audio #1 (DTS): Invalid LFE scale factor index',
      ]);
      expect(t.deps.engine.jobDetail(id)?.path.map((s) => [s.nodeId, s.port])).toEqual([
        ['in', 'file'],
        ['cs', 'damaged'],
        ['rd', null],
        ['nw', 'file'],
      ]);
      expect((await stat(file())).size).toBe(1000);
    });

    it('Check source OK → the path encodes and replaces as usual', async () => {
      const id = await queue(file(), checked());
      expect(await runOnce(id)).toMatchObject({ state: 'done' });
      expect(passes()).toHaveLength(1);
      expect(traceOf(id, 'cs').at(-1)).toEqual(['decide', 'ok', 'source reads clean']);
      expect(runCalls).toEqual([]);
      expect(calledUrls()).toEqual([]);
    });

    it('a pass error the source does not reproduce at its spot → retried, then failed (never Damaged)', async () => {
      fake.execHook = lfeAt30;
      const id = await queue(file(), checked());
      await t.deps.engine.start();
      const job = await settled(id);
      expect(job).toMatchObject({ state: 'failed', failureCode: 'workflow', attempt: 2 });
      expect(job.reason).toMatch(/which the source does not reproduce$/);
      expect(findJobResult(t.db, id)?.sourceDamaged).toBe(false);
      expect(runCalls).toEqual([]);
      expect(calledUrls()).toEqual([]);
    });

    it('Check source read failure → retried once, then failed (never Damaged)', async () => {
      fake.execHook = async (_f, args) => {
        if (!isPass(args)) return null;
        throw Object.assign(new Error('Command failed: ffmpeg'), {
          code: 1,
          stderr: `[in#0/matroska,webm @ 0x1] [error] Error during demuxing: Input/output error\n${LFE}\n`,
        });
      };
      const id = await queue(file(), checked());
      await t.deps.engine.start();
      const job = await settled(id);
      expect(job).toMatchObject({
        state: 'failed',
        failureCode: 'workflow',
        attempt: 2,
        reason: 'cs: check source failed: Error during demuxing: Input/output error',
      });
      expect(passes()).toHaveLength(2);
      expect(findJobResult(t.db, id)?.sourceDamaged).toBe(false);
      expect(spawner.calls).toEqual([]);
      expect(runCalls).toEqual([]);
      expect(calledUrls()).toEqual([]);
    });

    it('a dry run runs Check source for real and ends kept_original + sourceDamaged when damaged; the real run that follows does not read the file again', async () => {
      passFindsLfe();
      const wf = checked();
      const dry = await queue(file(), wf, { dryRun: true, testEncode: false });
      await t.deps.engine.start();
      expect(await settled(dry)).toMatchObject({
        state: 'kept_original',
        reason: 'source is damaged: audio #1 (DTS): Invalid LFE scale factor index',
      });
      expect(findJobResult(t.db, dry)?.sourceDamaged).toBe(true);
      expect(passes()).toHaveLength(1);
      expect(runCalls).toEqual([]);
      expect(calledUrls()).toEqual([]);
      const real = await queue(file(), wf, { force: true });
      expect(await settled(real)).toMatchObject({ state: 'kept_original' });
      expect(passes()).toHaveLength(1);
      expect(runCalls).toHaveLength(1);
      expect(findJobResult(t.db, real)?.sourceDamaged).toBe(true);
    });

    it('cancel during Check source kills the pass and ends cancelled', async () => {
      let started = false;
      fake.execHook = async (_f, args, signal) => {
        if (!isPass(args)) return null;
        started = true;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      };
      const id = await queue(file(), checked());
      await t.deps.engine.start();
      await until('the pass runs', () => started);
      t.deps.engine.scheduler.cancelJob(id);
      expect(await settled(id)).toMatchObject({ state: 'cancelled' });
      expect(execSignals.some((sig) => sig?.aborted)).toBe(true);
      expect(findJobResult(t.db, id)?.sourceDamaged ?? false).toBe(false);
      expect(runCalls).toEqual([]);
      expect(calledUrls()).toEqual([]);
      expect(spawner.calls).toEqual([]);
    });

    describe('a path that never writes (find damaged files)', () => {
      /** in → cs; OK → Render → Notify (ok); Damaged → Replace damaged file, Notify. */
      const finder = (): string =>
        workflow(
          bareGraph(
            [
              node('in', 'core:input-manual'),
              node('cs', 'core:check-source'),
              node('r', 'core:render'),
              node('ok', 'core:notify-webhook', { url: `${URL}/ok`, method: 'POST' }),
              node('rd', 'test:replace-damaged'),
              notify(),
            ],
            [
              edge('in', 'cs'),
              edge('cs', 'r', { from: 'ok' }),
              edge('r', 'ok', { from: 'done' }),
              edge('cs', 'rd', { from: 'damaged' }),
              edge('cs', 'nw', { from: 'damaged' }),
            ],
          ),
        );
      const damagedPath = [
        ['in', 'file'],
        ['cs', 'damaged'],
        ['rd', null],
        ['nw', 'file'],
      ];

      it('damaged → Check source runs, the Damaged steps run, the job ends kept_original + sourceDamaged', async () => {
        passFindsLfe();
        const id = await queue(file(), finder());
        await t.deps.engine.start();
        expect(await settled(id)).toMatchObject({
          state: 'kept_original',
          reason: 'source is damaged: audio #1 (DTS): Invalid LFE scale factor index',
        });
        expect(passes()).toHaveLength(1);
        expect(spawner.calls).toEqual([]);
        expect(findJobResult(t.db, id)?.sourceDamaged).toBe(true);
        expect(runCalls).toHaveLength(1);
        expect(runCalls[0]).toMatchObject({ outcome: 'damaged', newPath: file() });
        expect(calledUrls()).toEqual([URL]);
        expect(t.deps.engine.jobDetail(id)?.path.map((s) => [s.nodeId, s.port])).toEqual(
          damagedPath,
        );
        expect((await stat(file())).size).toBe(1000);
      });

      it('OK → Check source runs and the job ends as today, with no step run', async () => {
        const id = await queue(file(), finder());
        await t.deps.engine.start();
        const job = await settled(id);
        expect(job).toMatchObject({ state: 'nothing_to_do', reason: 'already as planned' });
        expect(passes()).toHaveLength(1);
        expect(traceOf(id, 'cs').at(-1)).toEqual(['decide', 'ok', 'source reads clean']);
        expect(spawner.calls).toEqual([]);
        expect(findJobResult(t.db, id)?.sourceDamaged ?? false).toBe(false);
        expect(runCalls).toEqual([]);
        expect(calledUrls()).toEqual([]);
      });

      it('a dry run of a damaged file runs the check, shows the Damaged side, and runs no step', async () => {
        passFindsLfe();
        const id = await queue(file(), finder(), { dryRun: true, testEncode: false });
        await t.deps.engine.start();
        expect(await settled(id)).toMatchObject({
          state: 'kept_original',
          reason: 'source is damaged: audio #1 (DTS): Invalid LFE scale factor index',
        });
        expect(passes()).toHaveLength(1);
        expect(findJobResult(t.db, id)?.sourceDamaged).toBe(true);
        expect(t.deps.engine.jobDetail(id)?.path.map((s) => [s.nodeId, s.port])).toEqual(
          damagedPath,
        );
        expect(spawner.calls).toEqual([]);
        expect(runCalls).toEqual([]);
        expect(calledUrls()).toEqual([]);
      });

      it('a dry run of a good file runs the check and runs no step', async () => {
        const id = await queue(file(), finder(), { dryRun: true, testEncode: false });
        await t.deps.engine.start();
        const job = await settled(id);
        expect(job).toMatchObject({ state: 'nothing_to_do', reason: 'already as planned' });
        expect(passes()).toHaveLength(1);
        expect(traceOf(id, 'cs').at(-1)).toEqual(['decide', 'ok', 'source reads clean']);
        expect(findJobResult(t.db, id)?.sourceDamaged ?? false).toBe(false);
        expect(runCalls).toEqual([]);
        expect(calledUrls()).toEqual([]);
      });
    });
  });
});
