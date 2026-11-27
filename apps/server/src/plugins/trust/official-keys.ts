import { OFFICIAL_BLOCKLIST_URL, OFFICIAL_SIGNING_KEYS } from '../../platform/official-plugins.ts';
import type { SigningKey } from '../../platform/signing-keys.ts';

export const BLOCKLIST_INERT_WARNING =
  'the official plugin blocklist is configured but TRANSCODA_PLUGIN_CATALOG_KEY replaces the official signing keys: the blocklist is inert and blocks nothing';

/**
 * Non-null when the official blocklist url is in use but the keys that verify it are not the
 * official ones (a `TRANSCODA_PLUGIN_CATALOG_KEY` override): no entry of it can verify. Null keys
 * (development `none`) read the list unsigned, which works.
 */
export function blocklistInertWarning(
  blocklistUrl: string,
  keys: readonly SigningKey[] | null,
): string | null {
  if (blocklistUrl !== OFFICIAL_BLOCKLIST_URL || keys === null) return null;
  const same =
    keys.length === OFFICIAL_SIGNING_KEYS.length &&
    keys.every((k) =>
      OFFICIAL_SIGNING_KEYS.some((o) => o.id === k.id && o.publicKey === k.publicKey),
    );
  return same ? null : BLOCKLIST_INERT_WARNING;
}
