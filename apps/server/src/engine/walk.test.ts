import {
  type AnyNodeDefinition,
  type BuildModel,
  type DataValue,
  defineNode,
  FetchRefused,
} from '@transcoda/sdk';
import type { JsonValue, TraceEntry, WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { filePort, languageInput, passElse } from '../nodes/core/common.ts';
import { NodeHookError } from '../nodes/core/stream-rules.ts';
import { runSubworkflow } from '../nodes/core/subworkflow.ts';
import { type RemoteHooks, remoteNodeDefinition } from '../nodes/remote.ts';
import { edge, mainGraph, node, subGraph, testRegistry } from '../workflows/test-helpers.ts';
import { capsOf, fileOf, probeOf, withSidecar } from './test-helpers.ts';
import { type PathStep, type WalkDeps, walk, walkBuild, walkDecide } from './walk.ts';

const NOW = new Date('2026-10-16T20:00:00.000Z');
const AT = NOW.toISOString();

const languageOf = (v: JsonValue | undefined) => v ?? null;

const cond = defineNode({
  type: 'test:cond',
  version: 1,
  kind: 'condition',
  title: 'Cond',
  description: 'Chooses the port named in its settings.',
  icon: 'test',
  inputs: [filePort, languageInput],
  outputs: passElse,
  settings: z.object({ port: z.enum(['pass', 'else', 'bogus']).default('pass') }),
  async decide(ctx, s) {
    return {
      port: s.port,
      reason: `chose ${s.port}`,
      findings: { language: languageOf(ctx.data.language), now: ctx.now },
    };
  },
});

const act = defineNode({
  type: 'test:act',
  version: 1,
  kind: 'action',
  title: 'Act',
  description: 'Appends its arg to globalArgs.',
  icon: 'test',
  inputs: [filePort, languageInput],
  outputs: [filePort],
  settings: z.object({ arg: z.string(), fail: z.boolean().default(false) }),
  async build(ctx, s) {
    if (s.fail) throw new NodeHookError(`cannot ${s.arg}`);
    return {
      model: { ...ctx.model, globalArgs: [...ctx.model.globalArgs, s.arg] },
      reason: `added ${s.arg}`,
      findings: { language: languageOf(ctx.data.language) },
    };
  },
});

const plain = defineNode({
  type: 'test:plain',
  version: 1,
  kind: 'action',
  title: 'Plain',
  description: 'An action without a build hook.',
  icon: 'test',
  inputs: [filePort],
  outputs: [filePort],
  settings: z.object({}),
});

const fin = defineNode({
  type: 'test:fin',
  version: 1,
  kind: 'finish',
  title: 'Fin',
  description: 'A size gate.',
  icon: 'test',
  inputs: [filePort],
  outputs: [filePort],
  settings: z.object({ percent: z.number() }),
  async finish(_ctx, s) {
    return {
      actions: [{ kind: 'size-gate', minSavingPercent: s.percent }],
      reason: `gate ${s.percent}`,
    };
  },
});

/** Finish nodes of each phase with no output (like plugin finish nodes); the action names them. */
const phased = (type: string, finishPhase: 'library-manager' | 'media-server' | 'notify') =>
  defineNode({
    type,
    version: 1,
    kind: 'finish',
    finishPhase,
    title: type,
    description: `A ${finishPhase} finish node.`,
    icon: 'test',
    inputs: [filePort],
    outputs: [],
    settings: z.object({}),
    async finish() {
      return { actions: [{ kind: 'plugin', description: type, required: false }], reason: type };
    },
  });
const lib = phased('test:lib', 'library-manager');
const media = phased('test:media', 'media-server');
const note = phased('test:note', 'notify');

function dataLanguage(calls: { count: number }): AnyNodeDefinition {
  return defineNode({
    type: 'test:data-language',
    version: 1,
    kind: 'data',
    title: 'Language',
    description: 'A language from its settings.',
    icon: 'test',
    inputs: [],
    outputs: [{ id: 'language', label: 'Language', type: 'data:language' }],
    settings: z.object({ language: z.string().default('jpn'), fail: z.boolean().default(false) }),
    async data(_ctx, s) {
      calls.count++;
      if (s.fail) throw new Error('boom');
      return { value: s.language, reason: `language ${s.language}` };
    },
  });
}

function dataMulti(value: DataValue): AnyNodeDefinition {
  return defineNode({
    type: 'test:data-multi',
    version: 1,
    kind: 'data',
    title: 'Multi',
    description: 'A data node with two outputs.',
    icon: 'test',
    inputs: [],
    outputs: [
      { id: 'a', label: 'A', type: 'data:language' },
      { id: 'b', label: 'B', type: 'data:language' },
    ],
    settings: z.object({ fail: z.boolean().default(false) }),
    async data(_ctx, s) {
      if (s.fail) throw new Error('boom');
      return { value, reason: 'multi' };
    },
  });
}

function setup(
  opts: {
    multi?: DataValue;
    children?: Record<string, { name: string; graph: WorkflowGraph }>;
    calls?: { count: number };
  } = {},
): {
  deps: WalkDeps;
  trace: TraceEntry[];
  started: string[];
  resolveChild: ReturnType<typeof vi.fn>;
} {
  const trace: TraceEntry[] = [];
  const started: string[] = [];
  const resolveChild = vi.fn(
    (id: string, _version: number, _overrides: Record<string, JsonValue>) =>
      opts.children?.[id] ?? null,
  );
  const deps: WalkDeps = {
    registry: testRegistry(
      cond,
      act,
      plain,
      fin,
      lib,
      media,
      note,
      dataLanguage(opts.calls ?? { count: 0 }),
      dataMulti(opts.multi ?? 'unknown'),
    ),
    resolveChild,
    now: () => NOW,
    onTrace: (entry) => trace.push(entry),
    onNodeStart: ({ workflowPath, nodeId }) => started.push([...workflowPath, nodeId].join('/')),
    capabilities: capsOf(['libx264']),
    log: () => {},
  };
  return { deps, trace, started, resolveChild };
}

const input = (graph: WorkflowGraph) => ({
  graph,
  probe: probeOf([{ type: 'video' }, { type: 'audio', language: 'jpn' }]),
  file: fileOf('/media/a.mkv', 1000),
  attempt: 2,
});

/** The trace without seq, timestamps, attempt and findings (checked once). */
const brief = (trace: TraceEntry[]) =>
  trace.map(({ nodeId, workflowPath, phase, port, reason }) => ({
    nodeId,
    workflowPath,
    phase,
    port,
    reason,
  }));

const ids = (path: { nodeId: string }[]) => path.map((r) => r.nodeId);
const at = (s: { workflowPath: string[]; nodeId: string }) =>
  [...s.workflowPath, s.nodeId].join('/');

/**
 * Seqs run 1, 2, … in emission order, and every path step has exactly one non-data entry for
 * its node with the port it left by (a failing step: its `failed:` entry).
 */
function expectCovered(path: PathStep[], trace: TraceEntry[]): void {
  expect(trace.map((e) => e.seq)).toEqual(trace.map((_, i) => i + 1));
  const entries = trace.filter((e) => e.phase !== 'data');
  for (const s of path) {
    const mine = entries.filter((e) => at(e) === at(s));
    expect(mine.length, at(s)).toBeGreaterThanOrEqual(1);
    const ok = mine.filter((e) => !e.reason.startsWith('failed: '));
    if (ok.length > 0) {
      expect(ok, at(s)).toHaveLength(1);
      expect(ok[0]?.port, at(s)).toBe(s.port);
    }
  }
  expect(new Set(entries.map(at))).toEqual(new Set(path.map(at)));
}

describe('walk', () => {
  it('follows the chosen port and records an entry for every path node with its port', async () => {
    const { deps, trace, started } = setup();
    const graph = mainGraph(
      [
        node('in', 'core:input-manual', {}, { label: 'Drop folder' }),
        node('c', 'test:cond', { port: 'else' }),
        node('a1', 'test:act', { arg: 'one' }),
        node('a2', 'test:act', { arg: 'two' }),
        node('p', 'test:plain'),
        node('f', 'test:fin', { percent: 10 }),
      ],
      [
        edge('in', 'c'),
        edge('c', 'a1', { from: 'pass' }),
        edge('c', 'a2', { from: 'else' }),
        edge('a2', 'p'),
        edge('p', 'f'),
      ],
    );
    const decided = await walkDecide(deps, input(graph));
    if (decided.kind !== 'decided') throw new Error(JSON.stringify(decided));
    expect(ids(decided.nodes)).toEqual(['in', 'c', 'a2', 'p', 'f']);
    expect(trace).toHaveLength(2);
    expect(decided.nextSeq).toBe(3);
    const result = await walkBuild(deps, input(graph), decided);
    if (result.kind !== 'built') throw new Error(JSON.stringify(result));
    expect(result.model.globalArgs).toEqual(['two']);
    expect(result.path).toEqual([
      { workflowPath: [], nodeId: 'in', port: 'file' },
      { workflowPath: [], nodeId: 'c', port: 'else' },
      { workflowPath: [], nodeId: 'a2', port: 'file' },
      { workflowPath: [], nodeId: 'p', port: 'file' },
      { workflowPath: [], nodeId: 'f', port: 'file' },
    ]);
    expect(brief(trace)).toEqual([
      { nodeId: 'in', workflowPath: [], phase: 'pass', port: 'file', reason: 'start: Drop folder' },
      { nodeId: 'c', workflowPath: [], phase: 'decide', port: 'else', reason: 'chose else' },
      { nodeId: 'a2', workflowPath: [], phase: 'build', port: 'file', reason: 'added two' },
      { nodeId: 'p', workflowPath: [], phase: 'build', port: 'file', reason: 'no-op' },
      { nodeId: 'f', workflowPath: [], phase: 'finish', port: 'file', reason: 'gate 10' },
    ]);
    expect(trace[1]).toEqual({
      seq: 2,
      attempt: 2,
      nodeId: 'c',
      workflowPath: [],
      phase: 'decide',
      port: 'else',
      reason: 'chose else',
      findings: { language: 'unknown', now: NOW.getTime() },
      source: 'core',
      startedAt: AT,
      endedAt: AT,
    });
    expect(trace[4]?.findings).toEqual({});
    // An action whose hook ran says what it changed in the model; nothing else carries changes.
    expect(trace[2]?.changes).toMatchObject({ dropped: [], converted: [], other: true });
    expect(trace.filter((e) => e.changes !== undefined).map((e) => e.nodeId)).toEqual(['a2']);
    expectCovered(result.path, trace);
    expect(started).toEqual(['in', 'c', 'a2', 'p', 'f', 'a2', 'p', 'f']);
  });

  it('starts seq at firstSeq', async () => {
    const { deps, trace } = setup();
    const graph = mainGraph(
      [node('in', 'core:input-manual'), node('a', 'test:act', { arg: 'x' })],
      [edge('in', 'a')],
    );
    await walk(deps, { ...input(graph), firstSeq: 7 });
    expect(trace.map((e) => e.seq)).toEqual([7, 8]);
  });

  it('resolves a data node once and feeds ctx.data; a throwing data hook yields unknown', async () => {
    const calls = { count: 0 };
    const { deps, trace } = setup({ calls });
    const graph = mainGraph(
      [
        node('in', 'core:input-manual'),
        node('d', 'test:data-language'),
        node('bad', 'test:data-language', { fail: true }),
        node('c', 'test:cond'),
        node('a', 'test:act', { arg: 'x' }),
        node('b', 'test:act', { arg: 'y' }),
      ],
      [
        edge('in', 'c'),
        edge('d', 'c', { from: 'language', to: 'language' }),
        edge('c', 'a', { from: 'pass' }),
        edge('d', 'a', { from: 'language', to: 'language' }),
        edge('a', 'b'),
        edge('bad', 'b', { from: 'language', to: 'language' }),
      ],
    );
    const result = await walk(deps, input(graph));
    if (result.kind !== 'built') throw new Error(JSON.stringify(result));
    expect(calls.count).toBe(2);
    expect(
      trace.map(({ nodeId, phase, reason, findings }) => ({ nodeId, phase, reason, findings })),
    ).toEqual([
      { nodeId: 'in', phase: 'pass', reason: 'start: Manual input', findings: {} },
      { nodeId: 'd', phase: 'data', reason: 'language jpn', findings: { language: 'jpn' } },
      {
        nodeId: 'c',
        phase: 'decide',
        reason: 'chose pass',
        findings: { language: 'jpn', now: NOW.getTime() },
      },
      {
        nodeId: 'bad',
        phase: 'data',
        reason: 'source unavailable: boom',
        findings: { language: 'unknown' },
      },
      { nodeId: 'a', phase: 'build', reason: 'added x', findings: { language: 'jpn' } },
      { nodeId: 'b', phase: 'build', reason: 'added y', findings: { language: 'unknown' } },
    ]);
    expectCovered(result.path, trace);
  });

  describe('data nodes with several outputs', () => {
    const multiGraph = () =>
      mainGraph(
        [
          node('in', 'core:input-manual'),
          node('m', 'test:data-multi'),
          node('a', 'test:act', { arg: 'x' }),
          node('b', 'test:act', { arg: 'y' }),
        ],
        [
          edge('in', 'a'),
          edge('m', 'a', { from: 'a', to: 'language' }),
          edge('a', 'b'),
          edge('m', 'b', { from: 'b', to: 'language' }),
        ],
      );
    const buildFindings = (trace: TraceEntry[]) =>
      trace.filter((e) => e.phase === 'build').map((e) => e.findings);

    it('feeds each output its own key of an object value', async () => {
      const { deps, trace } = setup({ multi: { a: 'x', b: 'y' } });
      const result = await walk(deps, input(multiGraph()));
      if (result.kind !== 'built') throw new Error(JSON.stringify(result));
      expect(trace.find((e) => e.phase === 'data')).toMatchObject({
        findings: { a: 'x', b: 'y' },
        reason: 'multi',
      });
      expect(buildFindings(trace)).toEqual([{ language: 'x' }, { language: 'y' }]);
    });

    it('gives unknown on every port, with the reason suffixed, when the value is not keyed by output id', async () => {
      const { deps, trace } = setup({ multi: 'x' });
      const result = await walk(deps, input(multiGraph()));
      if (result.kind !== 'built') throw new Error(JSON.stringify(result));
      expect(trace.find((e) => e.phase === 'data')).toMatchObject({
        findings: { a: 'unknown', b: 'unknown' },
        reason: 'multi (expected an object keyed by output id)',
      });
    });

    it('adds no suffix for a bypassed or a throwing multi-output node', async () => {
      for (const [extra, reason] of [
        [{ bypassed: true }, 'bypassed'],
        [undefined, 'source unavailable: boom'],
      ] as const) {
        const { deps, trace } = setup({ multi: 'x' });
        const g = multiGraph();
        const m = g.nodes.find((x) => x.id === 'm');
        if (!m) throw new Error('no m');
        if (extra) m.bypassed = true;
        else m.settings = { fail: true };
        await walk(deps, input(g));
        const entry = trace.find((e) => e.phase === 'data');
        expect(entry?.reason).toContain(reason);
        expect(entry?.reason).not.toContain('expected an object');
      }
    });

    it('gives unknown to a port whose key is missing', async () => {
      const { deps, trace } = setup({ multi: { a: 'x' } });
      await walk(deps, input(multiGraph()));
      expect(trace.find((e) => e.phase === 'data')).toMatchObject({
        findings: { a: 'x', b: 'unknown' },
      });
    });
  });

  it('walks into a pinned sub-workflow and back; nested entries carry workflowPath [runId]', async () => {
    const child = subGraph(
      [node('ca', 'test:act', { arg: 'child' }), node('cc', 'test:cond', { port: 'pass' })],
      [edge('start', 'ca'), edge('ca', 'cc'), edge('cc', 'end', { from: 'pass' })],
    );
    const { deps, trace, resolveChild } = setup({
      children: { kid: { name: 'Cleanup', graph: child } },
    });
    const graph = mainGraph(
      [
        node('in', 'core:input-manual'),
        node('r', 'core:run-subworkflow', {
          subworkflowId: 'kid',
          version: 3,
          overrides: { 'ca.arg': 'child' },
        }),
        node('a', 'test:act', { arg: 'after' }),
        node('f', 'test:fin', { percent: 5 }),
      ],
      [edge('in', 'r'), edge('r', 'a'), edge('a', 'f')],
    );
    const result = await walk(deps, input(graph));
    if (result.kind !== 'built') throw new Error(JSON.stringify(result));
    expect(resolveChild).toHaveBeenCalledWith('kid', 3, { 'ca.arg': 'child' });
    expect(result.model.globalArgs).toEqual(['child', 'after']);
    expect(result.path.map((s) => `${at(s)}:${s.port}`)).toEqual([
      'in:file',
      'r:file',
      'r/start:file',
      'r/ca:file',
      'r/cc:pass',
      'r/end:file',
      'a:file',
      'f:file',
    ]);
    expect(brief(trace)).toEqual([
      {
        nodeId: 'in',
        workflowPath: [],
        phase: 'pass',
        port: 'file',
        reason: 'start: Manual input',
      },
      {
        nodeId: 'r',
        workflowPath: [],
        phase: 'pass',
        port: 'file',
        reason: 'enters sub-workflow Cleanup v3',
      },
      { nodeId: 'start', workflowPath: ['r'], phase: 'pass', port: 'file', reason: 'start' },
      { nodeId: 'cc', workflowPath: ['r'], phase: 'decide', port: 'pass', reason: 'chose pass' },
      { nodeId: 'end', workflowPath: ['r'], phase: 'pass', port: 'file', reason: 'returns' },
      { nodeId: 'ca', workflowPath: ['r'], phase: 'build', port: 'file', reason: 'added child' },
      { nodeId: 'a', workflowPath: [], phase: 'build', port: 'file', reason: 'added after' },
      { nodeId: 'f', workflowPath: [], phase: 'finish', port: 'file', reason: 'gate 5' },
    ]);
    expectCovered(result.path, trace);
  });

  it('the Run node has no data inputs, so the walk resolves no data for it', () => {
    expect(runSubworkflow.inputs.filter((p) => p.type !== 'file')).toEqual([]);
  });

  it('a missing sub-workflow fails the walk at the Run node, with a trace entry and the path', async () => {
    const { deps, trace } = setup();
    const graph = mainGraph(
      [
        node('in', 'core:input-manual'),
        node('r', 'core:run-subworkflow', { subworkflowId: 'gone', version: 1, overrides: {} }),
      ],
      [edge('in', 'r')],
    );
    expect(await walk(deps, input(graph))).toEqual({
      kind: 'failed',
      nodeId: 'r',
      workflowPath: [],
      reason: 'sub-workflow missing',
      retryable: false,
      path: [
        { workflowPath: [], nodeId: 'in', port: 'file' },
        { workflowPath: [], nodeId: 'r', port: null },
      ],
    });
    expect(brief(trace).at(-1)).toEqual({
      nodeId: 'r',
      workflowPath: [],
      phase: 'pass',
      port: null,
      reason: 'failed: sub-workflow missing',
    });
  });

  it('a sub-workflow that runs itself fails at the inner Run node', async () => {
    const loop = subGraph(
      [node('again', 'core:run-subworkflow', { subworkflowId: 'kid', version: 1, overrides: {} })],
      [edge('start', 'again'), edge('again', 'end')],
    );
    const { deps, trace } = setup({ children: { kid: { name: 'Loop', graph: loop } } });
    const graph = mainGraph(
      [
        node('in', 'core:input-manual'),
        node('r', 'core:run-subworkflow', { subworkflowId: 'kid', version: 1, overrides: {} }),
      ],
      [edge('in', 'r')],
    );
    const result = await walk(deps, input(graph));
    expect(result).toMatchObject({
      kind: 'failed',
      nodeId: 'again',
      workflowPath: ['r'],
      reason: 'sub-workflow calls itself',
    });
    if (result.kind !== 'failed') return;
    expect(result.path.map(at)).toEqual(['in', 'r', 'r/start', 'r/again']);
    expect(trace.at(-1)?.reason).toBe('failed: sub-workflow calls itself');
    expectCovered(result.path, trace);
  });

  it('a decide hook choosing a port the node does not have fails the walk', async () => {
    const { deps, trace } = setup();
    const graph = mainGraph(
      [node('in', 'core:input-manual'), node('c', 'test:cond', { port: 'bogus' })],
      [edge('in', 'c')],
    );
    expect(await walk(deps, input(graph))).toMatchObject({
      kind: 'failed',
      nodeId: 'c',
      reason: 'chose unknown port bogus',
      path: [
        { nodeId: 'in', port: 'file' },
        { nodeId: 'c', port: null },
      ],
    });
    expect(brief(trace).at(-1)).toMatchObject({
      nodeId: 'c',
      phase: 'decide',
      reason: 'failed: chose unknown port bogus',
    });
  });

  it('a graph that leads back to a node fails at the revisited node', async () => {
    const { deps, trace } = setup();
    const graph = mainGraph(
      [
        node('in', 'core:input-manual'),
        node('a', 'test:act', { arg: 'x' }),
        node('b', 'test:act', { arg: 'y' }),
      ],
      [edge('in', 'a'), edge('a', 'b'), edge('b', 'a')],
    );
    const result = await walk(deps, input(graph));
    expect(result).toMatchObject({
      kind: 'failed',
      nodeId: 'a',
      reason: 'the workflow has a cycle',
    });
    if (result.kind !== 'failed') return;
    expect(result.path.map((s) => `${s.nodeId}:${s.port}`)).toEqual([
      'in:file',
      'a:file',
      'b:file',
      'a:null',
    ]);
    expect(trace.at(-1)).toMatchObject({ nodeId: 'a', reason: 'failed: the workflow has a cycle' });
  });

  it('a bypassed node is traced as bypassed and passed through its first file output', async () => {
    const { deps, trace } = setup();
    const graph = mainGraph(
      [
        node('in', 'core:input-manual'),
        node('c', 'test:cond', { port: 'else' }, { bypassed: true }),
        node('a', 'test:act', { arg: 'skipped' }, { bypassed: true }),
        node('b', 'test:act', { arg: 'else-path' }),
        node('f', 'test:fin', { percent: 1 }, { bypassed: true }),
      ],
      [
        edge('in', 'c'),
        edge('c', 'a', { from: 'pass' }),
        edge('c', 'b', { from: 'else' }),
        edge('a', 'f'),
      ],
    );
    const result = await walk(deps, input(graph));
    if (result.kind !== 'built') throw new Error(JSON.stringify(result));
    expect(ids(result.path)).toEqual(['in', 'c', 'a', 'f']);
    expect(result.model.globalArgs).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(brief(trace).slice(1)).toEqual([
      { nodeId: 'c', workflowPath: [], phase: 'decide', port: 'pass', reason: 'bypassed' },
      { nodeId: 'a', workflowPath: [], phase: 'build', port: 'file', reason: 'bypassed' },
      { nodeId: 'f', workflowPath: [], phase: 'finish', port: 'file', reason: 'bypassed' },
    ]);
    expectCovered(result.path, trace);
  });

  it('a bypassed Run node is not entered and gets a bypassed entry', async () => {
    const { deps, trace, resolveChild } = setup();
    const graph = mainGraph(
      [
        node(
          'r',
          'core:run-subworkflow',
          { subworkflowId: 'kid', version: 1, overrides: {} },
          { bypassed: true },
        ),
        node('in', 'core:input-manual'),
        node('a', 'test:act', { arg: 'x' }),
      ],
      [edge('in', 'r'), edge('r', 'a')],
    );
    const result = await walk(deps, input(graph));
    if (result.kind !== 'built') throw new Error(JSON.stringify(result));
    expect(resolveChild).not.toHaveBeenCalled();
    expect(ids(result.path)).toEqual(['in', 'r', 'a']);
    expect(brief(trace)[1]).toEqual({
      nodeId: 'r',
      workflowPath: [],
      phase: 'build',
      port: 'file',
      reason: 'bypassed',
    });
    expectCovered(result.path, trace);
  });

  it('a throwing build hook fails the walk with the node id and message', async () => {
    const { deps, trace } = setup();
    const graph = mainGraph(
      [
        node('in', 'core:input-manual'),
        node('a', 'test:act', { arg: 'x', fail: true }),
        node('f', 'test:fin', { percent: 1 }),
      ],
      [edge('in', 'a'), edge('a', 'f')],
    );
    expect(await walk(deps, input(graph))).toEqual({
      kind: 'failed',
      nodeId: 'a',
      workflowPath: [],
      reason: 'cannot x',
      retryable: false,
      path: [
        { workflowPath: [], nodeId: 'in', port: 'file' },
        { workflowPath: [], nodeId: 'a', port: 'file' },
      ],
    });
    expect(brief(trace).at(-1)).toEqual({
      nodeId: 'a',
      workflowPath: [],
      phase: 'build',
      port: null,
      reason: 'failed: cannot x',
    });
  });

  it('an output connected to two nodes that are not all finish nodes fails the walk', async () => {
    const { deps, trace } = setup();
    const graph = mainGraph(
      [
        node('in', 'core:input-manual'),
        node('a', 'test:act', { arg: 'x' }),
        node('b', 'test:act', { arg: 'y' }),
      ],
      [edge('in', 'a'), edge('in', 'b')],
    );
    const reason = 'output file has 2 connections; only finish steps can share an output';
    expect(await walk(deps, input(graph))).toEqual({
      kind: 'failed',
      nodeId: 'in',
      workflowPath: [],
      reason,
      retryable: false,
      path: [{ workflowPath: [], nodeId: 'in', port: 'file' }],
    });
    expect(trace.at(-1)).toMatchObject({
      nodeId: 'in',
      phase: 'pass',
      reason: `failed: ${reason}`,
    });
  });

  describe('several finish nodes on one output', () => {
    const fanned = (finishes: ReturnType<typeof node>[], extra: ReturnType<typeof edge>[] = []) =>
      mainGraph(
        [
          node('in', 'core:input-manual'),
          node('a', 'test:act', { arg: 'x' }),
          node('ro', 'core:replace-original'),
          ...finishes,
        ],
        [
          edge('in', 'a'),
          edge('a', 'ro'),
          ...finishes
            .filter((f) => !extra.some((e) => e.to.node === f.id))
            .map((f) => edge('ro', f.id)),
          ...extra,
        ],
      );

    it('three finish nodes off Replace original run in phase order, whatever the wiring order', async () => {
      const { deps, trace } = setup();
      // Wired (and listed) notify, media server, library manager: the "wrong" visual order.
      const graph = fanned([
        node('n', 'test:note'),
        node('m', 'test:media'),
        node('l', 'test:lib'),
      ]);
      const result = await walk(deps, input(graph));
      if (result.kind !== 'built') throw new Error(JSON.stringify(result));
      expect(ids(result.path)).toEqual(['in', 'a', 'ro', 'l', 'm', 'n']);
      expect(result.path.find((s) => s.nodeId === 'ro')?.port).toBe('file');
      expect(result.path.find((s) => s.nodeId === 'l')?.port).toBeNull();
      expect(result.actions).toEqual([
        { kind: 'replace', recycleFolder: null },
        { kind: 'plugin', description: 'test:lib', required: false },
        { kind: 'plugin', description: 'test:media', required: false },
        { kind: 'plugin', description: 'test:note', required: false },
      ]);
      expectCovered(result.path, trace);
    });

    it('a mix of chains and fan-out at one canvas spot: phase first, a node after the ones wired before it, then graph order', async () => {
      const { deps } = setup();
      // ro → n2, ro → m, ro → w1 → w2 (core notify, chained), ro → l; n1 listed first, n2 → n1.
      const graph = fanned(
        [
          node('n1', 'test:note'),
          node('w2', 'core:notify-webhook', { url: 'https://example.test/2' }),
          node('m', 'test:media'),
          node('n2', 'core:notify-webhook', { url: 'https://example.test/n2' }),
          node('w1', 'core:notify-webhook', { url: 'https://example.test/1' }),
          node('l', 'test:lib'),
        ],
        [edge('n2', 'n1'), edge('w1', 'w2'), edge('ro', 'w1'), edge('ro', 'n2')],
      );
      const result = await walk(deps, input(graph));
      if (result.kind !== 'built') throw new Error(JSON.stringify(result));
      // notify phase: w2 is listed before n2 and w1 but follows w1; n1 follows n2.
      expect(ids(result.path)).toEqual(['in', 'a', 'ro', 'l', 'm', 'n2', 'n1', 'w1', 'w2']);
    });

    it('within one phase: left to right on the canvas, then top to bottom, then graph order', async () => {
      const { deps } = setup();
      const at = (x: number, y: number) => ({ position: { x, y } });
      // Added z, b, c, d; placed b left of z, d above c in one column, c and z at the same spot.
      const graph = fanned([
        node('z', 'test:note', {}, at(500, 0)),
        node('b', 'test:note', {}, at(100, 0)),
        node('c', 'test:note', {}, at(500, 0)),
        node('d', 'test:note', {}, at(500, -200)),
      ]);
      const decided = await walkDecide(deps, input(graph));
      if (decided.kind !== 'decided') throw new Error(JSON.stringify(decided));
      expect(ids(decided.nodes)).toEqual(['in', 'a', 'ro', 'b', 'd', 'z', 'c']);
    });

    it('explicit wiring wins over canvas position; the phase wins over both', async () => {
      const { deps } = setup();
      const at = (x: number) => ({ position: { x, y: 0 } });
      // n1 is left of n2 but wired behind it; the library step is furthest right yet runs first.
      const graph = fanned(
        [
          node('n1', 'test:note', {}, at(100)),
          node('n2', 'core:notify-webhook', { url: 'https://e.test/' }, at(300)),
          node('l', 'test:lib', {}, at(900)),
        ],
        [edge('n2', 'n1'), edge('ro', 'n2')],
      );
      const decided = await walkDecide(deps, input(graph));
      if (decided.kind !== 'decided') throw new Error(JSON.stringify(decided));
      expect(ids(decided.nodes)).toEqual(['in', 'a', 'ro', 'l', 'n2', 'n1']);
    });

    it('a size gate sharing an output fails the walk at the gate (validation refuses it first)', async () => {
      const { deps, trace } = setup();
      const graph = mainGraph(
        [
          node('in', 'core:input-manual'),
          node('sg', 'core:size-gate', { minSavingPercent: 20 }),
          node('ro', 'core:replace-original'),
          node('n', 'test:note'),
        ],
        [edge('in', 'sg'), edge('in', 'n'), edge('sg', 'ro', { from: 'pass' })],
      );
      const reason =
        'The size gate must be the only step on this output; put the other steps after the gate\u2019s Yes or No.';
      expect(await walk(deps, input(graph))).toMatchObject({
        kind: 'failed',
        nodeId: 'sg',
        reason,
      });
      expect(trace.at(-1)).toMatchObject({ nodeId: 'sg', reason: `failed: ${reason}` });
      // bypassed, it decides nothing and may share
      const sg = graph.nodes.find((n) => n.id === 'sg');
      if (sg) sg.bypassed = true;
      const result = await walk(setup().deps, input(graph));
      if (result.kind !== 'built') throw new Error(JSON.stringify(result));
      expect(ids(result.path)).toEqual(['in', 'sg', 'ro', 'n']);
    });

    it('a finish node reached by two paths inside the shared set runs once, after both', async () => {
      const { deps } = setup();
      const hook = (id: string) => node(id, 'core:notify-webhook', { url: `https://e.test/${id}` });
      const graph = fanned(
        [hook('w1'), hook('w2'), node('n', 'test:note')],
        [edge('w1', 'n'), edge('w2', 'n'), edge('ro', 'w1'), edge('ro', 'w2')],
      );
      const result = await walk(deps, input(graph));
      if (result.kind !== 'built') throw new Error(JSON.stringify(result));
      expect(ids(result.path)).toEqual(['in', 'a', 'ro', 'w1', 'w2', 'n']);
      expect(result.actions.filter((a) => a.kind === 'plugin')).toHaveLength(1);
    });

    it('a cycle inside the shared set fails the walk', async () => {
      const { deps } = setup();
      const hook = (id: string) => node(id, 'core:notify-webhook', { url: `https://e.test/${id}` });
      const graph = fanned(
        [hook('w1'), hook('w2'), node('l', 'test:lib')],
        [edge('w1', 'w2'), edge('w2', 'w1'), edge('ro', 'w1'), edge('ro', 'l')],
      );
      expect(await walk(deps, input(graph))).toMatchObject({
        kind: 'failed',
        reason: 'the workflow has a cycle',
      });
    });

    it('a bypassed finish node in the shared set is traced bypassed, runs nothing, and passes on', async () => {
      const { deps, trace } = setup();
      const graph = fanned(
        [
          node('w', 'core:notify-webhook', { url: 'https://e.test/w' }, { bypassed: true }),
          node('l', 'test:lib'),
          node('n', 'test:note'),
        ],
        [edge('w', 'n'), edge('ro', 'w')],
      );
      const result = await walk(deps, input(graph));
      if (result.kind !== 'built') throw new Error(JSON.stringify(result));
      expect(ids(result.path)).toEqual(['in', 'a', 'ro', 'l', 'w', 'n']);
      expect(result.actions.map((a) => a.kind)).toEqual(['replace', 'plugin', 'plugin']);
      expect(trace.filter((e) => e.nodeId === 'w').map((e) => [e.phase, e.reason])).toEqual([
        ['finish', 'bypassed'],
      ]);
      expectCovered(result.path, trace);
    });

    it('an action behind a finish node on a shared output fails the walk', async () => {
      const { deps } = setup();
      const graph = fanned(
        [node('l', 'test:lib'), node('w', 'core:notify-webhook', { url: 'https://e.test/' })],
        [edge('w', 'b'), edge('ro', 'w')],
      );
      graph.nodes.push(node('b', 'test:act', { arg: 'y' }));
      expect(await walk(deps, input(graph))).toMatchObject({
        kind: 'failed',
        nodeId: 'b',
        reason: 'Act comes after a finish node; only finish nodes may follow one',
      });
    });

    it('a Run node\u2019s output may feed several finish nodes; a shared output in the sub-workflow may not', async () => {
      const ok = subGraph(
        [node('ca', 'test:act', { arg: 'c' })],
        [edge('start', 'ca'), edge('ca', 'end')],
      );
      const split = subGraph(
        [node('ca', 'test:act', { arg: 'c' }), node('cb', 'test:act', { arg: 'd' })],
        [edge('start', 'ca'), edge('start', 'cb'), edge('ca', 'end'), edge('cb', 'end')],
      );
      const { deps } = setup({
        children: { ok: { name: 'Ok', graph: ok }, split: { name: 'Split', graph: split } },
      });
      const parent = (id: string) =>
        mainGraph(
          [
            node('in', 'core:input-manual'),
            node('r', 'core:run-subworkflow', { subworkflowId: id, version: 1, overrides: {} }),
            node('ro', 'core:replace-original'),
            node('n', 'test:note'),
            node('l', 'test:lib'),
          ],
          [edge('in', 'r'), edge('r', 'ro'), edge('ro', 'n'), edge('ro', 'l')],
        );
      const result = await walk(deps, input(parent('ok')));
      if (result.kind !== 'built') throw new Error(JSON.stringify(result));
      expect(result.path.map(at)).toEqual(['in', 'r', 'r/start', 'r/ca', 'r/end', 'ro', 'l', 'n']);
      expect(await walk(deps, input(parent('split')))).toMatchObject({
        kind: 'failed',
        nodeId: 'start',
        workflowPath: ['r'],
        reason: 'output file has 2 connections; only finish steps can share an output',
      });
    });
  });

  it('collects finish actions in path order', async () => {
    const { deps } = setup();
    const graph = mainGraph(
      [
        node('in', 'core:input-manual'),
        node('a', 'test:act', { arg: 'x' }),
        node('f', 'test:fin', { percent: 15 }),
        node('ro', 'core:replace-original'),
        node('f2', 'test:fin', { percent: 30 }),
      ],
      [edge('in', 'a'), edge('a', 'f'), edge('f', 'ro'), edge('ro', 'f2')],
    );
    const result = await walk(deps, input(graph));
    if (result.kind !== 'built') throw new Error(JSON.stringify(result));
    expect(result.actions).toEqual([
      { kind: 'size-gate', minSavingPercent: 15 },
      { kind: 'replace', recycleFolder: null },
      { kind: 'size-gate', minSavingPercent: 30 },
    ]);
  });

  describe('size gate else', () => {
    const notify = (id: string) =>
      node(id, 'core:notify-webhook', { url: 'https://example.test/h' });
    const gated = (elseNodes: ReturnType<typeof node>[] = [notify('nw')], connect = true) =>
      mainGraph(
        [
          node('in', 'core:input-manual'),
          node('sg', 'core:size-gate', { minSavingPercent: 20 }),
          node('ro', 'core:replace-original'),
          notify('after'),
          ...elseNodes,
        ],
        [
          edge('in', 'sg'),
          edge('sg', 'ro', { from: 'pass' }),
          edge('ro', 'after'),
          ...(connect && elseNodes[0] ? [edge('sg', elseNodes[0].id, { from: 'else' })] : []),
          ...elseNodes.slice(1).map((n, i) => edge((elseNodes[i] as { id: string }).id, n.id)),
        ],
      );

    it('the path follows pass; the else chain is walked apart, per gate', async () => {
      const { deps } = setup();
      const decided = await walkDecide(deps, input(gated([notify('n1'), notify('n2')])));
      if (decided.kind !== 'decided') throw new Error(JSON.stringify(decided));
      expect(ids(decided.nodes)).toEqual(['in', 'sg', 'ro', 'after']);
      expect(decided.nodes.find((n) => n.nodeId === 'sg')?.port).toBe('pass');
      expect([...decided.elseNodes].map(([gate, refs]) => [gate, ids(refs)])).toEqual([
        ['sg', ['n1', 'n2']],
      ]);
    });

    it('builds the else actions apart from the pass actions and traces the else steps', async () => {
      const { deps, trace } = setup();
      const result = await walk(deps, input(gated()));
      if (result.kind !== 'built') throw new Error(JSON.stringify(result));
      expect(result.actions.map((a) => a.kind)).toEqual(['size-gate', 'replace', 'notify']);
      expect(result.gates).toEqual([
        {
          nodeId: 'sg',
          actionIndex: 0,
          elseActions: [{ kind: 'notify', url: 'https://example.test/h', method: 'POST' }],
          elsePath: [{ workflowPath: [], nodeId: 'nw', port: 'file' }],
        },
      ]);
      expect(ids(result.path)).toEqual(['in', 'sg', 'ro', 'after']);
      expect(trace.filter((e) => e.nodeId === 'nw').map((e) => [e.phase, e.reason])).toEqual([
        ['finish', 'notify webhook (POST)'],
      ]);
    });

    it('an unconnected else, or a bypassed gate, has an empty else chain', async () => {
      const { deps } = setup();
      const plain = await walk(deps, input(gated([], false)));
      if (plain.kind !== 'built') throw new Error(JSON.stringify(plain));
      expect(plain.gates).toEqual([
        { nodeId: 'sg', actionIndex: 0, elseActions: [], elsePath: [] },
      ]);
      const bypassed = gated();
      const sg = bypassed.nodes.find((n) => n.id === 'sg');
      if (sg) sg.bypassed = true;
      const result = await walk(deps, input(bypassed));
      if (result.kind !== 'built') throw new Error(JSON.stringify(result));
      expect(result.gates).toEqual([]);
      expect(result.actions.map((a) => a.kind)).toEqual(['replace', 'notify']);
    });

    it('several finish nodes on else, or on pass, run in phase order', async () => {
      const { deps } = setup();
      const graph = mainGraph(
        [
          node('in', 'core:input-manual'),
          node('sg', 'core:size-gate', { minSavingPercent: 20 }),
          node('ro', 'core:replace-original'),
          node('pn', 'test:note'),
          node('pl', 'test:lib'),
          node('en', 'test:note'),
          node('em', 'test:media'),
        ],
        [
          edge('in', 'sg'),
          edge('sg', 'ro', { from: 'pass' }),
          edge('sg', 'pn', { from: 'pass' }),
          edge('sg', 'pl', { from: 'pass' }),
          edge('sg', 'en', { from: 'else' }),
          edge('sg', 'em', { from: 'else' }),
        ],
      );
      const result = await walk(deps, input(graph));
      if (result.kind !== 'built') throw new Error(JSON.stringify(result));
      expect(ids(result.path)).toEqual(['in', 'sg', 'ro', 'pl', 'pn']);
      expect(result.actions.map((a) => a.kind)).toEqual([
        'size-gate',
        'replace',
        'plugin',
        'plugin',
      ]);
      expect(result.gates).toEqual([
        {
          nodeId: 'sg',
          actionIndex: 0,
          elseActions: [
            { kind: 'plugin', description: 'test:media', required: false },
            { kind: 'plugin', description: 'test:note', required: false },
          ],
          elsePath: [
            { workflowPath: [], nodeId: 'em', port: null },
            { workflowPath: [], nodeId: 'en', port: null },
          ],
        },
      ]);
    });

    it('an action sharing the else output with a finish node fails the walk at the action', async () => {
      const { deps } = setup();
      const graph = gated([notify('n1')]);
      graph.nodes.push(node('x', 'test:act', { arg: 'x' }));
      graph.edges.push(edge('sg', 'x', { from: 'else' }));
      expect(await walk(deps, input(graph))).toMatchObject({
        kind: 'failed',
        nodeId: 'x',
        reason: 'only finish steps can follow the size gate\u2019s No branch',
      });
    });

    it('a write step on the else chain fails the walk (validation forbids it; defence in depth)', async () => {
      const { deps, trace } = setup();
      const result = await walk(deps, input(gated([node('rb', 'core:replace-original')])));
      expect(result).toMatchObject({
        kind: 'failed',
        nodeId: 'rb',
        reason: expect.stringContaining('No branch'),
      });
      expect(trace.at(-1)).toMatchObject({ nodeId: 'rb', phase: 'finish' });
      expect(trace.at(-1)?.reason).toMatch(/^failed: .*No branch/);
    });
  });

  describe('plugin nodes', () => {
    const meta = {
      type: 'example:notify',
      version: 1,
      kind: 'finish' as const,
      title: 'Example notify',
      description: 'A plugin finish node.',
      icon: 'bell',
      inputs: [filePort],
      outputs: [filePort],
      settingsSchema: { type: 'object', properties: { room: { type: 'string', default: 'a' } } },
      onNodeSettings: [],
      requires: {},
      migrations: [],
      finishPhase: 'notify' as const,
      hooks: ['finish' as const],
    };

    function pluginSetup(hooks: RemoteHooks) {
      const s = setup();
      const def = remoteNodeDefinition(
        meta,
        { kind: 'plugin', name: 'example', version: '1.0.0' },
        hooks,
        { callTimeoutMs: 1000, finishRunTimeoutMs: 2000 },
      );
      s.deps.registry.add([{ def, source: { kind: 'plugin', name: 'example', version: '1.0.0' } }]);
      return s;
    }
    const graph = mainGraph(
      [
        node('in', 'core:input-manual'),
        node('ro', 'core:replace-original'),
        node('pn', 'example:notify', { room: 'b' }),
      ],
      [edge('in', 'ro'), edge('ro', 'pn')],
    );

    it('stamps a plugin finish action with its phase and origin and marks the trace entry', async () => {
      const { deps, trace } = pluginSetup({
        async call() {
          return {
            ok: true,
            result: {
              actions: [{ kind: 'plugin', description: 'tell room b', required: false }],
              reason: 'queued',
            },
          };
        },
      });
      const result = await walk(deps, input(graph));
      if (result.kind !== 'built') throw new Error(JSON.stringify(result));
      expect(result.actions).toEqual([
        { kind: 'replace', recycleFolder: null },
        {
          kind: 'plugin',
          description: 'tell room b',
          required: false,
          phase: 'notify',
          nodeType: 'example:notify',
          nodeVersion: 1,
          nodeId: 'pn',
          workflowPath: [],
          settings: { room: 'b' },
        },
      ]);
      expect(trace.filter((e) => e.nodeId === 'pn').map((e) => e.source)).toEqual(['plugin']);
      expect(trace.filter((e) => e.nodeId === 'ro').map((e) => e.source)).toEqual(['core']);
    });

    it('a plugin node pinned to an older version goes to the host as stored, with its version, and is not parsed against the new schema', async () => {
      const seen: Array<{ version: number; settings: unknown }> = [];
      const s = setup();
      const source = { kind: 'plugin', name: 'example', version: '1.0.0' } as const;
      const def = remoteNodeDefinition(
        {
          ...meta,
          version: 3,
          migrations: [
            { from: 1, to: 2, risk: 'safe' as const, note: 'a' },
            { from: 2, to: 3, risk: 'safe' as const, note: 'b' },
          ],
        },
        source,
        {
          async call(_hook, _type, version, _ctx, settings) {
            seen.push({ version, settings });
            return {
              ok: true,
              result: {
                actions: [{ kind: 'plugin', description: 'd', required: false }],
                reason: 'ok',
              },
            };
          },
        },
        { callTimeoutMs: 1000, finishRunTimeoutMs: 2000 },
      );
      s.deps.registry.add([{ def, source }]);
      // `room: 5` is not a string: the v3 schema would refuse it before the host could migrate it.
      const old = mainGraph(
        [
          node('in', 'core:input-manual'),
          node('ro', 'core:replace-original'),
          node('pn', 'example:notify', { room: 5 }, { typeVersion: 1 }),
        ],
        [edge('in', 'ro'), edge('ro', 'pn')],
      );
      const result = await walk(s.deps, input(old));
      expect(result.kind).toBe('built');
      expect(seen).toEqual([{ version: 1, settings: { room: 5 } }]);
      if (result.kind !== 'built') return;
      expect(result.actions[1]).toMatchObject({ nodeVersion: 1, settings: { room: 5 } });
    });

    it('a pinned older plugin node whose path has a behaviour step fails the node (defence in depth: validation holds it first)', async () => {
      const s = setup();
      const source = { kind: 'plugin', name: 'example', version: '1.0.0' } as const;
      let called = false;
      const def = remoteNodeDefinition(
        {
          ...meta,
          version: 2,
          migrations: [{ from: 1, to: 2, risk: 'behaviour' as const, note: 'b' }],
        },
        source,
        {
          async call() {
            called = true;
            return { ok: true, result: { actions: [], reason: 'ok' } };
          },
        },
        { callTimeoutMs: 1000, finishRunTimeoutMs: 2000 },
      );
      s.deps.registry.add([{ def, source }]);
      const old = mainGraph(
        [
          node('in', 'core:input-manual'),
          node('ro', 'core:replace-original'),
          node('pn', 'example:notify', { room: 'b' }, { typeVersion: 1 }),
        ],
        [edge('in', 'ro'), edge('ro', 'pn')],
      );
      // Like invalid settings of a core node: the walk throws, the node never runs.
      await expect(walk(s.deps, input(old))).rejects.toThrow('plugin update changes behaviour');
      expect(called).toBe(false);
    });

    it('a retryable remote failure is a retryable walk failure; a plain one is not', async () => {
      for (const retryable of [true, false]) {
        const { deps } = pluginSetup({
          async call() {
            return { ok: false, error: { message: 'plugin example crashed', retryable } };
          },
        });
        const result = await walk(deps, input(graph));
        expect(result).toMatchObject({
          kind: 'failed',
          nodeId: 'pn',
          reason: 'plugin example crashed',
          retryable,
        });
      }
    });

    describe('input files', () => {
      const actionMeta = {
        type: 'example:subs',
        version: 1,
        kind: 'action' as const,
        title: 'Example subs',
        description: 'A plugin build node.',
        icon: 'cc',
        inputs: [filePort],
        outputs: [filePort],
        settingsSchema: { type: 'object', properties: {} },
        onNodeSettings: [],
        requires: {},
        migrations: [],
        finishPhase: null,
        hooks: ['build' as const],
      };
      const buildGraph = mainGraph(
        [
          node('in', 'core:input-manual'),
          node('pa', 'example:subs'),
          node('ro', 'core:replace-original'),
        ],
        [edge('in', 'pa'), edge('pa', 'ro')],
      );
      const WRONG = 'plugin build hooks cannot change input files';

      /** A plugin whose build hook returns the model it was given, changed by `edit`. */
      function pluginBuild(edit: (model: BuildModel) => BuildModel) {
        const s = setup();
        const def = remoteNodeDefinition(
          actionMeta,
          { kind: 'plugin', name: 'example', version: '1.0.0' },
          {
            async call(_hook, _type, _version, ctx) {
              const { model } = ctx as unknown as { model: BuildModel };
              return {
                ok: true,
                result: JSON.parse(JSON.stringify({ model: edit(model), reason: 'changed' })),
              };
            },
          },
          { callTimeoutMs: 1000, finishRunTimeoutMs: 2000 },
        );
        s.deps.registry.add([
          { def, source: { kind: 'plugin', name: 'example', version: '1.0.0' } },
        ]);
        return s;
      }

      it('a plugin build hook cannot change input files', async () => {
        const evil = (model: BuildModel): BuildModel =>
          withSidecar(model, 1, 'passwd.srt', { add: false, afterReplace: 'keep' });
        const { deps, trace } = pluginBuild((m) => {
          const out = evil(m);
          (out.extraInputs?.[0] as { path: string }).path = '/etc/passwd';
          return out;
        });
        const result = await walk(deps, input(buildGraph));
        expect(result).toMatchObject({
          kind: 'failed',
          nodeId: 'pa',
          reason: WRONG,
          retryable: false,
        });
        expect(trace.at(-1)).toMatchObject({ nodeId: 'pa', reason: `failed: ${WRONG}` });
      });

      it('a plugin build hook cannot add or re-point an extra stream either', async () => {
        for (const edit of [
          (m: BuildModel) => withSidecar(m, 1, 'x.srt'),
          (m: BuildModel) => ({
            ...m,
            streams: m.streams.map((s, i) => (i === 1 ? { ...s, input: 1 } : s)),
          }),
        ]) {
          const { deps } = pluginBuild(edit);
          expect(await walk(deps, input(buildGraph))).toMatchObject({
            kind: 'failed',
            nodeId: 'pa',
            reason: WRONG,
          });
        }
      });

      it('a plugin build hook that leaves the input files alone passes', async () => {
        const { deps } = pluginBuild((m) => ({ ...m, globalArgs: [...m.globalArgs, '-x'] }));
        expect(await walk(deps, input(buildGraph))).toMatchObject({ kind: 'built' });
      });

      it('a plugin build hook may edit a stream that comes from an extra input', async () => {
        const addSub = defineNode({
          type: 'test:add-sub',
          version: 1,
          kind: 'action',
          title: 'Add sub',
          description: 'Adds a sidecar like core:embed-sidecar-subtitles will.',
          icon: 'test',
          inputs: [filePort],
          outputs: [filePort],
          settings: z.object({}),
          async build(ctx) {
            return { model: withSidecar(ctx.model, 1, 'Show.de.srt'), reason: 'added a sidecar' };
          },
        });
        const s = pluginBuild((m) => ({
          ...m,
          streams: m.streams.map((st) => (st.input === 1 ? { ...st, default: true } : st)),
        }));
        s.deps.registry.add([{ def: addSub, source: { kind: 'core' } }]);
        const graph = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('cs', 'test:add-sub'),
            node('pa', 'example:subs'),
            node('ro', 'core:replace-original'),
          ],
          [edge('in', 'cs'), edge('cs', 'pa'), edge('pa', 'ro')],
        );
        const result = await walk(s.deps, input(graph));
        if (result.kind !== 'built') throw new Error(JSON.stringify(result));
        expect(result.model.extraInputs).toHaveLength(1);
        expect(result.model.streams.find((st) => st.input === 1)?.default).toBe(true);
      });

      const addTwo = defineNode({
        type: 'test:add-two',
        version: 1,
        kind: 'action',
        title: 'Add two',
        description: 'Adds two sidecars and leaves a dropped source stream.',
        icon: 'test',
        inputs: [filePort],
        outputs: [filePort],
        settings: z.object({}),
        async build(ctx) {
          let model = withSidecar(ctx.model, 1, 'Show.de.srt');
          model = withSidecar(model, 2, 'Show.en.srt', { language: 'eng' });
          return {
            model: {
              ...model,
              streams: model.streams.map((st) =>
                st.sourceIndex === 1 ? { ...st, keep: false } : st,
              ),
            },
            reason: 'added sidecars',
          };
        },
      });
      const twoGraph = mainGraph(
        [
          node('in', 'core:input-manual'),
          node('cs', 'test:add-two'),
          node('pa', 'example:subs'),
          node('ro', 'core:replace-original'),
        ],
        [edge('in', 'cs'), edge('cs', 'pa'), edge('pa', 'ro')],
      );

      it('a plugin that re-sorts the streams, or removes a dropped source stream, is not a change', async () => {
        for (const edit of [
          (m: BuildModel): BuildModel => ({ ...m, streams: [...m.streams].reverse() }),
          (m: BuildModel): BuildModel => ({
            ...m,
            streams: m.streams.filter((st) => st.keep || st.input !== undefined),
          }),
        ]) {
          const s = pluginBuild(edit);
          s.deps.registry.add([{ def: addTwo, source: { kind: 'core' } }]);
          expect(await walk(s.deps, input(twoGraph))).toMatchObject({ kind: 'built' });
        }
      });

      it('a non-core node is guarded even when its definition has no settingsJsonSchema', async () => {
        const sneaky = defineNode({
          type: 'example:sneaky',
          version: 1,
          kind: 'action',
          title: 'Sneaky',
          description: 'A plugin-sourced local definition.',
          icon: 'test',
          inputs: [filePort],
          outputs: [filePort],
          settings: z.object({}),
          async build(ctx) {
            return { model: withSidecar(ctx.model, 1, 'x.srt'), reason: 'added' };
          },
        });
        const { deps } = setup();
        deps.registry.add([
          { def: sneaky, source: { kind: 'plugin', name: 'example', version: '1.0.0' } },
        ]);
        const graph = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('pa', 'example:sneaky'),
            node('ro', 'core:replace-original'),
          ],
          [edge('in', 'pa'), edge('pa', 'ro')],
        );
        expect(await walk(deps, input(graph))).toMatchObject({
          kind: 'failed',
          nodeId: 'pa',
          reason: WRONG,
        });
      });

      it('a core build hook may add input files', async () => {
        const addSub = defineNode({
          type: 'test:add-sub',
          version: 1,
          kind: 'action',
          title: 'Add sub',
          description: 'Adds a sidecar like core:embed-sidecar-subtitles will.',
          icon: 'test',
          inputs: [filePort],
          outputs: [filePort],
          settings: z.object({}),
          async build(ctx) {
            return { model: withSidecar(ctx.model, 1, 'Show.de.srt'), reason: 'added a sidecar' };
          },
        });
        const { deps } = setup();
        deps.registry.add([{ def: addSub, source: { kind: 'core' } }]);
        const graph = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('cs', 'test:add-sub'),
            node('ro', 'core:replace-original'),
          ],
          [edge('in', 'cs'), edge('cs', 'ro')],
        );
        const result = await walk(deps, input(graph));
        if (result.kind !== 'built') throw new Error(JSON.stringify(result));
        expect(result.model.extraInputs?.map((e) => e.label.file)).toEqual(['Show.de.srt']);
        expect(result.model.streams.filter((st) => st.input === 1)).toHaveLength(1);
      });
    });

    describe('an unavailable plugin entry', () => {
      const unavailableEntry = (def: AnyNodeDefinition) => ({
        def,
        source: { kind: 'plugin', name: 'example', version: '1.0.0' } as const,
        unavailable: () => 'plugin example is not running: exited with code 3',
      });
      const pluginAct = defineNode({
        type: 'example:act',
        version: 1,
        kind: 'action',
        title: 'Example act',
        description: 'd',
        icon: 'x',
        inputs: [filePort],
        outputs: [filePort],
        settings: z.object({}),
        async build(ctx) {
          return { model: ctx.model, reason: 'ran' };
        },
      });
      const pluginData = defineNode({
        type: 'example:lang',
        version: 1,
        kind: 'data',
        title: 'Example lang',
        description: 'd',
        icon: 'x',
        inputs: [],
        outputs: [{ id: 'language', label: 'Language', type: 'data:language' }],
        settings: z.object({}),
        async data() {
          return { value: 'jpn', reason: 'ran' };
        },
      });

      it('fails an action node instead of running it', async () => {
        const { deps, trace } = setup();
        deps.registry.add([unavailableEntry(pluginAct)]);
        const g = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('x', 'example:act'),
            node('f', 'test:fin', { percent: 1 }),
          ],
          [edge('in', 'x'), edge('x', 'f')],
        );
        const r = await walk(deps, input(g));
        expect(r).toMatchObject({
          kind: 'failed',
          nodeId: 'x',
          reason: "Example act can't run: plugin example is not running: exited with code 3",
          retryable: false,
        });
        expect(trace.at(-1)?.reason).toContain("failed: Example act can't run");
      });

      it('fails the walk at a data node, never resolving it to unknown', async () => {
        const { deps } = setup();
        deps.registry.add([unavailableEntry(pluginData)]);
        const g = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('d', 'example:lang'),
            node('c', 'test:cond'),
            node('f', 'test:fin', { percent: 1 }),
          ],
          [
            edge('in', 'c'),
            edge('c', 'f', { from: 'pass' }),
            edge('d', 'c', { from: 'language', to: 'language' }),
          ],
        );
        const r = await walk(deps, input(g));
        expect(r).toMatchObject({
          kind: 'failed',
          nodeId: 'd',
          reason: "Example lang can't run: plugin example is not running: exited with code 3",
        });
      });

      it('a bypassed unavailable node is skipped, and the trace says why', async () => {
        const { deps, trace } = setup();
        deps.registry.add([unavailableEntry(pluginAct)]);
        const g = mainGraph(
          [
            node('in', 'core:input-manual'),
            { ...node('x', 'example:act'), bypassed: true },
            node('f', 'test:fin', { percent: 1 }),
          ],
          [edge('in', 'x'), edge('x', 'f')],
        );
        const r = await walk(deps, input(g));
        expect(r.kind).toBe('built');
        expect(trace.find((e) => e.nodeId === 'x')?.reason).toBe(
          'bypassed (plugin example is not running: exited with code 3)',
        );
      });
    });

    it('a core node gets an inert plugin context; hooks see dryRun and the job', async () => {
      const seen: unknown[] = [];
      const probing = defineNode({
        type: 'test:ctx',
        version: 1,
        kind: 'action',
        title: 'Ctx',
        description: 'Records its plugin context.',
        icon: 'test',
        inputs: [filePort],
        outputs: [filePort],
        settings: z.object({}),
        async build(ctx) {
          seen.push(ctx.plugin.settings, ctx.plugin.dryRun, ctx.plugin.job);
          await expect(ctx.plugin.fetch({ url: 'https://example.test/' })).rejects.toBeInstanceOf(
            FetchRefused,
          );
          return { model: ctx.model, reason: 'ok' };
        },
      });
      const { deps } = setup();
      deps.registry.add([{ def: probing, source: { kind: 'core' } }]);
      const g = mainGraph(
        [node('in', 'core:input-manual'), node('x', 'test:ctx')],
        [edge('in', 'x')],
      );
      const r = await walk(deps, { ...input(g), dryRun: true, jobId: 'job-1' });
      expect(r.kind).toBe('built');
      expect(seen).toEqual([{}, true, { id: 'job-1', attempt: 2 }]);
    });
  });
});

describe('autoPicks', () => {
  const encodeGraph = (encoder: string) =>
    mainGraph(
      [
        node('in', 'core:input-manual'),
        node('e', 'core:encode-video', { encoder, skipIf: 'never' }),
      ],
      [edge('in', 'e')],
    );

  it('names the video stream an auto Encode video put on an encoder', async () => {
    const { deps } = setup();
    deps.capabilities = capsOf(['hevc_nvenc', 'libx265'], ['cuda']);
    const r = await walk(deps, input(encodeGraph('auto')));
    if (r.kind !== 'built') throw new Error(JSON.stringify(r));
    expect(r.autoPicks).toEqual([{ sourceIndex: 0, input: 0, encoder: 'hevc_nvenc' }]);
  });

  it('a named encoder is no auto pick', async () => {
    const { deps } = setup();
    deps.capabilities = capsOf(['hevc_nvenc', 'libx265'], ['cuda']);
    const r = await walk(deps, input(encodeGraph('hevc_nvenc')));
    if (r.kind !== 'built') throw new Error(JSON.stringify(r));
    expect(r.model.streams[0]?.encoder).toBe('hevc_nvenc');
    expect(r.autoPicks).toEqual([]);
  });
});
