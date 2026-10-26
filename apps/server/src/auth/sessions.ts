import crypto from 'node:crypto';
import type { Database } from '../db/open.ts';
import {
  deleteExpiredSessions,
  deleteSession,
  deleteSessionsForUser,
  findSession,
  insertSession,
  touchSession,
} from '../db/repos/sessions.ts';

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const SESSION_TOUCH_INTERVAL_MS = 3600 * 1000;

const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;

export function hashSessionId(id: string): string {
  return crypto.createHash('sha256').update(id).digest('hex');
}

export class SessionService {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(userId: string): { id: string; expiresAt: Date } {
    const id = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    insertSession(this.db, {
      idHash: hashSessionId(id),
      userId,
      now,
      expiresAt: expiresAt.toISOString(),
    });
    return { id, expiresAt };
  }

  /**
   * Returns the session owner, or null. When this call slid the expiry (used after the touch
   * interval), `renewedExpiresAt` carries the new expiry so the caller can refresh the cookie.
   */
  verify(id: string): { userId: string; idHash: string; renewedExpiresAt?: Date } | null {
    if (!SESSION_ID_RE.test(id)) return null;
    const idHash = hashSessionId(id);
    const row = findSession(this.db, idHash);
    if (!row) return null;
    const now = this.now();
    if (row.expiresAt <= now.toISOString()) return null;
    if (now.getTime() - Date.parse(row.lastSeenAt) > SESSION_TOUCH_INTERVAL_MS) {
      const renewedExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);
      touchSession(this.db, idHash, {
        lastSeenAt: now.toISOString(),
        expiresAt: renewedExpiresAt.toISOString(),
      });
      return { userId: row.userId, idHash, renewedExpiresAt };
    }
    return { userId: row.userId, idHash };
  }

  revoke(id: string): void {
    deleteSession(this.db, hashSessionId(id));
  }

  revokeAllForUser(userId: string): number {
    return deleteSessionsForUser(this.db, userId);
  }

  purgeExpired(): number {
    return deleteExpiredSessions(this.db, this.now());
  }
}
