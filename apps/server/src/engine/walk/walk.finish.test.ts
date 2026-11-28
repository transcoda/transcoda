import { describe, expect, it } from 'vitest';
import { bareGraph, edge, node, subGraph } from '../../workflows/testing.ts';
import { at, expectCovered, ids, input, mainGraph, setup } from './testing.ts';
import { walk, walkDecide } from './walk.ts';

describe('walk', () => {
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
      const at = (nodeId: string) => ({ nodeId, workflowPath: [] });
      expect(result.actions).toEqual([
        { kind: 'replace', recycleFolder: null, ...at('ro') },
        { kind: 'plugin', description: 'test:lib', required: false, ...at('l') },
        { kind: 'plugin', description: 'test:media', required: false, ...at('m') },
        { kind: 'plugin', description: 'test:note', required: false, ...at('n') },
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
    // Each core action carries the node it came from (a later failure is told on that node).
    expect(result.actions).toEqual([
      { kind: 'size-gate', minSavingPercent: 15, nodeId: 'f', workflowPath: [] },
      { kind: 'replace', recycleFolder: null, nodeId: 'ro', workflowPath: [] },
      { kind: 'size-gate', minSavingPercent: 30, nodeId: 'f2', workflowPath: [] },
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
          elseActions: [
            {
              kind: 'notify',
              url: 'https://example.test/h',
              method: 'POST',
              nodeId: 'nw',
              workflowPath: [],
            },
          ],
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
            {
              kind: 'plugin',
              description: 'test:media',
              required: false,
              nodeId: 'em',
              workflowPath: [],
            },
            {
              kind: 'plugin',
              description: 'test:note',
              required: false,
              nodeId: 'en',
              workflowPath: [],
            },
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

  describe('approval', () => {
    const notify = (id: string) =>
      node(id, 'core:notify-webhook', { url: 'https://example.test/h' });
    /** in → ap; ap.pass → ro → after; ap.else → `rejected` (a chain). */
    const approved = (rejected: ReturnType<typeof node>[] = [notify('nw')]) =>
      mainGraph(
        [
          node('in', 'core:input-manual'),
          node('ap', 'core:approval', { expireAfterDays: 3 }),
          node('ro', 'core:replace-original'),
          notify('after'),
          ...rejected,
        ],
        [
          edge('in', 'ap'),
          edge('ap', 'ro', { from: 'pass' }),
          edge('ro', 'after'),
          ...(rejected[0] ? [edge('ap', rejected[0].id, { from: 'else' })] : []),
          ...rejected.slice(1).map((n, i) => edge((rejected[i] as { id: string }).id, n.id)),
        ],
      );

    it('adds its core-only action where it sits, and walks Rejected apart like a gate’s else', async () => {
      const { deps, trace } = setup();
      const result = await walk(deps, input(approved()));
      if (result.kind !== 'built') throw new Error(JSON.stringify(result));
      expect(ids(result.path)).toEqual(['in', 'ap', 'ro', 'after']);
      expect(result.path.find((s) => s.nodeId === 'ap')?.port).toBe('pass');
      expect(result.actions.map((a) => a.kind)).toEqual(['approval', 'replace', 'notify']);
      expect(result.actions[0]).toEqual({
        kind: 'approval',
        expireAfterDays: 3,
        nodeId: 'ap',
        workflowPath: [],
      });
      expect(result.gates).toEqual([
        {
          nodeId: 'ap',
          actionIndex: 0,
          elseActions: [
            {
              kind: 'notify',
              url: 'https://example.test/h',
              method: 'POST',
              nodeId: 'nw',
              workflowPath: [],
            },
          ],
          elsePath: [{ workflowPath: [], nodeId: 'nw', port: 'file' }],
        },
      ]);
      expect(trace.filter((e) => e.nodeId === 'ap').map((e) => [e.phase, e.reason])).toEqual([
        ['finish', 'wait for a person to approve the result (up to 3 days)'],
      ]);
    });

    it('a write step behind Rejected fails the walk', async () => {
      const { deps } = setup();
      expect(
        await walk(deps, input(approved([node('rb', 'core:replace-original')]))),
      ).toMatchObject({
        kind: 'failed',
        nodeId: 'rb',
        reason: 'a step that writes the result cannot follow Approval\u2019s Rejected branch',
      });
    });

    it('a bypassed approval adds no action and no branch', async () => {
      const { deps } = setup();
      const graph = approved();
      const ap = graph.nodes.find((n) => n.id === 'ap');
      if (ap) ap.bypassed = true;
      const result = await walk(deps, input(graph));
      if (result.kind !== 'built') throw new Error(JSON.stringify(result));
      expect(result.actions.map((a) => a.kind)).toEqual(['replace', 'notify']);
      expect(result.gates).toEqual([]);
    });
  });

  describe('Render', () => {
    const notify = (id: string) =>
      node(id, 'core:notify-webhook', { url: 'https://example.test/h' });
    /** in → kl → r (Render) → ro → after; r.damaged → each of `damaged` (one shared output). */
    const rendered = (qualityCheck: boolean, damaged: ReturnType<typeof node>[] = []) =>
      bareGraph(
        [
          node('in', 'core:input-manual'),
          node('kl', 'test:act', { arg: 'x' }),
          node('r', 'core:render', { qualityCheck }),
          node('ro', 'core:replace-original'),
          notify('after'),
          ...damaged,
        ],
        [
          edge('in', 'kl'),
          edge('kl', 'r'),
          edge('r', 'ro', { from: 'done' }),
          edge('ro', 'after'),
          ...damaged.map((n) => edge('r', n.id, { from: 'damaged' })),
        ],
      );

    it('a Render with Quality check on collects the Damaged finish steps into `damaged` (noWrite) and the main path continues on Done', async () => {
      const { deps, trace } = setup();
      // wired in the other order: they run in phase order
      const graph = rendered(true, [notify('d1'), node('dl', 'test:lib')]);
      const decided = await walkDecide(deps, input(graph));
      if (decided.kind !== 'decided') throw new Error(JSON.stringify(decided));
      expect(ids(decided.nodes)).toEqual(['in', 'kl', 'r', 'ro', 'after']);
      expect(decided.nodes.find((n) => n.nodeId === 'r')?.port).toBe('done');
      expect([...decided.damagedNodes].map(([r, refs]) => [r, ids(refs)])).toEqual([
        ['r', ['dl', 'd1']],
      ]);
      const result = await walk(deps, input(graph));
      if (result.kind !== 'built') throw new Error(JSON.stringify(result));
      expect(result.damaged).toEqual({
        nodeId: 'r',
        actionIndex: 0,
        actions: [
          {
            kind: 'plugin',
            description: 'test:lib',
            required: false,
            nodeId: 'dl',
            workflowPath: [],
          },
          {
            kind: 'notify',
            url: 'https://example.test/h',
            method: 'POST',
            nodeId: 'd1',
            workflowPath: [],
          },
        ],
        path: [
          { workflowPath: [], nodeId: 'dl', port: null },
          { workflowPath: [], nodeId: 'd1', port: 'file' },
        ],
      });
      expect(ids(result.path)).toEqual(['in', 'kl', 'r', 'ro', 'after']);
      expect(trace.filter((e) => e.nodeId === 'r').map((e) => [e.phase, e.port, e.reason])).toEqual(
        [['finish', 'done', 'render; a damaged source continues on Damaged']],
      );
      // a write on the Damaged side fails the walk (validation forbids it; defence in depth)
      const bad = await walk(deps, input(rendered(true, [node('rb', 'core:replace-original')])));
      expect(bad).toMatchObject({
        kind: 'failed',
        nodeId: 'rb',
        reason: 'a step that writes the result cannot follow Render\u2019s Damaged',
      });
    });

    it('a Render with Quality check off yields damaged: null and never follows an edge from the hidden port', async () => {
      const { deps, trace } = setup();
      const graph = rendered(false, [notify('d1')]);
      const decided = await walkDecide(deps, input(graph));
      if (decided.kind !== 'decided') throw new Error(JSON.stringify(decided));
      expect(decided.damagedNodes.size).toBe(0);
      const result = await walk(deps, input(graph));
      if (result.kind !== 'built') throw new Error(JSON.stringify(result));
      expect(result.damaged).toBeNull();
      expect(result.actions.map((a) => a.kind)).toEqual(['render', 'replace', 'notify']);
      expect(trace.some((e) => e.nodeId === 'd1')).toBe(false);
      // on, but nothing wired to Damaged: no branch either
      const unwired = await walk(deps, input(rendered(true)));
      if (unwired.kind !== 'built') throw new Error(JSON.stringify(unwired));
      expect(unwired.damaged).toBeNull();
    });

    it('the render action sits in `actions` at damaged.actionIndex', async () => {
      const { deps } = setup();
      const graph = rendered(true, [notify('d1')]);
      // a gate between Render and the write moves nothing: Render's action comes first
      const sg = node('sg', 'core:size-gate', { minSavingPercent: 5 });
      graph.nodes.push(sg);
      graph.edges = graph.edges.map((e) =>
        e.from.node === 'r' && e.to.node === 'ro' ? edge('r', 'sg', { from: 'done' }) : e,
      );
      graph.edges.push(edge('sg', 'ro', { from: 'pass' }));
      const result = await walk(deps, input(graph));
      if (result.kind !== 'built') throw new Error(JSON.stringify(result));
      expect(result.actions.map((a) => a.kind)).toEqual([
        'render',
        'size-gate',
        'replace',
        'notify',
      ]);
      expect(result.damaged?.actionIndex).toBe(0);
      expect(result.actions[result.damaged?.actionIndex ?? -1]).toEqual({
        kind: 'render',
        qualityCheck: true,
        nodeId: 'r',
        workflowPath: [],
      });
    });
  });
});
