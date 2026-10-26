import fs from 'node:fs';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import type { Context } from 'hono';
import { findJob, findJobResult } from '../db/repos/jobs.ts';
import type { AppDeps } from '../rpc/context.ts';
import { sameOriginOk } from '../rpc/middleware.ts';
import type { ResolvedAuth } from './auth-context.ts';
import { parseRange } from './range.ts';
import { requestHost } from './request-info.ts';

/** Route of a kept test output, under /api/v1 (outside the oRPC contract: it streams a file). */
export const TEST_OUTPUT_PATH = '/api/v1/jobs/:id/test-output';

const CONTENT_TYPES = { mp4: 'video/mp4', mkv: 'video/x-matroska' } as const;
const COMMON = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;

/**
 * A download name for a job's file: `<job file name without extension, safe characters only>` +
 * `suffix` (`fallback` when the job has no file name).
 */
export function jobDownloadName(
  path: string | undefined,
  fallback: string,
  suffix: string,
): string {
  const file = path ? basename(path) : '';
  const stem = (file.slice(0, file.length - extname(file).length) || fallback)
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .slice(0, 100);
  return `${stem}${suffix}`;
}

/** `<job file name>.test-encode.<container>`. */
const downloadName = (path: string | undefined, container: 'mkv' | 'mp4') =>
  jobDownloadName(path, 'test-output', `.test-encode.${container}`);

export const closeQuietly = (fd: number): void => {
  try {
    fs.closeSync(fd);
  } catch {
    // already closed
  }
};

/**
 * Plays or downloads a kept test output. Guarded like the backup download: a person's browser
 * session only (every API token → 403, no MCP tool), never cross-site, never cached, addressed by
 * job id only (the path comes from the registered row; a symlink or anything but a regular file in
 * its place is a 404). Range is honoured for a download and for an mp4 played inline. `?play=1` on
 * an mkv serves its cached mp4 preview, built on the first play (see TestOutputStore.preview): 503
 * BUSY when too many are building, 503 SCRATCH_LOW without the space, 500 when ffmpeg fails. A
 * HEAD never builds one; it says in `x-preview` whether a play now would be served or refused.
 */
export async function testOutputResponse(
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
    return c.json({ code: 'FORBIDDEN', message: 'Test outputs are played in the UI' }, 403);
  }
  const host = requestHost(c.req.raw, remoteAddr, deps.trustedProxies);
  if (!sameOriginOk(c.req.raw, host, deps.allowedHosts())) {
    return c.json({ code: 'CSRF_FAILED', message: 'Cross-site request refused' }, 403);
  }
  const id = c.req.param('id') ?? '';
  const store = deps.engine.testOutputs;
  const opened = store.open(id);
  if (!opened) return c.json({ error: 'NOT_FOUND' }, 404);
  const { row } = opened;
  const head = c.req.method === 'HEAD';
  const play = c.req.query('play') === '1';
  const name = downloadName(findJob(deps.db, id)?.path, row.container);

  if (!play || row.container === 'mp4') {
    const disposition = `${play ? 'inline' : 'attachment'}; filename="${name}"`;
    return fileResponse(c, opened, CONTENT_TYPES[row.container], disposition);
  }

  const disposition = `inline; filename="${name.replace(/\.mkv$/, '.mp4')}"`;
  // Hono answers HEAD with this handler and drops the body: never build a preview for it.
  // `x-preview` says where the preview stands (TestOutputStore.previewState), for the player.
  if (head) {
    closeQuietly(opened.fd);
    const state = await store.previewState(id, opened.size);
    const built = state === 'ready' ? store.openPreview(id) : null;
    if (built) {
      const res = fileResponse(c, built, 'video/mp4', disposition);
      res.headers.set('x-preview', 'ready');
      return res;
    }
    return new Response(null, {
      status: 200,
      headers: {
        ...COMMON,
        'content-type': 'video/mp4',
        'content-disposition': disposition,
        'accept-ranges': 'bytes',
        'x-preview': state === 'ready' ? 'none' : state,
      },
    });
  }
  const preview = await store.preview(id, opened, {
    ffmpegPath: deps.config.ffmpegPath,
    plan: findJobResult(deps.db, id)?.plan ?? null,
  });
  // The client may have gone while the build ran: the server never reads this response then.
  if (c.req.raw.signal.aborted) {
    if (preview.kind === 'ready') closeQuietly(preview.fd);
    return new Response(null, { status: 499 });
  }
  switch (preview.kind) {
    case 'ready':
      return fileResponse(c, preview, 'video/mp4', disposition);
    case 'missing':
      return c.json({ error: 'NOT_FOUND' }, 404);
    case 'busy':
      return c.json({ code: 'BUSY', message: 'Too many previews are being prepared' }, 503, {
        ...COMMON,
        'retry-after': '5',
      });
    case 'scratchLow':
      return c.json(
        { code: 'SCRATCH_LOW', message: 'Not enough scratch space to prepare the preview' },
        503,
        COMMON,
      );
    case 'failed':
      return c.json(
        { code: 'PREVIEW_FAILED', message: 'Could not prepare the preview' },
        500,
        COMMON,
      );
  }
}

/**
 * A checked fd as the response, with Range (206, or 416 when unsatisfiable). Streams from that fd
 * (no second open by path); autoClose closes it at the end, on an error, or when the client goes
 * away: the request's abort signal destroys the stream (the node server does not cancel a body it
 * stopped writing). A HEAD closes it at once.
 */
export function fileResponse(
  c: Context,
  file: { fd: number; size: number },
  contentType: string,
  disposition: string,
): Response {
  const { fd, size } = file;
  const range = parseRange(c.req.header('range') ?? null, size);
  if (range === 'unsatisfiable') {
    closeQuietly(fd);
    return new Response(null, {
      status: 416,
      headers: { ...COMMON, 'content-range': `bytes */${size}` },
    });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const headers: Record<string, string> = {
    ...COMMON,
    'content-type': contentType,
    'content-disposition': disposition,
    'accept-ranges': 'bytes',
    'content-length': String(size === 0 ? 0 : end - start + 1),
  };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  const status = range ? 206 : 200;
  if (c.req.method === 'HEAD' || size === 0) {
    closeQuietly(fd);
    return new Response(null, { status, headers });
  }
  const stream = fs.createReadStream('', { fd, start, end, autoClose: true });
  const { signal } = c.req.raw;
  if (signal.aborted) stream.destroy();
  else signal.addEventListener('abort', () => stream.destroy(), { once: true });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
}
