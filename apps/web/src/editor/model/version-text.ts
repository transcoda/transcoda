/** `createdBy` of the versions the server's node upgrader writes. */
export const SYSTEM_UPGRADE = 'system:upgrade';

/** `activatedBy` of an activation the 0005 migration made from an enabled workflow. */
const SYSTEM_MIGRATION = 'system:migration';

type Me = { id: string; username: string } | null;

/** Who saved a version: the current user's name, "automatic update" for the upgrader, else "another user" (never the raw id). */
export function versionAuthor(createdBy: string, me: Me): string {
  if (createdBy === SYSTEM_UPGRADE) return 'automatic update';
  return me !== null && createdBy === me.id ? me.username : 'another user';
}

/** Who activated a version: as `versionAuthor`, and "the upgrade" for the migration. */
export function activatedByText(activatedBy: string, me: Me): string {
  return activatedBy === SYSTEM_MIGRATION ? 'the upgrade' : versionAuthor(activatedBy, me);
}
