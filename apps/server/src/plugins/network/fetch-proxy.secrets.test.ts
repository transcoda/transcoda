import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_LIMITS } from '@transcoda/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { secretToken } from '../../plugin-host/redact.ts';
import { FetchProxy, type FetchProxyDeps } from './fetch-proxy.ts';
import { input, lan, origin, proxy, requests, setHandler, useTestServer } from './testing.ts';

useTestServer();

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
    setHandler((req, res) => {
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
    });
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
    setHandler((req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: '' });
      if (req.url?.startsWith('/start')) {
        res.statusCode = 302;
        res.setHeader('location', '/final');
        res.end();
      } else res.end('{}');
    });
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
    setHandler((req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: '' });
      res.statusCode = 302;
      res.setHeader('location', 'http://localhost:1/steal');
      res.end();
    });
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
