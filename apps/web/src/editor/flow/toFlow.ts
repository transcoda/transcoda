import { branchPortLabel, type Issue, valueNamed, type WorkflowGraph } from '@transcoda/shared';
import type { Catalog } from '../../hooks/useCatalog.ts';
import type { EditorState } from '../model/editor-state.ts';
import { NODE_SIZE } from '../model/graph-ops.ts';
import { groupProblem } from '../model/group-state.ts';
import {
  edgeStateFor,
  edgesIntoBroken,
  type NodeState,
  nodeStateFor,
  stateTypeFor,
} from '../model/issues.ts';
import { VALUES_CARD_ID } from '../model/notes-values.ts';
import { edgeStyle, edgeWord } from './edge-style.ts';
import type {
  TcEdge,
  TcFlowEdge,
  TcFlowNode,
  TcGroupNode,
  TcLinkEdge,
  TcNode,
  TcValuesNode,
  TraceOverlay,
} from './types.ts';

/** Handle id of a collapsed group's stand-in for the ports of its hidden members. */
export const GROUP_HANDLE = 'group';

/** A collapsed group is drawn as one tile of this size (N10); the stored `size` is kept. */
export const COLLAPSED_GROUP_SIZE = { width: 210, height: 60 } as const;

/** Handle ids of the dotted value lines: the card's source and a node's target. */
export const VALUES_HANDLE = 'values';
export const VALUE_LINK_HANDLE = 'value-link';

/**
 * The values card and one dotted line per node that follows a value it holds (to the collapsed
 * group standing in for a hidden node). Lines are drawn only; they are never selected or deleted.
 */
function valuesParts(
  draft: WorkflowGraph,
  selection: EditorState['selection'],
  hiddenIn: ReadonlyMap<string, string>,
): { card: TcValuesNode | null; links: TcLinkEdge[] } {
  const values = draft.values;
  if (!values) return { card: null, links: [] };
  const uses: Record<string, number> = {};
  const links: TcLinkEdge[] = [];
  const seen = new Set<string>();
  for (const n of draft.nodes) {
    const names = [...new Set(Object.values(n.links ?? {}))].filter((v) => valueNamed(draft, v));
    if (names.length === 0) continue;
    for (const name of names) uses[name] = (uses[name] ?? 0) + 1;
    const group = hiddenIn.get(n.id);
    const target = group ?? n.id;
    if (seen.has(target)) continue;
    seen.add(target);
    links.push({
      id: `~link:${target}`,
      type: 'tc-link',
      source: VALUES_CARD_ID,
      sourceHandle: VALUES_HANDLE,
      target,
      targetHandle: group !== undefined ? GROUP_HANDLE : VALUE_LINK_HANDLE,
      selectable: false,
      deletable: false,
      focusable: false,
      data: {},
    });
  }
  return {
    card: {
      id: VALUES_CARD_ID,
      type: 'tc-values',
      position: { x: values.position.x, y: values.position.y },
      selected: selection.group === VALUES_CARD_ID,
      data: { values, uses },
    },
    links,
  };
}

/**
 * The graph as a read-only canvas shows it: the viewer's own collapse/expand choices (group id →
 * collapsed) replace the stored flags. View state only — the result is never saved; the page keeps
 * `overrides` in local state and passes the result to `toFlow`. No overrides → the same graph.
 */
export function withViewCollapse(
  graph: WorkflowGraph,
  overrides: ReadonlyMap<string, boolean>,
): WorkflowGraph {
  if (overrides.size === 0) return graph;
  return {
    ...graph,
    groups: graph.groups.map((gr) => {
      const collapsed = overrides.get(gr.id);
      return collapsed === undefined || collapsed === gr.collapsed ? gr : { ...gr, collapsed };
    }),
  };
}

/**
 * The server's graph → React Flow nodes and edges. Graph positions are absolute; a node inside an
 * existing group gets `parentId` and a position relative to the group. Nothing React Flow adds
 * (`measured`, `dragging`, viewport) ever flows back: `fromFlow` maps changes to graph ops.
 */
