// The format of a trusted ed25519 key list (`TRANSCODA_PLUGIN_CATALOG_KEY`, a custom catalog's
// keys). Here so config.ts can parse it; plugins/trust/signature.ts verifies with the keys.

/** One trusted ed25519 public key: an id the signature file names, and the raw 32 bytes as hex. */
export interface SigningKey {
  id: string;
  /** 64 lowercase hex characters. */
  publicKey: string;
}

export const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
export const HEX_KEY = /^[0-9a-f]{64}$/;

/** `<id>:<64 hex>` entries, comma-separated. */
export function parseSigningKeys(value: string): SigningKey[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      const i = entry.indexOf(':');
      const id = i < 0 ? '' : entry.slice(0, i);
      const publicKey = i < 0 ? '' : entry.slice(i + 1);
      if (!KEY_ID.test(id) || !HEX_KEY.test(publicKey)) {
        throw new Error(`${entry}: expected <id>:<64 hex>`);
      }
      return { id, publicKey };
    });
}
