import type { TraceEntry } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { runSubworkflow } from '../../nodes/core/subworkflow.ts';
import { edge, node, subGraph } from '../../workflows/testing.ts';
import { capsOf } from '../testing/builders.ts';
import { AT, at, brief, expectCovered, ids, input, mainGraph, NOW, setup } from './testing.ts';
import { walk, walkBuild, walkDecide } from './walk.ts';

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
