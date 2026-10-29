import { emptyGraph, type NodeInstance, type WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { catalogFixture as catalog } from '../../test/fixtures/catalog.ts';
import {
  chainMainReplace,
  oneTrigger,
  tiggerPoohMain,
  tiggerPoohSub,
} from '../../test/fixtures/graphs.ts';
import {
  addNode,
  connect,
  createGroup,
  DEFAULT_GROUP_NAME,
  disconnect,
  duplicateNode,
  joinGroup,
  moveNodes,
  type OpResult,
  removeNodes,
  removeSelection,
  renameGroup,
  resizeGroup,
  setGroupCollapsed,
  setLabel,
  setNodeGroup,
  setOverride,
  setPinnedVersion,
  setSettings,
  toggleBypass,
  ungroup,
} from './graph-ops.ts';

function graphOf(r: OpResult): WorkflowGraph {
  if (!r.ok) throw new Error(`refused: ${r.refusal.reason}`);
  return r.graph;
}

function nodeOf(g: WorkflowGraph, id: string): NodeInstance {
  const n = g.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
}

function manyNodes(count: number): WorkflowGraph {
  const g = emptyGraph('workflow');
  const nodes: NodeInstance[] = Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    type: 'core:remux',
    typeVersion: 1,
    settings: {},
    position: { x: 0, y: 0 },
  }));
  return { ...g, nodes };
}

