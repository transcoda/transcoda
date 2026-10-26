import { implement, ORPCError } from '@orpc/server';
import { contract, errorDefs } from '@transcoda/contract';
import type { TokenScope } from '@transcoda/shared';
import { CSRF_HEADER, verifyCsrfToken } from '../auth/csrf.ts';
import { hasScope } from '../auth/tokens.ts';
import { checkOrigin, hostnameOf } from '../http/host-check.ts';
import { requestHost } from '../http/request-info.ts';
import type { AuthContext, ServerContext } from './context.ts';

/** The contract implementer every procedure is built from. */
export const os = implement(contract).$context<ServerContext>();

type SessionAuth = Extract<AuthContext, { kind: 'session' }>;
/** A signed-in caller: a session or an API token, both carrying `user`. */
type UserAuth = Exclude<AuthContext, { kind: 'none' }>;

/**
 * A contract-defined error, built exactly as the handler `errors.X()` proxy builds it. Middlewares
 * see the union of every procedure's error map, so the typed proxy is not usable here; every
 * procedure these middlewares guard declares the codes raised (see contract errors.ts).
 */
function contractError(
  code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'CSRF_FAILED',
  message?: string,
): ORPCError<string, unknown> {
  const def = errorDefs[code];
  return new ORPCError(code, {
    defined: true,
    status: def.status,
    message: message ?? def.message,
  });
}

/** GET procedures are reads; everything else (POST, PUT, PATCH, DELETE, default POST) mutates. */
function isMutation(procedure: { '~orpc': { route: { method?: string } } }): boolean {
  return (procedure['~orpc'].route.method ?? 'POST').toUpperCase() !== 'GET';
}

/**
 * Cookie-authenticated mutations need a trusted Origin/Referer (or, when both are absent,
 * `Sec-Fetch-Site: same-origin|none`) and the session-bound CSRF token.
 */
function sessionCsrfOk(context: ServerContext, auth: SessionAuth): boolean {
  const { req, deps } = context;
  const origin = checkOrigin(req, deps.allowedHosts());
  const fetchSite = req.headers.get('sec-fetch-site')?.toLowerCase();
  const originOk =
    origin === 'ok' ||
    (origin === 'absent' && (fetchSite === 'same-origin' || fetchSite === 'none'));
  if (!originOk) return false;
  return verifyCsrfToken(deps.secretKey, auth.sessionIdHash, req.headers.get(CSRF_HEADER));
}

/**
 * Same-origin guard for the public, cookie-issuing procedures (setup, login), which have no
 * session to bind a CSRF token to. Rejects `Sec-Fetch-Site: cross-site`, and an Origin (else
 * Referer) whose hostname is neither the request's effective host (`host`, see `requestHost`)
 * nor an allowed host. Requests with neither Origin nor Referer (curl, scripts) pass.
 */
export function sameOriginOk(req: Request, host: string | null, allowedHosts: string[]): boolean {
  if (req.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') return false;
  const raw = req.headers.get('origin') ?? req.headers.get('referer');
  if (raw === null) return true;
  let source: string | null;
  try {
    source = hostnameOf(new URL(raw).host);
  } catch {
    source = null; // includes `Origin: null`
  }
  if (source === null) return false;
  return source === hostnameOf(host) || allowedHosts.includes(source);
}

/** Public procedure guarded by `sameOriginOk` (CSRF_FAILED otherwise). */
export const requireSameOrigin = os.middleware(({ context, next }) => {
  const { req, remoteAddr, deps } = context;
  const host = requestHost(req, remoteAddr, deps.trustedProxies);
  if (!sameOriginOk(req, host, deps.allowedHosts())) throw contractError('CSRF_FAILED');
  return next();
});

/** No checks; marks a procedure as intentionally public. */
export const publicProcedure = os.middleware(({ next }) => next());

/** Browser session only (no API tokens), with CSRF protection for mutations. */
export const requireSession = os.middleware(({ context, next, procedure }) => {
  const { auth } = context;
  if (auth.kind !== 'session') throw contractError('UNAUTHORIZED');
  if (isMutation(procedure) && !sessionCsrfOk(context, auth)) throw contractError('CSRF_FAILED');
  return next({ context: { auth } });
});

/**
 * A person's browser session only: every API token is refused with FORBIDDEN, whatever its scopes
 * (activation is a UI action). Narrows `context.auth` to the session like `requireSession`.
 */
export function requireHumanSessionWith(refusal: string) {
  return os.middleware(({ context, next, procedure }) => {
    const { auth } = context;
    if (auth.kind === 'none') throw contractError('UNAUTHORIZED');
    if (auth.kind === 'token') throw contractError('FORBIDDEN', refusal);
    if (isMutation(procedure) && !sessionCsrfOk(context, auth)) throw contractError('CSRF_FAILED');
    return next({ context: { auth } });
  });
}

/** The activation routes' guard: refusal text "Activation is a UI action". */
export const requireHumanSession = requireHumanSessionWith('Activation is a UI action');

/**
 * A session (CSRF-checked for mutations) or an API token carrying `scope`. Narrows
 * `context.auth` to the signed-in caller, so handlers can read `context.auth.user`.
 */
export function requireScope(scope: TokenScope) {
  return requireAnyScope(scope);
}

/** As {@link requireScope}, passing when the token holds any of `scopes` (each exact). */
export function requireAnyScope(...scopes: TokenScope[]) {
  return os.middleware(({ context, next, procedure }) => {
    const { auth: caller } = context;
    if (caller.kind === 'none') throw contractError('UNAUTHORIZED');
    if (caller.kind === 'session') {
      if (isMutation(procedure) && !sessionCsrfOk(context, caller))
        throw contractError('CSRF_FAILED');
    } else if (!scopes.some((scope) => hasScope(caller.scopes, scope))) {
      throw contractError('FORBIDDEN');
    }
    const auth: UserAuth = caller;
    return next({ context: { auth } });
  });
}
