import type { AddressInfo } from 'node:net';
import { DEFAULT_LIMITS } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { type AddressKind, classifyAddress } from './address-policy.ts';
import { FetchProxy, type FetchProxyDeps } from './fetch-proxy.ts';
import {
  input,
  lanClassify,
  requests,
  server,
  setHandler,
  setRequests,
  useTestServer,
} from './testing.ts';

useTestServer();

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
    setHandler((req, res) => {
      host = req.headers.host;
      res.end('{}');
    });
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
    setHandler((req, res) => {
      if (req.url === '/start') {
        res.statusCode = 302;
        res.setHeader('location', '/next');
      }
      res.end('{}');
    });
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
    setHandler((req, res) => {
      if (req.url === '/start') {
        res.statusCode = 307;
        res.setHeader('location', '/next');
      }
      res.end('{}');
    });
    const o = `http://media.invalid:${port()}`;
    for (const inside of ['192.168.1.5', '172.17.0.2', '10.0.0.1', 'fd12::1']) {
      setRequests(0);
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
    setHandler((req, res) => {
      host = req.headers.host;
      res.end('{}');
    });
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
