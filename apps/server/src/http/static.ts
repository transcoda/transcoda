import { resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';

/** Vite's built files under /assets carry a content hash in their name, so they never change. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

export function mountStatic(app: Hono, webDistDir: string): void {
  const root = resolve(webDistDir);
  const files = serveStatic({ root });
  const fallback = serveStatic({ root, path: 'index.html' });
  const isApi = (path: string) =>
    path === '/api' || path.startsWith('/api/') || path === '/rpc' || path.startsWith('/rpc/');

  // index.html (and everything else unhashed) is revalidated on every load, so a browser picks
  // up a new build right after an update instead of running the old app from its cache.
  app.get('*', async (c, next) => {
    await next();
    if (isApi(c.req.path) || c.res.status !== 200) return;
    c.res.headers.set('cache-control', c.req.path.startsWith('/assets/') ? IMMUTABLE : 'no-cache');
  });

  app.get('*', async (c, next) => {
    if (isApi(c.req.path)) return next();
    return files(c, next);
  });
  // A missing asset (last path segment has an extension) is a 404, not the SPA page.
  const looksLikeFile = (path: string) => /\.[^/]+$/.test(path.slice(path.lastIndexOf('/') + 1));

  // SPA fallback for client-side routes.
  app.get('*', async (c, next) => {
    if (isApi(c.req.path) || looksLikeFile(c.req.path)) return next();
    return fallback(c, next);
  });
}
