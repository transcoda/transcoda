import type { ApiClient } from '@transcoda/contract';
import type { WorkflowGraph } from '@transcoda/shared';

/**
 * Creates a workflow from a graph (a bundled example or an imported file) as its version 1 and
 * answers its id. The graph is checked only for its shape here; the server validates the rest.
 */
export async function createFromGraph(
  api: ApiClient,
  name: string,
  graph: unknown,
): Promise<{ id: string }> {
  if (!isGraph(graph)) throw new Error('This file is not a Transcoda workflow.');
  const created = await api.workflows.create({ name, kind: graph.kind, graph });
  return { id: created.id };
}

function isGraph(g: unknown): g is WorkflowGraph {
  if (typeof g !== 'object' || g === null) return false;
  const o = g as Record<string, unknown>;
  return (
    (o.kind === 'workflow' || o.kind === 'subworkflow') &&
    Array.isArray(o.nodes) &&
    Array.isArray(o.edges)
  );
}
