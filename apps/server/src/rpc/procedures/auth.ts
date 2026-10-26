import crypto from 'node:crypto';
import type { User } from '@transcoda/contract';
import { z } from 'zod';
import { clearSessionCookie, sessionCookie } from '../../auth/cookies.ts';
import { csrfTokenFor } from '../../auth/csrf.ts';
import { hashPassword, needsRehash, verifyPassword } from '../../auth/password.ts';
import type { Database } from '../../db/open.ts';
import { deleteOtherSessions, deleteSession } from '../../db/repos/sessions.ts';
import { getSetting, setSetting } from '../../db/repos/settings.ts';
import {
  countUsers,
  createUser,
  findUserByUsername,
  type UserWithHash,
  updatePasswordHash,
} from '../../db/repos/users.ts';
import { ALWAYS_ALLOWED_HOSTS, hostnameOf } from '../../http/host-check.ts';
import { clientIp, isHttps, requestHost } from '../../http/request-info.ts';
import { readAppearance } from '../../settings/service.ts';
import type { ServerContext } from '../context.ts';
import {
  os,
  publicProcedure,
  requireHumanSessionWith,
  requireSameOrigin,
  requireSession,
} from '../middleware.ts';

class SetupAlreadyDone extends Error {}

/** Never let the password hash reach a response. */
const publicUser = ({ id, username, createdAt }: UserWithHash): User => ({
  id,
  username,
  createdAt,
});

let dummyHash: Promise<string> | undefined;
/**
 * A real argon2id hash (current params) of a random, never-revealed password, computed once
 * lazily. Verifying unknown usernames against it keeps login timing equal to a wrong password.
 */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(crypto.randomBytes(32).toString('base64url')).catch((e: unknown) => {
    dummyHash = undefined; // let the next login retry instead of caching the failure
    throw e;
  });
  return dummyHash;
}

function secure(context: ServerContext): boolean {
  return isHttps(context.req, context.remoteAddr, context.deps.trustedProxies);
}

/** Fails loudly: a dropped Set-Cookie would silently break login/logout. */
function appendSetCookie(context: ServerContext, value: string): void {
  if (!context.resHeaders)
    throw new Error('resHeaders missing: ResponseHeadersPlugin not installed');
  context.resHeaders.append('set-cookie', value);
}

function startSession(context: ServerContext, userId: string): void {
  const session = context.deps.sessions.create(userId);
  appendSetCookie(
    context,
    sessionCookie(session.id, { secure: secure(context), expires: session.expiresAt }),
  );
}

