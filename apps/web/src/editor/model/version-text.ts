import type { WorkflowSummary, WorkflowVersionInfo } from '@transcoda/contract';
import { fmtAgo } from '../../lib/time.ts';

/** `createdBy` of the versions the server's node upgrader writes. */
export const SYSTEM_UPGRADE = 'system:upgrade';

/** `activatedBy` of an activation the 0005 migration made from an enabled workflow. */
const SYSTEM_MIGRATION = 'system:migration';

type Me = { id: string; username: string } | null;

/** Who saved a version: "you", "automatic update" for the upgrader, else "another user" (never the raw id). */
export function versionAuthor(createdBy: string, me: Me): string {
  if (createdBy === SYSTEM_UPGRADE) return 'automatic update';
  return me !== null && createdBy === me.id ? 'you' : 'another user';
}

/** Who activated a version: as `versionAuthor`, and "the upgrade" for the migration. */
export function activatedByText(activatedBy: string, me: Me): string {
  return activatedBy === SYSTEM_MIGRATION ? 'the upgrade' : versionAuthor(activatedBy, me);
}

/**
 * The one verb for making `version` the one that runs: "Roll back to v1" below the active version,
 * "Activate v3" otherwise. The menu, the past-version banner and the confirmation all use it.
 */
export function activateLabel(active: WorkflowSummary['active'], version: number): string {
  return active !== null && version < active.version
    ? `Roll back to v${version}`
    : `Activate v${version}`;
}

/**
 * One version as the versions panel and the activate dialog both show it: "v2 · saved by you
 * 2 min ago", "v8 · Layout only · saved by another user 3 h ago", "v6 · Updated … · automatic
 * update on 12 Oct 2026". Never a raw user id.
 */
export function versionLine(
  v: Pick<WorkflowVersionInfo, 'version' | 'note' | 'createdBy' | 'createdAt'>,
  me: Me,
  now: Date = new Date(),
): string {
  const by =
    v.createdBy === SYSTEM_UPGRADE
      ? 'automatic update'
      : me !== null && v.createdBy === me.id
        ? 'saved by you'
        : 'saved by another user';
  const ago = fmtAgo(v.createdAt, now);
  const when = ago === 'just now' || ago.endsWith(' ago') ? ago : `on ${ago}`;
  return `v${v.version} · ${v.note ? `${v.note} · ` : ''}${by} ${when}`;
}
