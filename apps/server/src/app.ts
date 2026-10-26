import { getConnInfo } from '@hono/node-server/conninfo';
import { ORPCError } from '@orpc/server';
import { errorDefs } from '@transcoda/contract';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { clearSessionCookie, SESSION_COOKIE, sessionCookie } from './auth/cookies.ts';
import { type ResolvedAuth, resolveAuth } from './http/auth-context.ts';
import { BACKUP_DOWNLOAD_PATH, backupDownload } from './http/backup-download.ts';
import { checkHost, hostnameOf } from './http/host-check.ts';
import { JOB_LOG_PATH, jobLogResponse } from './http/job-log.ts';
import { isHttps, requestHost } from './http/request-info.ts';
import { mountStatic } from './http/static.ts';
import { TEST_OUTPUT_PATH, testOutputResponse } from './http/test-output.ts';
import type { Logger } from './logger.ts';
import { createMcpHandler } from './mcp/handler.ts';
import { jsonRpcError } from './mcp/jsonrpc.ts';
import type { AnyToolDef } from './mcp/tool.ts';
import { ALL_TOOLS } from './mcp/tools/index.ts';
import type { AppDeps, ServerContext } from './rpc/context.ts';
import { createHandlers } from './rpc/handlers.ts';
import { createRouter } from './rpc/router.ts';

export interface AppOptions {
  deps: AppDeps;
  log: Logger;
  getRemoteAddr?: (c: Context) => string;
  /** Tools offered on /mcp (default: all of them). */
  mcpTools?: AnyToolDef[];
}

function defaultRemoteAddr(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? '127.0.0.1';
  } catch {
    return '127.0.0.1';
  }
}

/**
 * The HOST_NOT_ALLOWED error as oRPC itself would encode it, so oRPC clients (`safe`,
 * `isDefinedError`) parse it: the bare error JSON for REST, wrapped as `{ json, meta }` for RPC.
 */
function hostNotAllowedBody(host: string | null, rpc: boolean): object {
  const def = errorDefs.HOST_NOT_ALLOWED;
  const json = new ORPCError('HOST_NOT_ALLOWED', {
    defined: true,
    status: def.status,
    message: def.message,
    data: { host: hostnameOf(host) ?? '' },
  }).toJSON();
  return rpc ? { json, meta: [] } : json;
}

/** Largest request body accepted on /api and /rpc (a 500-node graph is far below this). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

const isRpcPath = (path: string) => path === '/rpc' || path.startsWith('/rpc/');

/** 413 as an (undefined) oRPC error, so oRPC clients parse it like any other error. */
const tooLarge = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => {
    const json = new ORPCError('PAYLOAD_TOO_LARGE', {
      status: 413,
      message: `Request body is larger than ${MAX_BODY_BYTES} bytes`,
    }).toJSON();
    return c.json(isRpcPath(c.req.path) ? { json, meta: [] } : json, 413);
  },
});

/** 413 on /mcp as a JSON-RPC error. */
const tooLargeMcp = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: () => jsonRpcError(413, -32600, `Request body is larger than ${MAX_BODY_BYTES} bytes`),
});