/** Add the setup request's effective hostname (see `requestHost`) to `allowed_hosts` (deduplicated; always-allowed hosts skipped). */
function recordHost(db: Database, host: string | null, now: Date): void {
  const name = hostnameOf(host);
  if (name === null || ALWAYS_ALLOWED_HOSTS.includes(name)) return;
  let stored: string[] = [];
  try {
    stored = getSetting(db, 'allowed_hosts', z.array(z.string())) ?? [];
  } catch {
    stored = [];
  }
  if (stored.includes(name)) return;
  setSetting(db, 'allowed_hosts', [...stored, name], now);
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

export const setup = os.auth.setup
  .use(requireSameOrigin)
  .handler(async ({ input, context, errors }) => {
    const { db } = context.deps;
    if (countUsers(db) > 0) throw errors.SETUP_ALREADY_DONE();
    const passwordHash = await hashPassword(input.password);
    const now = context.deps.now();
    let created: UserWithHash;
    try {
      // Re-check inside the transaction: a concurrent setup may have won while we were hashing.
      created = db.transaction(() => {
        if (countUsers(db) > 0) throw new SetupAlreadyDone();
        const user = createUser(db, { username: input.username, passwordHash }, now);
        recordHost(
          db,
          requestHost(context.req, context.remoteAddr, context.deps.trustedProxies),
          now,
        );
        return user;
      })();
    } catch (e) {
      if (e instanceof SetupAlreadyDone || isUniqueViolation(e)) throw errors.SETUP_ALREADY_DONE();
      throw e;
    }
    startSession(context, created.id);
    return { user: publicUser(created) };
  });

export const login = os.auth.login
  .use(requireSameOrigin)
  .handler(async ({ input, context, errors }) => {
    const { db, limiter } = context.deps;
    const ip = clientIp(context.req, context.remoteAddr, context.deps.trustedProxies);
    const keys = [`ip:${ip}`, `user:${input.username.toLowerCase()}`];
    const gate = limiter.check(keys);
    if (!gate.allowed) {
      throw errors.RATE_LIMITED({
        data: { retryAfterSeconds: Math.ceil(gate.retryAfterMs / 1000) },
      });
    }

    // Reserve the attempt before the (async) verify so a parallel burst cannot all pass `check`;
    // `check` + `recordFailure` run with no await between them. Cleared again on success.
    limiter.recordFailure(keys);
    const user = findUserByUsername(db, input.username);
    const ok = await verifyPassword(input.password, user?.passwordHash ?? (await getDummyHash()));
    if (!user || !ok) throw errors.INVALID_CREDENTIALS();
    limiter.recordSuccess(keys);

    if (needsRehash(user.passwordHash)) {
      updatePasswordHash(db, user.id, await hashPassword(input.password));
    }
    // Rotation: drop the session the request arrived with, then issue a fresh id.
    if (context.auth.kind === 'session') deleteSession(db, context.auth.sessionIdHash);
    startSession(context, user.id);
    return { user: publicUser(user) };
  });

export const logout = os.auth.logout.use(requireSession).handler(({ context }) => {
  deleteSession(context.deps.db, context.auth.sessionIdHash);
  appendSetCookie(context, clearSessionCookie({ secure: secure(context) }));
  return { ok: true as const };
});

export const me = os.auth.me.use(publicProcedure).handler(({ context }) => {
  const { auth, deps } = context;
  const appearance = readAppearance(deps.db);
  return {
    setupRequired: deps.setupRequired(),
    user: auth.kind === 'none' ? null : auth.user,
    csrfToken: auth.kind === 'session' ? csrfTokenFor(deps.secretKey, auth.sessionIdHash) : null,
    // The theme applies before sign-in too; the server name is for signed-in callers only.
    appearance: {
      ...appearance,
      serverName: auth.kind === 'none' ? null : appearance.serverName,
    },
  };
});

/**
 * A person's browser session only (CSRF-checked; every API token is refused, whatever its scopes).
 * Rate-limited like login (IP + username). Signs the user out of their other browser sessions;
 * API tokens keep working.
 */
export const changePassword = os.auth.changePassword
  .use(requireHumanSessionWith('Passwords are changed in the UI'))
  .handler(async ({ input, context, errors }) => {
    const { db, limiter } = context.deps;
    const { user, sessionIdHash } = context.auth;
    const ip = clientIp(context.req, context.remoteAddr, context.deps.trustedProxies);
    const keys = [`ip:${ip}`, `user:${user.username.toLowerCase()}`];
    const gate = limiter.check(keys);
    if (!gate.allowed) {
      throw errors.RATE_LIMITED({
        data: { retryAfterSeconds: Math.ceil(gate.retryAfterMs / 1000) },
      });
    }
    // Reserved before the async verify, as in login, so a parallel burst cannot all pass `check`.
    limiter.recordFailure(keys);
    const stored = findUserByUsername(db, user.username);
    const ok = await verifyPassword(
      input.currentPassword,
      stored?.passwordHash ?? (await getDummyHash()),
    );
    if (!stored || !ok) {
      throw errors.INVALID_CREDENTIALS({ message: 'The current password is wrong' });
    }
    limiter.recordSuccess(keys);
    const passwordHash = await hashPassword(input.newPassword);
    db.transaction(() => {
      updatePasswordHash(db, user.id, passwordHash);
      deleteOtherSessions(db, user.id, sessionIdHash);
    })();
    return { ok: true as const };
  });
