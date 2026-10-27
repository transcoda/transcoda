import type { WalkStep } from '@transcoda/contract';
import type { WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { catalogFixture } from '../../test/fixtures/catalog.ts';
import {
  ELSE_PATH,
  ELSE_TRACE,
  entry,
  PATH,
  RUNNING_TRACE,
  TRACE,
  traceMain,
  traceSub,
} from '../../test/fixtures/trace.ts';
import {
  buildTraceOverlay,
  currentNodeOf,
  decisions,
  encodeNode,
  runTitle,
  type TraceSource,
} from './traceOverlay.ts';

const done: TraceSource = { trace: TRACE, steps: PATH, jobState: 'done', currentNode: undefined };
const status = (o: ReturnType<typeof buildTraceOverlay>, id: string) => o.nodes.get(id)?.status;
const edge = (o: ReturnType<typeof buildTraceOverlay>, id: string) => o.edges.get(id);

describe('buildTraceOverlay', () => {
  it('marks the taken path from in → vi(pass) → run-a → ca → sg → ro-a and the else branch untaken', () => {
    const o = buildTraceOverlay(traceMain(), done, []);
    for (const id of ['in-vi', 'vi-run-a', 'run-a-ca', 'ca-sg', 'sg-ro-a']) {
      expect(edge(o, id), id).toMatchObject({ taken: true, untaken: false });
    }
    for (const id of ['vi-ev', 'ev-run-b', 'run-b-ro-b']) {
      expect(edge(o, id), id).toMatchObject({ taken: false, untaken: true });
    }
    for (const id of ['in', 'vi', 'run-a', 'ca', 'sg', 'ro-a'])
      expect(status(o, id), id).toBe('done');
    for (const id of ['ev', 'run-b', 'ro-b']) expect(status(o, id), id).toBe('untaken');
    expect(o.nodes.get('vi')).toMatchObject({ port: 'pass', findings: { codec: 'hevc' } });
    expect(o.nodes.get('sg')?.reason).toBe('this file: −33%, passes');
    expect(o.currentNodeId).toBeNull();
  });

  it('the last node is current while the job runs and done when final', () => {
    const running: TraceSource = {
      trace: RUNNING_TRACE,
      steps: PATH,
      jobState: 'building',
      currentNode: undefined,
    };
    const o = buildTraceOverlay(traceMain(), running, []);
    expect(o.currentNodeId).toBe('ca');
    expect(status(o, 'ca')).toBe('current');
    expect(status(o, 'vi')).toBe('done');
    // Decided but not built yet; the else branch is out of reach already.
    expect(status(o, 'sg')).toBe('pending');
    expect(status(o, 'ev')).toBe('pending');
    expect(edge(o, 'vi-ev')).toMatchObject({ untaken: true });
    // job.changed's currentNode wins over the trace.
    const lit = buildTraceOverlay(
      traceMain(),
      { ...running, currentNode: { workflowPath: [], nodeId: 'sg' } },
      [],
    );
    expect(lit.currentNodeId).toBe('sg');
    expect(status(lit, 'ca')).toBe('done');
    // Inside the sub-workflow, the Run node is the current node of the top level.
    const inside = buildTraceOverlay(
      traceMain(),
      { ...running, currentNode: { workflowPath: ['run-a'], nodeId: 'sdt' } },
      [],
    );
    expect(inside.currentNodeId).toBe('run-a');
    // currentNode null (replacing) lights nothing.
    expect(
      buildTraceOverlay(traceMain(), { ...running, currentNode: null }, []).currentNodeId,
    ).toBe(null);
    const final = buildTraceOverlay(traceMain(), { ...running, jobState: 'cancelled' }, []);
    expect(final.currentNodeId).toBeNull();
    expect(status(final, 'ca')).toBe('done');
  });

  it('a Run node counts as done from its child entries and the child overlay with path ["run-a"] marks keep/sdt/rt done', () => {
    const o = buildTraceOverlay(traceMain(), done, []);
    expect(status(o, 'run-a')).toBe('done');
    const child = buildTraceOverlay(traceSub(), done, ['run-a']);
    for (const id of ['start', 'keep', 'sdt', 'rt', 'end'])
      expect(status(child, id), id).toBe('done');
    expect(child.nodes.get('keep')?.reason).toBe('kept en, de, tr, original, untagged');
    for (const id of ['start-keep', 'keep-sdt', 'sdt-rt', 'rt-end']) {
      expect(edge(child, id)?.taken, id).toBe(true);
    }
    // run-b took no path: its child overlay is all untaken.
    const other = buildTraceOverlay(traceSub(), done, ['run-b']);
    expect(status(other, 'keep')).toBe('untaken');
  });

  it('data edge labels come from findings by output port', () => {
    const graph: WorkflowGraph = {
      ...traceMain(),
      nodes: [
        ...traceMain().nodes,
        {
          id: 'ol',
          type: 'test:original-language',
          typeVersion: 1,
          settings: {},
          position: { x: 0, y: 0 },
        },
      ],
      edges: [
        ...traceMain().edges,
        {
          id: 'ol-sg',
          from: { node: 'ol', port: 'language' },
          to: { node: 'sg', port: 'language' },
        },
        { id: 'ol-ca', from: { node: 'ol', port: 'tags' }, to: { node: 'ca', port: 'tags' } },
      ],
    };
    const trace = [
      ...TRACE,
      entry(12, 'ol', 'data', null, 'Sonarr says Japanese', {
        findings: { language: 'ja', tags: ['a', 'b'] },
      }),
    ];
    const o = buildTraceOverlay(graph, { ...done, trace }, []);
    expect(edge(o, 'ol-sg')?.value).toBe('ja');
    expect(edge(o, 'ol-ca')?.value).toBe('["a","b"]');
    expect(edge(o, 'in-vi')?.value).toBeNull();
    expect(status(o, 'ol')).toBe('done');
  });

  it('attempt 2 wins and marks the node retried', () => {
    const trace = [
      ...TRACE.slice(0, 9),
      entry(10, 'sg', 'finish', null, 'failed: output 4 s shorter'),
      entry(11, 'in', 'pass', 'file', 'start: Manual input', { attempt: 2 }),
      entry(12, 'sg', 'finish', 'file', 'this file: −30%, passes', { attempt: 2 }),
    ];
    const o = buildTraceOverlay(traceMain(), { ...done, trace }, []);
    expect(o.nodes.get('sg')).toMatchObject({
      status: 'done',
      attempt: 2,
      retried: true,
      reason: 'this file: −30%, passes',
    });
    expect(o.nodes.get('vi')).toMatchObject({ attempt: 1, retried: false });
  });

  it('the last failed: entry of a node is authoritative and the path stops there', () => {
    const steps: WalkStep[] = PATH.slice(0, 2);
    const trace = [
      entry(1, 'in', 'pass', 'file', 'start: Manual input'),
      entry(2, 'vi', 'decide', null, 'failed: probe has no video stream'),
    ];
    const o = buildTraceOverlay(
      traceMain(),
      { trace, steps, jobState: 'failed', currentNode: null },
      [],
    );
    expect(o.nodes.get('vi')).toMatchObject({
      status: 'failed',
      reason: 'failed: probe has no video stream',
    });
    expect(edge(o, 'in-vi')?.taken).toBe(true);
    expect(edge(o, 'vi-run-a')).toMatchObject({ taken: false, untaken: true });
    expect(status(o, 'run-a')).toBe('untaken');
  });
});

describe('decisions', () => {
  it('lists entries in trace order with titles, depth and findings; Start/End are left out', () => {
    const children = new Map([['run-a', traceSub()]]);
    const list = decisions(TRACE, traceMain(), catalogFixture, children);
    expect(list.map((d) => `${d.title} · ${d.reason}`)).toEqual([
      'Manual input · start: Manual input',
      'Video is · already HEVC ≤ 8 Mb/s',
      'Run sub-workflow · enters sub-workflow Language cleanup v3',
      'Keep languages · kept en, de, tr, original, untagged',
      'Set default track · audio English (was Turkish)',
      'Reorder tracks · English then German first',
      'Cover and attachments · cover kept',
      'Size gate · this file: −33%, passes',
      'Replace original · original → recycle folder',
    ]);
    const keep = list.find((d) => d.nodeId === 'keep');
    expect(keep).toMatchObject({ depth: 1, workflowPath: ['run-a'], attempt: 1 });
    expect(list[1]?.findings).toEqual({ codec: 'hevc' });
  });

  it('follows the walk when the engine traced a Run node before an action ahead of it (else branch)', () => {
    // As the engine writes it: decide phase (trigger, condition, Run node, sub Start/End), then the
    // build phase along the path (encode first, then the sub-workflow's actions).
    const subB = { workflowPath: ['run-b'] };
    const trace = [
      entry(1, 'in', 'pass', 'file', 'start: Manual input'),
      entry(2, 'vi', 'decide', 'else', 'video is h264 360p, wanted hevc → else'),
      entry(3, 'run-b', 'pass', 'file', 'enters sub-workflow Language cleanup v3'),
      entry(4, 'start', 'pass', 'file', 'start', subB),
      entry(5, 'end', 'pass', 'file', 'returns', subB),
      entry(6, 'ev', 'build', 'file', 'video h264 → hevc'),
      entry(7, 'keep', 'build', 'file', 'kept eng, deu', subB),
      entry(8, 'ro-b', 'finish', 'file', 'original → recycle folder'),
    ];
    const steps: WalkStep[] = [
      { workflowPath: [], nodeId: 'in', port: 'file' },
      { workflowPath: [], nodeId: 'vi', port: 'else' },
      { workflowPath: [], nodeId: 'ev', port: 'file' },
      { workflowPath: [], nodeId: 'run-b', port: 'file' },
      { workflowPath: ['run-b'], nodeId: 'start', port: 'file' },
      { workflowPath: ['run-b'], nodeId: 'keep', port: 'file' },
      { workflowPath: ['run-b'], nodeId: 'end', port: 'file' },
      { workflowPath: [], nodeId: 'ro-b', port: 'file' },
    ];
    const children = new Map([['run-b', traceSub()]]);
    const list = decisions(trace, traceMain(), catalogFixture, children, steps);
    expect(list.map((d) => `${d.depth} ${d.title}`)).toEqual([
      '0 Manual input',
      '0 Video is',
      '0 Encode video',
      '0 Run sub-workflow',
      '1 Keep languages',
      '0 Replace original',
    ]);
    // Without the walk the trace order stands.
    expect(decisions(trace, traceMain(), catalogFixture, children)[2]?.title).toBe(
      'Run sub-workflow',
    );
  });

  it('uses a node label and falls back to the node id when the graph is unknown', () => {
    const graph = traceMain();
    const vi = graph.nodes.find((n) => n.id === 'vi');
    if (vi) vi.label = 'HEVC already?';
    const list = decisions(TRACE, graph, catalogFixture, new Map());
    expect(list[1]?.title).toBe('HEVC already?');
    expect(list.find((d) => d.nodeId === 'keep')?.title).toBe('keep');
  });
});

describe('encodeNode', () => {
  const children = new Map([['run-b', traceSub()]]);

  it('is the Encode video on the walk, not the Run node whose actions were built after it', () => {
    expect(encodeNode(ELSE_PATH, traceMain(), children)).toEqual({
      workflowPath: [],
      nodeId: 'ev',
    });
  });

  it('is null on a path without an encoding node, and a bypassed Encode video does not count', () => {
    expect(encodeNode(PATH, traceMain(), new Map([['run-a', traceSub()]]))).toBeNull();
    const graph = traceMain();
    const ev = graph.nodes.find((n) => n.id === 'ev');
    if (ev) ev.bypassed = true;
    expect(encodeNode(ELSE_PATH, graph, children)).toBeNull();
  });
});

describe('currentNodeOf', () => {
  const running = (over: Partial<TraceSource>): TraceSource => ({
    trace: ELSE_TRACE.slice(0, 9),
    steps: ELSE_PATH,
    jobState: 'encoding',
    currentNode: undefined,
    ...over,
  });

  it('is the reported node, else the last traced one; none while queued or final', () => {
    const at = { workflowPath: ['run-b'], nodeId: 'rt' };
    expect(currentNodeOf(running({ currentNode: at }))).toEqual(at);
    expect(currentNodeOf(running({ currentNode: null }))).toBeNull();
    expect(currentNodeOf(running({}))).toEqual(at);
    expect(currentNodeOf(running({ jobState: 'queued' }))).toBeNull();
    expect(currentNodeOf(running({ jobState: 'done' }))).toBeNull();
  });
});

describe('runTitle', () => {
  it("is the Run node's label, else the sub-workflow's name, else the node type's title", () => {
    const names = new Map([['run-b', 'Language cleanup']]);
    const graph = traceMain();
    expect(runTitle(['run-b'], graph, new Map(), catalogFixture, names)).toBe('Language cleanup');
    expect(runTitle(['run-b'], graph, new Map(), catalogFixture, new Map())).toBe(
      'Run sub-workflow',
    );
    const run = graph.nodes.find((n) => n.id === 'run-b');
    if (run) run.label = 'Languages';
    expect(runTitle(['run-b'], graph, new Map(), catalogFixture, names)).toBe('Languages');
  });

  it('decisions inside a sub-workflow say which one they are in', () => {
    const children = new Map([['run-b', traceSub()]]);
    const names = new Map([['run-b', 'Language cleanup']]);
    const list = decisions(ELSE_TRACE, traceMain(), catalogFixture, children, ELSE_PATH, names);
    expect(list.find((d) => d.nodeId === 'keep')?.within).toBe('Language cleanup');
    expect(list.find((d) => d.nodeId === 'ev')?.within).toBeNull();
  });
});

describe('plugin trace entries', () => {
  const plugin = TRACE.map((e) => (e.nodeId === 'sg' ? { ...e, source: 'plugin' as const } : e));

  it('flag the node and its decision, and only those', () => {
    const o = buildTraceOverlay(traceMain(), { ...done, trace: plugin }, []);
    expect(o.nodes.get('sg')?.plugin).toBe(true);
    expect(o.nodes.get('vi')?.plugin).toBeUndefined();
    const items = decisions(plugin, traceMain(), catalogFixture, new Map(), PATH);
    expect(items.filter((d) => d.plugin).map((d) => d.nodeId)).toEqual(['sg']);
  });
});

describe('size gate pass and else', () => {
  const nodeOf = (id: string, type: string, typeVersion = 1) => ({
    id,
    type,
    typeVersion,
    settings: {},
    position: { x: 0, y: 0 },
  });
  const link = (from: string, to: string, port = 'file') => ({
    id: `${from}-${to}`,
    from: { node: from, port },
    to: { node: to, port: 'file' },
  });
  /** in → sg; sg.pass → ro → np (notify); sg.else → ne (notify). */
  const graph = (): WorkflowGraph => ({
    formatVersion: 2,
    kind: 'workflow',
    nodes: [
      nodeOf('in', 'core:input-manual'),
      nodeOf('sg', 'core:size-gate', 2),
      nodeOf('ro', 'core:replace-original'),
      nodeOf('np', 'core:notify-webhook'),
      nodeOf('ne', 'core:notify-webhook'),
    ],
    edges: [link('in', 'sg'), link('sg', 'ro', 'pass'), link('ro', 'np'), link('sg', 'ne', 'else')],
    groups: [],
  });
  const built = [
    entry(1, 'in', 'pass', 'file', 'start: Manual input'),
    entry(2, 'sg', 'finish', 'pass', 'size gate: at least 20% smaller'),
    entry(3, 'ro', 'finish', 'file', 'replace the original'),
    entry(4, 'np', 'finish', 'file', 'notify webhook (POST)'),
    entry(5, 'ne', 'finish', 'file', 'notify webhook (POST)'),
  ];
  const step = (nodeId: string, port: string): WalkStep => ({ workflowPath: [], nodeId, port });
  const elseTrace = [
    ...built,
    entry(6, 'sg', 'finish', 'else', 'Size gate: saved 2.9%, below 20% → else'),
  ];
  const elseSteps = [step('in', 'file'), step('sg', 'else'), step('ne', 'file')];
  const passTrace = [
    ...built,
    entry(6, 'sg', 'finish', 'pass', 'Size gate: saved 30.0%, at least 20% → pass'),
  ];
  const passSteps = [
    step('in', 'file'),
    step('sg', 'pass'),
    step('ro', 'file'),
    step('np', 'file'),
  ];
  const src = (trace: typeof built, steps: WalkStep[], jobState: 'kept_original' | 'done') =>
    ({ trace, steps, jobState, currentNode: undefined }) satisfies TraceSource;

  it('else taken: the else edge and node are taken, the pass chain is untaken, the gate reads its decision', () => {
    const o = buildTraceOverlay(graph(), src(elseTrace, elseSteps, 'kept_original'), []);
    expect(edge(o, 'sg-ne')).toMatchObject({ taken: true, untaken: false });
    expect(edge(o, 'sg-ro')).toMatchObject({ taken: false, untaken: true });
    expect(status(o, 'ne')).toBe('done');
    expect(status(o, 'ro')).toBe('untaken');
    expect(status(o, 'np')).toBe('untaken');
    expect(o.nodes.get('sg')).toMatchObject({
      status: 'done',
      port: 'else',
      reason: 'Size gate: saved 2.9%, below 20% → else',
    });
  });

  it('pass taken: the pass chain is taken and the else node untaken', () => {
    const o = buildTraceOverlay(graph(), src(passTrace, passSteps, 'done'), []);
    expect(edge(o, 'sg-ro')).toMatchObject({ taken: true });
    expect(edge(o, 'sg-ne')).toMatchObject({ taken: false, untaken: true });
    expect(status(o, 'ne')).toBe('untaken');
    expect(status(o, 'np')).toBe('done');
  });

  it('a dry run depends on the result: both branches are shown as possible', () => {
    const dry = [
      ...built,
      entry(6, 'sg', 'finish', null, 'Size gate: depends on the result (below 20% → else)'),
    ];
    const steps = [
      step('in', 'file'),
      { ...step('sg', 'file'), port: null },
      step('ro', 'file'),
      step('np', 'file'),
      step('ne', 'file'),
    ];
    const o = buildTraceOverlay(graph(), src(dry, steps, 'kept_original'), []);
    expect(edge(o, 'sg-ro')).toMatchObject({ taken: true, untaken: false });
    expect(edge(o, 'sg-ne')).toMatchObject({ taken: true, untaken: false });
    expect(status(o, 'ne')).toBe('done');
    expect(status(o, 'np')).toBe('done');
  });

  it('a gate the job never reached (failed earlier): neither branch is dimmed or taken', () => {
    const failed = built;
    const o = buildTraceOverlay(graph(), src(failed, passSteps, 'kept_original'), []);
    expect(status(o, 'ne')).toBe('pending');
    expect(edge(o, 'sg-ne')).toMatchObject({ taken: false, untaken: false });
    const none = new Map();
    const list = decisions(failed, graph(), catalogFixture, none, passSteps, none, true);
    expect(list.filter((d) => d.untaken)).toEqual([]);
    expect(list.every((d) => d.branch === null)).toBe(true);
  });

  it('branches come from the decision entry (port), not from its wording', () => {
    const none = new Map();
    const odd = [...built, entry(6, 'sg', 'finish', 'else', 'whatever the engine says')];
    const list = decisions(odd, graph(), catalogFixture, none, elseSteps, none, true);
    expect(list.filter((d) => d.branch).map((d) => [d.nodeId, d.branch])).toEqual([['sg', 'else']]);
  });

  it('decisions dim the finish steps off the settled walk, and only then', () => {
    const none = new Map();
    const dimmed = (list: ReturnType<typeof decisions>) =>
      list.filter((d) => d.untaken).map((d) => d.nodeId);
    const settledElse = decisions(elseTrace, graph(), catalogFixture, none, elseSteps, none, true);
    expect(dimmed(settledElse)).toEqual(['ro', 'np']);
    const settledPass = decisions(passTrace, graph(), catalogFixture, none, passSteps, none, true);
    expect(dimmed(settledPass)).toEqual(['ne']);
    // While the job runs the branch is not known: nothing is dimmed.
    expect(dimmed(decisions(built, graph(), catalogFixture, none, passSteps, none, false))).toEqual(
      [],
    );
    // A dry run lists both branches on its walk: nothing is dimmed.
    const dry = decisions(
      built,
      graph(),
      catalogFixture,
      none,
      [...passSteps, step('ne', 'file')],
      none,
      true,
    );
    expect(dimmed(dry)).toEqual([]);
    // The gate's own entries are never dimmed.
    expect(settledElse.filter((d) => d.nodeId === 'sg').every((d) => !d.untaken)).toBe(true);
  });
});

describe("a plugin finish step's own answer (C2, #37)", () => {
  const nodeOf = (id: string, type: string) => ({
    id,
    type,
    typeVersion: 1,
    settings: {},
    position: { x: 0, y: 0 },
  });
  const link = (from: string, to: string) => ({
    id: `${from}-${to}`,
    from: { node: from, port: 'file' },
    to: { node: to, port: 'file' },
  });
  /** in → ro → rs (a plugin finish step; a core finish type stands in for its kind). */
  const graph = (): WorkflowGraph => ({
    formatVersion: 2,
    kind: 'workflow',
    nodes: [
      nodeOf('in', 'core:input-manual'),
      nodeOf('ro', 'core:replace-original'),
      nodeOf('rs', 'core:notify-webhook'),
    ],
    edges: [link('in', 'ro'), link('ro', 'rs')],
    groups: [],
  });
  const plugin = { source: 'plugin' as const };
  const planned = [
    entry(1, 'in', 'pass', 'file', 'start: Manual input'),
    entry(2, 'ro', 'finish', 'file', 'replace the original'),
    entry(3, 'rs', 'finish', 'file', 'rescan after the write', plugin),
  ];
  const answered = [...planned, entry(4, 'rs', 'finish', null, 'Radarr lists /m/a.mkv', plugin)];
  const steps: WalkStep[] = ['in', 'ro', 'rs'].map((nodeId) => ({
    workflowPath: [],
    nodeId,
    port: 'file',
  }));
  const none = new Map();

  it('replaces the planned text in the decisions once the step answered, as a plain finish step', () => {
    const list = decisions(answered, graph(), catalogFixture, none, steps, none, true);
    expect(list.filter((d) => d.nodeId === 'rs')).toMatchObject([
      { reason: 'Radarr lists /m/a.mkv', branch: null, untaken: false, plugin: true },
    ]);
    expect(list.map((d) => d.nodeId)).toEqual(['in', 'ro', 'rs']);
  });

  it('keeps the planned text while the step has not answered', () => {
    const list = decisions(planned, graph(), catalogFixture, none, steps, none, false);
    expect(list.find((d) => d.nodeId === 'rs')?.reason).toBe('rescan after the write');
  });

  it('a failed answer is the failed decision', () => {
    const failed = [...planned, entry(4, 'rs', 'finish', null, 'failed: Radarr is down', plugin)];
    const list = decisions(failed, graph(), catalogFixture, none, steps, none, true);
    expect(list.filter((d) => d.nodeId === 'rs').map((d) => d.reason)).toEqual([
      'failed: Radarr is down',
    ]);
  });

  it('a best-effort step that failed shows its card failed while the job is done (a warning)', () => {
    const failed = [...planned, entry(4, 'rs', 'finish', null, 'failed: Radarr is down', plugin)];
    const src: TraceSource = { trace: failed, steps, jobState: 'done', currentNode: undefined };
    const o = buildTraceOverlay(graph(), src, []);
    expect(o.nodes.get('rs')).toMatchObject({ status: 'failed', reason: 'failed: Radarr is down' });
    expect(o.nodes.get('ro')?.status).toBe('done');
  });

  it('the card shows the answer', () => {
    const src: TraceSource = { trace: answered, steps, jobState: 'done', currentNode: undefined };
    const o = buildTraceOverlay(graph(), src, []);
    expect(o.nodes.get('rs')).toMatchObject({ status: 'done', reason: 'Radarr lists /m/a.mkv' });
  });
});
