import type { Edge, NodeInstance, WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { catalogFixture } from '../../test/fixtures/catalog.ts';
import { tvCleanupMain } from '../../test/fixtures/tv-cleanup.ts';
import { GROUP_PADDING, NODE_SIZE, type Position, type Size } from './graph-ops.ts';
import { tidyUp } from './layout.ts';

const node = (id: string, type: string, x: number, y: number): NodeInstance => ({
  id,
  type,
  typeVersion: 1,
  settings: {},
  position: { x, y },
});

const edge = (from: string, to: string, fromPort = 'file'): Edge => ({
  id: `${from}-${to}`,
  from: { node: from, port: fromPort },
  to: { node: to, port: 'file' },
});

const graph = (nodes: NodeInstance[], edges: Edge[]): WorkflowGraph => ({
  formatVersion: 2,
  kind: 'workflow',
  nodes,
  edges,
  groups: [],
});

/** Jan's v8: the chain drifted up and down the canvas. */
function zigZag(): WorkflowGraph {
  return graph(
    [
      node('in', 'core:input-manual', -400, 40),
      node('ro', 'core:reorder-tracks', 0, 0),
      node('ea', 'core:encode-audio', 20, 240),
      node('dd', 'core:remux', 160, 420),
      node('ev', 'core:encode-video', 480, 250),
      node('sg', 'core:size-gate', 600, 0),
      node('rep', 'core:replace-original', 920, 0),
    ],
    [
      edge('in', 'ro'),
      edge('ro', 'ea'),
      edge('ea', 'dd'),
      edge('dd', 'ev'),
      edge('ev', 'sg'),
      edge('sg', 'rep', 'pass'),
    ],
  );
}

function laidOut(g: WorkflowGraph, opts: Parameters<typeof tidyUp>[1] = {}): WorkflowGraph {
  const r = tidyUp(g, { catalog: catalogFixture, ...opts });
  if (!r.ok) throw new Error(r.refusal.reason);
  return r.graph;
}

const at = (g: WorkflowGraph, id: string): Position => {
  const n = g.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n.position;
};

type Box = { id: string; x: number; y: number; width: number; height: number };

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Every pair of top-level boxes (ungrouped cards and groups) is apart. */
function expectNoOverlap(g: WorkflowGraph, sizes: ReadonlyMap<string, Size> = new Map()) {
  const boxes: Box[] = [
    ...g.nodes
      .filter((n) => n.groupId === undefined)
      .map((n) => ({ id: n.id, ...n.position, ...(sizes.get(n.id) ?? NODE_SIZE) })),
    ...g.groups.map((gr) => ({ id: gr.id, ...gr.position, ...gr.size })),
  ];
  for (const a of boxes) {
    for (const b of boxes) {
      if (a.id < b.id) expect(intersects(a, b), `${a.id} overlaps ${b.id}`).toBe(false);
    }
  }
}

describe('tidyUp', () => {
  it('lines a chain up on one row, left to right in graph order, trigger first', () => {
    const g = laidOut(zigZag());
    const order = ['in', 'ro', 'ea', 'dd', 'ev', 'sg', 'rep'];
    const ys = new Set(order.map((id) => at(g, id).y));
    expect(ys.size).toBe(1);
    for (let i = 1; i < order.length; i++) {
      const prev = at(g, order[i - 1] as string).x;
      expect(at(g, order[i] as string).x).toBeGreaterThanOrEqual(prev + NODE_SIZE.width + 40);
    }
    expectNoOverlap(g);
  });

  it('keeps the layout where the graph was (its top-left corner)', () => {
    const g = laidOut(zigZag());
    expect(at(g, 'in')).toEqual({ x: -400, y: 0 });
  });

  it('changes only positions: edges, settings and ids stay, the input is not mutated', () => {
    const before = zigZag();
    const copy = structuredClone(before);
    const g = laidOut(before);
    expect(before).toEqual(copy);
    expect(g.edges).toEqual(before.edges);
    expect(g.nodes.map(({ position: _, ...rest }) => rest)).toEqual(
      before.nodes.map(({ position: _, ...rest }) => rest),
    );
  });

  it('puts the Yes branch on the condition’s row and the No branch on a row below', () => {
    const g = laidOut(
      graph(
        [
          node('in', 'core:input-manual', 0, 0),
          node('vi', 'core:video-is', 300, 300),
          // The "No" branch drawn above the "Yes" one: tidying swaps them back.
          node('ev', 'core:encode-video', 600, -200),
          node('rep-b', 'core:replace-original', 900, -200),
          node('ea', 'core:encode-audio', 600, 400),
          node('rep-a', 'core:replace-original', 900, 400),
        ],
        [
          edge('in', 'vi'),
          edge('vi', 'ev', 'else'),
          edge('ev', 'rep-b'),
          edge('vi', 'ea', 'pass'),
          edge('ea', 'rep-a'),
        ],
      ),
    );
    const row0 = at(g, 'in').y;
    expect(at(g, 'vi').y).toBe(row0);
    expect(at(g, 'ea').y).toBe(row0);
    expect(at(g, 'rep-a').y).toBe(row0);
    expect(at(g, 'ev').y).toBeGreaterThanOrEqual(row0 + NODE_SIZE.height + 40);
    expect(at(g, 'rep-b').y).toBe(at(g, 'ev').y);
    // Both branches start in the column after the condition.
    expect(at(g, 'ev').x).toBe(at(g, 'ea').x);
    expectNoOverlap(g);
  });

  it('places a node after its longest path in (a branch that merges back)', () => {
    const g = laidOut(
      graph(
        [
          node('in', 'core:input-manual', 0, 0),
          node('vi', 'core:video-is', 0, 300),
          node('ev', 'core:encode-video', 0, 600),
          node('rep', 'core:replace-original', 0, 900),
        ],
        [edge('in', 'vi'), edge('vi', 'ev', 'else'), edge('ev', 'rep'), edge('vi', 'rep', 'pass')],
      ),
    );
    expect(at(g, 'rep').x).toBeGreaterThan(at(g, 'ev').x);
    expect(at(g, 'rep').y).toBe(at(g, 'in').y);
    expectNoOverlap(g);
  });

  it('keeps groups intact: members inside their box, nothing else in it', () => {
    const before = tvCleanupMain('sub', 1);
    // Scramble every position.
    const scrambled: WorkflowGraph = {
      ...before,
      nodes: before.nodes.map((n, i) => ({ ...n, position: { x: (i * 137) % 500, y: i * 61 } })),
    };
    const g = laidOut(scrambled);
    expect(g.nodes.map((n) => n.groupId)).toEqual(before.nodes.map((n) => n.groupId));
    const [group] = g.groups;
    if (!group) throw new Error('no group');
    for (const n of g.nodes.filter((m) => m.groupId === group.id)) {
      expect(n.position.x).toBeGreaterThanOrEqual(group.position.x + GROUP_PADDING);
      expect(n.position.y).toBeGreaterThanOrEqual(group.position.y + GROUP_PADDING);
      expect(n.position.x + NODE_SIZE.width).toBeLessThanOrEqual(
        group.position.x + group.size.width - GROUP_PADDING,
      );
      expect(n.position.y + NODE_SIZE.height).toBeLessThanOrEqual(
        group.position.y + group.size.height - GROUP_PADDING,
      );
    }
    // The group's two runs are on separate rows of the group.
    expect(at(g, 'run-a').y).not.toBe(at(g, 'run-b').y);
    // Trigger first, the group after "Video is", the last finish after the group.
    expect(at(g, 'in').x).toBeLessThan(at(g, 'vi').x);
    expect(group.position.x).toBeGreaterThan(at(g, 'vi').x);
    expect(at(g, 'ro-a').x).toBeGreaterThan(group.position.x + group.size.width);
    expectNoOverlap(g);
  });

  it('a collapsed group takes the tile’s room and its members move with it', () => {
    const before = tvCleanupMain('sub', 1);
    const collapsed: WorkflowGraph = {
      ...before,
      groups: before.groups.map((gr) => ({ ...gr, collapsed: true })),
    };
    const tile = { width: 210, height: 60 };
    const g = laidOut(collapsed, { collapsedGroupSize: tile });
    const [group] = g.groups;
    if (!group) throw new Error('no group');
    expect(group.collapsed).toBe(true);
    // The tile is followed at a card's distance, not the expanded box's.
    const next = at(g, 'ca');
    expect(next.x - (group.position.x + tile.width)).toBeLessThan(200);
    expect(at(g, 'run-a').x).toBe(group.position.x + GROUP_PADDING);
  });

  it('spaces rows by the measured card sizes', () => {
    const g0 = graph(
      [
        node('in', 'core:input-manual', 0, 0),
        node('vi', 'core:video-is', 0, 0),
        node('a', 'core:encode-audio', 0, 0),
        node('b', 'core:encode-video', 0, 0),
      ],
      [edge('in', 'vi'), edge('vi', 'a', 'pass'), edge('vi', 'b', 'else')],
    );
    const sizes = new Map([['a', { width: 210, height: 400 }]]);
    const g = laidOut(g0, { sizes });
    expect(at(g, 'b').y).toBeGreaterThanOrEqual(at(g, 'a').y + 400);
    expectNoOverlap(g, sizes);
  });

  it('never spaces by less than a card (zoomed out, cards measure as small tiles)', () => {
    const tiles = new Map(zigZag().nodes.map((n) => [n.id, { width: 80, height: 80 }]));
    const g = laidOut(zigZag(), { sizes: tiles });
    expect(at(g, 'ro').x - at(g, 'in').x).toBeGreaterThanOrEqual(NODE_SIZE.width + 40);
  });

  it('places unconnected nodes and survives a cycle', () => {
    const g = laidOut(
      graph(
        [
          node('in', 'core:input-manual', 0, 0),
          node('a', 'core:encode-audio', 0, 0),
          node('b', 'core:encode-video', 0, 0),
          node('lonely', 'core:remux', 0, 0),
        ],
        [edge('in', 'a'), edge('a', 'b'), edge('b', 'a')],
      ),
    );
    expect(at(g, 'a').x).toBeLessThan(at(g, 'b').x);
    expectNoOverlap(g);
  });

  it('leaves an empty graph as it is', () => {
    const g0 = graph([], []);
    expect(laidOut(g0)).toEqual(g0);
  });

  it('works without a catalogue (ports in edge order)', () => {
    const r = tidyUp(zigZag());
    expect(r.ok).toBe(true);
  });
});
