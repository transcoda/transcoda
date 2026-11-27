import {
  CHECK_SOURCE_TYPE,
  type Edge,
  type Issue,
  type NodeInstance,
  SUBWORKFLOW_END_TYPE,
  SUBWORKFLOW_START_TYPE,
  type WorkflowGraph,
} from '@transcoda/shared';
import { defOf, error, title, warning } from './issues.ts';
import type { NodeState } from './types.ts';

// Checks 4 and 5: cycles, the kind rules (triggers, finishes, sub-workflow ends) and reachability.

/** Successor lists over existing edges; every node has an entry. */
export type Adjacency = Map<string, string[]>;

export function adjacency(graph: WorkflowGraph, edges: Edge[]): Adjacency {
  const next: Adjacency = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const e of edges) next.get(e.from.node)?.push(e.to.node);
  return next;
}

/**
 * Check 4: the first cycle found by DFS, as node ids with the first repeated at the end.
 * Iterative (explicit stack), so graph depth never reaches the call-stack limit.
 */
export function findCycle(graph: WorkflowGraph, next: Adjacency): string[] | null {
  const done = new Set<string>();
  const onStack = new Set<string>();
  for (const start of graph.nodes) {
    if (done.has(start.id)) continue;
    const path: string[] = [start.id];
    const cursor: number[] = [0];
    onStack.add(start.id);
    while (path.length > 0) {
      const top = path.length - 1;
      const id = path[top] as string;
      const successors = next.get(id) ?? [];
      const i = cursor[top] as number;
      if (i === successors.length) {
        path.pop();
        cursor.pop();
        onStack.delete(id);
        done.add(id);
        continue;
      }
      cursor[top] = i + 1;
      const to = successors[i] as string;
      if (onStack.has(to)) return [...path.slice(path.indexOf(to)), to];
      if (done.has(to)) continue;
      path.push(to);
      cursor.push(0);
      onStack.add(to);
    }
  }
  return null;
}

/** Every node reachable from `roots` along `next` (roots included). */
function closure(roots: Iterable<string>, next: Adjacency): Set<string> {
  const reached = new Set(roots);
  const work = [...reached];
  for (let id = work.pop(); id !== undefined; id = work.pop()) {
    for (const to of next.get(id) ?? []) {
      if (reached.has(to)) continue;
      reached.add(to);
      work.push(to);
    }
  }
  return reached;
}

/** Check 5: kind rules and reachability. */
export function checkKindRules(
  graph: WorkflowGraph,
  states: Map<string, NodeState>,
  edges: Edge[],
  next: Adjacency,
  issues: Issue[],
): void {
  const kindOf = (n: NodeInstance) => defOf(states.get(n.id))?.kind;
  const notAllowed = (n: NodeInstance, where: string) =>
    issues.push(
      error(
        'NODE_NOT_ALLOWED_HERE',
        `${title(n, defOf(states.get(n.id)))} is not allowed in ${where}`,
        {
          nodeId: n.id,
        },
      ),
    );
  let roots: NodeInstance[];
  if (graph.kind === 'workflow') {
    roots = graph.nodes.filter((n) => kindOf(n) === 'trigger');
    if (roots.length !== 1) {
      issues.push(
        error('TRIGGER_COUNT', `A workflow needs exactly one trigger; it has ${roots.length}`, {}),
      );
    }
    for (const n of graph.nodes) {
      if (n.type === SUBWORKFLOW_START_TYPE || n.type === SUBWORKFLOW_END_TYPE)
        notAllowed(n, 'a workflow');
    }
    const finishes = graph.nodes.filter((n) => kindOf(n) === 'finish');
    const root = roots.length === 1 ? roots[0] : undefined;
    const reached = root ? closure([root.id], next) : new Set<string>();
    if (finishes.length === 0 || (root && !finishes.some((n) => reached.has(n.id)))) {
      issues.push(error('NO_FINISH_PATH', 'No finish node can be reached from the trigger', {}));
    }
  } else {
    for (const n of graph.nodes) {
      const kind = kindOf(n);
      // Check source's Damaged would lead back out of the sub-workflow into steps that render.
      if (kind === 'trigger' || kind === 'finish' || n.type === CHECK_SOURCE_TYPE) {
        notAllowed(n, 'a sub-workflow');
      }
    }
    roots = graph.nodes.filter((n) => n.type === SUBWORKFLOW_START_TYPE);
    const ends = graph.nodes.filter((n) => n.type === SUBWORKFLOW_END_TYPE).length;
    if (roots.length !== 1 || ends === 0) {
      issues.push(
        error(
          'SUBWORKFLOW_IO_COUNT',
          `A sub-workflow needs exactly one start and at least one end; it has ${roots.length} start and ${ends} end nodes`,
          {},
        ),
      );
    }
  }

  const root = roots.length === 1 ? roots[0] : undefined;
  if (!root) return;
  // Data nodes feeding a reachable node (via a data:* output) count as reachable, transitively:
  // walk data edges backwards from everything forward-reachable.
  const feeders: Adjacency = new Map();
  for (const e of edges) {
    const out = defOf(states.get(e.from.node))?.outputs.find((p) => p.id === e.from.port);
    if (!out?.type.startsWith('data:')) continue;
    const list = feeders.get(e.to.node);
    if (list) list.push(e.from.node);
    else feeders.set(e.to.node, [e.from.node]);
  }
  const reachable = closure(closure([root.id], next), feeders);
  for (const n of graph.nodes) {
    if (reachable.has(n.id)) continue;
    issues.push(
      warning(
        'NODE_UNREACHABLE',
        `${title(n, defOf(states.get(n.id)))} is not reachable from ${title(root, defOf(states.get(root.id)))}`,
        {
          nodeId: n.id,
        },
      ),
    );
  }
}
