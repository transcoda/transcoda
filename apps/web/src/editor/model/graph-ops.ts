import type { NodeInfo } from '@transcoda/contract';
import {
  type Group,
  type JsonValue,
  MAX_GRAPH_EDGES,
  MAX_GRAPH_GROUPS,
  MAX_GRAPH_NODES,
  type NodeInstance,
  type PortRef,
  RUN_SUBWORKFLOW_TYPE,
  SUBWORKFLOW_END_TYPE,
  SUBWORKFLOW_START_TYPE,
  shortId,
  valueNamed,
  type WorkflowGraph,
} from '@transcoda/shared';
import type { Catalog } from '../../hooks/useCatalog.ts';
import { checkConnection } from './connection.ts';
import { removeValuesCard, setValue, VALUES_CARD_ID } from './notes-values.ts';
import { defaultSettings, isRedactedUrl } from './schema-fields.ts';

/**
 * Pure operations over the server's `WorkflowGraph`. Each returns a new graph or a refusal the
 * editor shows as a toast; inputs are never mutated. No React and no React Flow here.
 */

export type EditorRefusal = { reason: string };
export type OpResult = { ok: true; graph: WorkflowGraph } | { ok: false; refusal: EditorRefusal };
export type Position = NodeInstance['position'];
export type Size = Group['size'];

export const NODE_SIZE = { width: 210, height: 120 } as const;
export const GROUP_PADDING = 24;
const DUPLICATE_OFFSET = 40;
/** `NodeInstanceSchema.label` is `z.string().max(120)`. */
export const MAX_LABEL_LENGTH = 120;

const NODE_MISSING = 'That node no longer exists';
const GROUP_MISSING = 'That group no longer exists';

const ok = (graph: WorkflowGraph): OpResult => ({ ok: true, graph });
const refuse = (reason: string): OpResult => ({ ok: false, refusal: { reason } });

