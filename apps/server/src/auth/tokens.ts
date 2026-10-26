import crypto from 'node:crypto';
import type { ApiToken, TokenCreateInput, TokenCreateOutput, User } from '@transcoda/contract';
import { isTokenScope, type TokenScope } from '@transcoda/shared';
import type { Database } from '../db/open.ts';
import {
  findTokenByHash,
  insertToken,
  listTokens,
  revokeToken,
  type TokenRow,
  toApiToken,
  touchTokenLastUsed,
} from '../db/repos/tokens.ts';
import { findUserById } from '../db/repos/users.ts';

export const TOKEN_PREFIX = 'tcd_';
export const TOKEN_TOUCH_INTERVAL_MS = 60 * 1000;

const TOKEN_RE = /^tcd_[A-Za-z0-9_-]{43}$/;

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateToken(): { token: string; tokenHash: string } {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/** Cheap shape check (prefix, exact length, base64url charset) before hashing or touching the DB. */
export function looksLikeToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

export function hasScope(scopes: TokenScope[], required: TokenScope): boolean {
  return scopes.includes(required);
}

/** Defence in depth: drop scopes that are not (or no longer) known. */
function clean(row: TokenRow): TokenRow {
  return { ...row, scopes: row.scopes.filter(isTokenScope) };
}

export class InvalidTokenExpiryError extends Error {
  constructor(message = 'expiresAt must be a valid date in the future') {
    super(message);
    this.name = 'InvalidTokenExpiryError';
  }
}

export class TokenService {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(userId: string, input: TokenCreateInput): TokenCreateOutput {
    const now = this.now();
    let expiresAt: string | null = null;
    if (input.expiresAt) {
      const d = new Date(input.expiresAt);
      if (Number.isNaN(d.getTime()) || d.getTime() <= now.getTime()) {
        throw new InvalidTokenExpiryError();
      }
      // Normalise so lexicographic comparison with toISOString() timestamps is valid.
      expiresAt = d.toISOString();
    }
    const { token, tokenHash } = generateToken();
    const row: TokenRow = {
      id: crypto.randomUUID(),
      userId,
      name: input.name,
      tokenHash,
      scopes: [...input.scopes],
      createdAt: now.toISOString(),
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    };
    insertToken(this.db, row);
    return { ...toApiToken(row), token };
  }

  list(userId: string): ApiToken[] {
    return listTokens(this.db, userId).map((r) => toApiToken(clean(r)));
  }

  revoke(userId: string, id: string): boolean {
    return revokeToken(this.db, id, userId, this.now());
  }

  authenticate(bearer: string): { user: User; tokenId: string; scopes: TokenScope[] } | null {
    if (!looksLikeToken(bearer)) return null;
    const found = findTokenByHash(this.db, hashToken(bearer));
    if (!found) return null;
    const row = clean(found);
    const now = this.now();
    if (row.revokedAt !== null) return null;
    if (row.expiresAt !== null && row.expiresAt <= now.toISOString()) return null;
    const user = findUserById(this.db, row.userId);
    if (!user) return null;
    if (
      row.lastUsedAt === null ||
      now.getTime() - Date.parse(row.lastUsedAt) > TOKEN_TOUCH_INTERVAL_MS
    ) {
      touchTokenLastUsed(this.db, row.id, now);
    }
    return { user, tokenId: row.id, scopes: row.scopes };
  }
}
