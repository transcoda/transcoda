// POST /api/client-errors: the web UI's error reports (docs/dev/server-api.md, "Web UI error
// reports"). A signed-in browser session only. The body is the session's CSRF token and up to 20
// scrubbed events; each becomes a `client_error` log line and counts in
// `transcoda_client_errors_total`. Nothing is stored and nothing leaves the server.
import { join } from 'node:path';
import { ClientErrorBatchSchema } from '@transcoda/shared';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { verifyCsrfToken } from '../../auth/csrf.ts';
import { checkOrigin } from '../../auth/host-check.ts';
import type { Logger } from '../../platform/logger.ts';
import type { AppDeps } from '../../rpc/context.ts';
import type { ResolvedAuth } from '../auth-context.ts';
import { SourceMaps } from './source-maps.ts';
import { LogThrottle } from './throttle.ts';

/** A full batch of 20 events is far below this. */
export const CLIENT_ERRORS_MAX_BYTES = 64_000;

/** `client_error` lines a minute, all tabs together. */
export const CLIENT_ERROR_LOG_LIMIT = 60;

/** 413 for a body over {@link CLIENT_ERRORS_MAX_BYTES}. */
export const clientErrorsBodyLimit = bodyLimit({
  maxSize: CLIENT_ERRORS_MAX_BYTES,
  onError: (c) =>
    c.json(
      {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Request body is larger than ${CLIENT_ERRORS_MAX_BYTES} bytes`,
      },
      413,
    ),
});

const refuse = (c: Context, status: 400 | 401 | 403, code: string, message: string) =>
  c.json({ code, message }, status);

/** The route's handler; one per app, holding the log throttle and the parsed source maps. */
export function createClientErrorsHandler(
  deps: Pick<AppDeps, 'config' | 'allowedHosts' | 'secretKey' | 'metrics' | 'now'>,
  log: Logger,
): (c: Context, resolved: ResolvedAuth) => Promise<Response> {
  const throttle = new LogThrottle(CLIENT_ERROR_LOG_LIMIT, () => deps.now().getTime());
  const maps = new SourceMaps(
    deps.config.webDistDir === null ? null : join(deps.config.webDistDir, 'assets'),
  );

  return async (c, resolved) => {
    const { auth } = resolved;
    if (auth.kind === 'none') return refuse(c, 401, 'UNAUTHORIZED', 'Authentication required');
    if (auth.kind === 'token') {
      return refuse(c, 403, 'FORBIDDEN', 'Error reports come from the web UI only');
    }
    // The same origin rule as every cookie mutation (rpc/middleware.ts); the token is in the body
    // because sendBeacon cannot set a header.
    const req = c.req.raw;
    const origin = checkOrigin(req, deps.allowedHosts());
    const site = req.headers.get('sec-fetch-site')?.toLowerCase();
    if (
      !(origin === 'ok' || (origin === 'absent' && (site === 'same-origin' || site === 'none')))
    ) {
      return refuse(c, 403, 'CSRF_FAILED', 'Cross-site request refused');
    }
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return refuse(c, 400, 'BAD_REQUEST', 'The body is not JSON');
    }
    const parsed = ClientErrorBatchSchema.safeParse(body);
    if (!parsed.success) return refuse(c, 400, 'BAD_REQUEST', 'Not an error report');
    if (!verifyCsrfToken(deps.secretKey, auth.sessionIdHash, parsed.data.csrf)) {
      return refuse(c, 403, 'CSRF_FAILED', 'Cross-site request refused');
    }

    for (const e of parsed.data.events) {
      deps.metrics.countClientErrors(e.kind, e.count);
      const take = throttle.take();
      if (take === 'first-drop') {
        log.warn({ msg: 'client_error throttled', limitPerMinute: CLIENT_ERROR_LOG_LIMIT });
      }
      if (take !== 'log') continue;
      const stack = await Promise.all(e.stack.map((f) => maps.resolve(f)));
      log.warn({
        msg: 'client_error',
        kind: e.kind,
        route: e.route,
        version: e.version,
        name: e.name,
        message: e.message,
        count: e.count,
        stack,
      });
    }
    return c.body(null, 204);
  };
}
