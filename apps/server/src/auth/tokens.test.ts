import { describe, expect, it } from 'vitest';
import { findTokenByHash } from '../db/repos/tokens.ts';
import { createUser } from '../db/repos/users.ts';
import { createTestDb } from '../db/test-db.ts';
import {
  generateToken,
  hashToken,
  hasScope,
  InvalidTokenExpiryError,
  looksLikeToken,
  TOKEN_PREFIX,
  TokenService,
} from './tokens.ts';

function setup() {
  const db = createTestDb();
  let t = new Date('2026-01-01T00:00:00.000Z');
  const clock = {
    advance(ms: number) {
      t = new Date(t.getTime() + ms);
    },
  };
  const user = createUser(db, { username: 'admin', passwordHash: 'h' }, t);
  const svc = new TokenService(db, () => t);
  return { db, svc, user, clock };
}

describe('token helpers', () => {
  it('generateToken produces tcd_ + 43 base64url chars and a 64-hex hash', () => {
    const { token, tokenHash } = generateToken();
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(token).toMatch(/^tcd_[A-Za-z0-9_-]{43}$/);
    expect(token).toHaveLength(47);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(tokenHash);
    expect(generateToken().token).not.toBe(token);
  });

  it('looksLikeToken rejects malformed values', () => {
    const body = 'A'.repeat(43);
    expect(looksLikeToken(`tcd_${body}`)).toBe(true);
    expect(looksLikeToken('Bearer')).toBe(false);
    expect(looksLikeToken('tcd_')).toBe(false);
    expect(looksLikeToken(`tcd_${'A'.repeat(42)}`)).toBe(false);
    expect(looksLikeToken(`tcd_${'A'.repeat(44)}`)).toBe(false);
    expect(looksLikeToken(`tcd_${'A'.repeat(42)}!`)).toBe(false);
    expect(looksLikeToken(`xxx_${body}`)).toBe(false);
    expect(looksLikeToken('')).toBe(false);
  });

  it('hasScope', () => {
    expect(hasScope(['read', 'plan'], 'plan')).toBe(true);
    expect(hasScope(['read'], 'jobs:create')).toBe(false);
    expect(hasScope([], 'read')).toBe(false);
  });
});

