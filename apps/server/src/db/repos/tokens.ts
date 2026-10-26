import type { ApiToken } from '@transcoda/contract';
import type { TokenScope } from '@transcoda/shared';
import type { Database } from '../open.ts';

export interface TokenRow {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  scopes: TokenScope[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface RawToken {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  scopes: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

const fromRaw = (r: RawToken): TokenRow => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  tokenHash: r.token_hash,
  scopes: JSON.parse(r.scopes) as TokenScope[],
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

export function toApiToken(row: TokenRow): ApiToken {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

export function insertToken(db: Database, row: TokenRow): void {
  db.prepare(
    `INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at, expires_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.userId,
    row.name,
    row.tokenHash,
    JSON.stringify(row.scopes),
    row.createdAt,
    row.expiresAt,
    row.lastUsedAt,
    row.revokedAt,
  );
}

export function findTokenByHash(db: Database, tokenHash: string): TokenRow | null {
  const r = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(tokenHash) as
    | RawToken
    | undefined;
  return r ? fromRaw(r) : null;
}

export function listTokens(db: Database, userId: string): TokenRow[] {
  const rows = db
    .prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC, id')
    .all(userId) as RawToken[];
  return rows.map(fromRaw);
}

/** Revokes a token owned by `userId`; false if it does not exist, is not theirs, or is already revoked. */
export function revokeToken(db: Database, id: string, userId: string, now: Date): boolean {
  return (
    db
      .prepare(
        'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      )
      .run(now.toISOString(), id, userId).changes > 0
  );
}

export function touchTokenLastUsed(db: Database, id: string, now: Date): void {
  db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now.toISOString(), id);
}
