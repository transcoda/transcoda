import { describe, expect, it } from 'vitest';
import { findSession } from '../db/repos/sessions.ts';
import { createUser } from '../db/repos/users.ts';
import { createTestDb } from '../db/test-db.ts';
import { hashSessionId, SESSION_TTL_MS, SessionService } from './sessions.ts';

function setup() {
  const db = createTestDb();
  let t = new Date('2026-01-01T00:00:00.000Z');
  const clock = {
    advance(ms: number) {
      t = new Date(t.getTime() + ms);
    },
  };
  const user = createUser(db, { username: 'admin', passwordHash: 'h' }, t);
  const svc = new SessionService(db, () => t);
  return { db, svc, user, clock };
}

describe('SessionService', () => {
  it('create returns a 43-char base64url id and stores only its hash', () => {
    const { db, svc, user } = setup();
    const { id } = svc.create(user.id);
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = findSession(db, hashSessionId(id));
    expect(row?.userId).toBe(user.id);
    expect(JSON.stringify(db.prepare('SELECT * FROM sessions').all())).not.toContain(id);
  });

  it('verify returns the user for a valid id', () => {
    const { svc, user } = setup();
    const { id } = svc.create(user.id);
    expect(svc.verify(id)).toEqual({ userId: user.id, idHash: hashSessionId(id) });
  });

  it('verify returns null for an unknown id and for a tampered id', () => {
    const { svc, user } = setup();
    const { id } = svc.create(user.id);
    expect(svc.verify('A'.repeat(43))).toBeNull();
    expect(svc.verify(`${id.slice(0, 42)}${id.endsWith('A') ? 'B' : 'A'}`)).toBeNull();
    expect(svc.verify('short')).toBeNull();
    expect(svc.verify(`${id}!`)).toBeNull();
    expect(svc.verify('')).toBeNull();
  });

  it('verify returns null after 30 days of inactivity', () => {
    const { svc, user, clock } = setup();
    const { id } = svc.create(user.id);
    clock.advance(SESSION_TTL_MS + 1);
    expect(svc.verify(id)).toBeNull();
  });

  it('verify slides expiry when used after the touch interval', () => {
    const { db, svc, user, clock } = setup();
    const { id } = svc.create(user.id);
    const h = hashSessionId(id);
    const e0 = findSession(db, h)?.expiresAt;
    clock.advance(2 * 3600 * 1000);
    const slid = svc.verify(id);
    expect(slid).not.toBeNull();
    const e1 = findSession(db, h)?.expiresAt;
    expect(slid?.renewedExpiresAt?.toISOString()).toBe(e1);
    expect(e1).not.toBe(e0);
    expect(e1).toBe(
      new Date(Date.parse('2026-01-01T02:00:00.000Z') + SESSION_TTL_MS).toISOString(),
    );
    clock.advance(10 * 60 * 1000);
    const within = svc.verify(id);
    expect(within).not.toBeNull();
    expect(within).not.toHaveProperty('renewedExpiresAt');
    expect(findSession(db, h)?.expiresAt).toBe(e1);
  });

  it('revoke makes verify return null', () => {
    const { svc, user } = setup();
    const { id } = svc.create(user.id);
    svc.revoke(id);
    expect(svc.verify(id)).toBeNull();
  });

  it('two logins produce two different ids', () => {
    const { svc, user } = setup();
    expect(svc.create(user.id).id).not.toBe(svc.create(user.id).id);
  });

  it('revokeAllForUser removes only that user sessions and returns the count', () => {
    const { db, svc, user, clock } = setup();
    const other = createUser(db, { username: 'other', passwordHash: 'h' }, new Date());
    const a = svc.create(user.id);
    svc.create(user.id);
    const b = svc.create(other.id);
    expect(svc.revokeAllForUser(user.id)).toBe(2);
    expect(svc.verify(a.id)).toBeNull();
    expect(svc.verify(b.id)).not.toBeNull();
    clock.advance(0);
  });

  it('purgeExpired removes expired sessions only', () => {
    const { svc, user, clock } = setup();
    const old = svc.create(user.id);
    clock.advance(SESSION_TTL_MS - 1000);
    const fresh = svc.create(user.id);
    clock.advance(2000);
    expect(svc.purgeExpired()).toBe(1);
    expect(svc.verify(old.id)).toBeNull();
    expect(svc.verify(fresh.id)).not.toBeNull();
  });
});
