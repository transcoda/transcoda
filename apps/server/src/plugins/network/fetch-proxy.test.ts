import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_LIMITS } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { FetchProxy, resolveAllowedOrigins } from './fetch-proxy.ts';
import {
  input,
  lan,
  maxInFlight,
  origin,
  proxy,
  requests,
  setHandler,
  useTestServer,
} from './testing.ts';

useTestServer();

describe('FetchProxy', () => {
  it('refuses an origin that is not allowed and never opens a socket', async () => {
    const result = await proxy().fetch(input('https://evil.example/x'));
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'refused',
        message: 'origin https://evil.example is not allowed for plugin sonarr',
      },
    });
    const sameHostOtherPort = await proxy().fetch(input('http://127.0.0.1:1/x'));
    expect(sameHostOtherPort.ok).toBe(false);
    expect(requests).toBe(0);
  });

  it('refuses a non http(s) scheme', async () => {
    const result = await proxy().fetch(input('ftp://127.0.0.1/x'));
    expect(result).toMatchObject({ ok: false, error: { kind: 'refused' } });
  });

  it('parses JSON, returns only the allowed lower-cased headers and sends JSON bodies', async () => {
    let seen: { method: string | undefined; type: string; body: string } = {
      method: undefined,
      type: '',
      body: '',
    };
    setHandler((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        seen = { method: req.method, type: req.headers['content-type'] as string, body };
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Request-Id', 'r1');
        res.setHeader('X-Secret-Thing', 'nope');
        res.setHeader('ETag', '"e"');
        res.end('{"a":[1,2]}');
      });
    });
    const result = await proxy().fetch(input(`${origin}/x`, { method: 'POST', body: { q: 1 } }));
    expect(seen).toEqual({ method: 'POST', type: 'application/json', body: '{"q":1}' });
    expect(result).toEqual({
      ok: true,
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'r1',
          etag: '"e"',
          'content-length': '11',
        },
        body: { a: [1, 2] },
      },
    });
  });

  it('keeps a caller content-type and sends a string body as is', async () => {
    let seen = { type: '', body: '' };
    setHandler((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        seen = { type: req.headers['content-type'] as string, body };
        res.end('ok');
      });
    });
    const result = await proxy().fetch(
      input(`${origin}/x`, {
        method: 'PUT',
        body: 'a=b',
        headers: { 'Content-Type': 'text/plain' },
        accept: 'text',
      }),
    );
    expect(seen).toEqual({ type: 'text/plain', body: 'a=b' });
    expect(result).toMatchObject({ ok: true, response: { status: 200, body: 'ok' } });
  });

  it('returns null for accept none and fails on invalid JSON', async () => {
    setHandler((_req, res) => res.end('not json'));
    const none = await proxy().fetch(input(`${origin}/x`, { accept: 'none' }));
    expect(none).toMatchObject({ ok: true, response: { body: null } });
    const bad = await proxy().fetch(input(`${origin}/x`));
    expect(bad).toMatchObject({ ok: false, error: { kind: 'failed' } });
  });

  it('returns non-2xx responses as ok results', async () => {
    setHandler((_req, res) => {
      res.statusCode = 404;
      res.end('{"error":"nope"}');
    });
    expect(await proxy().fetch(input(`${origin}/x`))).toMatchObject({
      ok: true,
      response: { status: 404, body: { error: 'nope' } },
    });
  });

  it('follows a same-origin redirect and refuses a cross-origin one', async () => {
    setHandler((req, res) => {
      if (req.url === '/start') {
        res.statusCode = 302;
        res.setHeader('Location', '/end');
        res.end();
      } else if (req.url === '/away') {
        res.statusCode = 307;
        res.setHeader('Location', 'https://evil.example/steal');
        res.end();
      } else {
        res.end('{"done":true}');
      }
    });
    const p = proxy();
    expect(await p.fetch(input(`${origin}/start`))).toMatchObject({
      ok: true,
      response: { body: { done: true } },
    });
    const away = await p.fetch(input(`${origin}/away`));
    expect(away).toMatchObject({ ok: false, error: { kind: 'refused' } });
  });

  it('gives up on a redirect loop after 5 redirects', async () => {
    setHandler((_req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', '/again');
      res.end();
    });
    expect(await proxy().fetch(input(`${origin}/again`))).toMatchObject({
      ok: false,
      error: { kind: 'refused' },
    });
    expect(requests).toBe(6);
  });

  it('times out at timeoutMs and reports kind timeout', async () => {
    setHandler((_req, res) => {
      setTimeout(() => res.end('{}'), 500);
    });
    const started = Date.now();
    const result = await proxy().fetch(input(`${origin}/slow`, { timeoutMs: 50 }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('caps the per-call timeout at fetchMaxTimeoutMs', async () => {
    setHandler((_req, res) => {
      setTimeout(() => res.end('{}'), 500);
    });
    const result = await proxy({ fetchMaxTimeoutMs: 40 }).fetch(
      input(`${origin}/slow`, { timeoutMs: 60_000 }),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  });

  it('runs at most two requests at once', async () => {
    setHandler((_req, res) => {
      setTimeout(() => res.end('{}'), 60);
    });
    const p = proxy();
    const results = await Promise.all([1, 2, 3, 4].map((i) => p.fetch(input(`${origin}/${i}`))));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(maxInFlight).toBe(2);
    expect(requests).toBe(4);
  });

  it('waits on the token bucket instead of failing', async () => {
    let t = 0;
    const waits: number[] = [];
    const p = proxy(
      { fetchPerSecond: 2, fetchConcurrency: 4 },
      {
        now: () => t,
        sleep: async (ms) => {
          waits.push(ms);
          t += ms;
        },
      },
    );
    const results = await Promise.all([1, 2, 3, 4].map((i) => p.fetch(input(`${origin}/${i}`))));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1000);
  });

  it('honours one Retry-After then reports rate-limited', async () => {
    let calls = 0;
    setHandler((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.statusCode = 429;
        res.setHeader('Retry-After', '2');
        res.end();
      } else {
        res.end('{"ok":1}');
      }
    });
    const waits: number[] = [];
    const p = proxy({}, { sleep: async (ms) => void waits.push(ms) });
    expect(await p.fetch(input(`${origin}/x`))).toMatchObject({
      ok: true,
      response: { body: { ok: 1 } },
    });
    expect(waits).toContain(2000);
    expect(calls).toBe(2);

    calls = -10;
    setHandler((_req, res) => {
      res.statusCode = 429;
      res.setHeader('Retry-After', '1');
      res.end();
    });
    const again = await p.fetch(input(`${origin}/x`));
    expect(again).toMatchObject({ ok: false, error: { kind: 'rate-limited' } });
  });

  it('caps Retry-After at 60 seconds and reads HTTP dates', async () => {
    let calls = 0;
    setHandler((_req, res) => {
      calls += 1;
      if (calls <= 2) {
        res.statusCode = 429;
        res.setHeader(
          'Retry-After',
          calls === 1 ? '3600' : new Date(Date.now() + 5000).toUTCString(),
        );
        res.end();
      } else res.end('{}');
    });
    const waits: number[] = [];
    const p = proxy({}, { sleep: async (ms) => void waits.push(ms) });
    await p.fetch(input(`${origin}/a`));
    expect(waits).toContain(60_000);
    calls = 1;
    waits.length = 0;
    await p.fetch(input(`${origin}/b`));
    const w = waits.find((x) => x > 1000 && x <= 5000);
    expect(w).toBeDefined();
  });

  it('caps the response body', async () => {
    setHandler((_req, res) => {
      res.end('x'.repeat(5000));
    });
    const result = await proxy({ fetchBodyBytes: 1000 }).fetch(
      input(`${origin}/big`, { accept: 'text' }),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'failed', message: 'response larger than 16 MB' },
    });
  });

  it('reports a connection failure as failed without the URL', async () => {
    const closed = createServer();
    closed.listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const o = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    closed.close();
    await once(closed, 'close');
    const p = new FetchProxy('sonarr', { limits: DEFAULT_LIMITS, ...lan });
    p.setPolicy({ allowedOrigins: [o], allowInsecureTls: false });
    const result = await p.fetch(input(`${o}/secret?token=abc`));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failed' } });
    expect(JSON.stringify(result)).not.toContain('token=abc');
  });

  it('uses the override policy instead of the stored one and sets rejectUnauthorized only on https', async () => {
    const opts: Array<{ rejectUnauthorized?: boolean }> = [];
    const fakeRequest = ((_url: URL, o: { rejectUnauthorized?: boolean }) => {
      opts.push(o);
      throw new Error('stop');
    }) as unknown as typeof import('node:https').request;
    const p = new FetchProxy('sonarr', {
      limits: DEFAULT_LIMITS,
      ...lan,
      request: fakeRequest,
      requestHttp: fakeRequest,
    });
    p.setPolicy({ allowedOrigins: ['https://a.lan'], allowInsecureTls: false });
    await p.fetch(input('https://a.lan/x'), {
      override: { allowedOrigins: ['https://a.lan'], allowInsecureTls: true },
    });
    await p.fetch(input('http://b.lan/x'), {
      override: { allowedOrigins: ['http://b.lan'], allowInsecureTls: true },
    });
    await p.fetch(input('https://a.lan/x'));
    expect(opts[0]?.rejectUnauthorized).toBe(false);
    expect(opts[1]?.rejectUnauthorized).toBeUndefined();
    expect(opts[2]?.rejectUnauthorized).toBeUndefined();
  });

  it('refuses everything before a policy is set', async () => {
    const p = new FetchProxy('sonarr', { limits: DEFAULT_LIMITS, ...lan });
    expect(await p.fetch(input(`${origin}/x`))).toMatchObject({
      ok: false,
      error: { kind: 'refused' },
    });
    expect(requests).toBe(0);
  });
});

describe('resolveAllowedOrigins', () => {
  it('maps $settings.url to its origin and keeps literals', () => {
    expect(
      resolveAllowedOrigins(['$settings.url', 'https://api.themoviedb.org/3'], {
        url: 'http://sonarr.lan:8989/',
      }),
    ).toEqual(['http://sonarr.lan:8989', 'https://api.themoviedb.org']);
  });

  it('skips unset or invalid settings and invalid literals, and de-duplicates', () => {
    expect(resolveAllowedOrigins(['$settings.url'], {})).toEqual([]);
    expect(resolveAllowedOrigins(['$settings.url'], { url: 'not a url' })).toEqual([]);
    expect(resolveAllowedOrigins(['$settings.url'], { url: 5 })).toEqual([]);
    expect(resolveAllowedOrigins(['$settings.url'], { url: 'ftp://x.lan/' })).toEqual([]);
    expect(resolveAllowedOrigins(['nope', 'https://a.lan/x', 'https://a.lan/y'], {})).toEqual([
      'https://a.lan',
    ]);
  });
});
