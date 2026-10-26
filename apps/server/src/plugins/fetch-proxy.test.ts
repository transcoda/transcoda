import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import { DEFAULT_LIMITS, type FetchInput } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secretToken } from '../plugin-host/redact.ts';
import { type AddressKind, classifyAddress } from './address-policy.ts';
import { FetchProxy, type FetchProxyDeps, resolveAllowedOrigins } from './fetch-proxy.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let origin = '';
let handler: Handler = (_req, res) => res.end();
let requests = 0;
let inFlight = 0;
let maxInFlight = 0;

beforeEach(async () => {
  requests = 0;
  inFlight = 0;
  maxInFlight = 0;
  handler = (_req, res) => res.end();
  server = createServer((req, res) => {
    requests += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    res.on('close', () => {
      inFlight -= 1;
    });
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
  // Late 'close' events of the old server's responses must not leak into the next test's counters.
  await new Promise((resolve) => setTimeout(resolve, 10));
});

const input = (url: string, extra: Partial<FetchInput> = {}): FetchInput => ({
  url,
  method: 'GET',
  headers: {},
  accept: 'json',
  ...extra,
});

/**
 * The test servers listen on loopback, which the proxy always refuses. Most tests stand in for a
 * LAN service: loopback counts as a private address, and every name resolves to a LAN address.
 */
const lanClassify = (ip: string): AddressKind =>
  ip === '127.0.0.1' || ip === '::1' ? 'private' : classifyAddress(ip);
const lan: Pick<FetchProxyDeps, 'classify' | 'resolve'> = {
  classify: lanClassify,
  resolve: async () => [{ address: '192.168.1.5', family: 4 }],
};

const proxy = (
  limits: Partial<FetchProxyDeps['limits']> = {},
  deps: Partial<FetchProxyDeps> = {},
) => {
  const p = new FetchProxy('sonarr', {
    limits: { ...DEFAULT_LIMITS, ...limits },
    ...lan,
    ...deps,
  });
  p.setPolicy({ allowedOrigins: [origin], allowInsecureTls: false });
  return p;
};

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
    handler = (req, res) => {
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
    };
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
    handler = (req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        seen = { type: req.headers['content-type'] as string, body };
        res.end('ok');
      });
    };
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
    handler = (_req, res) => res.end('not json');
    const none = await proxy().fetch(input(`${origin}/x`, { accept: 'none' }));
    expect(none).toMatchObject({ ok: true, response: { body: null } });
    const bad = await proxy().fetch(input(`${origin}/x`));
    expect(bad).toMatchObject({ ok: false, error: { kind: 'failed' } });
  });

  it('returns non-2xx responses as ok results', async () => {
    handler = (_req, res) => {
      res.statusCode = 404;
      res.end('{"error":"nope"}');
    };
    expect(await proxy().fetch(input(`${origin}/x`))).toMatchObject({
      ok: true,
      response: { status: 404, body: { error: 'nope' } },
    });
  });

  it('follows a same-origin redirect and refuses a cross-origin one', async () => {
    handler = (req, res) => {
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
    };
    const p = proxy();
    expect(await p.fetch(input(`${origin}/start`))).toMatchObject({
      ok: true,
      response: { body: { done: true } },
    });
    const away = await p.fetch(input(`${origin}/away`));
    expect(away).toMatchObject({ ok: false, error: { kind: 'refused' } });
  });

  it('gives up on a redirect loop after 5 redirects', async () => {
    handler = (_req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', '/again');
      res.end();
    };
    expect(await proxy().fetch(input(`${origin}/again`))).toMatchObject({
      ok: false,
      error: { kind: 'refused' },
    });
    expect(requests).toBe(6);
  });

  it('times out at timeoutMs and reports kind timeout', async () => {
    handler = (_req, res) => {
      setTimeout(() => res.end('{}'), 500);
    };
    const started = Date.now();
    const result = await proxy().fetch(input(`${origin}/slow`, { timeoutMs: 50 }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('caps the per-call timeout at fetchMaxTimeoutMs', async () => {
    handler = (_req, res) => {
      setTimeout(() => res.end('{}'), 500);
    };
    const result = await proxy({ fetchMaxTimeoutMs: 40 }).fetch(
      input(`${origin}/slow`, { timeoutMs: 60_000 }),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  });

  it('runs at most two requests at once', async () => {
    handler = (_req, res) => {
      setTimeout(() => res.end('{}'), 60);
    };
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
    handler = (_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.statusCode = 429;
        res.setHeader('Retry-After', '2');
        res.end();
      } else {
        res.end('{"ok":1}');
      }
    };
    const waits: number[] = [];
    const p = proxy({}, { sleep: async (ms) => void waits.push(ms) });
    expect(await p.fetch(input(`${origin}/x`))).toMatchObject({
      ok: true,
      response: { body: { ok: 1 } },
    });
    expect(waits).toContain(2000);
    expect(calls).toBe(2);

    calls = -10;
    handler = (_req, res) => {
      res.statusCode = 429;
      res.setHeader('Retry-After', '1');
      res.end();
    };
    const again = await p.fetch(input(`${origin}/x`));
    expect(again).toMatchObject({ ok: false, error: { kind: 'rate-limited' } });
  });

  it('caps Retry-After at 60 seconds and reads HTTP dates', async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls += 1;
      if (calls <= 2) {
        res.statusCode = 429;
        res.setHeader(
          'Retry-After',
          calls === 1 ? '3600' : new Date(Date.now() + 5000).toUTCString(),
        );
        res.end();
      } else res.end('{}');
    };
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
    handler = (_req, res) => {
      res.end('x'.repeat(5000));
    };
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

describe('FetchProxy hardening', () => {
  const refusedFor = async (url: string, allowed = [origin]) => {
    const p = new FetchProxy('sonarr', { limits: DEFAULT_LIMITS, ...lan });
    p.setPolicy({ allowedOrigins: allowed, allowInsecureTls: false });
    return p.fetch(input(url));
  };

  it('refuses look-alike hosts, userinfo, other ports, other schemes, trailing-dot hosts and IPv6 literals', async () => {
    const allowed = ['http://sonarr.local'];
    for (const url of [
      'http://evil-sonarr.local/x',
      'http://sonarr.local.evil.example/x',
      'http://sonarr.localx/x',
      'http://xsonarr.local/x',
      'http://sonarr.local./x',
      'http://sonarr.local:8080/x',
      'https://sonarr.local/x',
      'http://[::1]/x',
    ]) {
      const r = await refusedFor(url, allowed);
      expect(r, url).toMatchObject({ ok: false, error: { kind: 'refused' } });
    }
    expect(await refusedFor('http://user:pw@sonarr.local/x', allowed)).toEqual({
      ok: false,
      error: { kind: 'refused', message: 'credentials in the url are not allowed' },
    });
    expect(await refusedFor('http://user@sonarr.local/x', allowed)).toMatchObject({ ok: false });
    expect(requests).toBe(0);
  });

  it('treats host case and an explicit default port as the same origin', async () => {
    const seen: string[] = [];
    const fake = ((url: URL) => {
      seen.push(url.href);
      throw new Error('stop');
    }) as unknown as typeof import('node:https').request;
    const p = new FetchProxy('sonarr', {
      limits: DEFAULT_LIMITS,
      ...lan,
      request: fake,
      requestHttp: fake,
    });
    p.setPolicy({
      allowedOrigins: ['https://sonarr.lan', 'http://[::1]:9000'],
      allowInsecureTls: false,
    });
    await p.fetch(input('https://SONARR.LAN:443/x'));
    await p.fetch(input('http://[::1]:9000/x'));
    expect(seen).toEqual(['https://sonarr.lan/x', 'http://[::1]:9000/x']);
  });

  it('refuses a redirect to another scheme or port on the same host, with a fixed message', async () => {
    handler = (req, res) => {
      res.statusCode = 302;
      res.setHeader(
        'Location',
        req.url === '/port' ? 'http://127.0.0.1:1/x?token=abc' : 'https://127.0.0.1/x?token=abc',
      );
      res.end();
    };
    for (const path of ['/port', '/scheme']) {
      const r = await proxy().fetch(input(`${origin}${path}`));
      expect(r).toEqual({
        ok: false,
        error: { kind: 'refused', message: 'redirect to another origin is not allowed' },
      });
    }
  });

  it('drops Host, Content-Length and the other hop-by-hop request headers', async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    let raw = '';
    handler = (req, res) => {
      seen = req.headers;
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => res.end('{}'));
    };
    const res = await proxy().fetch(
      input(`${origin}/x`, {
        method: 'POST',
        body: 'ab',
        headers: {
          Host: 'evil.example',
          'Content-Length': '999',
          Upgrade: 'websocket',
          TE: 'trailers',
          'Keep-Alive': 'timeout=5',
          Trailer: 'x',
          'Proxy-Authorization': 'Basic abc',
          'Proxy-Connection': 'keep-alive',
          Expect: '100-continue',
          'X-Custom': 'kept',
        },
      }),
    );
    expect(res).toMatchObject({ ok: true });
    expect(raw).toBe('ab');
    expect(seen.host).toBe(origin.slice('http://'.length));
    expect(seen['content-length']).toBe('2');
    for (const name of [
      'upgrade',
      'te',
      'keep-alive',
      'trailer',
      'proxy-authorization',
      'proxy-connection',
      'expect',
    ]) {
      expect(seen[name], name).toBeUndefined();
    }
    expect(seen['x-custom']).toBe('kept');
  });

  it('never puts the query string in an error message', async () => {
    const refused = await proxy().fetch(input('https://evil.example/x?token=abc'));
    handler = (_req, res) => {
      setTimeout(() => res.end('{}'), 300);
    };
    const timeout = await proxy().fetch(input(`${origin}/x?token=abc`, { timeoutMs: 30 }));
    for (const r of [refused, timeout]) expect(JSON.stringify(r)).not.toContain('token=abc');
  });

  it('rejects early when content-length exceeds the cap, and when a chunked body has none', async () => {
    handler = (_req, res) => {
      res.setHeader('Content-Length', '5000');
      res.flushHeaders();
    };
    const early = await proxy({ fetchBodyBytes: 1000 }).fetch(
      input(`${origin}/x`, { accept: 'text' }),
    );
    expect(early).toMatchObject({
      ok: false,
      error: { kind: 'failed', message: 'response larger than 16 MB' },
    });
    handler = (_req, res) => {
      res.write('x'.repeat(600));
      res.write('x'.repeat(600));
      res.end();
    };
    const chunked = await proxy({ fetchBodyBytes: 1000 }).fetch(
      input(`${origin}/x`, { accept: 'text' }),
    );
    expect(chunked).toMatchObject({
      ok: false,
      error: { kind: 'failed', message: 'response larger than 16 MB' },
    });
  });

  it('fails when the server lies about content-length by closing early', async () => {
    const raw = createNetServer((socket) => {
      socket.on('data', () =>
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 50\r\nConnection: close\r\n\r\nhi'),
      );
      socket.on('error', () => {});
    });
    raw.listen(0, '127.0.0.1');
    await once(raw, 'listening');
    const o = `http://127.0.0.1:${(raw.address() as AddressInfo).port}`;
    const p = new FetchProxy('sonarr', { limits: DEFAULT_LIMITS, ...lan });
    p.setPolicy({ allowedOrigins: [o], allowInsecureTls: false });
    const r = await p.fetch(input(`${o}/x`, { accept: 'text' }));
    raw.close();
    expect(r).toMatchObject({ ok: false, error: { kind: 'failed' } });
  });

  it('returns a gzip body raw (no Accept-Encoding sent) and counts the compressed bytes', async () => {
    let acceptEncoding: string | string[] | undefined = 'unset';
    handler = (req, res) => {
      acceptEncoding = req.headers['accept-encoding'];
      res.setHeader('Content-Encoding', 'gzip');
      res.end(Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3, 4]));
    };
    const ok = await proxy().fetch(input(`${origin}/x`, { accept: 'none' }));
    expect(ok).toMatchObject({ ok: true, response: { body: null } });
    expect(acceptEncoding).toBeUndefined();
    const capped = await proxy({ fetchBodyBytes: 5 }).fetch(
      input(`${origin}/x`, { accept: 'none' }),
    );
    expect(capped).toMatchObject({ ok: false, error: { kind: 'failed' } });
  });

  it('applies one deadline across redirects', async () => {
    handler = (req, res) => {
      setTimeout(() => {
        const n = Number(req.url?.slice(1)) || 0;
        res.statusCode = 302;
        res.setHeader('Location', `/${n + 1}`);
        res.end();
      }, 60);
    };
    const started = Date.now();
    const r = await proxy().fetch(input(`${origin}/0`, { timeoutMs: 150 }));
    expect(r).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(Date.now() - started).toBeLessThan(450);
  });

  it('gives the hop after a redirect only the remaining time', async () => {
    handler = (req, res) => {
      if (req.url === '/start') {
        setTimeout(() => {
          res.statusCode = 302;
          res.setHeader('Location', '/slow');
          res.end();
        }, 80);
      } else setTimeout(() => res.end('{}'), 300);
    };
    const started = Date.now();
    const r = await proxy().fetch(input(`${origin}/start`, { timeoutMs: 150 }));
    expect(r).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(Date.now() - started).toBeLessThan(280);
  });

  it('counts the Retry-After sleep and the retry in the deadline', async () => {
    handler = (_req, res) => {
      res.statusCode = 429;
      res.setHeader('Retry-After', '5');
      res.end();
    };
    const started = Date.now();
    const r = await proxy().fetch(input(`${origin}/x`, { timeoutMs: 100 }));
    expect(r).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('counts queue time in the deadline', async () => {
    handler = (_req, res) => {
      setTimeout(() => res.end('{}'), 300);
    };
    const p = proxy({ fetchConcurrency: 1 });
    const first = p.fetch(input(`${origin}/a`));
    const queued = await p.fetch(input(`${origin}/b`, { timeoutMs: 60 }));
    expect(queued).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    await first;
    expect(requests).toBe(1);
  });

  it('aborts on a signal, destroys the request and frees the slot', async () => {
    handler = (req, res) => {
      if (req.url === '/slow') setTimeout(() => res.end('{}'), 2000);
      else res.end('{}');
    };
    const p = proxy({ fetchConcurrency: 1 });
    const ctrl = new AbortController();
    const pending = p.fetch(input(`${origin}/slow`), { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 30);
    expect(await pending).toEqual({
      ok: false,
      error: { kind: 'failed', message: 'request aborted' },
    });
    expect(await p.fetch(input(`${origin}/fast`))).toMatchObject({ ok: true });
    const already = new AbortController();
    already.abort();
    expect(await p.fetch(input(`${origin}/fast`), { signal: already.signal })).toMatchObject({
      ok: false,
    });
  });

  it('frees the concurrency slot during the Retry-After sleep', async () => {
    let calls = 0;
    handler = (req, res) => {
      if (req.url === '/limited' && calls++ === 0) {
        res.statusCode = 429;
        res.setHeader('Retry-After', '3');
        res.end();
      } else res.end('{"ok":1}');
    };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p = proxy({ fetchConcurrency: 1 }, { sleep: () => gate });
    const limited = p.fetch(input(`${origin}/limited`));
    const other = await p.fetch(input(`${origin}/other`));
    expect(other).toMatchObject({ ok: true });
    release();
    expect(await limited).toMatchObject({ ok: true, response: { body: { ok: 1 } } });
  });

  it('bounds the waiting queue', async () => {
    handler = (_req, res) => {
      setTimeout(() => res.end('{}'), 200);
    };
    const p = proxy({ fetchConcurrency: 1 });
    const all = Array.from({ length: 103 }, (_, i) => p.fetch(input(`${origin}/${i}`)));
    const results = await Promise.all(all);
    const busy = results.filter((r) => !r.ok && r.error.kind === 'rate-limited');
    expect(busy.length).toBe(2);
  }, 30_000);

  it('survives a clock that moves backwards', async () => {
    let t = 1000;
    const p = proxy(
      { fetchPerSecond: 1 },
      {
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      },
    );
    await p.fetch(input(`${origin}/a`));
    t = 0;
    expect(await p.fetch(input(`${origin}/b`))).toMatchObject({ ok: true });
  });
});

describe('FetchProxy secret substitution', () => {
  const KEY = 'K3y/with space&+=é!~*';
  const OTHER = 'second:secret é';
  const seen: Array<{
    method: string;
    url: string;
    headers: IncomingMessage['headers'];
    body: string;
  }> = [];

  const withSecrets = (extra: Record<string, string> = {}) => {
    const p = proxy();
    p.setSecrets({ apiKey: KEY, 'cred.pass': OTHER, ...extra });
    return p;
  };

  beforeEach(() => {
    seen.length = 0;
    handler = (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
    };
  });

  const expectNoClearValue = (result: unknown) => {
    const text = JSON.stringify(result);
    for (const clear of [
      KEY,
      OTHER,
      encodeURIComponent(KEY),
      Buffer.from(KEY).toString('base64'),
    ]) {
      expect(text).not.toContain(clear);
    }
  };

  it('puts the real key into the url path, query (url and form encoded), header and JSON body', async () => {
    const p = withSecrets();
    const result = await p.fetch(
      input(
        `${origin}/k/${secretToken('apiKey', 'url')}?a=${secretToken('apiKey', 'url')}&b=${secretToken('apiKey', 'form')}`,
        {
          method: 'POST',
          headers: {
            'X-Api-Key': secretToken('apiKey', 'raw'),
            'X-B64': secretToken('apiKey', 'b64'),
          },
          body: {
            key: secretToken('apiKey', 'raw'),
            nested: [`pre-${secretToken('cred.pass', 'raw')}`],
          },
        },
      ),
    );
    expect(result).toMatchObject({ ok: true });
    const got = seen[0];
    expect(got?.url).toBe(
      `/k/${encodeURIComponent(KEY)}?a=${encodeURIComponent(KEY)}&b=${new URLSearchParams([['', KEY]]).toString().slice(1)}`,
    );
    expect(new URL(`http://x${got?.url}`).searchParams.get('b')).toBe(KEY);
    expect(got?.headers['x-api-key']).toBe(KEY);
    expect(JSON.parse(got?.body ?? '{}')).toEqual({ key: KEY, nested: [`pre-${OTHER}`] });
    expectNoClearValue(result);
  });

  it('substitutes a header and a string body', async () => {
    const p = withSecrets({ token: 'abc123' });
    await p.fetch(
      input(`${origin}/x`, {
        method: 'PUT',
        headers: { 'X-Token': secretToken('token', 'raw'), 'X-B64': secretToken('token', 'b64') },
        body: `t=${secretToken('token', 'raw')}`,
      }),
    );
    expect(seen[0]?.headers['x-token']).toBe('abc123');
    expect(seen[0]?.headers['x-b64']).toBe(Buffer.from('abc123').toString('base64'));
    expect(seen[0]?.body).toBe('t=abc123');
  });

  it('encodes b64url', async () => {
    const p = withSecrets();
    await p.fetch(input(`${origin}/x`, { headers: { 'X-U': secretToken('apiKey', 'b64url') } }));
    expect(seen[0]?.headers['x-u']).toBe(Buffer.from(KEY).toString('base64url'));
  });

  it('applies each auth variant server-side', async () => {
    const p = withSecrets();
    const user = 'üser';
    await p.fetch(
      input(`${origin}/basic`, {
        auth: { basic: { username: user, password: `${secretToken('cred.pass', 'raw')}` } },
      }),
    );
    expect(seen[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from(`${user}:${OTHER}`, 'utf8').toString('base64')}`,
    );
    await p.fetch(input(`${origin}/bearer`, { auth: { bearer: secretToken('apiKey', 'raw') } }));
    expect(seen[1]?.headers.authorization).toBe(`Bearer ${KEY}`);
    await p.fetch(
      input(`${origin}/h`, {
        headers: { 'x-api-key': 'plugin-set' },
        auth: { header: { name: 'X-Api-Key', value: secretToken('apiKey', 'raw') } },
      }),
    );
    expect(seen[2]?.headers['x-api-key']).toBe(KEY);
    await p.fetch(
      input(`${origin}/q?x=1`, {
        auth: { query: { name: 'api key', value: secretToken('apiKey', 'raw') } },
      }),
    );
    expect(seen[3]?.url).toBe(`/q?x=1&${new URLSearchParams([['api key', KEY]]).toString()}`);
  });

  it('applies auth.basic with a password that contains a colon', async () => {
    const p = withSecrets({ pw: 'a:b:c' });
    await p.fetch(
      input(`${origin}/b`, {
        auth: { basic: { username: 'u', password: secretToken('pw', 'raw') } },
      }),
    );
    expect(seen[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from('u:a:b:c').toString('base64')}`,
    );
  });

  it('refuses a token for an unknown field before any network I/O, naming only the field', async () => {
    const p = withSecrets();
    const result = await p.fetch(
      input(`${origin}/x`, { headers: { a: secretToken('nope', 'raw') } }),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'refused',
        message: 'secret "nope" is not a secret field of this integration',
      },
    });
    const viaAuth = await p.fetch(
      input(`${origin}/x`, { auth: { bearer: secretToken('zzz', 'raw') } }),
    );
    expect(viaAuth).toMatchObject({ ok: false, error: { kind: 'refused' } });
    expect(requests).toBe(0);
  });

  it('checks the origin first: a token on a request to another origin is refused for the origin, not the field', async () => {
    const p = withSecrets();
    const result = await p.fetch(
      input(`https://evil.example/x?k=${secretToken('apiKey', 'raw')}`, {
        headers: { a: secretToken('unknown', 'raw') },
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'refused',
        message: 'origin https://evil.example is not allowed for plugin sonarr',
      },
    });
    expect(requests).toBe(0);
  });

  it('opts.secrets (candidate values) win over the stored ones for that request only', async () => {
    const p = withSecrets();
    const header = { headers: { 'X-K': secretToken('apiKey', 'raw') } };
    await p.fetch(input(`${origin}/a`, header), { secrets: { apiKey: 'candidate-value' } });
    await p.fetch(input(`${origin}/b`, header));
    expect(seen[0]?.headers['x-k']).toBe('candidate-value');
    expect(seen[1]?.headers['x-k']).toBe(KEY);
  });

  it('setSecrets throws when two field paths sanitise to the same key, and keeps the old values', () => {
    const p = proxy();
    p.setSecrets({ 'api-key': 'aaaaaa' });
    expect(() => p.setSecrets({ 'api-key': 'aaaaaa', api_key: 'bbbbbb' })).toThrow(
      'secret fields "api-key" and "api_key" are ambiguous',
    );
    expect(() => p.setSecrets({ 'api-key': 'aaaaaa', api_key: 'bbbbbb' })).not.toThrow(
      /aaaaaa|bbbbbb/,
    );
  });

  it('a field whose name sanitises is addressed by the sanitised path', async () => {
    const p = proxy();
    p.setSecrets({ 'api-key': 'dash-secret' });
    await p.fetch(input(`${origin}/x`, { headers: { a: secretToken('api-key', 'raw') } }));
    expect(seen[0]?.headers.a).toBe('dash-secret');
  });

  it('refuses ambiguous candidate paths without echoing values', async () => {
    const p = proxy();
    const result = await p.fetch(input(`${origin}/x`), {
      secrets: { 'a-b': 'xxxxxx', a_b: 'yyyyyy' },
    });
    expect(result).toMatchObject({ ok: false, error: { kind: 'refused' } });
    expect(JSON.stringify(result)).not.toMatch(/xxxxxx|yyyyyy/);
    expect(requests).toBe(0);
  });

  it('carries the substituted value over a same-origin redirect and refuses a cross-origin one', async () => {
    const p = withSecrets();
    handler = (req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: '' });
      if (req.url?.startsWith('/start')) {
        res.statusCode = 302;
        res.setHeader('location', '/final');
        res.end();
      } else res.end('{}');
    };
    const result = await p.fetch(
      input(`${origin}/start`, {
        auth: { query: { name: 'k', value: secretToken('apiKey', 'raw') } },
        headers: { 'X-K': secretToken('apiKey', 'raw') },
      }),
    );
    expect(result).toMatchObject({ ok: true });
    expect(seen.map((r) => r.url.split('?')[0])).toEqual(['/start', '/final']);
    expect(seen[1]?.headers['x-k']).toBe(KEY);
    expect(seen[1]?.url).toContain(`k=${new URLSearchParams([['', KEY]]).toString().slice(1)}`);

    seen.length = 0;
    handler = (req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: '' });
      res.statusCode = 302;
      res.setHeader('location', 'http://localhost:1/steal');
      res.end();
    };
    const cross = await p.fetch(
      input(`${origin}/start`, { headers: { 'X-K': secretToken('apiKey', 'raw') } }),
    );
    expect(cross).toMatchObject({ ok: false, error: { kind: 'refused' } });
    expect(seen).toHaveLength(1);
    expectNoClearValue(cross);
  });

  it('keeps clear values out of failure messages', async () => {
    const closed = createServer();
    closed.listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const o = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    closed.close();
    await once(closed, 'close');
    const p = new FetchProxy('sonarr', { limits: DEFAULT_LIMITS, ...lan });
    p.setPolicy({ allowedOrigins: [o], allowInsecureTls: false });
    p.setSecrets({ apiKey: KEY });
    const result = await p.fetch(input(`${o}/x?k=${secretToken('apiKey', 'url')}`));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failed' } });
    expectNoClearValue(result);
  });

  it('has no logging by construction: FetchProxyDeps carries no logger', () => {
    const deps: Array<keyof FetchProxyDeps> = [
      'limits',
      'now',
      'sleep',
      'request',
      'requestHttp',
      'resolve',
      'classify',
    ];
    expect(deps).not.toContain('log');
    expect(Object.keys(FetchProxy.prototype)).not.toContain('log');
  });

  it('refuses auth.header names the transport owns, before any I/O', async () => {
    const p = withSecrets();
    for (const name of [
      'Host',
      'Transfer-Encoding',
      'content-length',
      'Proxy-Authorization',
      'Connection',
      'EXPECT',
    ]) {
      const result = await p.fetch(
        input(`${origin}/x`, { auth: { header: { name, value: secretToken('apiKey', 'raw') } } }),
      );
      expect(result).toEqual({
        ok: false,
        error: { kind: 'refused', message: `header "${name}" cannot be set` },
      });
    }
    expect(requests).toBe(0);
  });

  it('setSecrets and candidate secrets refuse a path with "__"', async () => {
    const p = proxy();
    expect(() => p.setSecrets({ a__b: 'secret-value' })).toThrow(
      'secret field "a__b" contains "__", which is ambiguous in tokens',
    );
    expect(() => p.setSecrets({ 'a b': 'x1234', 'c.d': 'y1234' })).not.toThrow();
    const result = await p.fetch(input(`${origin}/x`), { secrets: { 'a-_b': 'zzzzzz' } });
    expect(result).toMatchObject({ ok: false, error: { kind: 'refused' } });
  });

  it('refuses a request that still contains [redacted], pointing at auth and structured bodies', async () => {
    const p = withSecrets();
    const bad = [
      input(`${origin}/x?k=[redacted]`),
      input(`${origin}/x`, { headers: { a: 'Basic [redacted]' } }),
      input(`${origin}/x`, { method: 'POST', body: '{"k":"[redacted]"}' }),
      input(`${origin}/x`, { method: 'POST', body: { k: ['[redacted]'] } }),
      input(`${origin}/x`, { auth: { bearer: '[redacted]' } }),
    ];
    for (const i of bad) {
      const result = await p.fetch(i);
      expect(result).toMatchObject({ ok: false, error: { kind: 'refused' } });
      expect(JSON.stringify(result)).toMatch(/auth.*structured JSON body/);
    }
    expect(requests).toBe(0);
  });

  it('refuses ":" in a Basic username, also one that arrives through a token', async () => {
    const p = withSecrets({ user: 'a:b' });
    for (const username of ['a:b', secretToken('user', 'raw')]) {
      const result = await p.fetch(
        input(`${origin}/x`, { auth: { basic: { username, password: 'pw1234' } } }),
      );
      expect(result).toEqual({
        ok: false,
        error: { kind: 'refused', message: 'a Basic auth username cannot contain ":"' },
      });
    }
    expect(requests).toBe(0);
  });

  it('refuses a header value the transport rejects, without leaking it', async () => {
    const p = withSecrets({ nl: 'line1\nline2-secret' });
    const result = await p.fetch(
      input(`${origin}/x`, { headers: { a: secretToken('nl', 'raw') } }),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'failed' } });
    expect(JSON.stringify(result)).not.toContain('line2-secret');
  });
});

