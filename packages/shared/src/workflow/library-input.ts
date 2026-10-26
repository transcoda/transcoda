import type { WorkflowGraph } from './graph.ts';

/** The trigger that takes files from a library; its `settings.libraryId` names the library. */
export const LIBRARY_INPUT_TYPE = 'core:input-library';

/**
 * The graph's Library input node and the library it names (`''` when unset or not a string);
 * null when the graph has no Library input. With more than one, the first in node order
 * (validation reports `TRIGGER_COUNT`).
 */
export function libraryInputOf(graph: WorkflowGraph): { nodeId: string; libraryId: string } | null {
  const node = graph.nodes.find((n) => n.type === LIBRARY_INPUT_TYPE);
  if (!node) return null;
  const settings = node.settings;
  const raw =
    settings !== null && typeof settings === 'object' && !Array.isArray(settings)
      ? settings.libraryId
      : undefined;
  return { nodeId: node.id, libraryId: typeof raw === 'string' ? raw : '' };
}
