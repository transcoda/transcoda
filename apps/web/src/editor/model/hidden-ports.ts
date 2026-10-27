import type { NodeInfo } from '@transcoda/contract';
import { type Edge, type NodeInstance, portShown, type WorkflowGraph } from '@transcoda/shared';
import type { Catalog, PortSpec } from '../../hooks/useCatalog.ts';

/**
 * The outputs a node shows for its settings: an output with `shownWhen` exists only while its
 * setting has that value (Render's Damaged only while Quality check is on). The server refuses an
 * edge from a hidden output (PORT_HIDDEN) and never follows one.
 */
export function shownOutputs(def: NodeInfo, instance: Pick<NodeInstance, 'settings'>): PortSpec[] {
  return def.outputs.filter((p) => portShown(p, instance.settings));
}

/** The edges that leave an output its node's settings hide; edges of unknown nodes are kept. */
export function hiddenPortEdges(g: WorkflowGraph, catalog: Catalog): Edge[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  return g.edges.filter((e) => {
    const node = byId.get(e.from.node);
    const def = node && catalog.byType.get(node.type);
    const port = def?.outputs.find((p) => p.id === e.from.port);
    return node !== undefined && port !== undefined && !portShown(port, node.settings);
  });
}

/** The graph without the edges from hidden outputs, and those edges (`graph` is `g` when none). */
export function dropHiddenPortEdges(
  g: WorkflowGraph,
  catalog: Catalog,
): { graph: WorkflowGraph; removed: Edge[] } {
  const removed = hiddenPortEdges(g, catalog);
  if (removed.length === 0) return { graph: g, removed };
  const gone = new Set(removed.map((e) => e.id));
  return { graph: { ...g, edges: g.edges.filter((e) => !gone.has(e.id)) }, removed };
}

/**
 * What the save says after it removed edges from hidden outputs: "Removed the connection from
 * Damaged", "Removed 2 connections from Damaged" (the outputs' labels, as the cards show them).
 */
export function removedNotice(
  removed: readonly Edge[],
  g: WorkflowGraph,
  catalog: Catalog,
): string {
  const labels = new Set<string>();
  for (const e of removed) {
    const node = g.nodes.find((n) => n.id === e.from.node);
    const def = node && catalog.byType.get(node.type);
    labels.add(def?.outputs.find((p) => p.id === e.from.port)?.label ?? e.from.port);
  }
  const from = [...labels].join(' and ');
  return removed.length === 1
    ? `Removed the connection from ${from}`
    : `Removed ${removed.length} connections from ${from}`;
}
