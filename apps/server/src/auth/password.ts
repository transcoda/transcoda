import crypto from 'node:crypto';

export const PASSWORD_ALGO = 'argon2id' as const;

const ARGON = { memory: 65536, passes: 3, parallelism: 1, tagLength: 32, saltLength: 16 } as const;
const SCRYPT_MAX_N = 1 << 20;

function argon2(
  message: string,
  salt: Buffer,
  memory: number,
  passes: number,
  parallelism: number,
  tagLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.argon2(
      'argon2id',
      { message, nonce: salt, parallelism, tagLength, memory, passes },
      (err, out) => (err ? reject(err) : resolve(out)),
    );
  });
}

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number, len: number) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, len, { N, r, p, maxmem: 256 * 1024 * 1024 }, (err, out) =>
      err ? reject(err) : resolve(out),
    );
  });
}

const b64 = (b: Buffer): string => b.toString('base64').replace(/=+$/, '');
const BASE64_RE = /^[A-Za-z0-9+/]+$/;

function unb64(s: string | undefined): Buffer | null {
  if (!s || !BASE64_RE.test(s) || s.length % 4 === 1) return null;
  return Buffer.from(s, 'base64');
}

function parseParams(s: string | undefined): Record<string, number> | null {
  if (!s) return null;
  const out: Record<string, number> = {};
  for (const part of s.split(',')) {
    const m = /^([A-Za-z]+)=(\d{1,10})$/.exec(part);
    if (!m) return null;
    out[m[1] as string] = Number(m[2]);
  }
  return out;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(ARGON.saltLength);
  const hash = await argon2(
    password,
    salt,
    ARGON.memory,
    ARGON.passes,
    ARGON.parallelism,
    ARGON.tagLength,
  );
  return `$argon2id$v=19$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts[0] !== '') return false;
    if (parts[1] === 'argon2id') {
      // ['', 'argon2id', 'v=19', 'm=..,t=..,p=..', salt, hash]
      if (parts.length !== 6 || parts[2] !== 'v=19') return false;
      const params = parseParams(parts[3]);
      const salt = unb64(parts[4]);
      const expected = unb64(parts[5]);
      if (!params || !salt || !expected) return false;
      const { m, t, p } = params;
      if (m === undefined || t === undefined || p === undefined) return false;
      if (salt.length < 8 || expected.length < 4 || m < 8 * p || m > 1 << 21 || t < 1 || t > 20)
        return false;
      if (p < 1 || p > 16) return false;
      const actual = await argon2(password, salt, m, t, p, expected.length);
      return crypto.timingSafeEqual(actual, expected);
    }
    if (parts[1] === 'scrypt') {
      // ['', 'scrypt', 'N=..,r=..,p=..', salt, hash]
      if (parts.length !== 5) return false;
      const params = parseParams(parts[2]);
      const salt = unb64(parts[3]);
      const expected = unb64(parts[4]);
      if (!params || !salt || !expected) return false;
      const { N, r, p } = params;
      if (N === undefined || r === undefined || p === undefined) return false;
      if (N < 2 || N > SCRYPT_MAX_N || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16)
        return false;
      if (expected.length < 4 || salt.length < 8) return false;
      const actual = await scrypt(password, salt, N, r, p, expected.length);
      return crypto.timingSafeEqual(actual, expected);
    }
    return false;
  } catch {
    return false;
  }
}

export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts[0] !== '' || parts[1] !== 'argon2id' || parts.length !== 6 || parts[2] !== 'v=19')
    return true;
  const params = parseParams(parts[3]);
  if (!params) return true;
  const tag = unb64(parts[5]);
  return (
    params.m !== ARGON.memory ||
    params.t !== ARGON.passes ||
    params.p !== ARGON.parallelism ||
    tag?.length !== ARGON.tagLength
  );
}
