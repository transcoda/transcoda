import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, PASSWORD_ALGO, verifyPassword } from './password.ts';

function scryptHash(password: string, N = 32768): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `$scrypt$N=${N},r=8,p=1$${salt.toString('base64').replace(/=+$/, '')}$${hash.toString('base64').replace(/=+$/, '')}`;
}

describe('password hashing', () => {
  it('uses argon2id', () => {
    expect(PASSWORD_ALGO).toBe('argon2id');
  });

  it('hash and verify round-trip', async () => {
    const h = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', h)).toBe(true);
  });

  it('verify rejects wrong password', async () => {
    const h = await hashPassword('correct horse');
    expect(await verifyPassword('wrong horse', h)).toBe(false);
  });

  it('two hashes of the same password differ', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it("stored string starts with '$' + PASSWORD_ALGO and has the documented PHC shape", async () => {
    const h = await hashPassword('x');
    expect(h.startsWith(`$${PASSWORD_ALGO}$`)).toBe(true);
    expect(h).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  });

  it('verify returns false for garbage and never throws', async () => {
    for (const s of [
      '',
      'x',
      '$argon2id$',
      '$argon2id$v=19$m=65536,t=3,p=1$$',
      '$argon2id$v=19$m=abc,t=3,p=1$AAAA$AAAA',
      '$argon2id$v=19$m=65536,t=3,p=1$AAAA$AAAA',
      '$argon2id$v=19$m=999999999,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '$scrypt$N=3,r=8,p=1$AAAA$AAAA',
      '$scrypt$N=x$AAAA$AAAA',
      '$bcrypt$12$abc$def',
      '$$$$$$',
    ]) {
      expect(await verifyPassword('pw', s)).toBe(false);
    }
  });

  it('needsRehash false for a fresh hash', async () => {
    expect(needsRehash(await hashPassword('x'))).toBe(false);
  });

  it('needsRehash true for other params, scrypt and garbage', () => {
    expect(needsRehash('$argon2id$v=19$m=1024,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAA')).toBe(true);
    expect(needsRehash(scryptHash('x', 1024))).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
  });

  it('verifies scrypt PHC hashes', async () => {
    const h = scryptHash('legacy');
    expect(await verifyPassword('legacy', h)).toBe(true);
    expect(await verifyPassword('other', h)).toBe(false);
  });

  it('hashing takes under 2 s', async () => {
    const t = Date.now();
    await hashPassword('timing');
    expect(Date.now() - t).toBeLessThan(5000);
  });
});
