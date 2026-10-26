import { resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';

export function mountStatic(app: Hono, webDistDir: string): void {
  const root = resolve(webDistDir);
  const files = serveStatic({ root });
  const fallback = serveStatic({ root, path: 'index.html' });
  const isApi = (path: string) =>
    path === '/api' || path.startsWith('/api/') || path === '/rpc' || path.startsWith('/rpc/');

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
