import type { WorkflowGraph } from '@transcoda/shared';
import type { NodeChange } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { catalogFixture } from '../../test/fixtures/catalog.ts';
import { chainMainReplace, tiggerPoohMain, tiggerPoohSub } from '../../test/fixtures/graphs.ts';
import { graphEquals } from '../model/equality.ts';
import { type FlowChangeResult, fromEdgeChanges, fromNodeChanges } from './fromFlow.ts';
import { toFlow } from './toFlow.ts';

const none = { nodes: [], edges: [] };

/** Cleanup group at {100,100} sized 400×200, run-a at absolute {160,140}, run-b at {350,180}. */
function grouped(): WorkflowGraph {
  const g = tiggerPoohMain('sub', 1);
  return {
    ...g,
    nodes: g.nodes.map((n) =>
      n.id === 'run-a'
        ? { ...n, position: { x: 160, y: 140 } }
        : n.id === 'run-b'
          ? { ...n, position: { x: 350, y: 180 } }
          : n,
    ),
    groups: g.groups.map((gr) => ({ ...gr, position: { x: 100, y: 100 } })),
  };
}

/** Folds the op results over `g`; a refusal fails the test. */
function apply(results: FlowChangeResult[], g: WorkflowGraph): WorkflowGraph {
  let graph = g;
  for (const r of results) {
    if (r && 'op' in r) {
      const out = r.op(graph);
      if (!out.ok) throw new Error(out.refusal.reason);
      graph = out.graph;
    }
  }
  return graph;
}

const ops = (results: FlowChangeResult[]) => results.filter((r) => r !== null && 'op' in r);
const pos = (g: WorkflowGraph, id: string) => g.nodes.find((n) => n.id === id)?.position;

