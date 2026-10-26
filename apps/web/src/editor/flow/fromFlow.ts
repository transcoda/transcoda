import type { WorkflowGraph } from '@transcoda/shared';
import type { EdgeChange, NodeChange } from '@xyflow/react';
import {
  disconnect,
  moveNodes,
  NODE_SIZE,
  type OpResult,
  type Position,
  removeNodes,
  resizeGroup,
  type Size,
  setNodeGroup,
  ungroup,
} from '../model/graph-ops.ts';
import { moveValuesCard, removeValuesCard } from '../model/notes-values.ts';
import type { TcFlowEdge, TcFlowNode } from './types.ts';

/**
 * React Flow changes → graph operations. An `op` is applied to the draft by the page (dispatch
 * `apply`); a refusal is a toast. A `select` result is the complete next selection of the kind
 * that changed: `fromNodeChanges` gives nodes and group (its `edges` is empty), `fromEdgeChanges`
 * gives edges (its `nodes` is empty). React Flow reports node and edge selection in two calls of
 * the same tick, so the page merges each by kind against the latest state.
 */
export type FlowChangeResult =
  | { op: (g: WorkflowGraph) => OpResult; coalesce?: 'move' }
  | { select: { nodes: string[]; edges: string[]; group?: string } }
  | null;

type Op = (g: WorkflowGraph) => OpResult;

/** Runs the steps in order; the first refusal wins. */
function chain(steps: Op[]): Op {
  return (g) => {
    let graph = g;
    for (const step of steps) {
      const result = step(graph);
      if (!result.ok) return result;
      graph = result.graph;
    }
    return { ok: true, graph };
  };
}

