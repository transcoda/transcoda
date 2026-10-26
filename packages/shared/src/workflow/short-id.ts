const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** 10 characters from [A-Za-z0-9_-]; works in Node and browsers. */
export function shortId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(10));
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte & 63];
  return out;
}
