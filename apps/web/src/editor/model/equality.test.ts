import type { WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { chainMainReplace } from '../../test/fixtures/graphs.ts';
import { graphEquals, isLayoutOnlyChange } from './equality.ts';

function edit(fn: (g: WorkflowGraph) => void): WorkflowGraph {
  const g = chainMainReplace();
  fn(g);
  return g;
}

function nodeAt(g: WorkflowGraph, index: number) {
  const n = g.nodes[index];
  if (!n) throw new Error(`no node at ${index}`);
  return n;
}

describe('graphEquals', () => {
  it('ignores key order and isLayoutOnlyChange is true for moved nodes, renamed labels and group changes only', () => {
    const base = chainMainReplace();
    const reordered = edit((g) => {
      const keep = nodeAt(g, 1);
      g.nodes[1] = {
        settings: { keepUntagged: true, keepOriginal: true, languages: ['en'] },
        position: { y: keep.position.y, x: keep.position.x },
        typeVersion: keep.typeVersion,
        type: keep.type,
        id: keep.id,
      };
    });
    expect(graphEquals(base, reordered)).toBe(true);
    expect(graphEquals(base, chainMainReplace())).toBe(true);

    const layout = edit((g) => {
      nodeAt(g, 0).position = { x: 40, y: 40 };
      nodeAt(g, 1).label = 'Keep English';
      nodeAt(g, 2).groupId = 'grp';
      g.groups.push({
        id: 'grp',
        name: 'Finish',
        collapsed: true,
        position: { x: 500, y: -40 },
        size: { width: 300, height: 200 },
      });
      g.nodes.reverse();
      g.edges.reverse();
    });
    expect(graphEquals(base, layout)).toBe(false);
    expect(isLayoutOnlyChange(base, layout)).toBe(true);
    expect(isLayoutOnlyChange(base, chainMainReplace())).toBe(true);
  });

  it('isLayoutOnlyChange is false for a settings, bypass or edge change', () => {
    const base = chainMainReplace();
    const changes: Array<(g: WorkflowGraph) => void> = [
      (g) => {
        nodeAt(g, 1).settings = { languages: ['de'], keepOriginal: true, keepUntagged: true };
      },
      (g) => {
        nodeAt(g, 1).bypassed = true;
      },
      (g) => {
        g.edges.pop();
      },
      (g) => {
        const e = g.edges[1];
        if (e) g.edges[1] = { ...e, from: { node: 'in', port: 'file' } };
      },
      (g) => {
        nodeAt(g, 1).typeVersion = 2;
      },
      (g) => {
        nodeAt(g, 1).type = 'core:remux';
      },
      (g) => {
        g.nodes.push({ ...nodeAt(g, 2), id: 'ro2' });
      },
      (g) => {
        g.kind = 'subworkflow';
      },
    ];
    for (const change of changes) expect(isLayoutOnlyChange(base, edit(change))).toBe(false);
    // An explicit `bypassed: false` is the same as no key.
    const explicitFalse = edit((g) => {
      nodeAt(g, 1).bypassed = false;
    });
    expect(isLayoutOnlyChange(base, explicitFalse)).toBe(true);
    // Parallel edges count: a duplicated edge is a behaviour change.
    expect(
      isLayoutOnlyChange(
        base,
        edit((g) => {
          const e = g.edges[0];
          if (e) g.edges.push({ ...e, id: 'dup' });
        }),
      ),
    ).toBe(false);
  });
});
