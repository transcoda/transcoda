import type { WorkflowGraph } from '@transcoda/shared';
import { isLayoutOnlyChange } from './equality.ts';

/** The note a save gets when the diff touches only positions, labels and groups. */
export const LAYOUT_ONLY_NOTE = 'Layout only';

/**
 * The version note for saving `draft` over `saved`: the user's note (trimmed, non-empty) wins;
 * else "Layout only" when the change has no behaviour (the server's safe-change list); else none.
 */
export function saveNoteFor(
  saved: WorkflowGraph,
  draft: WorkflowGraph,
  userNote: string | undefined,
): string | undefined {
  const note = userNote?.trim();
  if (note) return note;
  return isLayoutOnlyChange(saved, draft) ? LAYOUT_ONLY_NOTE : undefined;
}
