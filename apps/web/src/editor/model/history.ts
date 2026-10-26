import type { WorkflowGraph } from '@transcoda/shared';

/** Undo/redo as stacks of immutable graphs; the newest entry is last in `past`, first in `future`. */
export interface History {
  past: WorkflowGraph[];
  future: WorkflowGraph[];
}

export const UNDO_DEPTH = 100;

function capped(past: WorkflowGraph[]): WorkflowGraph[] {
  return past.length > UNDO_DEPTH ? past.slice(past.length - UNDO_DEPTH) : past;
}

/** Records `current` before it is replaced; drops the oldest step beyond 100 and clears redo. */
export function push(h: History, current: WorkflowGraph): History {
  return { past: capped([...h.past, current]), future: [] };
}

export function undo(
  h: History,
  current: WorkflowGraph,
): { history: History; graph: WorkflowGraph } | null {
  const graph = h.past[h.past.length - 1];
  if (!graph) return null;
  return { graph, history: { past: h.past.slice(0, -1), future: [current, ...h.future] } };
}

export function redo(
  h: History,
  current: WorkflowGraph,
): { history: History; graph: WorkflowGraph } | null {
  const [graph, ...future] = h.future;
  if (!graph) return null;
  return { graph, history: { past: capped([...h.past, current]), future } };
}
