import { defineNode } from '@transcoda/sdk';
import type { WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  bumpNoPath,
  bumpSettingsV1,
  bumpThrowing,
  bumpV1,
  bumpV2,
  bumpV3,
  chain,
  childGraph,
  edge,
  mainGraph,
  moveNodes,
  node,
  PLUGIN_LINKS,
  registryWithPlugin,
  remoteA,
  testRegistry,
  withExtraNode,
  withSetting,
} from './test-helpers.ts';
import {
  applyPluginUpgrades,
  comparePinChange,
  migrationPath,
  planNodeUpgrades,
  pluginNodesBehind,
  stepsBetween,
  type UpgradePlan,
} from './upgrade.ts';
import { migratePinned } from './validate.ts';

const v1Graph = () => mainGraph([node('b', 'test:bump', { level: 2 }, { typeVersion: 1 })]);

describe('migrationPath', () => {
  it('migrationPath finds a chain, [] when current, null when a link is missing', () => {
    expect(migrationPath(bumpV3(), 1)?.map((m) => m.to)).toEqual([2, 3]);
    expect(migrationPath(bumpV3(), 3)).toEqual([]);
    expect(migrationPath(bumpNoPath(), 1)).toBeNull();
  });

  it('is null for ambiguous, non-increasing or overshooting steps, and above the version', () => {
    const base = { ...bumpV1(), version: 3 };
    const step = (from: number, to: number) => ({
      from,
      to,
      risk: 'safe' as const,
      note: '',
      migrate: (s: unknown) => s as never,
    });
    expect(migrationPath(defineNode({ ...base, migrations: [step(1, 2), step(1, 3)] }), 1)).toBe(
      null,
    );
    expect(migrationPath(defineNode({ ...base, migrations: [step(1, 1)] }), 1)).toBeNull();
    expect(migrationPath(defineNode({ ...base, migrations: [step(1, 4)] }), 1)).toBeNull();
    expect(migrationPath(bumpV3(), 4)).toBeNull();
  });

  it('is null for non-integer versions; such a node is broken', () => {
    expect(migrationPath(bumpV3(), 1.5)).toBeNull();
    expect(migrationPath({ ...bumpV2(), version: 2.5 }, 1)).toBeNull();
    const g = mainGraph([node('b', 'test:bump', { level: 1 }, { typeVersion: 1.5 })]);
    expect(planNodeUpgrades(g, testRegistry(bumpV3()))).toEqual({ kind: 'broken', nodeIds: ['b'] });
  });
});

describe('size gate v1 → v2', () => {
  const v1Gate = () =>
    mainGraph(
      [
        node('in', 'core:input-manual'),
        node('sg', 'core:size-gate', { minSavingPercent: 20 }, { typeVersion: 1 }),
        node('ro', 'core:replace-original'),
      ],
      [edge('in', 'sg'), edge('sg', 'ro')],
    );

  it('is a safe migration that re-keys the v1 output edge to pass and keeps the settings', () => {
    const p = planNodeUpgrades(v1Gate(), testRegistry());
    expect(p).toMatchObject({ kind: 'upgraded', risk: 'safe', notes: ['Updated Size gate 1→2'] });
    const { graph } = p as Extract<UpgradePlan, { kind: 'upgraded' }>;
    expect(graph.nodes.find((n) => n.id === 'sg')).toMatchObject({
      typeVersion: 2,
      settings: { minSavingPercent: 20 },
    });
    expect(graph.edges.map((e) => [e.from.node, e.from.port, e.to.node, e.to.port])).toEqual([
      ['in', 'file', 'sg', 'file'],
      ['sg', 'pass', 'ro', 'file'],
    ]);
  });

  it('leaves edges of other nodes and of other ports alone, and the input untouched', () => {
    const g = v1Gate();
    const before = structuredClone(g);
    planNodeUpgrades(g, testRegistry());
    expect(g).toEqual(before);
  });

  it('migratePinned (how a job loads its own version) re-keys the edges too', () => {
    const { graph, held } = migratePinned(v1Gate(), testRegistry());
    expect(held).toEqual([]);
    expect(graph.edges.map((e) => e.from.port)).toEqual(['file', 'pass']);
  });
});

