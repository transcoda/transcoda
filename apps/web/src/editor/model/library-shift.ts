import type { Library, WorkflowSummary } from '@transcoda/contract';
import { libraryInputOf, type WorkflowGraph } from '@transcoda/shared';

/**
 * The draft moves the workflow off the library its active version feeds: `from` is that
 * library's name, `to` the draft's library name (null when the draft has no Library input or names
 * an unknown library). Null while the workflow feeds no library, the draft still names the fed
 * one, or the draft names a library and the libraries are still loading (no banner until its name
 * is known).
 */
export function libraryShift(
  workflow: WorkflowSummary,
  graph: WorkflowGraph,
  libraries: Pick<Library, 'id' | 'name'>[] | null,
): { activeVersion: number; from: string; to: string | null } | null {
  const fed = workflow.feedsLibrary;
  const active = workflow.active;
  if (fed === null || active === null) return null;
  const draftId = libraryInputOf(graph)?.libraryId ?? null;
  if (draftId === fed.id) return null;
  if (draftId && libraries === null) return null;
  const to = draftId ? (libraries?.find((l) => l.id === draftId)?.name ?? null) : null;
  return { activeVersion: active.version, from: fed.name, to };
}