export function createApp(opts: AppOptions): Hono {
  const { deps, log } = opts;
  const getRemoteAddr = opts.getRemoteAddr ?? defaultRemoteAddr;
  const router = createRouter();
  const handlers = createHandlers(router, deps.version, log);
  const app = new Hono();

  // Resolves the caller once per request, before the oRPC handlers run.
  const buildCtx = async (c: Context): Promise<{ ctx: ServerContext; resolved: ResolvedAuth }> => {
    const resolved = await resolveAuth(c.req.raw, deps);
    return {
      ctx: { req: c.req.raw, remoteAddr: getRemoteAddr(c), auth: resolved.auth, deps },
      resolved,
    };
  };

  // Session cookie upkeep, unless the procedure already set or cleared tcd_session itself
  // (setup/login/logout): clear a stale cookie, or re-send a slid one with its new Expires.
  const respond = (c: Context, response: Response, ctx: ServerContext, resolved: ResolvedAuth) => {
    const out = c.newResponse(response.body, response);
    const setsSession = out.headers.getSetCookie().some((h) => h.startsWith(`${SESSION_COOKIE}=`));
    if (setsSession) return out;
    const secure = isHttps(ctx.req, ctx.remoteAddr, deps.trustedProxies);
    if (resolved.clearCookie) {
      out.headers.append('set-cookie', clearSessionCookie({ secure }));
    } else if (resolved.renewedSession) {
      const { id, expiresAt } = resolved.renewedSession;
      out.headers.append('set-cookie', sessionCookie(id, { secure, expires: expiresAt }));
    }
    return out;
  };

  // (1) Host check for API and RPC paths. Skipped while no users exist so the first visit can reach setup.
  app.use('*', async (c, next) => {
    const path = c.req.path;
    const guarded =
      path === '/api' ||
      path.startsWith('/api/') ||
      path === '/rpc' ||
      path.startsWith('/rpc/') ||
      path === '/mcp';
    if (guarded && !deps.setupRequired()) {
      const host = requestHost(c.req.raw, getRemoteAddr(c), deps.trustedProxies);
      if (checkHost(host, deps.allowedHosts()) !== 'ok') {
        if (path === '/mcp') {
          return jsonRpcError(403, -32000, 'Host not allowed', { host: hostnameOf(host) ?? '' });
        }
        const rpc = path === '/rpc' || path.startsWith('/rpc/');
        return c.json(hostNotAllowedBody(host, rpc), 403);
      }
    }
    return next();
  });

  // (1b) Request body size limit.
  app.use('/api/*', tooLarge);
  app.use('/rpc/*', tooLarge);
  app.use('/mcp', tooLargeMcp);

  // (2) Browser RPC.
  app.use('/rpc/*', async (c, next) => {
    const { ctx, resolved } = await buildCtx(c);
    const { matched, response } = await handlers.rpc.handle(c.req.raw, {
      prefix: '/rpc',
      context: ctx,
    });
    return matched ? respond(c, response, ctx, resolved) : next();
  });

  // (2b) MCP (Streamable HTTP, bearer tokens only).
  app.all(
    '/mcp',
    createMcpHandler({
      router,
      deps,
      version: deps.version,
      log,
      tools: opts.mcpTools ?? ALL_TOOLS,
      getRemoteAddr,
    }),
  );

  // (3) OpenAPI spec.
  app.get('/api/openapi.json', async (c) => c.json(await handlers.spec()));

  // (3b) Backup download: a file stream, so a plain route beside the contract (session only).
  app.get(BACKUP_DOWNLOAD_PATH, async (c) => {
    const { ctx, resolved } = await buildCtx(c);
    return respond(c, backupDownload(c, deps, resolved, ctx.remoteAddr), ctx, resolved);
  });

  // (3c) Kept test outputs: a file stream, so a plain route beside the contract (session only).
  // GET (and HEAD) only: DELETE of the same path is the contract's jobs.deleteTestOutput.
  app.get(TEST_OUTPUT_PATH, async (c) => {
    const { ctx, resolved } = await buildCtx(c);
    return respond(c, await testOutputResponse(c, deps, resolved, ctx.remoteAddr), ctx, resolved);
  });

  // (3d) A job's whole ffmpeg log: a file stream, so a plain route beside the contract (session only).
  app.get(JOB_LOG_PATH, async (c) => {
    const { ctx, resolved } = await buildCtx(c);
    return respond(c, jobLogResponse(c, deps, resolved, ctx.remoteAddr), ctx, resolved);
  });

  // (4) REST.
  app.use('/api/v1/*', async (c, next) => {
    const { ctx, resolved } = await buildCtx(c);
    const { matched, response } = await handlers.openapi.handle(c.req.raw, {
      prefix: '/api/v1',
      context: ctx,
    });
    return matched ? respond(c, response, ctx, resolved) : next();
  });

  // (5) Static UI.
  if (deps.config.webDistDir) mountStatic(app, deps.config.webDistDir);

  // (6) Fallback.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const path = c.req.path;
    const api =
      path === '/api' || path.startsWith('/api/') || path === '/rpc' || path.startsWith('/rpc/');
    if (path === '/mcp') {
      // The error name only: a message may echo a request body (a webhook URL).
      log.error(`request failed: ${err instanceof Error ? err.name : 'unknown error'}`);
      return jsonRpcError(500, -32603, 'Internal error');
    }
    log.error(`request failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    if (api) return c.json({ error: 'INTERNAL' }, 500);
    return c.text('Internal Server Error', 500);
  });
  app.notFound((c) => c.json({ error: 'NOT_FOUND' }, 404));
  return app;
}