describe('encode video and encode audio from v1', () => {
  const v1Encoders = () =>
    mainGraph(
      [
        node('in', 'core:input-manual'),
        node('ev', 'core:encode-video', { quality: 20, preset: 'slow' }, { typeVersion: 1 }),
        node('ea', 'core:encode-audio', { mode: 'reencode' }, { typeVersion: 1 }),
        node('ro', 'core:replace-original'),
      ],
      [edge('in', 'ev'), edge('ev', 'ea'), edge('ea', 'ro')],
    );

  it('is a safe migration that keeps a saved node encoding as before: the cap and title updates start off', () => {
    const p = planNodeUpgrades(v1Encoders(), testRegistry());
    expect(p).toMatchObject({
      kind: 'upgraded',
      risk: 'safe',
      notes: ['Updated Encode video 1→2', 'Updated Encode audio 1→3'],
    });
    const { graph } = p as Extract<UpgradePlan, { kind: 'upgraded' }>;
    expect(graph.nodes.find((n) => n.id === 'ev')).toMatchObject({
      typeVersion: 2,
      settings: { quality: 20, preset: 'slow', neverIncreaseBitrate: false },
    });
    expect(graph.nodes.find((n) => n.id === 'ea')).toMatchObject({
      typeVersion: 3,
      settings: { mode: 'reencode', neverIncreaseBitrate: false, updateTitles: false },
    });
    expect(graph.edges).toEqual(v1Encoders().edges);
  });

  it('a new node is current and keeps the defaults', () => {
    const g = mainGraph([node('ev', 'core:encode-video'), node('ea', 'core:encode-audio')]);
    expect(planNodeUpgrades(g, testRegistry())).toEqual({ kind: 'current' });
  });
});

describe('planNodeUpgrades', () => {
  it('safe chain rewrites settings and typeVersion, risk safe', () => {
    const p = planNodeUpgrades(v1Graph(), testRegistry(bumpV2()));
    expect(p).toMatchObject({ kind: 'upgraded', risk: 'safe', notes: ['Updated Bump 1→2'] });
    expect((p as Extract<UpgradePlan, { kind: 'upgraded' }>).graph.nodes[0]).toMatchObject({
      typeVersion: 2,
      settings: { level: 2, label: '' },
    });
  });

  it('a behaviour step marks the plan behaviour and names the step', () => {
    expect(planNodeUpgrades(v1Graph(), testRegistry(bumpV3()))).toMatchObject({
      kind: 'upgraded',
      risk: 'behaviour',
      notes: ['Updated Bump 1→3 (strict mode on by default)'],
    });
  });

  it('no path → broken even when another node could be upgraded; current → current', () => {
    const g = mainGraph([
      node('b', 'test:bump', { level: 1 }, { typeVersion: 1 }),
      node('k', 'core:keep-languages', {}, { typeVersion: 1 }),
    ]);
    expect(planNodeUpgrades(g, testRegistry(bumpNoPath()))).toEqual({
      kind: 'broken',
      nodeIds: ['b'],
    });
    expect(planNodeUpgrades(v1Graph(), testRegistry(bumpV1()))).toEqual({ kind: 'current' });
  });

  it('broken wins over an upgradable node of another type and runs no migration', () => {
    const throwingOther = defineNode({
      ...bumpThrowing(),
      type: 'test:other',
      settings: bumpSettingsV1,
    });
    const g = mainGraph([
      node('o', 'test:other', {}, { typeVersion: 1 }),
      node('b', 'test:bump', {}, { typeVersion: 1 }),
    ]);
    expect(planNodeUpgrades(g, testRegistry(bumpNoPath(), throwingOther))).toEqual({
      kind: 'broken',
      nodeIds: ['b'],
    });
  });

  it('leaves unknown types and nodes at or above the registered version alone', () => {
    const g = mainGraph([
      node('u', 'nope:nothing', {}, { typeVersion: 1 }),
      node('h', 'test:bump', { level: 1 }, { typeVersion: 5 }),
    ]);
    expect(planNodeUpgrades(g, testRegistry(bumpV2()))).toEqual({ kind: 'current' });
  });

  it('does not modify the input graph', () => {
    const g = v1Graph();
    const before = structuredClone(g);
    planNodeUpgrades(g, testRegistry(bumpV3()));
    expect(g).toEqual(before);
  });

  it('a throwing migration propagates', () => {
    expect(() => planNodeUpgrades(v1Graph(), testRegistry(bumpThrowing()))).toThrow('boom');
  });
});

