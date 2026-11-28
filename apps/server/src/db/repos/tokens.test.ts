import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../open.ts';
import { createTestDb } from '../testing.ts';
import { findTokenByHash, insertToken, revokeToken } from './tokens.ts';
import { createUser } from './users.ts';

const now = new Date('2026-01-01T00:00:00.000Z');

describe('tokens', () => {
  let db: Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
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
});
