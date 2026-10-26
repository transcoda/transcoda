import type { Database } from '../open.ts';

export interface SessionRow {
  idHash: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

interface RawSession {
  id_hash: string;
  user_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

export function insertSession(
  db: Database,
  s: { idHash: string; userId: string; now: Date; expiresAt: string },
): void {
  const ts = s.now.toISOString();
  db.prepare(
    'INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(s.idHash, s.userId, ts, ts, s.expiresAt);
}

export function findSession(db: Database, idHash: string): SessionRow | null {
  const r = db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as
    | RawSession
    | undefined;
  return r
    ? {
        idHash: r.id_hash,
        userId: r.user_id,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        expiresAt: r.expires_at,
      }
    : null;
}

export function touchSession(
  db: Database,
  idHash: string,
  t: { lastSeenAt: string; expiresAt: string },
): void {
  db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?').run(
    t.lastSeenAt,
    t.expiresAt,
    idHash,
  );
}

export function deleteSession(db: Database, idHash: string): void {
  db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
}

export function deleteExpiredSessions(db: Database, now: Date): number {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString()).changes;
}

export function deleteSessionsForUser(db: Database, userId: string): number {
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

/** Signs a user out everywhere except the session `keepIdHash` (a password change keeps the caller's). */
export function deleteOtherSessions(db: Database, userId: string, keepIdHash: string): number {
  return db
    .prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?')
    .run(userId, keepIdHash).changes;
}
