import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { JsonValue } from '@transcoda/shared';

/** The stored form of an encrypted plugin setting. */
export type Encrypted = { $enc: string };

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const INFO = 'transcoda plugin settings v1';

/** Never carries a key, plaintext or ciphertext: only the plugin and field names. */
export class SettingsDecryptError extends Error {
  constructor(pluginName: string, fieldPath: string) {
    super(`cannot decrypt ${pluginName}.${fieldPath}`);
    this.name = 'SettingsDecryptError';
  }
}

function derive(secretKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', secretKey, '', INFO, 32));
}

function aad(pluginName: string, fieldPath: string): Buffer {
  return Buffer.from(`${pluginName}\0${fieldPath}`, 'utf8');
}

export function isEncrypted(v: JsonValue | undefined): v is Encrypted {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, JsonValue>).$enc === 'string'
  );
}

export function encryptValue(
  secretKey: Buffer,
  pluginName: string,
  fieldPath: string,
  value: string,
): Encrypted {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', derive(secretKey), nonce);
  cipher.setAAD(aad(pluginName, fieldPath));
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { $enc: Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString('base64') };
}

export function decryptValue(
  secretKey: Buffer,
  pluginName: string,
  fieldPath: string,
  v: Encrypted,
): string {
  try {
    const raw = Buffer.from(v.$enc, 'base64');
    if (raw.length < NONCE_BYTES + TAG_BYTES) throw new Error('short');
    const nonce = raw.subarray(0, NONCE_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const ct = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', derive(secretKey), nonce);
    decipher.setAAD(aad(pluginName, fieldPath));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new SettingsDecryptError(pluginName, fieldPath);
  }
}

function isSetMarker(v: JsonValue | undefined): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    (v as Record<string, JsonValue>).set === true
  );
}

/** True when an `$enc` marker appears anywhere inside `v`. */
function containsEncrypted(v: JsonValue | undefined): boolean {
  if (isEncrypted(v)) return true;
  if (Array.isArray(v)) return v.some(containsEncrypted);
  if (typeof v === 'object' && v !== null) return Object.values(v).some(containsEncrypted);
  return false;
}

/**
 * `$enc` is implicitly envelope v1; a change of algorithm or KDF uses a new marker key.
 * Input may never carry the marker: it is only produced by encryptValue.
 *
 * Secret keys: a non-empty string is encrypted; absent or `{ set: true }` keeps the previous
 * stored value; an empty string removes it. Other keys are copied as they are.
 */
export function sealSettings(
  secretKey: Buffer,
  pluginName: string,
  settings: Record<string, JsonValue>,
  secretKeys: string[],
  previous: Record<string, JsonValue> | null,
): Record<string, JsonValue> {
  const secrets = new Set(secretKeys);
  for (const [k, v] of Object.entries(settings)) {
    if (!secrets.has(k) && containsEncrypted(v)) {
      throw new Error(`settings field ${k} must not contain an encrypted marker`);
    }
  }
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(settings)) {
    if (!secrets.has(k)) out[k] = v;
  }
  for (const k of secretKeys) {
    const v = settings[k];
    if (typeof v === 'string' && v !== '') {
      out[k] = encryptValue(secretKey, pluginName, k, v);
    } else if (v === undefined || isSetMarker(v)) {
      const prev = previous?.[k];
      if (prev !== undefined) out[k] = prev;
    } else if (v !== '') throw new Error(`settings field ${k} has an unrecognised shape`);
    // empty string: removed
  }
  return out;
}

/** The only place that returns plaintext secrets. */
export function openSettings(
  secretKey: Buffer,
  pluginName: string,
  stored: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(stored)) {
    out[k] = isEncrypted(v) ? decryptValue(secretKey, pluginName, k, v) : v;
  }
  return out;
}

/** The API form: every encrypted value becomes `{ set: true }`. */
export function maskSettings(stored: Record<string, JsonValue>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(stored)) {
    out[k] = isEncrypted(v) ? { set: true } : v;
  }
  return out;
}

/** Plaintext secret values, for redaction by value. */
export function secretValues(opened: Record<string, JsonValue>, secretKeys: string[]): string[] {
  const out: string[] = [];
  for (const k of secretKeys) {
    const v = opened[k];
    if (typeof v === 'string' && v !== '') out.push(v);
  }
  return out;
}