describe('graph operations', () => {
  it('addNode uses the catalogue version and schema defaults and refuses at 500 nodes', () => {
    const r = addNode(emptyGraph('workflow'), 'core:keep-languages', { x: 10, y: 20 }, catalog);
    expect(r.ok && r.graph.nodes[0]).toMatchObject({
      type: 'core:keep-languages',
      typeVersion: 1,
      settings: { languages: ['en'], keepOriginal: true, keepUntagged: true },
      position: { x: 10, y: 20 },
    });
    const added = graphOf(r).nodes[0] as NodeInstance;
    expect(added.id).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(Object.keys(added).sort()).toEqual([
      'id',
      'position',
      'settings',
      'type',
      'typeVersion',
    ]);

    const full = manyNodes(500);
    expect(addNode(full, 'core:remux', { x: 0, y: 0 }, catalog)).toEqual({
      ok: false,
      refusal: { reason: 'A workflow can have at most 500 nodes' },
    });
    expect(addNode(manyNodes(499), 'core:remux', { x: 0, y: 0 }, catalog).ok).toBe(true);
  });

  it('addNode refuses an unknown type and honours the id and group options', () => {
    expect(addNode(emptyGraph('workflow'), 'acme:nope', { x: 0, y: 0 }, catalog)).toEqual({
      ok: false,
      refusal: { reason: 'Unknown node type acme:nope' },
    });
    const g = graphOf(
      addNode(tiggerPoohMain('sub1', 1), 'core:remux', { x: 1, y: 2 }, catalog, {
        id: 'mine',
        groupId: 'cleanup',
      }),
    );
    expect(nodeOf(g, 'mine')).toMatchObject({ groupId: 'cleanup', position: { x: 1, y: 2 } });
  });

  it('operations never mutate their input graph', () => {
    const g = chainMainReplace();
    const before = structuredClone(g);
    addNode(g, 'core:remux', { x: 0, y: 0 }, catalog);
    removeNodes(g, ['keep']);
    moveNodes(g, [{ id: 'in', position: { x: 5, y: 5 } }]);
    setLabel(g, 'keep', 'Keep');
    toggleBypass(g, 'keep');
    createGroup(g, 'G', ['in', 'keep']);
    expect(g).toEqual(before);
  });

  it('operations accept deep-frozen graphs (no in-place writes anywhere)', () => {
    const freeze = <T>(v: T): T => {
      if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
        Object.freeze(v);
        for (const x of Object.values(v)) freeze(x);
      }
      return v;
    };
    const g = freeze(tiggerPoohMain('sub1', 2));
    const before = structuredClone(g);
    const results = [
      addNode(g, 'core:remux', { x: 0, y: 0 }, catalog),
      removeNodes(g, ['ca']),
      duplicateNode(g, 'ca', catalog),
      disconnect(g, 'ca-sg'),
      connect(
        graphOf(disconnect(g, 'ca-sg')),
        { node: 'ca', port: 'file' },
        { node: 'sg', port: 'file' },
        catalog,
      ),
      moveNodes(g, [{ id: 'in', position: { x: 5, y: 5 } }]),
      setSettings(g, 'sg', { maxBytes: 1 }),
      setLabel(g, 'ca', 'Covers'),
      toggleBypass(g, 'ca'),
      createGroup(g, 'G', ['in', 'vi']),
      renameGroup(g, 'cleanup', 'Tidy'),
      setGroupCollapsed(g, 'cleanup', true),
      resizeGroup(g, 'cleanup', { x: 0, y: 0 }, { width: 900, height: 400 }),
      setNodeGroup(g, 'in', 'cleanup'),
      ungroup(g, 'cleanup'),
      setPinnedVersion(g, 'run-a', 3),
      setOverride(g, 'run-a', 'keep.languages', ['de']),
      setOverride(g, 'run-a', 'keep.languages', undefined),
    ];
    for (const r of results) expect(r.ok).toBe(true);
    expect(g).toEqual(before);
  });

  it('removeNodes drops attached edges and refuses to remove the last start/end of a sub-workflow', () => {
    const g = graphOf(removeNodes(chainMainReplace(), ['keep']));
    expect(g.nodes.map((n) => n.id)).toEqual(['in', 'ro']);
    expect(g.edges).toEqual([]);

    const sub = tiggerPoohSub();
    expect(removeNodes(sub, ['start'])).toEqual({
      ok: false,
      refusal: { reason: 'A sub-workflow needs its start and end' },
    });
    expect(removeNodes(sub, ['keep', 'end'])).toEqual({
      ok: false,
      refusal: { reason: 'A sub-workflow needs its start and end' },
    });
    const withSecondEnd: WorkflowGraph = {
      ...sub,
      nodes: [...sub.nodes, { ...nodeOf(sub, 'end'), id: 'end2' }],
    };
    expect(graphOf(removeNodes(withSecondEnd, ['end'])).nodes.map((n) => n.id)).not.toContain(
      'end',
    );
    expect(graphOf(removeNodes(sub, ['keep'])).edges.map((e) => e.id)).toEqual([
      'sdt-rt',
      'rt-end',
    ]);
  });

  it('duplicateNode offsets by 40/40, keeps settings, label, group and bypass, and has no edges', () => {
    const base = tiggerPoohMain('sub1', 1);
    const labelled = graphOf(toggleBypass(graphOf(setLabel(base, 'run-a', 'Clean A')), 'run-a'));
    const moved = graphOf(moveNodes(labelled, [{ id: 'run-a', position: { x: 100, y: 50 } }]));
    const g = graphOf(duplicateNode(moved, 'run-a', catalog));
    expect(g.nodes).toHaveLength(base.nodes.length + 1);
    expect(g.edges).toEqual(moved.edges);
    const copy = g.nodes.at(-1) as NodeInstance;
    const original = nodeOf(moved, 'run-a');
    expect(copy.id).not.toBe('run-a');
    expect(copy).toEqual({ ...original, id: copy.id, position: { x: 140, y: 90 } });
    expect(copy.settings).not.toBe(original.settings);
    expect(duplicateNode(manyNodes(500), 'n0', catalog)).toEqual({
      ok: false,
      refusal: { reason: 'A workflow can have at most 500 nodes' },
    });
  });

  it('duplicateNode drops redacted webhook URLs (the server would store them as typed)', () => {
    const base = graphOf(
      addNode(tiggerPoohMain('sub1', 1), 'core:notify-webhook', { x: 0, y: 400 }, catalog, {
        id: 'hook',
      }),
    );
    const g = graphOf(
      setSettings(
        graphOf(setSettings(base, 'hook', { url: 'https://hooks.example.test/…', method: 'PUT' })),
        'run-a',
        { overrides: { 'n1.url': 'https://hooks.example.test/…', 'n1.method': 'PUT' } },
      ),
    );
    const hook = graphOf(duplicateNode(g, 'hook', catalog)).nodes.at(-1) as NodeInstance;
    expect(hook.settings).toEqual({ method: 'PUT' });
    const run = graphOf(duplicateNode(g, 'run-a', catalog)).nodes.at(-1) as NodeInstance;
    expect(run.settings).toEqual({ overrides: { 'n1.method': 'PUT' } });
    // A URL that is not redacted is copied as it is.
    const plain = graphOf(setSettings(g, 'hook', { url: 'https://hooks.example.test/t0k3n' }));
    expect(
      (graphOf(duplicateNode(plain, 'hook', catalog)).nodes.at(-1) as NodeInstance).settings,
    ).toEqual({ url: 'https://hooks.example.test/t0k3n' });
  });

  it('connect refuses mismatched port types, a second edge into an input and self-loops', () => {
    const g = oneTrigger();
    const withKeep = graphOf(
      addNode(g, 'core:keep-languages', { x: 300, y: 0 }, catalog, { id: 'keep' }),
    );
    expect(
      connect(withKeep, { node: 'in', port: 'file' }, { node: 'keep', port: 'language' }, catalog),
    ).toEqual({ ok: false, refusal: { reason: "Those ports don't match (file → data:language)" } });

    const connected = graphOf(
      connect(withKeep, { node: 'in', port: 'file' }, { node: 'keep', port: 'file' }, catalog),
    );
    const edge = connected.edges[0];
    expect(edge).toMatchObject({
      from: { node: 'in', port: 'file' },
      to: { node: 'keep', port: 'file' },
    });
    expect(edge?.id).toMatch(/^[A-Za-z0-9_-]{10}$/);

    // A second connection into a file input is fine: branches that never both run merge there.
    const two = graphOf(addNode(connected, 'core:remux', { x: 0, y: 200 }, catalog, { id: 'wh' }));
    const merged = graphOf(
      connect(two, { node: 'wh', port: 'file' }, { node: 'keep', port: 'file' }, catalog),
    );
    expect(
      merged.edges.filter((e) => e.to.node === 'keep' && e.to.port === 'file').map((e) => e.from),
    ).toEqual([
      { node: 'in', port: 'file' },
      { node: 'wh', port: 'file' },
    ]);

    expect(
      connect(two, { node: 'keep', port: 'file' }, { node: 'keep', port: 'file' }, catalog),
    ).toEqual({ ok: false, refusal: { reason: "A node can't connect to itself" } });

    const back = graphOf(disconnect(connected, edge?.id ?? ''));
    expect(back.edges).toEqual([]);
  });

  it('connect refuses past 2000 edges', () => {
    const g = graphOf(addNode(oneTrigger(), 'core:remux', { x: 0, y: 0 }, catalog, { id: 'rx' }));
    const edges = Array.from({ length: 2000 }, (_, i) => ({
      id: `e${i}`,
      from: { node: 'in', port: 'file' },
      to: { node: `x${i}`, port: 'file' },
    }));
    expect(
      connect({ ...g, edges }, { node: 'in', port: 'file' }, { node: 'rx', port: 'file' }, catalog),
    ).toEqual({ ok: false, refusal: { reason: 'A workflow can have at most 2000 edges' } });
  });

  it('moveNodes, setSettings and missing nodes', () => {
    const g = graphOf(
      moveNodes(chainMainReplace(), [
        { id: 'in', position: { x: -5, y: 7 } },
        { id: 'ro', position: { x: 900, y: 1 } },
      ]),
    );
    expect(nodeOf(g, 'in').position).toEqual({ x: -5, y: 7 });
    expect(nodeOf(g, 'ro').position).toEqual({ x: 900, y: 1 });
    expect(nodeOf(graphOf(setSettings(g, 'keep', null)), 'keep').settings).toBeNull();
    expect(setSettings(g, 'gone', {})).toEqual({
      ok: false,
      refusal: { reason: 'That node no longer exists' },
    });
  });

  it('setLabel("") removes the key; toggleBypass twice removes the key', () => {
    const g = chainMainReplace();
    const labelled = graphOf(setLabel(g, 'keep', 'Keep EN'));
    expect(nodeOf(labelled, 'keep').label).toBe('Keep EN');
    for (const cleared of [setLabel(labelled, 'keep', ''), setLabel(labelled, 'keep', undefined)]) {
      expect('label' in nodeOf(graphOf(cleared), 'keep')).toBe(false);
    }
    const bypassed = graphOf(toggleBypass(g, 'keep'));
    expect(nodeOf(bypassed, 'keep').bypassed).toBe(true);
    const unbypassed = graphOf(toggleBypass(bypassed, 'keep'));
    expect('bypassed' in nodeOf(unbypassed, 'keep')).toBe(false);
    expect(unbypassed).toEqual(g);
  });

  it('createGroup computes the bounding box with 24 px padding and ungroup clears groupId', () => {
    const base = tiggerPoohMain('sub1', 1);
    const placed = graphOf(
      moveNodes(base, [
        { id: 'in', position: { x: 100, y: 50 } },
        { id: 'vi', position: { x: 400, y: 250 } },
        { id: 'run-a', position: { x: 200, y: 100 } },
      ]),
    );
    const g = graphOf(createGroup(placed, 'Intake', ['in', 'vi', 'run-a']));
    const group = g.groups.at(-1);
    expect(group).toMatchObject({
      name: 'Intake',
      collapsed: false,
      position: { x: 76, y: 26 },
      size: { width: 300 + 210 + 48, height: 200 + 120 + 48 },
    });
    expect(group?.id).toMatch(/^[A-Za-z0-9_-]{10}$/);
    // run-a was in "cleanup": it moves to the new group
    for (const id of ['in', 'vi', 'run-a']) expect(nodeOf(g, id).groupId).toBe(group?.id);
    expect(nodeOf(g, 'run-b').groupId).toBe('cleanup');

    const renamed = graphOf(renameGroup(g, group?.id ?? '', 'Front'));
    expect(renamed.groups.at(-1)?.name).toBe('Front');
    const collapsed = graphOf(setGroupCollapsed(renamed, group?.id ?? '', true));
    expect(collapsed.groups.at(-1)?.collapsed).toBe(true);
    const resized = graphOf(
      resizeGroup(collapsed, group?.id ?? '', { x: 1, y: 2 }, { width: 3, height: 4 }),
    );
    expect(resized.groups.at(-1)).toMatchObject({
      position: { x: 1, y: 2 },
      size: { width: 3, height: 4 },
    });

    const un = graphOf(ungroup(resized, group?.id ?? ''));
    expect(un.groups.map((x) => x.id)).toEqual(['cleanup']);
    for (const id of ['in', 'vi', 'run-a']) expect('groupId' in nodeOf(un, id)).toBe(false);
    expect(nodeOf(un, 'run-b').groupId).toBe('cleanup');
  });

  it('createGroup sizes the box from measured card sizes when given', () => {
    const placed = graphOf(
      moveNodes(tiggerPoohMain('sub1', 1), [
        { id: 'in', position: { x: 100, y: 50 } },
        { id: 'vi', position: { x: 400, y: 250 } },
      ]),
    );
    const sizes = new Map([['vi', { width: 210, height: 152 }]]);
    const group = graphOf(createGroup(placed, 'Intake', ['in', 'vi'], sizes)).groups.at(-1);
    // `in` has no measurement and falls back to NODE_SIZE; `vi` is 152 px high.
    expect(group).toMatchObject({
      position: { x: 76, y: 26 },
      size: { width: 300 + 210 + 48, height: 200 + 152 + 48 },
    });
  });

  it('createGroup refuses at 100 groups and without nodes', () => {
    const g = chainMainReplace();
    const groups = Array.from({ length: 100 }, (_, i) => ({
      id: `g${i}`,
      name: 'G',
      collapsed: false,
      position: { x: 0, y: 0 },
      size: { width: 1, height: 1 },
    }));
    expect(createGroup({ ...g, groups }, 'G', ['in'])).toEqual({
      ok: false,
      refusal: { reason: 'A workflow can have at most 100 groups' },
    });
    expect(createGroup(g, 'G', [])).toEqual({
      ok: false,
      refusal: { reason: 'Select at least one node to group' },
    });
  });

  it('joinGroup grows the box around the measured card (a tall card) plus padding', () => {
    const g: WorkflowGraph = {
      ...chainMainReplace(),
      groups: [
        {
          id: 'g1',
          name: 'Audio',
          collapsed: false,
          position: { x: 600, y: 300 },
          size: { width: 300, height: 200 },
        },
      ],
    };
    // keep at (280, 0); a 210 × 640 card reaches y = 640, + 24 padding.
    const tall = graphOf(joinGroup(g, 'keep', 'g1', { width: 210, height: 640 }));
    expect(nodeOf(tall, 'keep').groupId).toBe('g1');
    expect(tall.groups[0]).toMatchObject({
      position: { x: 256, y: -24 },
      size: { width: 644, height: 688 },
    });
    // Without a measured size the card counts as NODE_SIZE (210 × 120).
    expect(graphOf(joinGroup(g, 'keep', 'g1')).groups[0]?.size).toEqual({
      width: 644,
      height: 524,
    });
    // Leaving keeps the box; an unknown group is refused.
    const left = graphOf(joinGroup(tall, 'keep', undefined));
    expect('groupId' in nodeOf(left, 'keep')).toBe(false);
    expect(left.groups[0]).toEqual(tall.groups[0]);
    expect(joinGroup(g, 'keep', 'nope').ok).toBe(false);
  });

  it('renameGroup refuses an empty or blank name', () => {
    const g = tiggerPoohMain('sub1', 1);
    for (const name of ['', '   ']) {
      expect(renameGroup(g, 'cleanup', name)).toEqual({
        ok: false,
        refusal: { reason: 'A group needs a name' },
      });
    }
    expect(DEFAULT_GROUP_NAME).toBe('Group');
  });

  it('setNodeGroup sets and clears groupId and refuses an unknown group', () => {
    const g = tiggerPoohMain('sub1', 1);
    expect('groupId' in nodeOf(graphOf(setNodeGroup(g, 'run-a', undefined)), 'run-a')).toBe(false);
    expect(nodeOf(graphOf(setNodeGroup(g, 'ca', 'cleanup')), 'ca').groupId).toBe('cleanup');
    expect(setNodeGroup(g, 'ca', 'nope')).toEqual({
      ok: false,
      refusal: { reason: 'That group no longer exists' },
    });
  });

  it('setPinnedVersion changes only the version of a Run node', () => {
    const g = graphOf(setPinnedVersion(tiggerPoohMain('sub1', 3), 'run-a', 4));
    expect(nodeOf(g, 'run-a').settings).toEqual({
      subworkflowId: 'sub1',
      version: 4,
      overrides: { 'keep.languages': ['en', 'de', 'tr'] },
    });
    expect(nodeOf(g, 'run-b').settings).toMatchObject({ version: 3 });
    expect(setPinnedVersion(g, 'ca', 2)).toEqual({
      ok: false,
      refusal: { reason: 'That node does not run a sub-workflow' },
    });
  });

  it('setOverride(undefined) deletes the key and keeps overrides an object', () => {
    const g = tiggerPoohMain('sub1', 1);
    const set = graphOf(setOverride(g, 'run-a', 'sdt.audioLanguages', ['de']));
    expect(nodeOf(set, 'run-a').settings).toMatchObject({
      overrides: { 'keep.languages': ['en', 'de', 'tr'], 'sdt.audioLanguages': ['de'] },
    });
    const cleared = graphOf(
      setOverride(
        graphOf(setOverride(set, 'run-a', 'keep.languages', undefined)),
        'run-a',
        'sdt.audioLanguages',
        undefined,
      ),
    );
    expect(nodeOf(cleared, 'run-a').settings).toEqual({
      subworkflowId: 'sub1',
      version: 1,
      overrides: {},
    });
    // a Run node whose settings are not an object (or lack overrides) still gets an object
    const broken = graphOf(setSettings(g, 'run-b', null));
    expect(nodeOf(graphOf(setOverride(broken, 'run-b', 'k', 1)), 'run-b').settings).toEqual({
      overrides: { k: 1 },
    });
    expect(nodeOf(g, 'run-a').settings).toMatchObject({
      overrides: { 'keep.languages': ['en', 'de', 'tr'] },
    });
  });
  it('addNode and duplicateNode follow the placement rules of the server', () => {
    const refusal = (reason: string) => ({ ok: false, refusal: { reason } });
    const main = oneTrigger();
    expect(addNode(main, 'core:input-webhook', { x: 0, y: 0 }, catalog)).toEqual(
      refusal('A workflow has exactly one trigger'),
    );
    expect(duplicateNode(main, 'in', catalog)).toEqual(
      refusal('A workflow has exactly one trigger'),
    );
    expect(addNode(main, 'core:subworkflow-end', { x: 0, y: 0 }, catalog)).toEqual(
      refusal('End is not allowed in a workflow'),
    );
    expect(addNode(emptyGraph('workflow'), 'core:input-manual', { x: 0, y: 0 }, catalog).ok).toBe(
      true,
    );

    const sub = tiggerPoohSub();
    expect(addNode(sub, 'core:subworkflow-start', { x: 0, y: 0 }, catalog)).toEqual(
      refusal('A sub-workflow has exactly one start'),
    );
    expect(duplicateNode(sub, 'start', catalog)).toEqual(
      refusal('A sub-workflow has exactly one start'),
    );
    expect(addNode(sub, 'core:input-manual', { x: 0, y: 0 }, catalog)).toEqual(
      refusal('Manual input is not allowed in a sub-workflow'),
    );
    expect(addNode(sub, 'core:replace-original', { x: 0, y: 0 }, catalog)).toEqual(
      refusal('Replace original is not allowed in a sub-workflow'),
    );
    // a second End is allowed
    expect(addNode(sub, 'core:subworkflow-end', { x: 0, y: 0 }, catalog).ok).toBe(true);
    expect(graphOf(duplicateNode(sub, 'end', catalog)).nodes).toHaveLength(sub.nodes.length + 1);

    const unknown: WorkflowGraph = {
      ...main,
      nodes: [...main.nodes, { ...nodeOf(main, 'in'), id: 'x', type: 'acme:gone' }],
    };
    expect(duplicateNode(unknown, 'x', catalog)).toEqual(refusal('Unknown node type acme:gone'));
  });

  it('addNode refuses an id that is already taken', () => {
    expect(
      addNode(chainMainReplace(), 'core:remux', { x: 0, y: 0 }, catalog, { id: 'keep' }),
    ).toEqual({ ok: false, refusal: { reason: 'A node with the id keep already exists' } });
  });

  it('setLabel refuses labels longer than 120 characters', () => {
    const g = chainMainReplace();
    expect(nodeOf(graphOf(setLabel(g, 'keep', 'x'.repeat(120))), 'keep').label).toHaveLength(120);
    expect(setLabel(g, 'keep', 'x'.repeat(121))).toEqual({
      ok: false,
      refusal: { reason: 'A label can be at most 120 characters' },
    });
  });

  it('setPinnedVersion refuses versions that are not whole numbers of at least 1', () => {
    const g = tiggerPoohMain('sub1', 3);
    for (const version of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(setPinnedVersion(g, 'run-a', version)).toEqual({
        ok: false,
        refusal: { reason: 'The pinned version must be a whole number of at least 1' },
      });
    }
    expect(nodeOf(graphOf(setPinnedVersion(g, 'run-a', 1)), 'run-a').settings).toMatchObject({
      version: 1,
    });
  });
});

