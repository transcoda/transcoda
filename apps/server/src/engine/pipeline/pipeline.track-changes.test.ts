// A size gate set to Write track changes: when the encode saves too little, the plan's other
// changes are written as a remux (the video copied) and the job goes on along Yes.
import { readFile, stat } from 'node:fs/promises';
import type { JsonValue, WorkflowGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findJobResult, listTrace } from '../../db/repos/jobs/jobs.ts';
import { edge, mainGraph, node } from '../../workflows/testing.ts';
import { probeOf } from '../testing/builders.ts';
import {
  fake,
  file,
  listAll,
  queue,
  row,
  settled,
  spawner,
  t,
  toH264,
  transcodeDir,
  until,
  workflow,
} from './testing.ts';

const PASS_URL = 'https://hooks.example.com/pass';
const ELSE_URL = 'https://hooks.example.com/else';
const hook = (id: string, url: string) => node(id, 'core:notify-webhook', { url, method: 'POST' });

/**
 * in → [set the default audio to French] → encode video → gate (writes track changes) → replace →
 * notify; gate.else → notify.
 */
function tracksGraph(
  o: { defaultFrench?: boolean; belowMinimum?: string; secondGate?: boolean } = {},
): WorkflowGraph {
  const sd = node('sd', 'core:set-default-track', { audioLanguages: ['fr'] });
  const gate = node('sg', 'core:size-gate', {
    minSavingPercent: 50,
    belowMinimum: o.belowMinimum ?? 'write-track-changes',
  });
  const second = node('sg2', 'core:size-gate', { minSavingPercent: 30 });
  const steps = [
    node('in', 'core:input-manual'),
    ...(o.defaultFrench === false ? [] : [sd]),
    toH264(),
    gate,
    ...(o.secondGate ? [second] : []),
    node('ro', 'core:replace-original'),
    hook('pn', PASS_URL),
  ];
  const edges = steps.slice(1).map((n, i) => {
    const from = steps[i] as ReturnType<typeof node>;
    return edge(from.id, n.id, from.type === 'core:size-gate' ? { from: 'pass' } : {});
  });
  return mainGraph(
    [...steps, hook('en', ELSE_URL)],
    [...edges, edge('sg', 'en', { from: 'else' })],
  );
}

