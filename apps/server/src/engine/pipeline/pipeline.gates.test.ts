// Size gates: the pass and else branches, a plan-only dry run that depends on size, and
// test-encode dry runs that measure instead.
import { readdirSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findJobResult, listTrace } from '../../db/repos/jobs/jobs.ts';
import { listRecycled } from '../../db/repos/recycled.ts';
import { chain, edge, mainGraph, node } from '../../workflows/testing.ts';
import {
  base,
  fake,
  file,
  fsOps,
  gated,
  line,
  listAll,
  queue,
  root,
  row,
  runOnce,
  settled,
  setup,
  spawner,
  t,
  toH264,
  transcodeDir,
  until,
  workflow,
} from './testing.ts';

describe('pipeline: size gate pass and else', () => {
  const PASS_URL = 'https://hooks.example.com/pass';
  const ELSE_URL = 'https://hooks.example.com/else';
  const hook = (id: string, url: string) =>
    node(id, 'core:notify-webhook', { url, method: 'POST' });
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const calledUrls = () => fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
  const body = (i: number) =>
    JSON.parse(String((fetchMock.mock.calls[i] as unknown as [string, RequestInit])[1].body));
  const traceOf = (id: string, nodeId: string) =>
    listTrace(t.db, id)
      .filter((e) => e.nodeId === nodeId)
      .map((e) => [e.phase, e.port, e.reason]);

  it('else path: a failing gate keeps the original, runs only the else notify and records the branch', async () => {
    const wf = workflow(
      gated(
        50,
        [node('ro', 'core:replace-original'), hook('pn', PASS_URL)],
        [hook('en', ELSE_URL)],
      ),
    );
    const id = await queue(file(), wf);
    const job = await runOnce(id, 900);
    expect(job).toMatchObject({ state: 'kept_original', reason: 'saved only 10.0%, below 50%' });
    expect(calledUrls()).toEqual([ELSE_URL]);
    expect(body(0)).toMatchObject({
      jobId: id,
      outcome: 'kept_original',
      beforeBytes: 1000,
      afterBytes: 900,
      replacedTo: null,
      reason: 'saved only 10.0%, below 50%',
    });
    expect(findJobResult(t.db, id)).toMatchObject({
      outcome: 'kept_original',
      afterBytes: 900,
      replacedTo: null,
    });
    expect((await stat(file())).size).toBe(1000);
    expect(await listAll(transcodeDir)).toEqual([]);
    // The trace says which branch the gate took, and the walk now runs through else.
    expect(traceOf(id, 'sg').at(-1)).toEqual([
      'finish',
      'else',
      'Size gate: saved 10.0%, below 50% \u2192 no',
    ]);
    // Its numbers are findings too, so the job page need not read them from the reason.
    expect(
      listTrace(t.db, id)
        .filter((e) => e.nodeId === 'sg')
        .at(-1)?.findings,
    ).toEqual({
      minSavingPercent: 50,
      savedPercent: 10,
    });
    expect(t.deps.engine.jobDetail(id)?.path).toEqual([
      { workflowPath: [], nodeId: 'in', port: 'file' },
      { workflowPath: [], nodeId: 'ev', port: 'file' },
      { workflowPath: [], nodeId: 'render-1', port: 'done' },
      { workflowPath: [], nodeId: 'sg', port: 'else' },
      { workflowPath: [], nodeId: 'en', port: 'file' },
    ]);
  });

  it('pass path: the pass steps run, the else notify does not, and the trace says pass', async () => {
    const wf = workflow(
      gated(
        50,
        [node('ro', 'core:replace-original'), hook('pn', PASS_URL)],
        [hook('en', ELSE_URL)],
      ),
    );
    const id = await queue(file(), wf);
    const job = await runOnce(id, 400);
    expect(job).toMatchObject({ state: 'done' });
    expect(calledUrls()).toEqual([PASS_URL]);
    expect(body(0)).toMatchObject({ outcome: 'done', afterBytes: 400 });
    expect((await stat(file())).size).toBe(400);
    expect(traceOf(id, 'sg').at(-1)).toEqual([
      'finish',
      'pass',
      'Size gate: saved 60.0%, at least 50% \u2192 yes',
    ]);
    expect(
      listTrace(t.db, id)
        .filter((e) => e.nodeId === 'sg')
        .at(-1)?.findings,
    ).toEqual({
      minSavingPercent: 50,
      savedPercent: 60,
    });
    expect(t.deps.engine.jobDetail(id)?.path.map((s) => s.nodeId)).toEqual([
      'in',
      'ev',
      'render-1',
      'sg',
      'ro',
      'pn',
    ]);
  });

  it('a failing gate with nothing wired to else is kept_original as before, with no notification', async () => {
    const wf = workflow(gated(50, [node('ro', 'core:replace-original'), hook('pn', PASS_URL)], []));
    const id = await queue(file(), wf);
    expect(await runOnce(id, 900)).toMatchObject({
      state: 'kept_original',
      reason: 'saved only 10.0%, below 50%',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an active workflow stored with the v1 gate (one output) still runs, on pass and on kept_original', async () => {
    const v1 = (): WorkflowGraph =>
      mainGraph(
        [
          node('in', 'core:input-manual'),
          toH264(),
          node('sg', 'core:size-gate', { minSavingPercent: 50 }, { typeVersion: 1 }),
          node('ro', 'core:replace-original'),
        ],
        [edge('in', 'ev'), edge('ev', 'sg'), edge('sg', 'ro')],
      );
    const kept = await queue(file(), workflow(v1()));
    expect(await runOnce(kept, 900)).toMatchObject({
      state: 'kept_original',
      reason: 'saved only 10.0%, below 50%',
    });
    const replaced = await queue(file(), workflow(v1()), { force: true });
    await until('second spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 400 });
    expect(await settled(replaced)).toMatchObject({ state: 'done' });
    expect((await stat(file())).size).toBe(400);
  });

  it('job detail returns a v1-stored gate workflow with its edges on pass', async () => {
    const wf = workflow(
      mainGraph(
        [
          node('in', 'core:input-manual'),
          toH264(),
          node('sg', 'core:size-gate', { minSavingPercent: 50 }, { typeVersion: 1 }),
          node('ro', 'core:replace-original'),
        ],
        [edge('in', 'ev'), edge('ev', 'sg'), edge('sg', 'ro')],
      ),
    );
    const id = await queue(file(), wf);
    await runOnce(id, 400);
    const g = t.deps.engine.jobDetail(id)?.graph;
    expect(g?.edges.map((e) => `${e.from.node}.${e.from.port}`)).toEqual([
      'in.file',
      'ev.file',
      'render-1.done',
      'sg.pass',
    ]);
    expect(g?.nodes.find((n) => n.id === 'sg')?.typeVersion).toBe(2);
  });

  it('an else notify that fails is a warning on the kept_original job', async () => {
    fetchMock.mockImplementation(async () => new Response('no', { status: 500 }));
    const wf = workflow(gated(50, [node('ro', 'core:replace-original')], [hook('en', ELSE_URL)]));
    const id = await queue(file(), wf);
    await runOnce(id, 900);
    expect(row(id).state).toBe('kept_original');
    expect(findJobResult(t.db, id)?.warnings).toEqual([
      'notify https://hooks.example.com/\u2026 answered 500',
    ]);
  });

  describe('one notify behind both Yes and No (two connections into its input)', () => {
    const URL = 'https://hooks.example.com/either';
    const shared = () => {
      const g = gated(50, [node('ro', 'core:replace-original'), hook('n', URL)], []);
      return { ...g, edges: [...g.edges, edge('sg', 'n', { from: 'else' })] };
    };
    const finishEntries = (id: string) => traceOf(id, 'n').filter(([phase]) => phase === 'finish');

    it('on Yes it runs once, after the replace', async () => {
      const id = await queue(file(), workflow(shared()));
      expect(await runOnce(id, 400)).toMatchObject({ state: 'done' });
      expect(calledUrls()).toEqual([URL]);
      expect(body(0)).toMatchObject({ outcome: 'done' });
      expect(finishEntries(id)).toHaveLength(1);
      expect(t.deps.engine.jobDetail(id)?.path.map((s) => s.nodeId)).toEqual([
        'in',
        'ev',
        'render-1',
        'sg',
        'ro',
        'n',
      ]);
    });

    it('on No it runs once, and the walk goes through else', async () => {
      const id = await queue(file(), workflow(shared()));
      expect(await runOnce(id, 900)).toMatchObject({ state: 'kept_original' });
      expect(calledUrls()).toEqual([URL]);
      expect(body(0)).toMatchObject({ outcome: 'kept_original' });
      expect(finishEntries(id)).toHaveLength(1);
      expect(t.deps.engine.jobDetail(id)?.path.map((s) => [s.nodeId, s.port])).toEqual([
        ['in', 'file'],
        ['ev', 'file'],
        ['render-1', 'done'],
        ['sg', 'else'],
        ['n', 'file'],
      ]);
    });

    it('a dry run lists it once', async () => {
      const id = await queue(file(), workflow(shared()), { dryRun: true });
      await t.deps.engine.start();
      expect(await settled(id)).toMatchObject({ state: 'dry_run' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(t.deps.engine.jobDetail(id)?.path.map((s) => s.nodeId)).toEqual([
        'in',
        'ev',
        'render-1',
        'sg',
        'ro',
        'n',
      ]);
    });
  });

  it('dry run: both branches are possible; the walk lists the else steps and the gate says it depends', async () => {
    const wf = workflow(gated(50, [node('ro', 'core:replace-original')], [hook('en', ELSE_URL)]));
    const id = await queue(file(), wf, { dryRun: true });
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'dry_run' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(t.deps.engine.jobDetail(id)?.path.map((s) => s.nodeId)).toEqual([
      'in',
      'ev',
      'render-1',
      'sg',
      'ro',
      'en',
    ]);
    // The gate's step leaves by no port: the result decides.
    expect(t.deps.engine.jobDetail(id)?.path.find((s) => s.nodeId === 'sg')?.port).toBeNull();
    expect(traceOf(id, 'sg').at(-1)).toEqual([
      'finish',
      null,
      'Size gate: decides after encoding: keep if it saves less than 50%',
    ]);
    expect(
      listTrace(t.db, id)
        .filter((e) => e.nodeId === 'sg')
        .at(-1)?.findings,
    ).toEqual({
      minSavingPercent: 50,
    });
  });
});

describe('pipeline: plan-only dry run outcome and the size gate (#41)', () => {
  const traceOf = (id: string, nodeId: string) =>
    listTrace(t.db, id)
      .filter((e) => e.nodeId === nodeId)
      .map((e) => [e.phase, e.port, e.reason]);
  const planOfJob = (id: string) => findJobResult(t.db, id)?.plan;
  const dry = async (wf: string): Promise<string> => {
    const id = await queue(file(), wf, { dryRun: true, testEncode: false });
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'dry_run' });
    return id;
  };

  it('no gate: would replace (nothing depends on size)', async () => {
    const id = await dry(
      workflow(
        line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
      ),
    );
    expect(planOfJob(id)?.dependsOnSize).toBeUndefined();
    expect(t.deps.engine.listJobs({ dependsOnSize: true }).jobs).toEqual([]);
  });

  it('a gate between the encode and the write: depends on size, carrying its threshold', async () => {
    const wf = workflow(gated(25, [node('ro', 'core:replace-original')], []));
    const id = await dry(wf);
    expect(planOfJob(id)?.dependsOnSize).toEqual({ minSavingPercent: 25 });
    const listed = t.deps.engine.listJobs({});
    expect(listed.jobs.find((j) => j.id === id)?.dependsOnSize).toEqual({ minSavingPercent: 25 });
    expect(listed.dependsOnSizeCount).toBe(1);
    expect(t.deps.engine.listJobs({ dependsOnSize: true }).jobs.map((j) => j.id)).toEqual([id]);
    const run = t.deps.engine.queue.runSummary(row(id).runId);
    expect(run?.counts).toMatchObject({ dry_run: 1, dependsOnSize: 1 });
    expect(run?.files[0]?.dependsOnSize).toEqual({ minSavingPercent: 25 });
    expect(traceOf(id, 'sg').at(-1)).toEqual([
      'finish',
      null,
      'Size gate: decides after encoding: keep if it saves less than 25%',
    ]);
  });

  it('two gates before the write: the strictest threshold decides', async () => {
    const id = await dry(
      workflow(
        line(
          node('in', 'core:input-manual'),
          toH264(),
          node('g1', 'core:size-gate', { minSavingPercent: 10 }),
          node('g2', 'core:size-gate', { minSavingPercent: 30 }),
          node('ro', 'core:replace-original'),
        ),
      ),
    );
    expect(planOfJob(id)?.dependsOnSize).toEqual({ minSavingPercent: 30 });
  });

  it('a Run node that encodes in its sub-workflow, then a gate before the replace: depends on size', async () => {
    // A sub-workflow holds no finish node (validate refuses one), so the gate after the Run node is
    // the one between the encode and the write.
    const sub = t.deps.workflows.create({ name: 'Encode sub', kind: 'subworkflow' }, 'u');
    t.deps.workflows.save(
      {
        id: sub.id,
        baseVersion: 1,
        graph: chain(
          'subworkflow',
          node('sev', 'core:encode-video', { codec: 'h264', encoder: 'libx264', skipIf: 'never' }),
        ),
      },
      'u',
    );
    const id = await dry(
      workflow(
        line(
          node('in', 'core:input-manual'),
          node('run', 'core:run-subworkflow', { subworkflowId: sub.id, version: 2, overrides: {} }),
          node('sg', 'core:size-gate', { minSavingPercent: 15 }),
          node('ro', 'core:replace-original'),
        ),
      ),
    );
    expect(planOfJob(id)?.streams[0]).toMatchObject({ action: 'convert' });
    expect(planOfJob(id)?.dependsOnSize).toEqual({ minSavingPercent: 15 });
  });

  it('a gate on the branch the file did not take does not count', async () => {
    const wf = workflow(
      mainGraph(
        [
          node('in', 'core:input-manual'),
          node('vi', 'core:video-is', { codecs: ['hevc'] }),
          toH264(),
          node('ro', 'core:replace-original'),
          node('ev2', 'core:encode-video', { codec: 'h264', encoder: 'libx264', skipIf: 'never' }),
          node('sg', 'core:size-gate', { minSavingPercent: 40 }),
          node('ro2', 'core:replace-original'),
        ],
        [
          edge('in', 'vi'),
          edge('vi', 'ev', { from: 'pass' }),
          edge('ev', 'ro'),
          edge('vi', 'ev2', { from: 'else' }),
          edge('ev2', 'sg'),
          edge('sg', 'ro2', { from: 'pass' }),
        ],
      ),
    );
    const id = await dry(wf);
    expect(t.deps.engine.jobDetail(id)?.path.map((s) => s.nodeId)).not.toContain('sg');
    expect(planOfJob(id)?.dependsOnSize).toBeUndefined();
  });

  it('a bypassed gate does not count', async () => {
    const id = await dry(
      workflow(
        line(
          node('in', 'core:input-manual'),
          toH264(),
          node('sg', 'core:size-gate', { minSavingPercent: 40 }, { bypassed: true }),
          node('ro', 'core:replace-original'),
        ),
      ),
    );
    expect(planOfJob(id)?.dependsOnSize).toBeUndefined();
  });

  it('a test-encode dry run measures instead: it never depends on size', async () => {
    const wf = workflow(gated(25, [node('ro', 'core:replace-original')], []));
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    expect(await runOnce(id, 600)).toMatchObject({ state: 'dry_run' });
    expect(planOfJob(id)?.dependsOnSize).toBeUndefined();
  });
});

describe('pipeline: test-encode dry runs', () => {
  const PASS_URL = 'https://hooks.example.com/pass';
  const ELSE_URL = 'https://hooks.example.com/else';
  const hook = (id: string, url: string) =>
    node(id, 'core:notify-webhook', { url, method: 'POST' });
  const ro = () => node('ro', 'core:replace-original');
  const input = () => node('in', 'core:input-manual');
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const traceOf = (id: string, nodeId: string) =>
    listTrace(t.db, id)
      .filter((e) => e.nodeId === nodeId)
      .map((e) => [e.phase, e.port, e.reason]);
  const gone = (p: string) =>
    stat(p).then(
      () => false,
      () => true,
    );

  it('test-encode: encodes, verifies and ends dry_run with the measured size; the library is untouched', async () => {
    const wf = workflow(line(input(), toH264(), ro(), hook('nw', PASS_URL)));
    const libraryBefore = await listAll(root);
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    expect(row(id).testEncode).toBe(true);
    const job = await runOnce(id, 600);
    expect(job).toMatchObject({ state: 'dry_run', reason: null });
    const result = findJobResult(t.db, id);
    expect(result).toMatchObject({
      outcome: 'dry_run',
      beforeBytes: 1000,
      afterBytes: 600,
      replacedTo: null,
    });
    expect(result?.command).not.toBeNull();
    expect(await listAll(root)).toEqual(libraryBefore);
    expect(await readFile(file())).toEqual(Buffer.alloc(1000, 7));
    expect(listRecycled(t.db)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spawner.calls).toHaveLength(1);
    expect(await gone(join(transcodeDir, id))).toBe(true);
  });

  it('test-encode: a failing gate ends kept_original with the real saving and runs no else step', async () => {
    const wf = workflow(gated(50, [ro(), hook('pn', PASS_URL)], [hook('en', ELSE_URL)]));
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    const job = await runOnce(id, 900);
    expect(job).toMatchObject({ state: 'kept_original', reason: 'saved only 10.0%, below 50%' });
    expect(findJobResult(t.db, id)).toMatchObject({ outcome: 'kept_original', afterBytes: 900 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(t.deps.engine.jobDetail(id)?.path.map((s) => s.nodeId)).toEqual([
      'in',
      'ev',
      'render-1',
      'sg',
      'en',
    ]);
    expect(traceOf(id, 'sg').at(-1)).toEqual([
      'finish',
      'else',
      'Size gate: saved 10.0%, below 50% → no',
    ]);
    expect(await readFile(file())).toEqual(Buffer.alloc(1000, 7));
    expect(await gone(join(transcodeDir, id))).toBe(true);
  });

  it('test-encode: a passing gate is traced and the job would replace', async () => {
    const wf = workflow(gated(10, [ro()], []));
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    expect(await runOnce(id, 600)).toMatchObject({ state: 'dry_run', reason: null });
    expect(traceOf(id, 'sg').at(-1)).toEqual([
      'finish',
      'pass',
      'Size gate: saved 40.0%, at least 10% → yes',
    ]);
    expect(await readFile(file())).toEqual(Buffer.alloc(1000, 7));
  });

  it('test-encode: a move-copy workflow puts nothing in the output root', async () => {
    const out = join(base, 'out');
    const wf = workflow(
      line(input(), toH264(), node('mc', 'core:move-copy', { mode: 'copy', outputRoot: out })),
    );
    const libraryBefore = await listAll(root);
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    expect(await runOnce(id, 600)).toMatchObject({ state: 'dry_run', reason: null });
    expect(findJobResult(t.db, id)?.afterBytes).toBe(600);
    expect(await listAll(out)).toEqual([]);
    expect(await listAll(root)).toEqual(libraryBefore);
    expect(await readFile(file())).toEqual(Buffer.alloc(1000, 7));
  });

  it('test-encode: with two gates the first failing one decides', async () => {
    const wf = workflow(
      line(
        input(),
        toH264(),
        node('g1', 'core:size-gate', { minSavingPercent: 10 }),
        node('g2', 'core:size-gate', { minSavingPercent: 50 }),
        ro(),
      ),
    );
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    expect(await runOnce(id, 600)).toMatchObject({
      state: 'kept_original',
      reason: 'saved only 40.0%, below 50%',
    });
    expect(traceOf(id, 'g1').at(-1)).toEqual([
      'finish',
      'pass',
      'Size gate: saved 40.0%, at least 10% → yes',
    ]);
    expect(traceOf(id, 'g2').at(-1)).toEqual([
      'finish',
      'else',
      'Size gate: saved 40.0%, below 50% → no',
    ]);
    expect(await readFile(file())).toEqual(Buffer.alloc(1000, 7));
  });

  it('test-encode: a verify failure fails the dry run after one retry', async () => {
    fake.brokenOutput = true;
    const wf = workflow(line(input(), toH264(), ro()));
    const libraryBefore = await listAll(root);
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    await t.deps.engine.start();
    await until('first spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('second spawn', () => spawner.calls.length === 2);
    expect(row(id)).toMatchObject({ attempt: 2 });
    await spawner.complete({ bytes: 600 });
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', failureCode: 'verify', attempt: 2 });
    expect(job.reason).toMatch(/^verify:/);
    expect(await listAll(root)).toEqual(libraryBefore);
    expect(await readFile(file())).toEqual(Buffer.alloc(1000, 7));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('test-encode: queued behind a real job in the encode lane', async () => {
    const b = join(root, 'Show', 'b.mkv');
    await writeFile(b, Buffer.alloc(1000, 8));
    const wf = workflow(line(input(), toH264(), ro()));
    const real = await queue(file(), wf);
    await t.deps.engine.start();
    await until('first spawn', () => spawner.calls.length === 1);
    const test = await queue(b, wf, { dryRun: true, testEncode: true });
    const inputOf = (i: number) => {
      const args = spawner.calls[i]?.args ?? [];
      return args[args.indexOf('-i') + 1];
    };
    expect(inputOf(0)).toBe(file());
    // The test-encode waits for the lane: nothing else spawns while the real job encodes.
    await until('test-encode waiting for the encode lane', () => row(test).lane === 'encode');
    await new Promise((r) => setTimeout(r, 50));
    expect(spawner.calls).toHaveLength(1);
    await spawner.complete({ bytes: 600 });
    await until('second spawn', () => spawner.calls.length === 2);
    expect(inputOf(1)).toBe(b);
    await spawner.complete({ bytes: 600 });
    expect(await settled(real)).toMatchObject({ state: 'done' });
    expect(await settled(test)).toMatchObject({ state: 'dry_run' });
    expect(await readFile(b)).toEqual(Buffer.alloc(1000, 8));
  });

  const kept = (id: string) => join(transcodeDir, 'test-outputs', `${id}.mkv`);
  const twoHoursOn = () => new Date(t.clock.now().getTime() + 2 * 3_600_000).toISOString();

  it('test-encode keeps the verified output', async () => {
    const wf = workflow(line(input(), toH264(), ro()));
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    expect(await runOnce(id, 600)).toMatchObject({ state: 'dry_run' });
    expect(t.deps.engine.jobDetail(id)).toMatchObject({
      testOutput: { container: 'mkv', sizeBytes: 600, keptUntil: twoHoursOn() },
      testOutputNote: null,
    });
    expect((await stat(kept(id))).size).toBe(600);
    expect(await gone(join(transcodeDir, id))).toBe(true);
  });

  it('test-encode: a failing gate keeps the output too', async () => {
    const wf = workflow(gated(50, [ro()], []));
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    expect(await runOnce(id, 900)).toMatchObject({ state: 'kept_original' });
    expect(t.deps.engine.jobDetail(id)?.testOutput).toMatchObject({ sizeBytes: 900 });
    expect((await stat(kept(id))).size).toBe(900);
  });

  it('test-encode: a verify failure keeps nothing', async () => {
    fake.brokenOutput = true;
    const wf = workflow(line(input(), toH264(), ro()));
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    await t.deps.engine.start();
    await until('first spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('second spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'failed', failureCode: 'verify' });
    expect(t.deps.engine.jobDetail(id)).toMatchObject({ testOutput: null, testOutputNote: null });
    expect(await listAll(transcodeDir)).toEqual([]);
  });

  it('test-encode: a cancelled test-encode keeps nothing', async () => {
    const wf = workflow(line(input(), toH264(), ro()));
    const id = await queue(file(), wf, { dryRun: true, testEncode: true });
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    expect(t.deps.engine.scheduler.cancelJob(id)).toBe('ok');
    expect(await settled(id)).toMatchObject({ state: 'cancelled' });
    expect(t.deps.engine.jobDetail(id)?.testOutput).toBeNull();
    expect(await listAll(transcodeDir)).toEqual([]);
  });

  it('test-encode: a real job evicts kept outputs when scratch is low before it encodes', async () => {
    await t.deps.engine.stop();
    // Scratch is low while a kept output sits in test-outputs (once the first one is kept).
    let squeeze = false;
    const outputs = join(transcodeDir, 'test-outputs');
    await setup({
      fs: {
        ...fsOps,
        statfs: async (p) =>
          squeeze && p === outputs && readdirSync(outputs).length > 0
            ? { bavail: 1, bsize: 4096 }
            : { bavail: 1e9, bsize: 4096 },
      },
    });
    const wf = workflow(line(input(), toH264(), ro()));
    const test = await queue(file(), wf, { dryRun: true, testEncode: true });
    expect(await runOnce(test, 600)).toMatchObject({ state: 'dry_run' });
    expect(t.deps.engine.jobDetail(test)?.testOutput).not.toBeNull();
    squeeze = true;
    const real = await queue(file(), wf);
    await until('second spawn', () => spawner.calls.length === 2);
    expect(t.deps.engine.jobDetail(test)).toMatchObject({
      testOutput: null,
      testOutputNote: 'deleted: scratch space was needed',
    });
    expect(await gone(kept(test))).toBe(true);
    await spawner.complete({ bytes: 600 });
    expect(await settled(real)).toMatchObject({ state: 'done' });
  });

  it('plan-only dry run unchanged', async () => {
    const wf = workflow(line(input(), toH264(), ro()));
    const id = await queue(file(), wf, { dryRun: true });
    expect(row(id).testEncode).toBe(false);
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'dry_run' });
    expect(spawner.calls).toEqual([]);
    expect(findJobResult(t.db, id)?.afterBytes).toBeNull();
  });
});
