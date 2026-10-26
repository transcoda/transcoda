import { emptyGraph, type WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { type History, push, redo, UNDO_DEPTH, undo } from './history.ts';

function graph(n: number): WorkflowGraph {
  return {
    ...emptyGraph('workflow'),
    nodes: [
      {
        id: `n${n}`,
        type: 'core:input-manual',
        typeVersion: 1,
        settings: {},
        position: { x: n, y: 0 },
      },
    ],
  };
}

const empty: History = { past: [], future: [] };

describe('history', () => {
  it('push/undo/redo round-trip, redo cleared by a new push, depth capped at 100', () => {
    const [g0, g1, g2] = [graph(0), graph(1), graph(2)];
    expect(undo(empty, g0)).toBeNull();
    expect(redo(empty, g0)).toBeNull();

    // g0 → g1 → g2
    let h = push(push(empty, g0), g1);
    const back = undo(h, g2);
    expect(back?.graph).toBe(g1);
    const back2 = back && undo(back.history, back.graph);
    expect(back2?.graph).toBe(g0);
    expect(back2 && undo(back2.history, back2.graph)).toBeNull();
    const fwd = back2 && redo(back2.history, back2.graph);
    expect(fwd?.graph).toBe(g1);
    const fwd2 = fwd && redo(fwd.history, fwd.graph);
    expect(fwd2?.graph).toBe(g2);
    expect(fwd2 && redo(fwd2.history, fwd2.graph)).toBeNull();

    // A new push after an undo clears the redo stack.
    if (!back) throw new Error('no undo');
    h = push(back.history, back.graph);
    expect(h.future).toEqual([]);
    expect(redo(h, graph(3))).toBeNull();

    // Depth: the oldest step falls off beyond UNDO_DEPTH.
    expect(UNDO_DEPTH).toBe(100);
    let deep = empty;
    for (let i = 0; i < 105; i++) deep = push(deep, graph(i));
    expect(deep.past).toHaveLength(100);
    expect(deep.past[0]).toEqual(graph(5));
    expect(deep.past[99]).toEqual(graph(104));
  });

  it('redo keeps the depth cap too and never mutates its input', () => {
    let h = empty;
    for (let i = 0; i < 100; i++) h = push(h, graph(i));
    const back = undo(h, graph(100));
    if (!back) throw new Error('no undo');
    const frozen = structuredClone(back.history);
    const fwd = redo(back.history, back.graph);
    expect(fwd?.history.past).toHaveLength(100);
    expect(back.history).toEqual(frozen);
  });
});