function isObject(v: JsonValue | undefined): v is { [key: string]: JsonValue } {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Applies `fn` to node `id`; refuses when the node is gone. */
function updateNode(
  g: WorkflowGraph,
  id: string,
  fn: (n: NodeInstance) => NodeInstance | string,
): OpResult {
  const index = g.nodes.findIndex((n) => n.id === id);
  const node = g.nodes[index];
  if (!node) return refuse(NODE_MISSING);
  const next = fn(node);
  if (typeof next === 'string') return refuse(next);
  const nodes = [...g.nodes];
  nodes[index] = next;
  return ok({ ...g, nodes });
}

function updateGroup(g: WorkflowGraph, id: string, fn: (gr: Group) => Group): OpResult {
  if (!g.groups.some((gr) => gr.id === id)) return refuse(GROUP_MISSING);
  return ok({ ...g, groups: g.groups.map((gr) => (gr.id === id ? fn(gr) : gr)) });
}

/** Sets or removes an optional key; `undefined` removes it so the saved graph has no empty keys. */
function withKey<K extends 'label' | 'groupId' | 'bypassed'>(
  n: NodeInstance,
  key: K,
  value: NodeInstance[K] | undefined,
): NodeInstance {
  const next: NodeInstance = { ...n };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

const nodeCapReached = (g: WorkflowGraph) => g.nodes.length >= MAX_GRAPH_NODES;
const NODE_CAP = `A workflow can have at most ${MAX_GRAPH_NODES} nodes`;

/**
 * Whether a node of `def` may be added to `g`, following the server's TRIGGER_COUNT,
 * SUBWORKFLOW_IO_COUNT and NODE_NOT_ALLOWED_HERE rules: one trigger per workflow, start/end only
 * in sub-workflows (one start, any number of ends), no trigger or finish in a sub-workflow. The
 * catalogue gives the kinds of the nodes already in the graph.
 */
export function placementRefusal(
  def: NodeInfo,
  g: WorkflowGraph,
  catalog: Catalog,
): EditorRefusal | null {
  if (g.kind === 'workflow') {
    if (def.type === SUBWORKFLOW_START_TYPE || def.type === SUBWORKFLOW_END_TYPE) {
      return { reason: `${def.title} is not allowed in a workflow` };
    }
    if (
      def.kind === 'trigger' &&
      g.nodes.some((n) => catalog.byType.get(n.type)?.kind === 'trigger')
    ) {
      return { reason: 'A workflow has exactly one trigger' };
    }
    return null;
  }
  if (def.kind === 'trigger' || def.kind === 'finish') {
    return { reason: `${def.title} is not allowed in a sub-workflow` };
  }
  if (
    def.type === SUBWORKFLOW_START_TYPE &&
    g.nodes.some((n) => n.type === SUBWORKFLOW_START_TYPE)
  ) {
    return { reason: 'A sub-workflow has exactly one start' };
  }
  return null;
}

export function addNode(
  g: WorkflowGraph,
  type: string,
  position: Position,
  catalog: Catalog,
  opts: { id?: string; groupId?: string } = {},
): OpResult {
  if (nodeCapReached(g)) return refuse(NODE_CAP);
  const def = catalog.byType.get(type);
  if (!def) return refuse(`Unknown node type ${type}`);
  const placement = placementRefusal(def, g, catalog);
  if (placement) return refuse(placement.reason);
  if (opts.id !== undefined && g.nodes.some((n) => n.id === opts.id)) {
    return refuse(`A node with the id ${opts.id} already exists`);
  }
  const node: NodeInstance = {
    id: opts.id ?? shortId(),
    type,
    typeVersion: def.version,
    settings: defaultSettings(def.settingsSchema),
    position: { ...position },
    ...(opts.groupId === undefined ? {} : { groupId: opts.groupId }),
  };
  return ok({ ...g, nodes: [...g.nodes, node] });
}

/** Removes the nodes and their edges; a sub-workflow keeps at least one start and one end. */
export function removeNodes(g: WorkflowGraph, ids: string[]): OpResult {
  const gone = new Set(ids);
  const nodes = g.nodes.filter((n) => !gone.has(n.id));
  if (g.kind === 'subworkflow') {
    for (const type of [SUBWORKFLOW_START_TYPE, SUBWORKFLOW_END_TYPE]) {
      const had = g.nodes.some((n) => n.type === type);
      if (had && !nodes.some((n) => n.type === type)) {
        return refuse('A sub-workflow needs its start and end');
      }
    }
  }
  const edges = g.edges.filter((e) => !gone.has(e.from.node) && !gone.has(e.to.node));
  return ok({ ...g, nodes, edges });
}

type JsonObject = { [key: string]: JsonValue };
const isJsonObject = (v: JsonValue | undefined): v is JsonObject =>
  v !== undefined && v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Settings for a copy of a node: redacted webhook URLs (top-level and in Run-node `overrides`)
 * are dropped. The server only restores a redacted value for the node it was read from, so a
 * copy would otherwise store the literal `https://host/…`; without it the copy needs a setting.
 */
export function withoutRedactedUrls(settings: JsonValue): JsonValue {
  if (!isJsonObject(settings)) return settings;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(settings)) {
    if (isRedactedUrl(value)) continue;
    out[key] =
      key === 'overrides' && isJsonObject(value)
        ? Object.fromEntries(Object.entries(value).filter(([, v]) => !isRedactedUrl(v)))
        : value;
  }
  return out;
}

export function duplicateNode(g: WorkflowGraph, id: string, catalog: Catalog): OpResult {
  const node = g.nodes.find((n) => n.id === id);
  if (!node) return refuse(NODE_MISSING);
  if (nodeCapReached(g)) return refuse(NODE_CAP);
  const def = catalog.byType.get(node.type);
  if (!def) return refuse(`Unknown node type ${node.type}`);
  const placement = placementRefusal(def, g, catalog);
  if (placement) return refuse(placement.reason);
  const copy: NodeInstance = {
    ...structuredClone(node),
    settings: withoutRedactedUrls(structuredClone(node.settings)),
    id: shortId(),
    position: { x: node.position.x + DUPLICATE_OFFSET, y: node.position.y + DUPLICATE_OFFSET },
  };
  return ok({ ...g, nodes: [...g.nodes, copy] });
}

export function connect(g: WorkflowGraph, from: PortRef, to: PortRef, catalog: Catalog): OpResult {
  const check = checkConnection(g, from, to, catalog);
  if (!check.ok) return refuse(check.reason);
  if (g.edges.length >= MAX_GRAPH_EDGES) {
    return refuse(`A workflow can have at most ${MAX_GRAPH_EDGES} edges`);
  }
  const edge = { id: shortId(), from: { ...from }, to: { ...to } };
  return ok({ ...g, edges: [...g.edges, edge] });
}

export function disconnect(g: WorkflowGraph, edgeId: string): OpResult {
  return ok({ ...g, edges: g.edges.filter((e) => e.id !== edgeId) });
}

/** Absolute canvas positions; ids not in the graph are ignored. */
export function moveNodes(
  g: WorkflowGraph,
  moves: Array<{ id: string; position: Position }>,
): OpResult {
  const to = new Map(moves.map((m) => [m.id, m.position] as const));
  return ok({
    ...g,
    nodes: g.nodes.map((n) => {
      const p = to.get(n.id);
      return p ? { ...n, position: { x: p.x, y: p.y } } : n;
    }),
  });
}

/**
 * A linked setting edited here (the inspector, an on-card control) is an edit of its shared value:
 * the value takes the new content and every setting that follows it gets it too.
 */
export function setSettings(g: WorkflowGraph, id: string, settings: JsonValue): OpResult {
  const updated = updateNode(g, id, (n) => ({ ...n, settings }));
  const links = g.nodes.find((n) => n.id === id)?.links;
  if (!updated.ok || !links || !isObject(settings)) return updated;
  let graph = updated.graph;
  for (const [key, name] of Object.entries(links)) {
    const next = settings[key];
    const value = valueNamed(graph, name);
    if (next === undefined || !value || JSON.stringify(value.value) === JSON.stringify(next)) {
      continue;
    }
    const r = setValue(graph, name, next);
    if (r.ok) graph = r.graph;
  }
  return ok(graph);
}

/** An empty label removes the key; longer than `MAX_LABEL_LENGTH` is refused. */
export function setLabel(g: WorkflowGraph, id: string, label: string | undefined): OpResult {
  if (label !== undefined && label.length > MAX_LABEL_LENGTH) {
    return refuse(`A label can be at most ${MAX_LABEL_LENGTH} characters`);
  }
  return updateNode(g, id, (n) => withKey(n, 'label', label === '' ? undefined : label));
}

/** Bypass on sets `bypassed: true`; off removes the key. */
export function toggleBypass(g: WorkflowGraph, id: string): OpResult {
  return updateNode(g, id, (n) => withKey(n, 'bypassed', n.bypassed ? undefined : true));
}

/**
 * A new group around the nodes' cards plus `GROUP_PADDING`; nodes already in another group move to
 * the new one. Card sizes come from `sizes` (the canvas's measured cards, which grow with their
 * port rows) and fall back to `NODE_SIZE`.
 */
export function createGroup(
  g: WorkflowGraph,
  name: string,
  nodeIds: string[],
  sizes: ReadonlyMap<string, Size> = new Map(),
): OpResult {
  if (g.groups.length >= MAX_GRAPH_GROUPS) {
    return refuse(`A workflow can have at most ${MAX_GRAPH_GROUPS} groups`);
  }
  const members = new Set(nodeIds);
  const nodes = g.nodes.filter((n) => members.has(n.id));
  if (nodes.length === 0) return refuse('Select at least one node to group');
  const xs = nodes.map((n) => n.position.x);
  const ys = nodes.map((n) => n.position.y);
  const left = Math.min(...xs) - GROUP_PADDING;
  const top = Math.min(...ys) - GROUP_PADDING;
  const sizeOf = (id: string) => sizes.get(id) ?? NODE_SIZE;
  const right = Math.max(...nodes.map((n) => n.position.x + sizeOf(n.id).width)) + GROUP_PADDING;
  const bottom = Math.max(...nodes.map((n) => n.position.y + sizeOf(n.id).height)) + GROUP_PADDING;
  const group: Group = {
    id: shortId(),
    name,
    collapsed: false,
    position: { x: left, y: top },
    size: { width: right - left, height: bottom - top },
  };
  return ok({
    ...g,
    nodes: g.nodes.map((n) => (members.has(n.id) ? { ...n, groupId: group.id } : n)),
    groups: [...g.groups, group],
  });
}

/** The name a group gets when it is created, and gets back when its name is emptied. */
export const DEFAULT_GROUP_NAME = 'Group';

export function renameGroup(g: WorkflowGraph, groupId: string, name: string): OpResult {
  if (name.trim() === '') return refuse('A group needs a name');
  return updateGroup(g, groupId, (gr) => ({ ...gr, name }));
}

export function setGroupCollapsed(g: WorkflowGraph, groupId: string, collapsed: boolean): OpResult {
  return updateGroup(g, groupId, (gr) => ({ ...gr, collapsed }));
}

export function resizeGroup(
  g: WorkflowGraph,
  groupId: string,
  position: Position,
  size: Size,
): OpResult {
  return updateGroup(g, groupId, (gr) => ({
    ...gr,
    position: { x: position.x, y: position.y },
    size: { width: size.width, height: size.height },
  }));
}

/** Removes the group and clears `groupId` on its nodes. */
export function ungroup(g: WorkflowGraph, groupId: string): OpResult {
  if (!g.groups.some((gr) => gr.id === groupId)) return refuse(GROUP_MISSING);
  return ok({
    ...g,
    nodes: g.nodes.map((n) => (n.groupId === groupId ? withKey(n, 'groupId', undefined) : n)),
    groups: g.groups.filter((gr) => gr.id !== groupId),
  });
}

/**
 * The editor's one delete (Delete/Backspace, the toolbar's Delete goes through `removeNodes`):
 * the selected edges are disconnected, a selected group is ungrouped (its members stay unless
 * selected too) and the selected nodes are removed with their edges, as one result.
 */
export function removeSelection(
  g: WorkflowGraph,
  sel: { nodes: string[]; edges: string[]; group?: string },
): OpResult {
  let graph = g;
  for (const edgeId of sel.edges) {
    const r = disconnect(graph, edgeId);
    if (!r.ok) return r;
    graph = r.graph;
  }
  if (sel.group !== undefined) {
    const r = sel.group === VALUES_CARD_ID ? removeValuesCard(graph) : ungroup(graph, sel.group);
    if (!r.ok) return r;
    graph = r.graph;
  }
  return sel.nodes.length > 0 ? removeNodes(graph, sel.nodes) : ok(graph);
}

export function setNodeGroup(
  g: WorkflowGraph,
  nodeId: string,
  groupId: string | undefined,
): OpResult {
  if (groupId !== undefined && !g.groups.some((gr) => gr.id === groupId)) {
    return refuse(GROUP_MISSING);
  }
  return updateNode(g, nodeId, (n) => withKey(n, 'groupId', groupId));
}

/**
 * Moves the node into `groupId` (or out of its group) and grows the group's box around the node's
 * card plus `GROUP_PADDING`, so a member is never drawn outside its box. `size` is the card's
 * measured size (cards grow with their port rows); leaving a group keeps the box.
 */
export function joinGroup(
  g: WorkflowGraph,
  nodeId: string,
  groupId: string | undefined,
  size: Size = NODE_SIZE,
): OpResult {
  const joined = setNodeGroup(g, nodeId, groupId);
  if (!joined.ok || groupId === undefined) return joined;
  const node = g.nodes.find((n) => n.id === nodeId);
  const group = g.groups.find((gr) => gr.id === groupId);
  if (!node || !group) return joined;
  const left = Math.min(group.position.x, node.position.x - GROUP_PADDING);
  const top = Math.min(group.position.y, node.position.y - GROUP_PADDING);
  const right = Math.max(
    group.position.x + group.size.width,
    node.position.x + size.width + GROUP_PADDING,
  );
  const bottom = Math.max(
    group.position.y + group.size.height,
    node.position.y + size.height + GROUP_PADDING,
  );
  return resizeGroup(
    joined.graph,
    groupId,
    { x: left, y: top },
    { width: right - left, height: bottom - top },
  );
}

/** Changes a Run node's settings; settings that are not an object start from `{}`. */
function updateRunSettings(
  g: WorkflowGraph,
  runNodeId: string,
  fn: (s: { [key: string]: JsonValue }) => { [key: string]: JsonValue },
): OpResult {
  return updateNode(g, runNodeId, (n) => {
    if (n.type !== RUN_SUBWORKFLOW_TYPE) return 'That node does not run a sub-workflow';
    return { ...n, settings: fn(isObject(n.settings) ? n.settings : {}) };
  });
}

export function setPinnedVersion(g: WorkflowGraph, runNodeId: string, version: number): OpResult {
  if (!Number.isInteger(version) || version < 1) {
    return refuse('The pinned version must be a whole number of at least 1');
  }
  return updateRunSettings(g, runNodeId, (s) => ({ ...s, version }));
}

/** `undefined` deletes the override; `overrides` is always left an object. */
export function setOverride(
  g: WorkflowGraph,
  runNodeId: string,
  key: string,
  value: JsonValue | undefined,
): OpResult {
  return updateRunSettings(g, runNodeId, (s) => {
    const { [key]: _drop, ...rest } = isObject(s.overrides) ? s.overrides : {};
    return { ...s, overrides: value === undefined ? rest : { ...rest, [key]: value } };
  });
}
