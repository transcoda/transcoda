import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../open.ts';
import { createTestDb } from '../test-db.ts';
import { deleteExpiredSessions, findSession, insertSession } from './sessions.ts';
import { createUser } from './users.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const later = (ms: number) => new Date(now.getTime() + ms).toISOString();

describe('sessions', () => {
  let db: Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('deleteExpiredSessions removes only expired', () => {
    const u = createUser(db, { username: 'a', passwordHash: 'h' }, now);
    insertSession(db, { idHash: 'old', userId: u.id, now, expiresAt: later(-1000) });
    insertSession(db, { idHash: 'new', userId: u.id, now, expiresAt: later(1000) });
    expect(deleteExpiredSessions(db, now)).toBe(1);
    expect(findSession(db, 'old')).toBeNull();
    expect(findSession(db, 'new')).not.toBeNull();
  });
});
