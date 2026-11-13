import type { Context } from 'hono';
import { hasScope } from '../auth/tokens.ts';
import { EXPOSITION_CONTENT_TYPE } from '../metrics/exposition.ts';
import type { AppDeps } from '../rpc/context.ts';
import type { ResolvedAuth } from './auth-context.ts';

/** Prometheus' default scrape path, outside `/api/v1` (a plain text body, not the contract). */
export const METRICS_PATH = '/metrics';

/**
 * The Prometheus scrape. A bearer token with the `metrics` scope, or a signed-in session (a GET
 * that changes nothing, so no CSRF check). Off with `TRANSCODA_METRICS=false`: 404 before auth.
 */
export async function metricsResponse(
  c: Context,
  deps: AppDeps,
  resolved: ResolvedAuth,
): Promise<Response> {
  if (!deps.config.metrics) return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
  const { auth } = resolved;
  if (auth.kind === 'none') {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401, {
      'www-authenticate': 'Bearer realm="transcoda"',
    });
  }
  if (auth.kind === 'token' && !hasScope(auth.scopes, 'metrics')) {
    return c.json({ code: 'FORBIDDEN', message: 'The token needs the metrics scope' }, 403);
  }
  const body = await deps.metrics.exposition();
  return c.body(body, 200, {
    'content-type': EXPOSITION_CONTENT_TYPE,
    'cache-control': 'no-store',
  });
}
