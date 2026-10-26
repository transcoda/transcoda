import type { NodeBadge, NodeBorder, NodeState } from './issues.ts';

/** What a collapsed group shows for the members it hides (N10): their worst state, never none. */
export interface GroupProblem {
  /** Worst: red > amber > dashed. */
  border: Exclude<NodeBorder, null>;
  /** The worst member's badge ('generic-error' when it has none). */
  badge: Exclude<NodeBadge, null>;
  /** Members with a state word. */
  count: number;
  /** One member: its word ("plugin missing"). Several: "<n> nodes need attention". */
  word: string;
}

const BORDER_RANK: Record<Exclude<NodeBorder, null>, number> = { red: 3, amber: 2, dashed: 1 };

/** The members' worst state, or null when none has a word. Ties keep member order. */
export function groupProblem(members: readonly NodeState[]): GroupProblem | null {
  let worst: { border: Exclude<NodeBorder, null>; badge: Exclude<NodeBadge, null> } | null = null;
  let firstWord = '';
  let count = 0;
  for (const m of members) {
    if (m.word === null) continue;
    count += 1;
    if (count === 1) firstWord = m.word;
    // A word without a border or badge kind reads as an error, as the card's badge does.
    const border = m.border ?? 'red';
    if (!worst || BORDER_RANK[border] > BORDER_RANK[worst.border]) {
      worst = { border, badge: m.badge ?? 'generic-error' };
    }
  }
  if (!worst) return null;
  return { ...worst, count, word: count === 1 ? firstWord : `${count} nodes need attention` };
}
