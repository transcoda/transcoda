// The official plugin catalog: where it is and the keys that sign it. Deployment defaults that
// config.ts reads; the plugin code that fetches and verifies is in plugins/.
import type { SigningKey } from './signing-keys.ts';

export const OFFICIAL_CATALOG_URL =
  'https://raw.githubusercontent.com/transcoda/transcoda-plugins/catalog/index.json';

/** Beside the catalog index; same key, same CI. */
export const OFFICIAL_BLOCKLIST_URL =
  'https://raw.githubusercontent.com/transcoda/transcoda-plugins/catalog/blocklist.json';

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
