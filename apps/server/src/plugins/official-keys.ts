import { OFFICIAL_BLOCKLIST_URL } from './catalog-url.ts';
import type { SigningKey } from './signature.ts';

/**
 * The ed25519 keys that sign the official plugin catalog, its blocklist and the official bundles.
 * Pinned 2026-10-18 (key id 2026-10).
 *
 * Rotation: add the new key here and release core, then switch the CI secret, then remove the
 * old key two core releases later; a bundle signed with a removed key stops at its next start
 * with 'signed with an unknown key'.
 *
 * Compromise, in this order: generate a new key; pin it here and drop the compromised one in a
 * core release; re-sign the index and the blocklist with the new key; only then add the sha256
 * entries for the affected bundles (a blocklist signed with the new key is refused by a core that
 * still pins only the old one, and the reverse). A server on an older core has no protection
 * until it updates.
 */
export const OFFICIAL_SIGNING_KEYS: readonly SigningKey[] = [
  // Generated 2026-10-18 by the author; the private key lives only in the plugins repo's
  // `plugin-signing` environment secret and the author's offline backup.
  { id: '2026-10', publicKey: '74ca7ab4d6a65b32a4c059cced60505bae0d04a66c43a45dd363d4164ce5f814' },
];

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