describe('FetchProxy address pinning (sandbox review M1)', () => {
  const port = () => (server.address() as AddressInfo).port;
  /** Stands in for a public service: the test server on loopback counts as a public address. */
  const publicClassify = (ip: string): AddressKind =>
    ip === '127.0.0.1' ? 'public' : classifyAddress(ip);
  /** A resolver that answers each lookup with the next address in line (DNS rebinding). */
  const rebinding = (...answers: string[]) => {
    const calls: string[] = [];
    const resolve = async (hostname: string) => {
      calls.push(hostname);
      const address = answers[Math.min(calls.length - 1, answers.length - 1)] ?? '';
      return [{ address, family: address.includes(':') ? 6 : 4 }];
    };
    return { calls, resolve };
  };
  const make = (o: string, deps: Partial<FetchProxyDeps>) => {
    const p = new FetchProxy('sonarr', { limits: DEFAULT_LIMITS, ...deps });
    p.setPolicy({ allowedOrigins: [o], allowInsecureTls: false });
    return p;
  };

  it('connects to the address it checked and keeps the original Host header', async () => {
    let host: string | undefined;
    handler = (req, res) => {
      host = req.headers.host;
      res.end('{}');
    };
    const o = `http://media.invalid:${port()}`;
    const dns = rebinding('127.0.0.1');
    const result = await make(o, { resolve: dns.resolve, classify: publicClassify }).fetch(
      input(`${o}/x`),
    );
    expect(result).toMatchObject({ ok: true });
    expect(host).toBe(`media.invalid:${port()}`);
    expect(dns.calls).toEqual(['media.invalid']);
  });

  it('resolves each redirect hop once and refuses a hop that rebinds to the metadata address', async () => {
    handler = (req, res) => {
      if (req.url === '/start') {
        res.statusCode = 302;
        res.setHeader('location', '/next');
      }
      res.end('{}');
    };
    const o = `http://media.invalid:${port()}`;
    const dns = rebinding('127.0.0.1', '169.254.169.254');
    const result = await make(o, { resolve: dns.resolve, classify: publicClassify }).fetch(
      input(`${o}/start`),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'refused' } });
    expect(requests).toBe(1);
    expect(dns.calls).toEqual(['media.invalid', 'media.invalid']);
  });

  it('refuses a public origin whose next hop rebinds into the LAN or the Docker network', async () => {
    handler = (req, res) => {
      if (req.url === '/start') {
        res.statusCode = 307;
        res.setHeader('location', '/next');
      }
      res.end('{}');
    };
    const o = `http://media.invalid:${port()}`;
    for (const inside of ['192.168.1.5', '172.17.0.2', '10.0.0.1', 'fd12::1']) {
      requests = 0;
      const dns = rebinding('127.0.0.1', inside);
      const result = await make(o, { resolve: dns.resolve, classify: publicClassify }).fetch(
        input(`${o}/start`),
      );
      expect(result, inside).toMatchObject({ ok: false, error: { kind: 'refused' } });
      expect(requests, inside).toBe(1);
    }
  });

  it('refuses loopback, link-local and metadata answers for a private origin too, before any I/O', async () => {
    const o = `http://sonarr.lan:${port()}`;
    for (const bad of ['127.0.0.1', '::1', '169.254.169.254', 'fe80::1', '0.0.0.0']) {
      const dns = rebinding(bad);
      const result = await make(o, { resolve: dns.resolve }).fetch(input(`${o}/x`));
      expect(result, bad).toMatchObject({ ok: false, error: { kind: 'refused' } });
    }
    expect(requests).toBe(0);
  });

  it('refuses when any of several answers is forbidden', async () => {
    const o = `http://media.invalid:${port()}`;
    const resolve = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    const result = await make(o, { resolve }).fetch(input(`${o}/x`));
    expect(result).toMatchObject({ ok: false, error: { kind: 'refused' } });
    expect(requests).toBe(0);
  });

  it('lets a private origin reach a LAN address, pinned', async () => {
    let host: string | undefined;
    handler = (req, res) => {
      host = req.headers.host;
      res.end('{}');
    };
    const o = `http://sonarr.lan:${port()}`;
    const dns = rebinding('127.0.0.1');
    const result = await make(o, { resolve: dns.resolve, classify: lanClassify }).fetch(
      input(`${o}/x`),
    );
    expect(result).toMatchObject({ ok: true });
    expect(host).toBe(`sonarr.lan:${port()}`);
  });

  it('refuses a public origin that resolves to a LAN address on the first hop', async () => {
    const o = 'http://media.example.com';
    const result = await make(o, { resolve: rebinding('192.168.1.5').resolve }).fetch(
      input(`${o}/x`),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'refused',
        message:
          'media.example.com resolves to a private network address, which only an integration configured with a private address or LAN name may reach',
      },
    });
  });

  it('checks IP literals without resolving: loopback and metadata refused, a LAN literal allowed', async () => {
    const opts: Array<{ lookup?: unknown }> = [];
    const fake = ((_url: URL, o: { lookup?: unknown }) => {
      opts.push(o);
      throw new Error('stop');
    }) as unknown as typeof import('node:https').request;
    const dns = rebinding('8.8.8.8');
    const deps = { resolve: dns.resolve, request: fake, requestHttp: fake };
    for (const o of [`http://127.0.0.1:${port()}`, 'http://169.254.169.254', 'http://[::1]:9']) {
      const result = await make(o, deps).fetch(input(`${o}/x`));
      expect(result, o).toMatchObject({ ok: false, error: { kind: 'refused' } });
    }
    expect(opts).toHaveLength(0);
    await make('http://192.168.1.5', deps).fetch(input('http://192.168.1.5/x'));
    expect(opts).toHaveLength(1);
    expect(opts[0]?.lookup).toBeUndefined();
    expect(dns.calls).toEqual([]);
    expect(requests).toBe(0);
  });

  it('pins https too: the url keeps the name (SNI and Host) and lookup answers with the checked address', async () => {
    const seen: Array<{ url: URL; lookup: (...a: unknown[]) => void }> = [];
    const fake = ((url: URL, o: { lookup: (...a: unknown[]) => void }) => {
      seen.push({ url, lookup: o.lookup });
      throw new Error('stop');
    }) as unknown as typeof import('node:https').request;
    await make('https://sonarr.lan', {
      resolve: rebinding('192.168.1.5').resolve,
      request: fake,
    }).fetch(input('https://sonarr.lan/x'));
    expect(seen[0]?.url.hostname).toBe('sonarr.lan');
    const answers: unknown[] = [];
    seen[0]?.lookup('sonarr.lan', { all: true }, (...a: unknown[]) => answers.push(a));
    seen[0]?.lookup('sonarr.lan', {}, (...a: unknown[]) => answers.push(a));
    expect(answers).toEqual([
      [null, [{ address: '192.168.1.5', family: 4 }]],
      [null, '192.168.1.5', 4],
    ]);
  });

  it('reports a name that does not resolve as failed', async () => {
    const resolve = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND sonarr.lan'), { code: 'ENOTFOUND' });
    };
    const result = await make('http://sonarr.lan', { resolve }).fetch(input('http://sonarr.lan/x'));
    expect(result).toEqual({
      ok: false,
      error: { kind: 'failed', message: 'request failed: ENOTFOUND' },
    });
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
