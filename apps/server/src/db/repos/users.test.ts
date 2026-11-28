import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../open.ts';
import { createTestDb } from '../testing.ts';
import { findSession, insertSession } from './sessions.ts';
import { findTokenByHash, insertToken } from './tokens.ts';
import { countUsers, createUser, findUserById, findUserByUsername } from './users.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const later = (ms: number) => new Date(now.getTime() + ms).toISOString();

describe('users', () => {
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
});
