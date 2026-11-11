import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseExposition } from '../metrics/parse-exposition.ts';
import { createTestApp, type TestApp } from '../test-app.ts';
import { asSession, bearer, createToken, HOST, login, type Session, send } from '../test-http.ts';

let t: TestApp;
let s: Session;

async function scrape(headers: Record<string, string> = {}, method = 'GET'): Promise<Response> {
  return await t.app.request('/metrics', { method, headers: { host: HOST, ...headers } });
}

afterEach(async () => {
  await t.close();
});

describe('GET /metrics', () => {
  beforeEach(async () => {
    t = createTestApp();
    s = await login(t);
  });

  it('a metrics token gets the Prometheus text format, never cached', async () => {
    const { token } = await createToken(t, s, { name: 'prom', scopes: ['metrics'] });
    const res = await scrape(bearer(token));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const parsed = parseExposition(await res.text());
    expect(parsed.types.get('transcoda_build_info')).toBe('gauge');
    expect(parsed.samples.find((x) => x.name === 'transcoda_queue_paused')?.value).toBe(0);
  });

  it('a signed-in session may read it too', async () => {
    const res = await scrape(asSession(s, false));
    expect(res.status).toBe(200);
  });

  it('no credentials is 401 with WWW-Authenticate; an invalid token is 401', async () => {
    const anon = await scrape();
    expect(anon.status).toBe(401);
    expect(anon.headers.get('www-authenticate')).toBe('Bearer realm="transcoda"');
    expect((await scrape(bearer('tcd_nope'))).status).toBe(401);
  });

  it('a token without the metrics scope is 403, even with every other scope', async () => {
    const { token } = await createToken(t, s, {
      name: 'all-but',
      scopes: ['read', 'plan', 'jobs:create', 'jobs:manage', 'workflows:write'],
    });
    expect((await scrape(bearer(token))).status).toBe(403);
  });

  it('a host that is not allowed is 403', async () => {
    const { token } = await createToken(t, s, { name: 'prom', scopes: ['metrics'] });
    const res = await scrape({ ...bearer(token), host: 'evil.example' });
    expect(res.status).toBe(403);
  });

  it('a revoked token is refused on the next scrape', async () => {
    const { id, token } = await createToken(t, s, { name: 'prom', scopes: ['metrics'] });
    expect((await scrape(bearer(token))).status).toBe(200);
    await send(t, 'DELETE', `/tokens/${id}`, { headers: asSession(s, true) });
    expect((await scrape(bearer(token))).status).toBe(401);
  });

  it('only GET (and HEAD): POST is not served', async () => {
    const { token } = await createToken(t, s, { name: 'prom', scopes: ['metrics'] });
    expect((await scrape(bearer(token), 'POST')).status).toBe(404);
  });
});

describe('GET /api/v1/system/status', () => {
  beforeEach(async () => {
    t = createTestApp();
    s = await login(t);
  });

  it('a metrics token gets the summary', async () => {
    const { token } = await createToken(t, s, { name: 'ha', scopes: ['metrics'] });
    const res = await send(t, 'GET', '/system/status', { headers: bearer(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      queuePaused: false,
      jobs: { queued: 0, running: 0 },
      libraries: [],
    });
  });

  it('a read-only token is 403, no credentials 401', async () => {
    const { token } = await createToken(t, s, { name: 'r', scopes: ['read'] });
    expect((await send(t, 'GET', '/system/status', { headers: bearer(token) })).status).toBe(403);
    expect((await send(t, 'GET', '/system/status')).status).toBe(401);
  });

  it('a metrics token reads nothing else', async () => {
    const { token } = await createToken(t, s, { name: 'ha', scopes: ['metrics'] });
    for (const path of ['/jobs', '/libraries', '/workflows', '/settings', '/queue']) {
      expect((await send(t, 'GET', path, { headers: bearer(token) })).status, path).toBe(403);
    }
  });
});

describe('TRANSCODA_METRICS=false', () => {
  beforeEach(async () => {
    t = createTestApp({ config: { metrics: false } });
    s = await login(t);
  });

  it('turns /metrics and the status summary off (404), for tokens and sessions alike', async () => {
    const { token } = await createToken(t, s, { name: 'prom', scopes: ['metrics'] });
    expect((await scrape(bearer(token))).status).toBe(404);
    expect((await scrape(asSession(s, false))).status).toBe(404);
    expect((await send(t, 'GET', '/system/status', { headers: bearer(token) })).status).toBe(404);
  });
});