describe('comparePinChange', () => {
  it('comparePinChange', () => {
    const reg = testRegistry(bumpV2());
    const a = childGraph();
    expect(comparePinChange(a, moveNodes(a), {}, reg)).toBe('safe');
    expect(comparePinChange(a, withSetting(a, 'kl', { languages: ['fr'] }), {}, reg)).toBe(
      'behaviour',
    );
    expect(comparePinChange(a, withExtraNode(a, node('x', 'core:remux')), {}, reg)).toBe(
      'behaviour',
    );
    const v1 = mainGraph([node('b', 'test:bump', { level: 1 }, { typeVersion: 1 })]);
    expect(comparePinChange(v1, withSetting(v1, 'b', { level: 1, label: '' }, 2), {}, reg)).toBe(
      'safe',
    );
    expect(comparePinChange(v1, withSetting(v1, 'b', { level: 1, label: 'x' }, 2), {}, reg)).toBe(
      'behaviour',
    );
    expect(
      comparePinChange(
        v1,
        withSetting(v1, 'b', { level: 1, label: '', strict: true }, 3),
        {},
        testRegistry(bumpV3()),
      ),
    ).toBe('behaviour');
  });

  it('an override of a nested Run node does not survive a re-pin (behaviour)', () => {
    const g = chain(
      'subworkflow',
      node('inner', 'core:run-subworkflow', { subworkflowId: 's2', version: 1, overrides: {} }),
    );
    expect(comparePinChange(g, moveNodes(g), {}, testRegistry())).toBe('safe');
    expect(comparePinChange(g, moveNodes(g), { 'inner.version': 2 }, testRegistry())).toBe(
      'behaviour',
    );
  });

  it('ignores settings key order', () => {
    const g = mainGraph([node('b', 'test:bump', { a: 1, b: { c: 2, d: 3 } })]);
    const reordered = withSetting(g, 'b', { b: { d: 3, c: 2 }, a: 1 });
    expect(comparePinChange(g, reordered, {}, testRegistry(bumpV1()))).toBe('safe');
  });

  it('a removed node, changed type or lowered typeVersion is behaviour', () => {
    const reg = testRegistry(bumpV2());
    const g = mainGraph([
      node('b', 'test:bump', { level: 1, label: '' }, { typeVersion: 2 }),
      node('r', 'core:remux'),
    ]);
    expect(comparePinChange(g, { ...g, nodes: g.nodes.slice(0, 1) }, {}, reg)).toBe('behaviour');
    expect(
      comparePinChange(
        g,
        { ...g, nodes: g.nodes.map((n) => (n.id === 'r' ? { ...n, type: 'core:move-copy' } : n)) },
        {},
        reg,
      ),
    ).toBe('behaviour');
    expect(comparePinChange(g, withSetting(g, 'b', { level: 1, label: '' }, 1), {}, reg)).toBe(
      'behaviour',
    );
  });

  it('edges compare as a set of endpoints; any endpoint change is behaviour', () => {
    const reg = testRegistry();
    const nodes = [node('a', 'core:remux'), node('b', 'core:remux'), node('c', 'core:remux')];
    const g = mainGraph(nodes, [edge('a', 'b'), edge('b', 'c')]);
    const renamedAndReordered: WorkflowGraph = {
      ...g,
      edges: [
        { ...edge('b', 'c'), id: 'e2' },
        { ...edge('a', 'b'), id: 'e1' },
      ],
    };
    expect(comparePinChange(g, renamedAndReordered, {}, reg)).toBe('safe');
    expect(comparePinChange(g, { ...g, edges: [edge('a', 'b'), edge('a', 'c')] }, {}, reg)).toBe(
      'behaviour',
    );
    expect(
      comparePinChange(g, { ...g, edges: [edge('a', 'b'), edge('b', 'c', { to: 'x' })] }, {}, reg),
    ).toBe('behaviour');
    expect(comparePinChange(g, { ...g, edges: [edge('a', 'b')] }, {}, reg)).toBe('behaviour');
  });

  it('toggling bypass is behaviour (the node stops changing files)', () => {
    const g = mainGraph([node('r', 'core:remux')]);
    const bypassed = { ...g, nodes: g.nodes.map((n) => ({ ...n, bypassed: true })) };
    expect(comparePinChange(g, bypassed, {}, testRegistry())).toBe('behaviour');
    const explicitFalse = { ...g, nodes: g.nodes.map((n) => ({ ...n, bypassed: false })) };
    expect(comparePinChange(g, explicitFalse, {}, testRegistry())).toBe('safe');
  });

  it('a typeVersion rise without a provable path is behaviour', () => {
    const v1 = mainGraph([node('b', 'test:bump', { level: 1 }, { typeVersion: 1 })]);
    const v2 = withSetting(v1, 'b', { level: 1, label: '' }, 2);
    expect(comparePinChange(v1, v2, {}, testRegistry(bumpNoPath()))).toBe('behaviour');
    expect(comparePinChange(v1, v2, {}, testRegistry(bumpThrowing()))).toBe('behaviour');
    const unknown = mainGraph([node('u', 'nope:nothing', {}, { typeVersion: 1 })]);
    expect(comparePinChange(unknown, withSetting(unknown, 'u', {}, 2), {}, testRegistry())).toBe(
      'behaviour',
    );
  });

  it('adding or removing a duplicate parallel edge is behaviour (edges are a multiset)', () => {
    const reg = testRegistry();
    const g = mainGraph([node('a', 'core:remux'), node('b', 'core:remux')], [edge('a', 'b')]);
    const doubled: WorkflowGraph = { ...g, edges: [...g.edges, { ...edge('a', 'b'), id: 'dup' }] };
    expect(comparePinChange(g, doubled, {}, reg)).toBe('behaviour');
    expect(comparePinChange(doubled, g, {}, reg)).toBe('behaviour');
    expect(comparePinChange(doubled, structuredClone(doubled), {}, reg)).toBe('safe');
  });
});