describe('pipeline: size gate writes the track changes', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    fake.sourceProbe = probeOf(
      [
        { type: 'video', codec: 'hevc', default: true },
        { type: 'audio', codec: 'aac', language: 'eng', default: true },
        { type: 'audio', codec: 'aac', language: 'fre' },
      ],
      { sizeBytes: 1000 },
    );
    fake.outputProbe = probeOf(
      [
        { type: 'video', codec: 'h264', default: true },
        { type: 'audio', codec: 'aac', language: 'eng' },
        { type: 'audio', codec: 'aac', language: 'fre', default: true },
      ],
      { sizeBytes: 900 },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const calledUrls = () => fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
  const gateEntry = (id: string, nodeId = 'sg') =>
    listTrace(t.db, id)
      .filter((e) => e.nodeId === nodeId)
      .at(-1);
  /** The remux's output as verify reads it: the source's video, the planned flags. */
  const remuxProbe = () =>
    probeOf(
      [
        { type: 'video', codec: 'hevc', default: true },
        { type: 'audio', codec: 'aac', language: 'eng' },
        { type: 'audio', codec: 'aac', language: 'fre', default: true },
      ],
      { sizeBytes: 990 },
    );

  /** Runs the encode (`encodedBytes`), then, when one starts, the remux (`remuxBytes`). */
  async function runBoth(id: string, encodedBytes: number, remuxBytes: number) {
    await t.deps.engine.start();
    await until('encode', () => spawner.calls.length >= 1);
    await spawner.complete({ bytes: encodedBytes });
    await until('remux or end', () => spawner.calls.length >= 2 || !row(id).state.match(/ing$/));
    if (spawner.calls.length >= 2) {
      fake.outputProbe = remuxProbe();
      await spawner.complete({ bytes: remuxBytes });
    }
    return settled(id);
  }

  it('saves too little: remuxes the plan with the video copied, replaces the original and goes on along Yes', async () => {
    const id = await queue(file(), workflow(tracksGraph()));
    const job = await runBoth(id, 900, 990);
    expect(job).toMatchObject({
      state: 'done',
      reason: 'saved only 10.0%, below 50% → wrote track changes without re-encoding',
    });
    // The second ffmpeg run copies every stream: nothing is encoded.
    const remux = spawner.calls[1]?.args ?? [];
    const codecs = remux.flatMap((a, i) => (/^-c:\d+$/.test(a) ? [remux[i + 1]] : []));
    expect(codecs).toEqual(['copy', 'copy', 'copy']);
    expect(remux).not.toContain('libx264');
    expect(remux.at(-1)).toMatch(/tracks\.mkv$/);
    // The log keeps both runs: the attempt's log is appended to, not truncated.
    expect(spawner.calls[1]?.logPath).toBe(spawner.calls[0]?.logPath);
    expect((await stat(file())).size).toBe(990);
    expect(calledUrls()).toEqual([PASS_URL]);
    expect(findJobResult(t.db, id)).toMatchObject({ outcome: 'done', afterBytes: 990 });
    // The result's plan is what was written: the video kept, the default audio moved.
    const plan = findJobResult(t.db, id)?.plan;
    expect(plan?.streams.map((s) => [s.type, s.action, s.default.after])).toEqual([
      ['video', 'keep', true],
      ['audio', 'keep', false],
      ['audio', 'keep', true],
    ]);
    expect(gateEntry(id)).toMatchObject({
      port: 'pass',
      reason: 'Size gate: saved 10.0%, below 50% → wrote track changes without re-encoding → yes',
      findings: { minSavingPercent: 50, savedPercent: 10, trackChanges: true },
    });
    expect(t.deps.engine.jobDetail(id)?.path.map((s) => s.nodeId)).toEqual([
      'in',
      'sd',
      'ev',
      'render-1',
      'sg',
      'ro',
      'pn',
    ]);
    expect(await listAll(transcodeDir)).toEqual([]);
  });

  it('saves enough: replaced with the encode as before; no remux', async () => {
    const id = await queue(file(), workflow(tracksGraph()));
    const job = await runBoth(id, 400, 990);
    expect(job).toMatchObject({ state: 'done', reason: null });
    expect(spawner.calls).toHaveLength(1);
    expect((await stat(file())).size).toBe(400);
  });

  it('nothing but the video would change: the original is kept and No runs, as with Keep original', async () => {
    fake.sourceProbe = probeOf(
      [
        { type: 'video', codec: 'hevc', default: true },
        { type: 'audio', codec: 'aac', language: 'fre', default: true },
      ],
      { sizeBytes: 1000 },
    );
    fake.outputProbe = probeOf(
      [
        { type: 'video', codec: 'h264', default: true },
        { type: 'audio', codec: 'aac', language: 'fre', default: true },
      ],
      { sizeBytes: 900 },
    );
    const id = await queue(file(), workflow(tracksGraph({ defaultFrench: false })));
    const job = await runBoth(id, 900, 990);
    expect(job).toMatchObject({ state: 'kept_original', reason: 'saved only 10.0%, below 50%' });
    expect(spawner.calls).toHaveLength(1);
    expect(calledUrls()).toEqual([ELSE_URL]);
    expect(gateEntry(id)).toMatchObject({
      port: 'else',
      reason: 'Size gate: saved 10.0%, below 50% → no (nothing but the video would change)',
    });
    expect((await readFile(file())).length).toBe(1000);
  });

  it('Keep original (the default) keeps the original even with track changes', async () => {
    const id = await queue(file(), workflow(tracksGraph({ belowMinimum: 'keep-original' })));
    const job = await runBoth(id, 900, 990);
    expect(job).toMatchObject({ state: 'kept_original', reason: 'saved only 10.0%, below 50%' });
    expect(spawner.calls).toHaveLength(1);
    expect(gateEntry(id)?.reason).toBe('Size gate: saved 10.0%, below 50% → no');
  });

  it('a remux that fails keeps the original with a warning, never retried', async () => {
    const id = await queue(file(), workflow(tracksGraph()));
    await t.deps.engine.start();
    await until('encode', () => spawner.calls.length >= 1);
    await spawner.complete({ bytes: 900 });
    await until('remux', () => spawner.calls.length >= 2);
    await spawner.complete({ code: 1 });
    const job = await settled(id);
    expect(job).toMatchObject({
      state: 'kept_original',
      reason: 'saved only 10.0%, below 50%',
      attempt: 1,
    });
    expect(findJobResult(t.db, id)?.warnings).toContainEqual(
      expect.stringMatching(/^could not write the track changes: ffmpeg exited 1/),
    );
    expect(calledUrls()).toEqual([ELSE_URL]);
    expect(gateEntry(id)?.reason).toMatch(
      /^Size gate: saved 10\.0%, below 50% → no \(could not write the track changes: /,
    );
    expect((await readFile(file())).length).toBe(1000);
    expect(spawner.calls).toHaveLength(2);
    // The kept result records the encode it measured, not the remux.
    expect(findJobResult(t.db, id)?.command).toContain('libx264');
  });

  it('a later gate does not measure the remux: it lets the track changes through', async () => {
    const id = await queue(file(), workflow(tracksGraph({ secondGate: true })));
    const job = await runBoth(id, 900, 990);
    expect(job).toMatchObject({ state: 'done' });
    expect(gateEntry(id, 'sg2')).toMatchObject({
      port: 'pass',
      reason: 'Size gate: only the track changes are written, nothing to measure → yes',
    });
  });

  it('a test encode says a real run would write the track changes; nothing is remuxed', async () => {
    const id = await queue(file(), workflow(tracksGraph()), { dryRun: true, testEncode: true });
    const job = await runBoth(id, 900, 990);
    expect(job).toMatchObject({
      state: 'dry_run',
      reason: 'saved only 10.0%, below 50% → would write track changes without re-encoding',
    });
    expect(spawner.calls).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gateEntry(id)).toMatchObject({
      port: 'pass',
      reason:
        'Size gate: saved 10.0%, below 50% → would write track changes without re-encoding → yes',
    });
  });

  it('a plan-only dry run does not depend on size when the gate writes track changes', async () => {
    const id = await queue(file(), workflow(tracksGraph()), { dryRun: true });
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'dry_run' });
    expect(findJobResult(t.db, id)?.plan?.dependsOnSize).toBeUndefined();
    expect(gateEntry(id)?.reason).toBe(
      'Size gate: decides after encoding: if it saves less than 50%, write the track changes only',
    );
  });

  it('a plan-only dry run still depends on size when only the video would change', async () => {
    fake.sourceProbe = probeOf(
      [
        { type: 'video', codec: 'hevc', default: true },
        { type: 'audio', codec: 'aac', language: 'fre', default: true },
      ],
      { sizeBytes: 1000 },
    );
    const id = await queue(file(), workflow(tracksGraph({ defaultFrench: false })), {
      dryRun: true,
    });
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'dry_run' });
    expect(findJobResult(t.db, id)?.plan?.dependsOnSize).toEqual({ minSavingPercent: 50 });
    expect(gateEntry(id)?.reason).toBe(
      'Size gate: decides after encoding: keep if it saves less than 50%',
    );
  });

  it('a saved v2 gate keeps the original as it did (the migration adds Keep original)', async () => {
    const graph = tracksGraph();
    const gate = graph.nodes.find((n) => n.id === 'sg');
    if (!gate) throw new Error('no gate');
    gate.typeVersion = 2;
    gate.settings = { minSavingPercent: 50 } as JsonValue as typeof gate.settings;
    const id = await queue(file(), workflow(graph));
    const job = await runBoth(id, 900, 990);
    expect(job).toMatchObject({ state: 'kept_original' });
    expect(spawner.calls).toHaveLength(1);
  });

  it('after the workflow switches to Write track changes, a file the gate kept is taken again', async () => {
    const wf = workflow(tracksGraph({ belowMinimum: 'keep-original' }));
    const first = await queue(file(), wf);
    expect(await runBoth(first, 900, 990)).toMatchObject({ state: 'kept_original' });
    // The same version takes it for processed.
    const again = await t.deps.engine.queue.queue({
      path: file(),
      workflowId: wf,
      dryRun: false,
      force: false,
      priority: 0,
      createdBy: 'u',
    });
    expect(again.kind === 'queued' && again.jobs[0]?.state).toBe('already_processed');
    // A new version whose gate writes the track changes queues it again and writes them.
    expect(
      t.deps.workflows.save({ id: wf, baseVersion: 2, graph: tracksGraph() }, 'u').version,
    ).toBe(3);
    expect(t.deps.workflows.activate(wf, 3, 'u').kind).toBe('ok');
    fake.outputProbe = probeOf(
      [
        { type: 'video', codec: 'h264', default: true },
        { type: 'audio', codec: 'aac', language: 'eng' },
        { type: 'audio', codec: 'aac', language: 'fre', default: true },
      ],
      { sizeBytes: 900 },
    );
    const second = await queue(file(), wf);
    expect(row(second).state).not.toBe('already_processed');
    await until('encode', () => spawner.calls.length >= 2);
    await spawner.complete({ bytes: 900 });
    await until('remux', () => spawner.calls.length >= 3);
    fake.outputProbe = remuxProbe();
    await spawner.complete({ bytes: 990 });
    expect(await settled(second)).toMatchObject({ state: 'done', workflowVersion: 3 });
  });
});
