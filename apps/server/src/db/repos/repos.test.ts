import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Database } from '../open.ts';
import { createTestDb } from '../test-db.ts';
import { deleteExpiredSessions, findSession, insertSession } from './sessions.ts';
import { getSetting, setSetting } from './settings.ts';
import { findTokenByHash, insertToken, revokeToken } from './tokens.ts';
import { countUsers, createUser, findUserById, findUserByUsername } from './users.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const later = (ms: number) => new Date(now.getTime() + ms).toISOString();

describe('repositories', () => {
  let db: Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('createUser then findUserByUsername is case-insensitive', () => {
    const u = createUser(db, { username: 'admin', passwordHash: 'h' }, now);
    expect(countUsers(db)).toBe(1);
    expect(findUserByUsername(db, 'Admin')?.id).toBe(u.id);
    expect(findUserById(db, u.id)).toEqual({
      id: u.id,
      username: 'admin',
      createdAt: now.toISOString(),
    });
  });

  it('duplicate username throws', () => {
    createUser(db, { username: 'admin', passwordHash: 'h' }, now);
    expect(() => createUser(db, { username: 'ADMIN', passwordHash: 'h' }, now)).toThrow(
      expect.objectContaining({ code: 'SQLITE_CONSTRAINT_UNIQUE' }),
    );
  });

  it('deleting a user cascades sessions and tokens', () => {
    const u = createUser(db, { username: 'a', passwordHash: 'h' }, now);
    insertSession(db, { idHash: 's1', userId: u.id, now, expiresAt: later(1000) });
    insertToken(db, {
      id: 't1',
      userId: u.id,
      name: 'n',
      tokenHash: 'th',
      scopes: ['read'],
      createdAt: now.toISOString(),
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    });
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    expect(findSession(db, 's1')).toBeNull();
    expect(findTokenByHash(db, 'th')).toBeNull();
  });

  it('deleteExpiredSessions removes only expired', () => {
    const u = createUser(db, { username: 'a', passwordHash: 'h' }, now);
    insertSession(db, { idHash: 'old', userId: u.id, now, expiresAt: later(-1000) });
    insertSession(db, { idHash: 'new', userId: u.id, now, expiresAt: later(1000) });
    expect(deleteExpiredSessions(db, now)).toBe(1);
    expect(findSession(db, 'old')).toBeNull();
    expect(findSession(db, 'new')).not.toBeNull();
  });

  it("revokeToken returns false for another user's token", () => {
    const a = createUser(db, { username: 'a', passwordHash: 'h' }, now);
    const b = createUser(db, { username: 'b', passwordHash: 'h' }, now);
    insertToken(db, {
      id: 't1',
      userId: a.id,
      name: 'n',
      tokenHash: 'th',
      scopes: ['read', 'plan'],
      createdAt: now.toISOString(),
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(revokeToken(db, 't1', b.id, now)).toBe(false);
    expect(findTokenByHash(db, 'th')?.revokedAt).toBeNull();
    expect(revokeToken(db, 't1', a.id, now)).toBe(true);
    const row = findTokenByHash(db, 'th');
    expect(row?.revokedAt).toBe(now.toISOString());
    expect(row?.scopes).toEqual(['read', 'plan']);
  });

  it('getSetting returns null when absent and parses JSON when present', () => {
    const schema = z.array(z.string());
    expect(getSetting(db, 'allowed_hosts', schema)).toBeNull();
    setSetting(db, 'allowed_hosts', ['a.example'], now);
    expect(getSetting(db, 'allowed_hosts', schema)).toEqual(['a.example']);
    setSetting(db, 'allowed_hosts', ['b.example'], now);
    expect(getSetting(db, 'allowed_hosts', schema)).toEqual(['b.example']);
  });
});
