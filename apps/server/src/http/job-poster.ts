import fs from 'node:fs';
import { Readable } from 'node:stream';
import type { Context } from 'hono';
import type { AppDeps } from '../rpc/context.ts';
import { sameOriginOk } from '../rpc/middleware.ts';
import type { ResolvedAuth } from './auth-context.ts';
import { requestHost } from './request-info.ts';
import { closeHandleQuietly, type OpenedHandle, openRegularFile } from './test-output.ts';

/** Route of a job's poster thumbnail, under /api/v1 (outside the oRPC contract: it returns bytes). */
export const JOB_POSTER_PATH = '/api/v1/jobs/:id/poster';

const HEADERS = {
  'content-type': 'image/jpeg',
  'cache-control': 'private, max-age=86400',
  'x-content-type-options': 'nosniff',
} as const;

/**
 * A job's poster as a small JPEG thumbnail. Guarded like the job log: a person's browser session
 * only (every API token → 403), never cross-site, addressed by job id only (the poster path comes
 * from the job). An unknown job, no poster, no thumbnail or a thumbnail file that vanished → 404.
 */
const posterEtag = (size: number, mtimeMs: number): string => `"${size}-${Math.round(mtimeMs)}"`;

export async function jobPosterResponse(
  c: Context,
  deps: AppDeps,
  resolved: ResolvedAuth,
  remoteAddr: string,
): Promise<Response> {
  const { auth } = resolved;
  if (auth.kind === 'none') {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }
  if (auth.kind === 'token') {
    return c.json({ code: 'FORBIDDEN', message: 'Posters are shown in the UI' }, 403);
  }
  const host = requestHost(c.req.raw, remoteAddr, deps.trustedProxies);
  if (!sameOriginOk(c.req.raw, host, deps.allowedHosts())) {
    return c.json({ code: 'CSRF_FAILED', message: 'Cross-site request refused' }, 403);
  }
  // `?of=show`: the show's own poster the job's media names (show cards).
  const of = c.req.query('of') === 'show' ? 'show' : undefined;
  const thumb = await deps.engine.jobPoster(c.req.param('id') ?? '', of);
  if (!thumb) return c.json({ error: 'NOT_FOUND' }, 404);
  const etag = posterEtag(thumb.size, thumb.mtimeMs);
  const headers = { ...HEADERS, etag };
  if (
    c.req
      .header('if-none-match')
      ?.split(',')
      .some((v) => v.trim() === etag)
  ) {
    return new Response(null, { status: 304, headers });
  }
  // Read-only, no symlink, a regular file only; one that vanished or failed its stat → 404.
  let opened: OpenedHandle | null;
  try {
    opened = await openRegularFile(thumb.path);
  } catch {
    return c.json({ error: 'NOT_FOUND' }, 404);
  }
  if (!opened) return c.json({ error: 'NOT_FOUND' }, 404);
  // The ETag and length of what is sent come from the open handle: a rebuild that renamed a new
  // thumbnail over the path while the open was pending must not go out under the old ETag.
  const { handle, size, mtimeMs } = opened;
  const sized = { ...HEADERS, etag: posterEtag(size, mtimeMs), 'content-length': String(size) };
  if (c.req.method === 'HEAD' || size === 0) {
    await closeHandleQuietly(handle);
    return new Response(null, { status: 200, headers: sized });
  }
  const stream = fs.createReadStream('', { fd: handle, start: 0, end: size - 1, autoClose: true });
  const { signal } = c.req.raw;
  if (signal.aborted) stream.destroy();
  else signal.addEventListener('abort', () => stream.destroy(), { once: true });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status: 200,
    headers: sized,
  });
}
