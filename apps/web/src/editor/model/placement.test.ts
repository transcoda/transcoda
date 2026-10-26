import type { WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { chainMainReplace } from '../../test/fixtures/graphs.ts';
import { NODE_SIZE } from './graph-ops.ts';
import { freeSpot } from './placement.ts';

const overlaps = (g: WorkflowGraph, p: { x: number; y: number }) =>
  g.nodes.some(
    (n) =>
      Math.abs(n.position.x - p.x) < NODE_SIZE.width &&
      Math.abs(n.position.y - p.y) < NODE_SIZE.height,
  );

describe('freeSpot', () => {
  it('keeps a free target spot', () => {
    expect(freeSpot(chainMainReplace(), { x: 0, y: 400 })).toEqual({ x: 0, y: 400 });
  });

  it('without a view steps right of an occupied spot', () => {
    const p = freeSpot(chainMainReplace(), { x: 0, y: 0 });
    expect(p.y).toBe(0);
    expect(overlaps(chainMainReplace(), p)).toBe(false);
  });

  it('repeated adds at the centre stay inside the view and never overlap', () => {
    const view = { x: -300, y: -400, width: 1400, height: 900 };
    let g = chainMainReplace();
    for (let i = 0; i < 6; i++) {
      const p = freeSpot(g, { x: 280, y: 0 }, view);
      expect(overlaps(g, p)).toBe(false);
      expect(p.x).toBeGreaterThanOrEqual(view.x);
      expect(p.y).toBeGreaterThanOrEqual(view.y);
      expect(p.x + NODE_SIZE.width).toBeLessThanOrEqual(view.x + view.width);
      expect(p.y + NODE_SIZE.height).toBeLessThanOrEqual(view.y + view.height);
      g = {
        ...g,
        nodes: [...g.nodes, { id: `n${i}`, type: 'x', typeVersion: 1, settings: {}, position: p }],
      };
    }
  });

  it('a full view cascades +40/+40 from the target spot, inside the view', () => {
    const view = { x: 0, y: 0, width: 400, height: 300 };
    expect(freeSpot(chainMainReplace(), { x: 0, y: 0 }, view)).toEqual({ x: 40, y: 40 });
    const g = chainMainReplace();
    const crowded = {
      ...g,
      nodes: [
        ...g.nodes,
        { id: 'x', type: 'x', typeVersion: 1, settings: {}, position: { x: 40, y: 40 } },
      ],
    };
    expect(freeSpot(crowded, { x: 0, y: 0 }, view)).toEqual({ x: 80, y: 80 });
  });
});
