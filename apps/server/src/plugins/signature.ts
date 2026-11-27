import { createPublicKey, type KeyObject, verify } from 'node:crypto';
import { z } from 'zod';
import { HEX_KEY, KEY_ID, type SigningKey } from '../platform/signing-keys.ts';

// Prefix of an ed25519 SubjectPublicKeyInfo DER; the raw key is appended.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Canonical base64 of exactly 64 bytes; extra keys are refused. */
export const SignatureFileSchema = z.strictObject({
  schema: z.literal(1),
  alg: z.literal('ed25519'),
  keyId: z.string().regex(KEY_ID),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});

export type SignatureCheck =
  | { ok: true; keyId: string }
  | { ok: false; reason: 'malformed' | 'unknown-key' | 'mismatch'; message: string };

export function publicKeyFromHex(hex: string): KeyObject {
  if (!HEX_KEY.test(hex)) throw new Error('public key must be 64 lowercase hex characters');
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
}

/** Is `data` signed, per the detached signature file `sigText`, by one of `keys`? */
export function verifySignature(
  data: Uint8Array,
  sigText: string,
  keys: readonly SigningKey[],
): SignatureCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(sigText);
  } catch {
    return { ok: false, reason: 'malformed', message: 'malformed signature file: not JSON' };
  }
  const parsed = SignatureFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    return {
      ok: false,
      reason: 'malformed',
      message: `malformed signature file: ${where}${issue?.message ?? 'invalid'}`,
    };
  }
  const { keyId, signature } = parsed.data;
  const key = keys.find((k) => k.id === keyId);
  if (!key) {
    return { ok: false, reason: 'unknown-key', message: `signed with an unknown key ${keyId}` };
  }
  let good = false;
  try {
    good = verify(null, data, publicKeyFromHex(key.publicKey), Buffer.from(signature, 'base64'));
  } catch {
    good = false;
  }
  return good
    ? { ok: true, keyId }
    : { ok: false, reason: 'mismatch', message: 'signature does not match' };
}
