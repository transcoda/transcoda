import { type JsonValue, SECRET_PLACEHOLDER } from '@transcoda/shared';

const MIN_SECRET_CHARS = 4;

export type SecretEncoding = 'raw' | 'url' | 'form' | 'b64' | 'b64url';

/**
 * The forms a secret is looked for in: itself, url-encoded, form-urlencoded (what URLSearchParams
 * writes: space as +, and !'()~* percent-encoded), base64 and base64url.
 */
export function secretForms(secret: string): Array<{ form: string; enc: SecretEncoding }> {
  const bytes = Buffer.from(secret);
  return [
    { form: secret, enc: 'raw' },
    { form: encodeURIComponent(secret), enc: 'url' },
    { form: new URLSearchParams([['', secret]]).toString().slice(1), enc: 'form' },
    { form: bytes.toString('base64'), enc: 'b64' },
    { form: bytes.toString('base64url'), enc: 'b64url' },
  ];
}

/**
 * The base64 characters of a secret that do not depend on what precedes or follows it, at each of
 * the three byte alignments (`user:<secret>` in a Basic auth header is aligned differently from
 * the secret alone).
 */
function base64Fragments(secret: string): string[] {
  const out: string[] = [];
  const start = [0, 2, 3];
  for (const k of [0, 1, 2] as const) {
    const encoded = Buffer.from(`${'\0'.repeat(k)}${secret}`)
      .toString('base64')
      .replace(/=+$/, '');
    const partialTail = (k + Buffer.byteLength(secret)) % 3 === 0 ? 0 : 1;
    const fragment = encoded.slice(start[k], encoded.length - partialTail);
    out.push(fragment, fragment.replaceAll('+', '-').replaceAll('/', '_'));
  }
  return out;
}

function clearForms(secret: string): string[] {
  if (secret.length < MIN_SECRET_CHARS) return [];
  return [
    ...secretForms(secret).map((f) => f.form),
    JSON.stringify(secret).slice(1, -1),
    ...base64Fragments(secret),
  ].filter((form) => form.length >= MIN_SECRET_CHARS);
}

/**
 * Replaces every secret (and its url-encoded, base64 and base64url forms, base64 at every byte
 * alignment, and its JSON-escaped form) with the placeholder, longest first so a secret that
 * contains another is replaced whole.
 */
export function createRedactor(secrets: string[]): (text: string) => string {
  const ordered = [...new Set(secrets.flatMap(clearForms))].sort((a, b) => b.length - a.length);
  if (ordered.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const form of ordered) out = out.split(form).join(SECRET_PLACEHOLDER);
    return out;
  };
}

/** Redacts every string value (not object keys) inside a JSON value. */
export function redactJson(redact: (s: string) => string, value: JsonValue): JsonValue {
  return mapStrings(value, redact);
}

function mapStrings(value: JsonValue, fn: (s: string) => string): JsonValue {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = mapStrings(item, fn);
    }
    return out;
  }
  return value;
}

export interface SecretEntry {
  /** The settings field, '.'-joined when nested. */
  path: string;
  value: string;
}

const TOKEN_PREFIX = '__TRANSCODA_SECRET__';
const TOKEN_PATTERN = /__TRANSCODA_SECRET__[A-Za-z0-9_.]+?__(?:raw|url|form|b64|b64url)__/g;

/** The token grammar is [A-Za-z0-9_.] only: anything else in a field path becomes `_`. */
export function sanitizeSecretPath(path: string): string {
  return path.replace(/[^A-Za-z0-9_.]/g, '_');
}

export function secretToken(path: string, enc: SecretEncoding): string {
  return `${TOKEN_PREFIX}${sanitizeSecretPath(path)}__${enc}__`;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * For the fetch channel only: each secret occurrence becomes a plain-ASCII token naming the field
 * and the encoding found, so the server (which owns the secrets) can put the real value back. Text
 * outside the tokens still goes through `fallback` (the clear redactor) so a form the tokens do not
 * cover, such as base64 of a prefixed secret, never leaves the process.
 */
export function createTokenizer(
  entries: SecretEntry[],
  fallback: (text: string) => string,
): (text: string) => string {
  const byForm = new Map<string, { path: string; enc: SecretEncoding }>();
  for (const { path, value } of entries) {
    if (value.length < MIN_SECRET_CHARS) continue;
    for (const { form, enc } of secretForms(value)) {
      if (form.length >= MIN_SECRET_CHARS && !byForm.has(form)) byForm.set(form, { path, enc });
    }
  }
  if (byForm.size === 0) return fallback;
  const forms = [...byForm.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(forms.map(escapeRegExp).join('|'), 'g');
  return (text) => {
    // One pass, so a token that was just written is never scanned again.
    const replaced = text.replace(pattern, (hit) => {
      const found = byForm.get(hit);
      return found ? secretToken(found.path, found.enc) : hit;
    });
    let out = '';
    let last = 0;
    for (const m of replaced.matchAll(TOKEN_PATTERN)) {
      out += fallback(replaced.slice(last, m.index)) + m[0];
      last = m.index + m[0].length;
    }
    return out + fallback(replaced.slice(last));
  };
}

export function tokenizeJson(tokenize: (s: string) => string, value: JsonValue): JsonValue {
  return mapStrings(value, tokenize);
}