describe('TokenService', () => {
  it('create returns the plaintext once and the row stores only the hash', () => {
    const { db, svc, user } = setup();
    const out = svc.create(user.id, { name: 'ci', scopes: ['read', 'plan'] });
    expect(out.token).toMatch(/^tcd_[A-Za-z0-9_-]{43}$/);
    expect(out.name).toBe('ci');
    expect(out.scopes).toEqual(['read', 'plan']);
    expect(out.expiresAt).toBeNull();
    expect(out.lastUsedAt).toBeNull();
    expect(out.revokedAt).toBeNull();
    expect(findTokenByHash(db, hashToken(out.token))?.id).toBe(out.id);
    expect(JSON.stringify(db.prepare('SELECT * FROM api_tokens').all())).not.toContain(out.token);
  });

  it('authenticate succeeds with the plaintext and sets last_used_at', () => {
    const { db, svc, user } = setup();
    const out = svc.create(user.id, { name: 'ci', scopes: ['read'] });
    const res = svc.authenticate(out.token);
    expect(res?.user.id).toBe(user.id);
    expect(res?.tokenId).toBe(out.id);
    expect(res?.scopes).toEqual(['read']);
    expect(findTokenByHash(db, hashToken(out.token))?.lastUsedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('authenticate touches last_used_at at most once per minute', () => {
    const { db, svc, user, clock } = setup();
    const out = svc.create(user.id, { name: 'ci', scopes: ['read'] });
    const h = hashToken(out.token);
    svc.authenticate(out.token);
    clock.advance(30_000);
    svc.authenticate(out.token);
    expect(findTokenByHash(db, h)?.lastUsedAt).toBe('2026-01-01T00:00:00.000Z');
    clock.advance(31_000);
    svc.authenticate(out.token);
    expect(findTokenByHash(db, h)?.lastUsedAt).toBe('2026-01-01T00:01:01.000Z');
  });

  it('authenticate returns null after revoke', () => {
    const { svc, user } = setup();
    const out = svc.create(user.id, { name: 'ci', scopes: ['read'] });
    expect(svc.revoke(user.id, out.id)).toBe(true);
    expect(svc.authenticate(out.token)).toBeNull();
    expect(svc.revoke(user.id, out.id)).toBe(false);
  });

  it('revoke refuses another user and unknown ids', () => {
    const { db, svc, user } = setup();
    const other = createUser(db, { username: 'other', passwordHash: 'h' }, new Date());
    const out = svc.create(user.id, { name: 'ci', scopes: ['read'] });
    expect(svc.revoke(other.id, out.id)).toBe(false);
    expect(svc.revoke(user.id, 'nope')).toBe(false);
    expect(svc.authenticate(out.token)).not.toBeNull();
  });

  it('authenticate returns null after expiresAt', () => {
    const { svc, user, clock } = setup();
    const out = svc.create(user.id, {
      name: 'ci',
      scopes: ['read'],
      expiresAt: '2026-01-01T01:00:00Z',
    });
    expect(svc.authenticate(out.token)).not.toBeNull();
    clock.advance(3600 * 1000);
    expect(svc.authenticate(out.token)).toBeNull();
  });

  it('authenticate returns null for a well-formed unknown token and malformed input', () => {
    const { svc } = setup();
    expect(svc.authenticate(generateToken().token)).toBeNull();
    expect(svc.authenticate('garbage')).toBeNull();
    expect(svc.authenticate('')).toBeNull();
  });

  it('drops unknown stored scopes when mapping', () => {
    const { db, svc, user } = setup();
    const out = svc.create(user.id, { name: 'ci', scopes: ['read'] });
    db.prepare('UPDATE api_tokens SET scopes = ? WHERE id = ?').run(
      JSON.stringify(['read', 'admin']),
      out.id,
    );
    expect(svc.authenticate(out.token)?.scopes).toEqual(['read']);
    expect(svc.list(user.id)[0]?.scopes).toEqual(['read']);
  });

  it('list hides token values and includes revoked ones with revokedAt set', () => {
    const { svc, user, clock } = setup();
    const a = svc.create(user.id, { name: 'a', scopes: ['read'] });
    clock.advance(1000);
    const b = svc.create(user.id, { name: 'b', scopes: ['plan'] });
    svc.revoke(user.id, a.id);
    const list = svc.list(user.id);
    expect(list.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(list.find((x) => x.id === a.id)?.revokedAt).not.toBeNull();
    expect(list.find((x) => x.id === b.id)?.revokedAt).toBeNull();
    for (const item of list) {
      expect(item).not.toHaveProperty('tokenHash');
      expect(item).not.toHaveProperty('token');
    }
    expect(JSON.stringify(list)).not.toContain(a.token);
  });

  it('create rejects past, equal-to-now and unparseable expiresAt', () => {
    const { svc, user } = setup();
    for (const expiresAt of ['2025-12-31T23:59:59Z', '2026-01-01T00:00:00.000Z', 'not a date']) {
      expect(() => svc.create(user.id, { name: 'x', scopes: ['read'], expiresAt })).toThrow(
        InvalidTokenExpiryError,
      );
    }
    expect(svc.list(user.id)).toEqual([]);
  });

  it('authenticate does not touch last_used_at of revoked or expired tokens', () => {
    const { db, svc, user, clock } = setup();
    const a = svc.create(user.id, { name: 'a', scopes: ['read'] });
    svc.revoke(user.id, a.id);
    clock.advance(120_000);
    expect(svc.authenticate(a.token)).toBeNull();
    expect(findTokenByHash(db, hashToken(a.token))?.lastUsedAt).toBeNull();
    const b = svc.create(user.id, {
      name: 'b',
      scopes: ['read'],
      expiresAt: '2026-01-01T00:10:00Z',
    });
    clock.advance(600_000);
    expect(svc.authenticate(b.token)).toBeNull();
    expect(findTokenByHash(db, hashToken(b.token))?.lastUsedAt).toBeNull();
  });

  it('authenticate returns null when the user no longer exists', () => {
    const { db, svc, user } = setup();
    const out = svc.create(user.id, { name: 'ci', scopes: ['read'] });
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    expect(svc.authenticate(out.token)).toBeNull();
  });
});
