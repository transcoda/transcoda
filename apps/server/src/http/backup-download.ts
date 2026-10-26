import fs from 'node:fs';
import { Readable } from 'node:stream';
import type { Context } from 'hono';
import { backupDirOf, findBackupFile } from '../db/backup.ts';
import type { AppDeps } from '../rpc/context.ts';
import { sameOriginOk } from '../rpc/middleware.ts';
import type { ResolvedAuth } from './auth-context.ts';
import { requestHost } from './request-info.ts';

/** Route of the download, under /api/v1 (outside the oRPC contract: it streams a file). */
export const BACKUP_DOWNLOAD_PATH = '/api/v1/system/backups/:name/download';

/**
 * Streams one backup as an attachment. A backup holds the password and token hashes and the
 * encrypted plugin secrets, so it is guarded like the database: a person's browser session only
 * (every API token → 403, no MCP tool), never cross-site (the session cookie is SameSite=Lax; a
 * `Sec-Fetch-Site: cross-site` request or a foreign Origin is refused too), never cached. A name
 * that is not a listed backup (traversal, `.part`, other files) is a plain 404.
 */
export function backupDownload(
  c: Context,
  deps: AppDeps,
  resolved: ResolvedAuth,
  remoteAddr: string,
): Response {
  const { auth } = resolved;
  if (auth.kind === 'none') {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }
  if (auth.kind === 'token') {
    return c.json({ code: 'FORBIDDEN', message: 'Backups are downloaded in the UI' }, 403);
  }
  const host = requestHost(c.req.raw, remoteAddr, deps.trustedProxies);
  if (!sameOriginOk(c.req.raw, host, deps.allowedHosts())) {
    return c.json({ code: 'CSRF_FAILED', message: 'Cross-site request refused' }, 403);
  }
  const name = c.req.param('name') ?? '';
  const found = findBackupFile(backupDirOf(deps.config.configDir), name);
  if (!found) return c.json({ error: 'NOT_FOUND' }, 404);
  const headers = {
    'content-type': 'application/vnd.sqlite3',
    'content-disposition': `attachment; filename="${name}"`,
    'content-length': String(found.size),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  // Hono answers HEAD with the GET handler and drops the body without cancelling it: close the fd
  // here and never create a stream, or every HEAD would leak a descriptor.
  if (c.req.method === 'HEAD') {
    fs.closeSync(found.fd);
    return new Response(null, { status: 200, headers });
  }
  // Streams from the fd that was checked; autoClose closes it at the end, on an error, or when the
  // client goes away (cancelling the web stream destroys the Node stream).
  const stream = fs.createReadStream('', { fd: found.fd, autoClose: true });
  const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  return new Response(body, { status: 200, headers });
}