describe('comparePinChange with overrides', () => {
  // test:bump v1 → v2 safely renames `level` to `depth`.
  const renaming = defineNode({
    ...bumpV1(),
    version: 2,
    settings: z.object({ depth: z.number().int().default(1).describe('Depth') }),
    migrations: [
      {
        from: 1,
        to: 2,
        risk: 'safe',
        note: 'level renamed to depth',
        migrate: (s) => ({ depth: (s as { level: number }).level }),
      },
    ],
  });
  const reg = testRegistry(renaming);
  const oldChild = chain(
    'subworkflow',
    node('b', 'test:bump', { level: 2 }, { typeVersion: 1 }),
    node('kl', 'core:keep-languages', { languages: ['en'] }),
  );
  const newChild = withSetting(oldChild, 'b', { depth: 2 }, 2);

  it('a safe migration that renames an overridden setting is behaviour', () => {
    expect(comparePinChange(oldChild, newChild, {}, reg)).toBe('safe');
    expect(comparePinChange(oldChild, newChild, { 'b.level': 5 }, reg)).toBe('behaviour');
  });

  it('a safe migration on a node without overrides stays safe', () => {
    expect(comparePinChange(oldChild, newChild, { 'kl.languages': ['de'] }, reg)).toBe('safe');
  });

  it('an override whose node is missing, retyped or re-versioned in the new child is behaviour', () => {
    const v1 = mainGraph([node('b', 'test:bump', { level: 1 }, { typeVersion: 1 })]);
    const v2 = withSetting(v1, 'b', { level: 1, label: '' }, 2);
    const reg2 = testRegistry(bumpV2());
    expect(comparePinChange(v1, v2, {}, reg2)).toBe('safe');
    expect(comparePinChange(v1, v2, { 'b.level': 3 }, reg2)).toBe('behaviour');
    expect(comparePinChange(v1, v1, { 'b.level': 3 }, reg2)).toBe('safe');
    expect(comparePinChange(v1, v1, { 'gone.level': 3 }, reg2)).toBe('behaviour');
    expect(comparePinChange(v1, v1, { 'b.nope': 3 }, reg2)).toBe('behaviour');
  });
});

describe('stepsBetween', () => {
  const links = [
    { from: 1, to: 2, risk: 'safe' as const },
    { from: 2, to: 3, risk: 'behaviour' as const },
  ];
  it('chains links like migrationPath: [] when equal, null for a gap, a fork, a backwards or overshooting link', () => {
    expect(stepsBetween(links, 1, 3)?.map((l) => l.to)).toEqual([2, 3]);
    expect(stepsBetween(links, 2, 2)).toEqual([]);
    expect(stepsBetween(links, 3, 2)).toBeNull();
    expect(stepsBetween([links[1] as (typeof links)[number]], 1, 3)).toBeNull();
    expect(stepsBetween([...links, { from: 1, to: 3, risk: 'safe' }], 1, 3)).toBeNull();
    expect(stepsBetween([{ from: 1, to: 1, risk: 'safe' }], 1, 2)).toBeNull();
    expect(stepsBetween([{ from: 1, to: 5, risk: 'safe' }], 1, 3)).toBeNull();
    expect(stepsBetween(links, 1.5, 3)).toBeNull();
    expect(migrationPath(bumpV3(), 1)?.map((m) => m.to)).toEqual(
      stepsBetween(bumpV3().migrations ?? [], 1, 3)?.map((m) => m.to),
    );
  });
});

