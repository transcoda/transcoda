import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTE_PATTERNS, scrubRoute, UNKNOWN_ROUTE } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { routePattern } from './routes.ts';

describe('routePattern', () => {
  it.each([
    ['/', '/'],
    ['/jobs', '/jobs'],
    ['/jobs/3f2a91c0-1234-4abc-9def-0123456789ab', '/jobs/:id'],
    ['/libraries/abc/files/def', '/libraries/:id/files/:fileId'],
    ['/libraries/abc/shows/Harbor%20Lights', '/libraries/:id/shows/:show'],
    [
      '/libraries/abc/shows/Harbor%20Lights/seasons/2',
      '/libraries/:id/shows/:show/seasons/:season',
    ],
    ['/libraries/abc/health', '/libraries/:id/health'],
    ['/workflows/new', '/workflows/new'],
    ['/workflows/abc', '/workflows/:id'],
    ['/settings', '/settings/:section?/:sub?'],
    ['/settings/api-tokens', '/settings/:section?/:sub?'],
    ['/settings/about/licenses', '/settings/:section?/:sub?'],
    ['/settings/tokens', '/settings/tokens'],
    ['/jobs/a/b', UNKNOWN_ROUTE],
    ['/Harbor Lights', UNKNOWN_ROUTE],
  ])('%s is %s', (path, pattern) => {
    expect(routePattern(path)).toBe(pattern);
  });

  it('every pattern passes the server check, so a report never says <unknown> for a real page', () => {
    for (const p of [...ROUTE_PATTERNS, UNKNOWN_ROUTE]) expect(scrubRoute(p)).toBe(p);
  });

  it('lists exactly the routes App.tsx has', () => {
    const app = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8');
    const inApp = [...app.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(inApp)).toEqual(new Set(ROUTE_PATTERNS));
  });
});
