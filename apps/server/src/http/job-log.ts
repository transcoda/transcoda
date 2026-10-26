import fs from 'node:fs';
import type { Context } from 'hono';
import { findJob } from '../db/repos/jobs.ts';
import type { AppDeps } from '../rpc/context.ts';
import { sameOriginOk } from '../rpc/middleware.ts';
import type { ResolvedAuth } from './auth-context.ts';
import { requestHost } from './request-info.ts';
import { closeQuietly, fileResponse, jobDownloadName } from './test-output.ts';

/**
 * Route of a job's whole ffmpeg log, under /api/v1 (outside the oRPC contract: it streams a file;
 * `jobs.log` answers only its tail).
 */
export const JOB_LOG_PATH = '/api/v1/jobs/:id/log/download';

/** Opens the log read-only; null when it is missing or not a regular file. */
function openLog(path: string): { fd: number; size: number } | null {
  let fd: number;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) {
    closeQuietly(fd);
    return null;
  }
  return { fd, size: stat.size };
}

/**
 * Downloads the job's ffmpeg log as it is now (a running job's log may grow after; the download
 * stops at the size it had when opened). Guarded like the test output: a person's browser session
 * only (every API token → 403; tokens read the tail with `jobs.log`), never cross-site, never
 * cached, addressed by job id only (the path comes from the job). No log yet → 404.
 */
export function jobLogResponse(
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
    return c.json({ code: 'FORBIDDEN', message: 'Job logs are downloaded in the UI' }, 403);
  }
  const host = requestHost(c.req.raw, remoteAddr, deps.trustedProxies);
  if (!sameOriginOk(c.req.raw, host, deps.allowedHosts())) {
    return c.json({ code: 'CSRF_FAILED', message: 'Cross-site request refused' }, 403);
  }
  const id = c.req.param('id') ?? '';
  const path = deps.engine.jobLogPath(id);
  const opened = path === null ? null : openLog(path);
  if (!opened) return c.json({ error: 'NOT_FOUND' }, 404);
  const name = jobDownloadName(findJob(deps.db, id)?.path, 'job', '.ffmpeg.log');
  // The test output's file response: Range, HEAD, and the stream closed when the client goes.
  return fileResponse(c, opened, 'text/plain; charset=utf-8', `attachment; filename="${name}"`);
}