/** Drops at any zoom land between pixels; the graph stores whole ones. */
function whole(p: Position): Position {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/** True when the node card's centre lies outside its group's box (both group-relative). */
function outsideBox(rel: Position, node: TcFlowNode | undefined, size: Size): boolean {
  const cx = rel.x + (node?.measured?.width ?? NODE_SIZE.width) / 2;
  const cy = rel.y + (node?.measured?.height ?? NODE_SIZE.height) / 2;
  return cx < 0 || cy < 0 || cx > size.width || cy > size.height;
}

/**
 * Positions and sizes, rounded to whole pixels. A finished drag or a nudge (`dragging: false`)
 * moves nodes; positions in progress (`dragging: true`) are left to the canvas. A child's flow
 * position is relative to its group, so it is converted back to absolute; a child dropped with
 * its centre outside the group leaves it. Dragging a group moves its members with it (the graph stores them absolute); a resize
 * moves the group and React Flow compensates the members' relative positions itself.
 */
function geometry(
  changes: NodeChange[],
  g: WorkflowGraph,
  flowById: ReadonlyMap<string, TcFlowNode>,
): FlowChangeResult {
  const groups = new Map(g.groups.map((gr) => [gr.id, gr] as const));
  const nodes = new Map(g.nodes.map((n) => [n.id, n] as const));
  const groupPos = new Map<string, Position>();
  const groupSize = new Map<string, Size>();
  const nodeMoves: Array<{ id: string; rel: Position; dropped: boolean }> = [];
  let cardAt: Position | null = null;

  for (const c of changes) {
    const kind = 'id' in c ? flowById.get(c.id)?.type : undefined;
    if (c.type === 'position' && c.position && c.dragging !== true) {
      const at = whole(c.position);
      if (kind === 'tc-values') cardAt = at;
      else if (kind === 'tc-group' && groups.has(c.id)) groupPos.set(c.id, at);
      else if (kind === 'tc-node' && nodes.has(c.id))
        nodeMoves.push({ id: c.id, rel: at, dropped: c.dragging === false });
    } else if (
      c.type === 'dimensions' &&
      kind === 'tc-group' &&
      typeof c.resizing === 'boolean' &&
      c.dimensions &&
      groups.has(c.id)
    ) {
      groupSize.set(c.id, {
        width: Math.round(c.dimensions.width),
        height: Math.round(c.dimensions.height),
      });
    }
  }
  if (nodeMoves.length === 0 && groupPos.size === 0 && groupSize.size === 0 && !cardAt) {
    return null;
  }

  const moves: Array<{ id: string; position: Position }> = [];
  const leaving: string[] = [];
  const moved = new Set<string>();
  for (const m of nodeMoves) {
    const node = nodes.get(m.id);
    const group = node?.groupId !== undefined ? groups.get(node.groupId) : undefined;
    moved.add(m.id);
    if (!group) {
      moves.push({ id: m.id, position: m.rel });
      continue;
    }
    const origin = groupPos.get(group.id) ?? group.position;
    const size = groupSize.get(group.id) ?? group.size;
    moves.push({ id: m.id, position: { x: origin.x + m.rel.x, y: origin.y + m.rel.y } });
    if (m.dropped && outsideBox(m.rel, flowById.get(m.id), size)) leaving.push(m.id);
  }
  for (const [id, to] of groupPos) {
    const group = groups.get(id);
    if (!group || groupSize.has(id)) continue;
    const dx = to.x - group.position.x;
    const dy = to.y - group.position.y;
    for (const n of g.nodes) {
      if (n.groupId !== id || moved.has(n.id)) continue;
      moves.push({ id: n.id, position: { x: n.position.x + dx, y: n.position.y + dy } });
    }
  }

  const steps: Op[] = [];
  const card = cardAt;
  if (card) steps.push((graph) => moveValuesCard(graph, card));
  if (moves.length > 0) steps.push((graph) => moveNodes(graph, moves));
  for (const id of leaving) steps.push((graph) => setNodeGroup(graph, id, undefined));
  for (const id of new Set([...groupPos.keys(), ...groupSize.keys()])) {
    const group = groups.get(id);
    if (!group) continue;
    const position = groupPos.get(id) ?? group.position;
    const size = groupSize.get(id) ?? group.size;
    steps.push((graph) => resizeGroup(graph, id, position, size));
  }
  return { op: chain(steps), coalesce: 'move' };
}

/** Removed groups are ungrouped (their nodes stay); removed nodes go with their edges. */
function removal(
  changes: NodeChange[],
  flowById: ReadonlyMap<string, TcFlowNode>,
): FlowChangeResult {
  const groupIds: string[] = [];
  const nodeIds: string[] = [];
  let card = false;
  for (const c of changes) {
    if (c.type !== 'remove') continue;
    const kind = flowById.get(c.id)?.type;
    if (kind === 'tc-group') groupIds.push(c.id);
    else if (kind === 'tc-node') nodeIds.push(c.id);
    else if (kind === 'tc-values') card = true;
  }
  if (groupIds.length === 0 && nodeIds.length === 0 && !card) return null;
  const steps: Op[] = groupIds.map((id) => (graph) => ungroup(graph, id));
  if (card) steps.push(removeValuesCard);
  if (nodeIds.length > 0) steps.push((graph) => removeNodes(graph, nodeIds));
  return { op: chain(steps) };
}

/** Next selected ids: the current `selected` flags with the select changes applied, in order. */
function nextSelected(
  items: ReadonlyArray<{ id: string; selected?: boolean }>,
  changes: ReadonlyArray<{ id: string; selected: boolean }>,
): string[] {
  const next = new Map(items.map((i) => [i.id, i.selected ?? false] as const));
  for (const c of changes) next.set(c.id, c.selected);
  return [...next].filter(([, on]) => on).map(([id]) => id);
}

function nodeSelection(changes: NodeChange[], flowNodes: TcFlowNode[]): FlowChangeResult {
  const selects = changes.filter((c) => c.type === 'select');
  if (selects.length === 0) return null;
  const kindOf = new Map(flowNodes.map((n) => [n.id, n.type] as const));
  const on = nextSelected(flowNodes, selects);
  const nodes = on.filter((id) => kindOf.get(id) === 'tc-node');
  // The values card is selected like a group (one of them at a time).
  const groups = new Set(
    on.filter((id) => kindOf.get(id) === 'tc-group' || kindOf.get(id) === 'tc-values'),
  );
  // One group at a time: the one just selected, else the first still selected.
  const picked = selects.filter((c) => c.selected && groups.has(c.id)).at(-1)?.id ?? [...groups][0];
  return { select: { nodes, edges: [], ...(picked !== undefined ? { group: picked } : {}) } };
}

/**
 * Node changes → graph ops and selection. One move op per batch (coalesced as `move`, the page
 * gives the key), then one removal op, then the selection. Measurements, adds and replaces map
 * to nothing.
 */
export function fromNodeChanges(
  changes: NodeChange[],
  g: WorkflowGraph,
  flowNodes: TcFlowNode[],
): FlowChangeResult[] {
  const flowById = new Map(flowNodes.map((n) => [n.id, n] as const));
  return [
    geometry(changes, g, flowById),
    removal(changes, flowById),
    nodeSelection(changes, flowNodes),
  ].filter((r) => r !== null);
}

/**
 * Edge changes → `disconnect` and the next edge selection. `flowEdges` (the edges `toFlow` drew)
 * carry the current selection, so an added edge keeps the ones already selected.
 */
export function fromEdgeChanges(all: EdgeChange[], flowEdges: TcFlowEdge[]): FlowChangeResult[] {
  // The values card's dotted lines are drawn only.
  const links = new Set(flowEdges.filter((e) => e.type === 'tc-link').map((e) => e.id));
  const changes = all.filter((c) => !('id' in c) || !links.has(c.id));
  const results: FlowChangeResult[] = [];
  const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
  if (removed.length > 0) {
    results.push({ op: chain(removed.map((id) => (graph) => disconnect(graph, id))) });
  }
  const selects = changes.filter((c) => c.type === 'select');
  if (selects.length > 0) {
    results.push({ select: { nodes: [], edges: nextSelected(flowEdges, selects) } });
  }
  return results;
}
