import { readCookie, SESSION_COOKIE } from '../auth/cookies.ts';
import { findUserById } from '../db/repos/users.ts';
import type { AppDeps, AuthContext } from '../rpc/context.ts';

const NONE: AuthContext = { kind: 'none' };

export interface ResolvedAuth {
  auth: AuthContext;
  clearCookie: boolean;
  /** Set when verifying the cookie slid the session; the response should re-send the cookie. */
  renewedSession?: { id: string; expiresAt: Date };
}

/**
 * Resolve the caller. A bearer header is authoritative: an invalid one yields `none` and never
 * falls back to the cookie. A cookie that is present but invalid asks the caller to clear it.
 */
export async function resolveAuth(req: Request, deps: AppDeps): Promise<ResolvedAuth> {
  const authorization = req.headers.get('authorization');
  if (authorization !== null && /^\s*bearer(\s|$)/i.test(authorization)) {
    const m = /^\s*bearer\s+(\S+)\s*$/i.exec(authorization);
    const found = m?.[1] ? deps.tokens.authenticate(m[1]) : null;
    if (!found) return { auth: NONE, clearCookie: false };
    return {
      auth: { kind: 'token', user: found.user, tokenId: found.tokenId, scopes: found.scopes },
      clearCookie: false,
    };
  }

  const sessionId = readCookie(req.headers.get('cookie'), SESSION_COOKIE);
  if (sessionId === null || sessionId === '') return { auth: NONE, clearCookie: false };
  const session = deps.sessions.verify(sessionId);
  const user = session ? findUserById(deps.db, session.userId) : null;
  if (!session || !user) return { auth: NONE, clearCookie: true };
  const auth: AuthContext = { kind: 'session', user, sessionIdHash: session.idHash };
  if (session.renewedExpiresAt) {
    return {
      auth,
      clearCookie: false,
      renewedSession: { id: sessionId, expiresAt: session.renewedExpiresAt },
    };
  }
  return { auth, clearCookie: false };
}