describe('fromNodeChanges', () => {
  it('moving the values card stores its position; deleting it removes it; its lines never change the graph', () => {
    const g: WorkflowGraph = {
      ...chainMainReplace(),
      values: { position: { x: 0, y: 0 }, entries: [] },
    };
    const flow = toFlow(g, catalogFixture, [], none);
    const moved = apply(
      fromNodeChanges(
        [{ type: 'position', id: '~values', position: { x: 40.4, y: -80 }, dragging: false }],
        g,
        flow.nodes,
      ),
      g,
    );
    expect(moved.values?.position).toEqual({ x: 40, y: -80 });
    const removed = apply(fromNodeChanges([{ type: 'remove', id: '~values' }], g, flow.nodes), g);
    expect(removed.values).toBeUndefined();
    expect(
      fromNodeChanges([{ type: 'select', id: '~values', selected: true }], g, flow.nodes),
    ).toEqual([{ select: { nodes: [], edges: [], group: '~values' } }]);
    const line = {
      id: '~link:a',
      type: 'tc-link',
      source: '~values',
      target: 'a',
      data: {},
    } as const;
    expect(fromEdgeChanges([{ type: 'remove', id: '~link:a' }], [line])).toEqual([]);
  });

  it('position changes map back to absolute coordinates and coalesce as moves', () => {
    const g = grouped();
    const { nodes } = toFlow(g, catalogFixture, [], none);
    const results = fromNodeChanges(
      [
        { id: 'run-a', type: 'position', position: { x: 80, y: 50 }, dragging: false },
        { id: 'in', type: 'position', position: { x: -20, y: 30 }, dragging: false },
      ],
      g,
      nodes,
    );
    expect(ops(results)).toHaveLength(1);
    expect(results[0]).toMatchObject({ coalesce: 'move' });
    const next = apply(results, g);
    expect(pos(next, 'run-a')).toEqual({ x: 180, y: 150 });
    expect(pos(next, 'in')).toEqual({ x: -20, y: 30 });
    expect(next.nodes.find((n) => n.id === 'run-a')?.groupId).toBe('cleanup');
  });

  it('a drop at a fractional position (any zoom) stores whole pixels', () => {
    const g = grouped();
    const { nodes } = toFlow(g, catalogFixture, [], none);
    const results = fromNodeChanges(
      [
        { id: 'in', type: 'position', position: { x: 275.9756, y: 365.2138 }, dragging: false },
        { id: 'run-a', type: 'position', position: { x: 80.5, y: 49.4 }, dragging: false },
      ],
      g,
      nodes,
    );
    const next = apply(results, g);
    expect(pos(next, 'in')).toEqual({ x: 276, y: 365 });
    expect(pos(next, 'run-a')).toEqual({ x: 181, y: 149 });
  });

  it('ignores position changes while a drag is still in progress', () => {
    const g = grouped();
    const { nodes } = toFlow(g, catalogFixture, [], none);
    const changes: NodeChange[] = [
      { id: 'in', type: 'position', position: { x: 5, y: 5 }, dragging: true },
    ];
    expect(fromNodeChanges(changes, g, nodes)).toEqual([]);
  });

  it('round trip: toFlow then fromFlow with no changes yields a graph equal to the input', () => {
    for (const g of [grouped(), chainMainReplace(), tiggerPoohSub()]) {
      const { nodes } = toFlow(g, catalogFixture, [], none);
      expect(graphEquals(apply(fromNodeChanges([], g, nodes), g), g)).toBe(true);
      // Dropping every node where it already is changes nothing either.
      const inPlace: NodeChange[] = nodes.map((n) => ({
        id: n.id,
        type: 'position',
        position: n.position,
        dragging: false,
      }));
      expect(graphEquals(apply(fromNodeChanges(inPlace, g, nodes), g), g)).toBe(true);
    }
  });

  it('a child dragged outside its group becomes ungrouped at its absolute position', () => {
    const g = grouped();
    const { nodes } = toFlow(g, catalogFixture, [], none);
    const next = apply(
      fromNodeChanges(
        [{ id: 'run-a', type: 'position', position: { x: 500, y: 40 }, dragging: false }],
        g,
        nodes,
      ),
      g,
    );
    const runA = next.nodes.find((n) => n.id === 'run-a');
    expect(runA?.groupId).toBeUndefined();
    expect(runA && 'groupId' in runA).toBe(false);
    expect(runA?.position).toEqual({ x: 600, y: 140 });
    expect(next.nodes.find((n) => n.id === 'run-b')?.groupId).toBe('cleanup');
  });

  it('a child nudged within its group stays grouped', () => {
    const g = grouped();
    const { nodes } = toFlow(g, catalogFixture, [], none);
    const next = apply(
      fromNodeChanges(
        [{ id: 'run-a', type: 'position', position: { x: 70, y: 40 }, dragging: false }],
        g,
        nodes,
      ),
      g,
    );
    expect(next.nodes.find((n) => n.id === 'run-a')).toMatchObject({
      groupId: 'cleanup',
      position: { x: 170, y: 140 },
    });
  });

  it('at icon zoom group membership on drop follows the 48 px tile, not the full card', () => {
    const g = grouped();
    // React Flow measures the cards as N9 icon tiles below 40 % zoom.
    const nodes = toFlow(g, catalogFixture, [], none).nodes.map((n) => ({
      ...n,
      measured: n.type === 'tc-node' ? { width: 48, height: 48 } : { width: 400, height: 200 },
    }));
    const drop = (x: number, y: number) =>
      apply(
        fromNodeChanges(
          [{ id: 'run-a', type: 'position', position: { x, y }, dragging: false }],
          g,
          nodes,
        ),
        g,
      ).nodes.find((n) => n.id === 'run-a')?.groupId;
    // Tile centre (364, 174) is inside the 400 × 200 box; a full card's (445, 210) would not be.
    expect(drop(340, 150)).toBe('cleanup');
    // Tile centre (414, 64) is outside on the right.
    expect(drop(390, 40)).toBeUndefined();
  });

  it('dragging a group moves the group and keeps its members at the same relative place', () => {
    const g = grouped();
    const { nodes } = toFlow(g, catalogFixture, [], none);
    const results = fromNodeChanges(
      [{ id: 'cleanup', type: 'position', position: { x: 150, y: 80 }, dragging: false }],
      g,
      nodes,
    );
    expect(results[0]).toMatchObject({ coalesce: 'move' });
    const next = apply(results, g);
    expect(next.groups[0]).toMatchObject({
      position: { x: 150, y: 80 },
      size: { width: 400, height: 200 },
    });
    expect(pos(next, 'run-a')).toEqual({ x: 210, y: 120 });
    expect(pos(next, 'run-b')).toEqual({ x: 400, y: 160 });
    expect(pos(next, 'in')).toEqual({ x: 0, y: 0 });
  });

  it('resizing a group from its top-left corner keeps its members in place', () => {
    const g = grouped();
    const { nodes } = toFlow(g, catalogFixture, [], none);
    // React Flow's resizer moves the group and compensates the children's relative positions.
    const results = fromNodeChanges(
      [
        { id: 'cleanup', type: 'position', position: { x: 90, y: 80 } },
        {
          id: 'cleanup',
          type: 'dimensions',
          resizing: true,
          setAttributes: true,
          dimensions: { width: 410, height: 220 },
        },
        { id: 'run-a', type: 'position', position: { x: 70, y: 60 } },
        { id: 'run-b', type: 'position', position: { x: 260, y: 100 } },
      ],
      g,
      nodes,
    );
    expect(results[0]).toMatchObject({ coalesce: 'move' });
    const next = apply(results, g);
    expect(next.groups[0]).toMatchObject({
      position: { x: 90, y: 80 },
      size: { width: 410, height: 220 },
    });
    expect(pos(next, 'run-a')).toEqual({ x: 160, y: 140 });
    expect(pos(next, 'run-b')).toEqual({ x: 350, y: 180 });
    expect(next.nodes.filter((n) => n.groupId === 'cleanup')).toHaveLength(2);
  });

  it('the end of a resize sets the group size', () => {
    const g = grouped();
    const { nodes } = toFlow(g, catalogFixture, [], none);
    const next = apply(
      fromNodeChanges(
        [
          {
            id: 'cleanup',
            type: 'dimensions',
            resizing: false,
            dimensions: { width: 500, height: 260 },
          },
        ],
        g,
        nodes,
      ),
      g,
    );
    expect(next.groups[0]).toMatchObject({
      position: { x: 100, y: 100 },
      size: { width: 500, height: 260 },
    });
  });

  it('ignores dimension and selection-only changes for plain nodes', () => {
    const g = grouped();
    const { nodes } = toFlow(g, catalogFixture, [], none);
    const measured: NodeChange[] = [
      { id: 'in', type: 'dimensions', dimensions: { width: 210, height: 130 } },
      { id: 'cleanup', type: 'dimensions', dimensions: { width: 400, height: 200 } },
    ];
    expect(fromNodeChanges(measured, g, nodes)).toEqual([]);
    const selected = fromNodeChanges([{ id: 'in', type: 'select', selected: true }], g, nodes);
    expect(ops(selected)).toEqual([]);
    expect(selected).toEqual([{ select: { nodes: ['in'], edges: [] } }]);
  });

  it('selection changes give the next node and group selection', () => {
    const g = grouped();
    const { nodes } = toFlow(g, catalogFixture, [], { nodes: ['in', 'vi'], edges: [] });
    expect(
      fromNodeChanges(
        [
          { id: 'in', type: 'select', selected: false },
          { id: 'cleanup', type: 'select', selected: true },
        ],
        g,
        nodes,
      ),
    ).toEqual([{ select: { nodes: ['vi'], edges: [], group: 'cleanup' } }]);
  });

  it('remove changes delete nodes and ungroup removed groups', () => {
    const g = grouped();
    const { nodes } = toFlow(g, catalogFixture, [], none);
    const next = apply(
      fromNodeChanges(
        [
          { id: 'cleanup', type: 'remove' },
          { id: 'ca', type: 'remove' },
        ],
        g,
        nodes,
      ),
      g,
    );
    expect(next.groups).toEqual([]);
    expect(next.nodes.map((n) => n.id)).not.toContain('ca');
    expect(next.nodes.find((n) => n.id === 'run-a')?.groupId).toBeUndefined();
    expect(next.edges.some((e) => e.from.node === 'ca' || e.to.node === 'ca')).toBe(false);
  });

  it('a refused removal comes back as a refusal, not a silent no-op', () => {
    const g = tiggerPoohSub();
    const { nodes } = toFlow(g, catalogFixture, [], none);
    const [result] = fromNodeChanges([{ id: 'start', type: 'remove' }], g, nodes);
    expect(result && 'op' in result && result.op(g)).toEqual({
      ok: false,
      refusal: { reason: 'A sub-workflow needs its start and end' },
    });
  });
});

describe('fromEdgeChanges', () => {
  it('remove disconnects and select gives the next edge selection', () => {
    const g = chainMainReplace();
    const { edges } = toFlow(g, catalogFixture, [], { nodes: [], edges: ['in-keep'] });
    const results = fromEdgeChanges(
      [
        { id: 'keep-ro', type: 'remove' },
        { id: 'in-keep', type: 'select', selected: false },
      ],
      edges,
    );
    expect(apply(results, g).edges.map((e) => e.id)).toEqual(['in-keep']);
    expect(results.filter((r) => r !== null && 'select' in r)).toEqual([
      { select: { nodes: [], edges: [] } },
    ]);
    expect(
      fromEdgeChanges([{ id: 'keep-ro', type: 'select', selected: true }], edges).at(-1),
    ).toEqual({ select: { nodes: [], edges: ['in-keep', 'keep-ro'] } });
  });
});