export function toFlow(
  draft: WorkflowGraph,
  catalog: Catalog | null,
  issues: Issue[],
  selection: EditorState['selection'],
  /** The job trace view (Task 23): each node's trace part and the taken/untaken/value edges. */
  trace?: TraceOverlay,
): { nodes: TcFlowNode[]; edges: TcFlowEdge[] } {
  const groups = new Map(draft.groups.map((gr) => [gr.id, gr] as const));
  const selectedNodes = new Set(selection.nodes);
  const selectedEdges = new Set(selection.edges);

  const counts = new Map<string, number>();
  for (const n of draft.nodes) {
    if (n.groupId !== undefined && groups.has(n.groupId)) {
      counts.set(n.groupId, (counts.get(n.groupId) ?? 0) + 1);
    }
  }

  // React Flow needs parents before their children.
  const groupNodes: TcGroupNode[] = draft.groups.map((group) => {
    const size = group.collapsed ? COLLAPSED_GROUP_SIZE : group.size;
    return {
      id: group.id,
      type: 'tc-group',
      position: { x: group.position.x, y: group.position.y },
      initialWidth: size.width,
      initialHeight: size.height,
      style: { width: size.width, height: size.height },
      selected: selection.group === group.id,
      data: { group, count: counts.get(group.id) ?? 0, problem: null },
    };
  });

  const states = new Map<string, NodeState>();
  /** Node id → the collapsed group that hides it. */
  const hiddenIn = new Map<string, string>();
  /** Collapsed group id → the states of the members it hides. */
  const hiddenStates = new Map<string, NodeState[]>();
  const nodes: TcNode[] = draft.nodes.map((instance) => {
    const state = nodeStateFor(instance.id, issues, stateTypeFor(instance.type, catalog));
    states.set(instance.id, state);
    const group = instance.groupId !== undefined ? groups.get(instance.groupId) : undefined;
    if (group?.collapsed) {
      hiddenIn.set(instance.id, group.id);
      const list = hiddenStates.get(group.id);
      if (list) list.push(state);
      else hiddenStates.set(group.id, [state]);
    }
    const node: TcNode = {
      id: instance.id,
      type: 'tc-node',
      position: group
        ? { x: instance.position.x - group.position.x, y: instance.position.y - group.position.y }
        : { x: instance.position.x, y: instance.position.y },
      initialWidth: NODE_SIZE.width,
      initialHeight: NODE_SIZE.height,
      selected: selectedNodes.has(instance.id),
      data: {
        instance,
        def: catalog?.byType.get(instance.type) ?? null,
        state,
        graphKind: draft.kind,
      },
    };
    const traced = trace?.nodes.get(instance.id);
    if (traced) node.data.trace = traced;
    if (group) node.parentId = group.id;
    if (group?.collapsed) node.hidden = true;
    return node;
  });

  // A collapsed group stands in for its hidden members' problems (expanded, they show their own).
  for (const groupNode of groupNodes) {
    const hidden = hiddenStates.get(groupNode.id);
    if (hidden) groupNode.data.problem = groupProblem(hidden);
  }

  const typeOf = new Map(draft.nodes.map((n) => [n.id, n.type] as const));
  const byId = new Map(draft.nodes.map((n) => [n.id, n] as const));
  /** A node's title as its card shows it; a collapsed group stands for its nodes by name. */
  const titleOf = (nodeId: string): string => {
    const hidden = hiddenIn.get(nodeId);
    if (hidden !== undefined) return groups.get(hidden)?.name ?? nodeId;
    const n = byId.get(nodeId);
    if (!n) return nodeId;
    return n.label ?? catalog?.byType.get(n.type)?.title ?? n.type;
  };
  /** "Edge from Video is, Yes, to Encode video": the port only when the node has several. */
  const edgeName = (e: WorkflowGraph['edges'][number]): string => {
    const type = typeOf.get(e.from.node);
    const outputs = (type !== undefined && catalog?.byType.get(type)?.outputs) || [];
    const shown = outputs.find((p) => p.id === e.from.port);
    const port =
      outputs.length > 1 && !hiddenIn.has(e.from.node)
        ? shown
          ? branchPortLabel(shown)
          : e.from.port
        : null;
    const from = port ? `${titleOf(e.from.node)}, ${port},` : titleOf(e.from.node);
    return `Edge from ${from} to ${titleOf(e.to.node)}`;
  };
  const intoBroken = edgesIntoBroken(draft, states);
  const edges: TcEdge[] = draft.edges.map((e) => {
    const sourceType = typeOf.get(e.from.node);
    const fromGroup = hiddenIn.get(e.from.node);
    const toGroup = hiddenIn.get(e.to.node);
    const edge: TcEdge = {
      id: e.id,
      type: 'tc-edge',
      source: fromGroup ?? e.from.node,
      sourceHandle: fromGroup !== undefined ? GROUP_HANDLE : e.from.port,
      target: toGroup ?? e.to.node,
      targetHandle: toGroup !== undefined ? GROUP_HANDLE : e.to.port,
      selected: selectedEdges.has(e.id),
      ariaLabel: edgeName(e),
      data: {
        portType:
          catalog && sourceType !== undefined ? catalog.portType(sourceType, e.from.port) : null,
        broken: edgeStateFor(e.id, issues, intoBroken).broken,
      },
    };
    const traced = trace?.edges.get(e.id);
    if (traced && edge.data) {
      if (traced.taken) edge.data.taken = true;
      if (traced.untaken) edge.data.untaken = true;
      if (traced.value !== null) edge.data.value = traced.value;
    }
    // The meaning word after the trace flags are merged, so colour and dash are never the only carrier.
    const word = edgeWord(edgeStyle(edge.data));
    if (word !== null) edge.ariaLabel = `${edge.ariaLabel}, ${word}`;
    // Both ends inside the same collapsed group: nothing to draw.
    if (fromGroup !== undefined && fromGroup === toGroup) edge.hidden = true;
    return edge;
  });

  const { card, links } = valuesParts(draft, selection, hiddenIn);
  return {
    nodes: card ? [...groupNodes, ...nodes, card] : [...groupNodes, ...nodes],
    edges: [...edges, ...links],
  };
}
