import type { WorkflowGraph } from '@transcoda/shared';
import { NODE_SIZE, type Position } from './graph-ops.ts';

/** The visible part of the canvas in flow coordinates. */
export type ViewRect = { x: number; y: number; width: number; height: number };

/** Horizontal step between a node and the one added after it (no view known). */
const NEXT_STEP_X = NODE_SIZE.width + 70;
/** Search grid inside the view: the duplicate offset, coarser on a zoomed-out view. */
const MIN_STEP = 40;
const MAX_STEPS_PER_AXIS = 60;
/** The duplicate offset, used when the view has no free spot left. */
const CASCADE = 40;

/** Room kept around a card: cards with several ports are taller than the nominal 120 px. */
const CLEARANCE = { x: 40, y: 60 };
/** Vertical distance counts more, so a new card prefers the right (flows run left to right). */
const VERTICAL_WEIGHT = 1.5;

function overlaps(g: WorkflowGraph, p: Position): boolean {
  return g.nodes.some(
    (n) =>
      Math.abs(n.position.x - p.x) < NODE_SIZE.width + CLEARANCE.x &&
      Math.abs(n.position.y - p.y) < NODE_SIZE.height + CLEARANCE.y,
  );
}

/** A full view: step +40/+40 from `pos` (kept inside the view) until no card starts there. */
function cascade(g: WorkflowGraph, pos: Position, maxX: number, maxY: number): Position {
  const taken = new Set(g.nodes.map((n) => `${n.position.x},${n.position.y}`));
  for (let k = 0; k < 50; k++) {
    const p = {
      x: Math.round(Math.min(pos.x + k * CASCADE, maxX)),
      y: Math.round(Math.min(pos.y + k * CASCADE, maxY)),
    };
    if (!taken.has(`${p.x},${p.y}`)) return p;
  }
  return pos;
}

/**
 * Where a new card goes: `pos` when free. With a `view`, the free spot nearest to `pos` whose card
 * lies wholly inside the view (repeated adds never walk off-screen); when the view is full, `pos`
 * offset by +40/+40 steps (overlapping but visible, never exactly on another card). Without a
 * view, the first free spot to the right of `pos`.
 */
export function freeSpot(g: WorkflowGraph, pos: Position, view?: ViewRect): Position {
  if (!overlaps(g, pos)) return pos;
  if (!view) {
    let p = pos;
    for (let i = 0; i < 50 && overlaps(g, p); i++) p = { x: p.x + NEXT_STEP_X, y: p.y };
    return p;
  }
  const maxX = view.x + view.width - NODE_SIZE.width;
  const maxY = view.y + view.height - NODE_SIZE.height;
  if (maxX < view.x || maxY < view.y) return pos;
  const step = Math.max(
    MIN_STEP,
    (maxX - view.x) / MAX_STEPS_PER_AXIS,
    (maxY - view.y) / MAX_STEPS_PER_AXIS,
  );
  const candidates: Array<{ p: Position; d: number }> = [];
  // A grid through `pos`, so the nearest candidates are whole steps away from it.
  const range = (from: number, lo: number, hi: number) => {
    const out: number[] = [];
    for (let k = Math.ceil((lo - from) / step); from + k * step <= hi; k++)
      out.push(from + k * step);
    return out;
  };
  for (const x of range(pos.x, view.x, maxX)) {
    for (const y of range(pos.y, view.y, maxY)) {
      const p = { x: Math.round(x), y: Math.round(y) };
      candidates.push({ p, d: (p.x - pos.x) ** 2 + (VERTICAL_WEIGHT * (p.y - pos.y)) ** 2 });
    }
  }
  candidates.sort((a, b) => a.d - b.d);
  return candidates.find((c) => !overlaps(g, c.p))?.p ?? cascade(g, pos, maxX, maxY);
}