describe('plugin nodes (remote definitions)', () => {
  const graph = (typeVersion: number) =>
    mainGraph([node('p', 'x:a', { old: 'a' }, { typeVersion })]);
  const registry = () => registryWithPlugin(remoteA(3, PLUGIN_LINKS));

  it('planNodeUpgrades leaves a plugin node with a path as current (the host migrates at call time), a node without one broken', () => {
    expect(planNodeUpgrades(graph(1), registry())).toEqual({ kind: 'current' });
    expect(planNodeUpgrades(graph(0), registry())).toEqual({ kind: 'broken', nodeIds: ['p'] });
  });

  it('a core node behind in a graph that also has a plugin node with a path is still upgraded', () => {
    const g = mainGraph([
      node('p', 'x:a', { old: 'a' }, { typeVersion: 1 }),
      node('b', 'test:bump', { level: 2 }, { typeVersion: 1 }),
    ]);
    const reg = registryWithPlugin(remoteA(3, PLUGIN_LINKS));
    reg.add([{ def: bumpV2(), source: { kind: 'core' } }]);
    const plan = planNodeUpgrades(g, reg);
    expect(plan.kind).toBe('upgraded');
    if (plan.kind !== 'upgraded') return;
    const byId = Object.fromEntries(plan.graph.nodes.map((n) => [n.id, n]));
    expect(byId.b).toMatchObject({ typeVersion: 2 });
    expect(byId.p).toMatchObject({ typeVersion: 1, settings: { old: 'a' } });
  });

  it('pluginNodesBehind lists the node with the risk of its path', () => {
    expect(pluginNodesBehind(graph(1), registry())).toEqual([
      { nodeId: 'p', type: 'x:a', from: 1, to: 3, risk: 'behaviour' },
    ]);
    expect(pluginNodesBehind(graph(2), registry())[0]?.risk).toBe('behaviour');
    expect(pluginNodesBehind(graph(3), registry())).toEqual([]);
    expect(pluginNodesBehind(graph(0), registry())).toEqual([]);
    expect(
      pluginNodesBehind(graph(1), registryWithPlugin(remoteA(2, PLUGIN_LINKS.slice(0, 1))))[0]
        ?.risk,
    ).toBe('safe');
  });

  it('applyPluginUpgrades migrates through the host, writes typeVersion and the returned settings, and notes the behaviour step', async () => {
    const calls: Array<[string, number, unknown]> = [];
    const plan = await applyPluginUpgrades(graph(1), registry(), async (t, from, s) => {
      calls.push([t, from, s]);
      return { value: 'a' };
    });
    expect(calls).toEqual([['x:a', 1, { old: 'a' }]]);
    expect(plan).toMatchObject({
      kind: 'upgraded',
      risk: 'behaviour',
      notes: ['Updated A 1→3 (value is now required)'],
    });
    if (plan.kind !== 'upgraded') return;
    expect(plan.graph.nodes[0]).toMatchObject({ typeVersion: 3, settings: { value: 'a' } });
  });

  it('applyPluginUpgrades: current when nothing is behind, broken when there is no path, a throwing migrate propagates', async () => {
    const never = async () => {
      throw new Error('should not be called');
    };
    expect(await applyPluginUpgrades(graph(3), registry(), never)).toEqual({ kind: 'current' });
    expect(await applyPluginUpgrades(graph(0), registry(), never)).toEqual({
      kind: 'broken',
      nodeIds: ['p'],
    });
    await expect(
      applyPluginUpgrades(graph(1), registry(), async () => {
        throw new Error('host says no');
      }),
    ).rejects.toThrow('host says no');
  });

  it('applyPluginUpgrades only touches the requested plugin types', async () => {
    const migrate = async () => ({ value: 'a' });
    expect(await applyPluginUpgrades(graph(1), registry(), migrate, new Set(['y:b']))).toEqual({
      kind: 'current',
    });
  });

  it('core refuses a migrated result its schema rejects or that is over 256 KB', async () => {
    await expect(
      applyPluginUpgrades(graph(1), registry(), async () => ({ value: 5 })),
    ).rejects.toThrow(/not valid for v3/);
    await expect(
      applyPluginUpgrades(graph(1), registry(), async () => ({ value: 'x'.repeat(300_000) })),
    ).rejects.toThrow(/larger than 256 KB/);
  });
});
