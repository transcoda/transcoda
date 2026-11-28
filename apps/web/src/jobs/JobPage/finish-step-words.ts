// Finish steps' sentences on the job page that need more than the engine's words: Approval, and
// what a notify step's warning says went wrong.
import type { NodeProblem } from '@transcoda/shared';
import type { Decision } from '../../editor/trace/trace-overlay.ts';

/**
 * The Approval step: before it is reached, what it does (a dry run: what it would do); while it
 * holds the result, that it waits; once answered, who answered and what followed. `said` is the
 * engine's entry as a sentence ("Approved by admin", "Rejected by admin", "Not approved within 3
 * days", "Waiting for a person, at most 3 days").
 */
export function approvalSentence(d: Decision, said: string, dryRun: boolean): string {
  if (d.branch === 'pass') return `${said}, so the finish steps went ahead`;
  if (d.branch === 'else') return `${said}, so the original was kept`;
  if (d.branch === 'depends') return said;
  const days = typeof d.settings.expireAfterDays === 'number' ? d.settings.expireAfterDays : 7;
  const wait = `for a person to approve the result, up to ${days} ${days === 1 ? 'day' : 'days'}`;
  return `${dryRun ? 'Would wait' : 'Waits'} ${wait}`;
}

/** What the engine's notify warning on the step says went wrong; null when it sent. */
export function notifyOutcome(
  problems: readonly NodeProblem[],
): { failed?: string; status?: string } | null {
  for (const p of problems) {
    if (!p.message.startsWith('notify ')) continue;
    const failed = p.message.indexOf(' failed: ');
    if (failed >= 0) return { failed: p.message.slice(failed + ' failed: '.length) };
    const status = /\sanswered (\d+)$/.exec(p.message)?.[1];
    if (status !== undefined) return { status };
  }
  return null;
}