describe('removeSelection', () => {
  it('disconnects edges, ungroups a group and removes nodes in one result; refusals pass through', () => {
    const g = tiggerPoohMain('sub', 1);
    const group = g.groups[0];
    if (!group) throw new Error('fixture has a group');
    const member = g.nodes.find((n) => n.groupId === group.id);
    const edge = g.edges.find((e) => e.from.node !== member?.id && e.to.node !== member?.id);
    const loose = g.nodes.find((n) => n.groupId === undefined && n.type !== 'core:input-manual');
    if (!member || !edge || !loose) throw new Error('fixture shape');
    const r = removeSelection(g, { nodes: [loose.id], edges: [edge.id], group: group.id });
    if (!r.ok) throw new Error(r.refusal.reason);
    expect(r.graph.groups).toHaveLength(0);
    expect(r.graph.nodes.find((n) => n.id === member.id)?.groupId).toBeUndefined();
    expect(r.graph.nodes.some((n) => n.id === loose.id)).toBe(false);
    expect(r.graph.edges.some((e) => e.id === edge.id)).toBe(false);

    const sub = tiggerPoohSub();
    const start = sub.nodes.find((n) => n.type === 'core:subworkflow-start');
    if (!start) throw new Error('fixture has a start');
    const refused = removeSelection(sub, { nodes: [start.id], edges: [] });
    expect(refused).toEqual({
      ok: false,
      refusal: { reason: 'A sub-workflow needs its start and end' },
    });
  });
});
