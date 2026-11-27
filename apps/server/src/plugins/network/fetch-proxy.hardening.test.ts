import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import { DEFAULT_LIMITS } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { FetchProxy } from './fetch-proxy.ts';
import { input, lan, origin, proxy, requests, setHandler, useTestServer } from './testing.ts';

useTestServer();

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
    setHandler((req, res) => {
      res.statusCode = 302;
      res.setHeader(
        'Location',
        req.url === '/port' ? 'http://127.0.0.1:1/x?token=abc' : 'https://127.0.0.1/x?token=abc',
      );
      res.end();
    });
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
    setHandler((req, res) => {
      seen = req.headers;
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => res.end('{}'));
    });
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
    setHandler((_req, res) => {
      setTimeout(() => res.end('{}'), 300);
    });
    const timeout = await proxy().fetch(input(`${origin}/x?token=abc`, { timeoutMs: 30 }));
    for (const r of [refused, timeout]) expect(JSON.stringify(r)).not.toContain('token=abc');
  });

  it('rejects early when content-length exceeds the cap, and when a chunked body has none', async () => {
    setHandler((_req, res) => {
      res.setHeader('Content-Length', '5000');
      res.flushHeaders();
    });
    const early = await proxy({ fetchBodyBytes: 1000 }).fetch(
      input(`${origin}/x`, { accept: 'text' }),
    );
    expect(early).toMatchObject({
      ok: false,
      error: { kind: 'failed', message: 'response larger than 16 MB' },
    });
    setHandler((_req, res) => {
      res.write('x'.repeat(600));
      res.write('x'.repeat(600));
      res.end();
    });
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
    setHandler((req, res) => {
      acceptEncoding = req.headers['accept-encoding'];
      res.setHeader('Content-Encoding', 'gzip');
      res.end(Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3, 4]));
    });
    const ok = await proxy().fetch(input(`${origin}/x`, { accept: 'none' }));
    expect(ok).toMatchObject({ ok: true, response: { body: null } });
    expect(acceptEncoding).toBeUndefined();
    const capped = await proxy({ fetchBodyBytes: 5 }).fetch(
      input(`${origin}/x`, { accept: 'none' }),
    );
    expect(capped).toMatchObject({ ok: false, error: { kind: 'failed' } });
  });

  it('applies one deadline across redirects', async () => {
    setHandler((req, res) => {
      setTimeout(() => {
        const n = Number(req.url?.slice(1)) || 0;
        res.statusCode = 302;
        res.setHeader('Location', `/${n + 1}`);
        res.end();
      }, 60);
    });
    const started = Date.now();
    const r = await proxy().fetch(input(`${origin}/0`, { timeoutMs: 150 }));
    expect(r).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(Date.now() - started).toBeLessThan(450);
  });

  it('gives the hop after a redirect only the remaining time', async () => {
    setHandler((req, res) => {
      if (req.url === '/start') {
        setTimeout(() => {
          res.statusCode = 302;
          res.setHeader('Location', '/slow');
          res.end();
        }, 80);
      } else setTimeout(() => res.end('{}'), 300);
    });
    const started = Date.now();
    const r = await proxy().fetch(input(`${origin}/start`, { timeoutMs: 150 }));
    expect(r).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(Date.now() - started).toBeLessThan(280);
  });

  it('counts the Retry-After sleep and the retry in the deadline', async () => {
    setHandler((_req, res) => {
      res.statusCode = 429;
      res.setHeader('Retry-After', '5');
      res.end();
    });
    const started = Date.now();
    const r = await proxy().fetch(input(`${origin}/x`, { timeoutMs: 100 }));
    expect(r).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('counts queue time in the deadline', async () => {
    setHandler((_req, res) => {
      setTimeout(() => res.end('{}'), 300);
    });
    const p = proxy({ fetchConcurrency: 1 });
    const first = p.fetch(input(`${origin}/a`));
    const queued = await p.fetch(input(`${origin}/b`, { timeoutMs: 60 }));
    expect(queued).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    await first;
    expect(requests).toBe(1);
  });

  it('aborts on a signal, destroys the request and frees the slot', async () => {
    setHandler((req, res) => {
      if (req.url === '/slow') setTimeout(() => res.end('{}'), 2000);
      else res.end('{}');
    });
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
    setHandler((req, res) => {
      if (req.url === '/limited' && calls++ === 0) {
        res.statusCode = 429;
        res.setHeader('Retry-After', '3');
        res.end();
      } else res.end('{"ok":1}');
    });
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
    setHandler((_req, res) => {
      setTimeout(() => res.end('{}'), 200);
    });
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
