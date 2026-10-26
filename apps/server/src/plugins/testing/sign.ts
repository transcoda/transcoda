import { type KeyObject, sign } from 'node:crypto';

/** A detached signature file (the Global Constraints format) over exactly `bytes`. */
export function signText(bytes: Uint8Array, privateKey: KeyObject, keyId: string): string {
  return JSON.stringify({
    schema: 1,
    alg: 'ed25519',
    keyId,
    signature: sign(null, bytes, privateKey).toString('base64'),
  });
}
