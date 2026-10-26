import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogClient, OFFICIAL_CATALOG_URL } from './catalog.ts';
import type { SigningKey } from './signature.ts';

const index = {
  schema: 1,
  generated: '2026-10-17T00:00:00.000Z',
  plugins: [
    {
      name: 'example',
      title: 'Example',
      description: 'd',
      latest: '1.0.0',
      versions: [
        {
          version: '1.0.0',
          sdk: '^1',
          coreTested: ['0.3.0'],
          url: 'https://example.com/b.js',
          manifestUrl: 'https://example.com/m.json',
          sha256: 'a'.repeat(64),
          size: 10,
          attestation: null,
          releasedAt: '2026-10-17T00:00:00.000Z',
        },
        {
          version: '2.0.0',
          sdk: '^2',
          coreTested: [],
          url: 'https://example.com/b2.js',
          manifestUrl: 'https://example.com/m2.json',
          sha256: 'b'.repeat(64),
          size: 10,
          attestation: null,
          releasedAt: '2026-10-17T00:00:00.000Z',
        },
      ],
    },
  ],
};

interface Hit {
  headers: IncomingHttpHeaders;
  url: string | undefined;
}

function serve(handler: (hit: Hit, res: import('node:http').ServerResponse) => void): Promise<{
  server: Server;
  base: string;
  hits: Hit[];
}> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const hit = { headers: req.headers, url: req.url };
    hits.push(hit);
    handler(hit, res);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits }),
    ),
  );
}

describe('CatalogClient', () => {
  let dir: string;
  const servers: Server[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-cat-'));
  });
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  const client = (over: Partial<ConstructorParameters<typeof CatalogClient>[0]> = {}) =>
    new CatalogClient({
      sdkVersion: '1.0.0-rc.1',
      token: null,
      cacheDir: join(dir, '.catalog'),
      allowFileUrls: true,
      keysFor: () => null,
      ...over,
    });

  it('caches for an hour, sends If-None-Match, marks versions compatible by sdk range, and serves the cache when the fetch fails', async () => {
    let fail = false;
    const s = await serve((hit, res) => {
      if (fail) {
        res.statusCode = 500;
        res.end('boom');
      } else if (hit.headers['if-none-match'] === '"v1"') {
        res.statusCode = 304;
        res.end();
      } else {
        res.setHeader('etag', '"v1"');
        res.end(JSON.stringify(index));
      }
    });
    servers.push(s.server);
    let now = new Date('2026-10-17T10:00:00Z');
    const c = client({ now: () => now });
    const url = `${s.base}/index.json`;

    const first = await c.list([url]);
    expect(first.errors).toEqual([]);
    expect(first.catalogs).toEqual([{ catalogUrl: url, fetchedAt: '2026-10-17T10:00:00.000Z' }]);
    expect(first.entries[0]?.versions[0]).toMatchObject({
      coreTested: ['0.3.0'],
      sha256: 'a'.repeat(64),
      size: 10,
      attestation: null,
      releasedAt: '2026-10-17T00:00:00.000Z',
    });
    expect(first.entries[0]?.versions.map((v) => [v.version, v.compatible])).toEqual([
      ['1.0.0', true],
      ['2.0.0', false],
    ]);
    expect(s.hits).toHaveLength(1);

    now = new Date('2026-10-17T10:30:00Z');
    await c.list([url]);
    expect(s.hits).toHaveLength(1);

    now = new Date('2026-10-17T11:30:00Z');
    const revalidated = await c.list([url]);
    expect(s.hits).toHaveLength(2);
    expect(s.hits[1]?.headers['if-none-match']).toBe('"v1"');
    expect(revalidated.entries).toHaveLength(1);

    fail = true;
    now = new Date('2026-10-17T13:00:00Z');
    const stale = await c.list([url]);
    expect(stale.entries).toHaveLength(1);
    expect(stale.errors).toEqual([{ catalogUrl: url, message: 'catalog fetch failed: HTTP 500' }]);

    const found = await c.find([url], 'example', '1.0.0');
    expect(found?.sha256).toBe('a'.repeat(64));
    expect(found?.catalogUrl).toBe(url);
    expect(await c.find([url], 'example', '9.9.9')).toBeNull();
  });

  it('find with refresh looks past a cached index', async () => {
    let body = JSON.stringify({ ...index, plugins: [] });
    const s = await serve((_h, res) => res.end(body));
    servers.push(s.server);
    const c = client();
    const url = `${s.base}/index.json`;
    expect(await c.find([url], 'example', '1.0.0')).toBeNull();
    body = JSON.stringify(index);
    expect(await c.find([url], 'example', '1.0.0')).toBeNull();
    expect((await c.find([url], 'example', '1.0.0', { refresh: true }))?.version).toBe('1.0.0');
    expect(s.hits).toHaveLength(2);
  });

  it('reports an error and no entries when nothing is cached and the fetch fails', async () => {
    const s = await serve((_h, res) => res.end('{"nope":1}'));
    servers.push(s.server);
    const r = await client().list([`${s.base}/x.json`]);
    expect(r.entries).toEqual([]);
    expect(r.errors[0]?.message).toMatch(/^invalid catalog/);
  });

  it('the catalog token is sent to raw.githubusercontent.com and never to another host', async () => {
    const allowed = await serve((_h, res) => res.end(JSON.stringify(index)));
    const other = await serve((_h, res) => res.end(JSON.stringify(index)));
    servers.push(allowed.server, other.server);
    const hostMap: Record<string, string> = {
      'raw.githubusercontent.com': allowed.base,
      'plugins.example.org': other.base,
    };
    const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      return fetch(`${hostMap[u.hostname]}${u.pathname}`, init);
    }) as typeof fetch;
    const c = client({ token: 'secret-token', fetchFn });

    await c.list([OFFICIAL_CATALOG_URL, 'https://plugins.example.org/index.json']);
    expect(allowed.hits[0]?.headers.authorization).toBe('Bearer secret-token');
    expect(other.hits).toHaveLength(1);
    expect(other.hits[0]?.headers.authorization).toBeUndefined();
  });

  it('refuses a catalog whose version is not valid semver or whose urls are not https', async () => {
    const bad = (mut: (v: Record<string, unknown>) => void) => {
      const copy = structuredClone(index);
      mut(copy.plugins[0]?.versions[0] as Record<string, unknown>);
      return copy;
    };
    const cases = [
      bad((v) => {
        v.version = '/../../../evil';
      }),
      bad((v) => {
        v.url = 'http://example.com/b.js';
      }),
      bad((v) => {
        v.manifestUrl = 'file:///etc/passwd';
      }),
    ];
    for (const body of cases) {
      const file = join(dir, 'bad.json');
      writeFileSync(file, JSON.stringify(body));
      const r = await client({ allowFileUrls: false }).list([pathToFileURL(file).href]);
      expect(r.entries).toEqual([]);
    }
    // via http (production-like client): the schema error is reported
    const s = await serve((_h, res) => res.end(JSON.stringify(cases[0])));
    servers.push(s.server);
    const r = await client().list([`${s.base}/i.json`]);
    expect(r.entries).toEqual([]);
    expect(r.errors[0]?.message).toMatch(/^invalid catalog/);
    const latest = structuredClone(index);
    (latest.plugins[0] as { latest: string }).latest = '../x';
    const s2 = await serve((_h, res) => res.end(JSON.stringify(latest)));
    servers.push(s2.server);
    expect((await client().list([`${s2.base}/i.json`])).entries).toEqual([]);
  });

  it('refuses an index body larger than 4 MB', async () => {
    const s = await serve((_h, res) => {
      res.write(Buffer.alloc(3 * 1024 * 1024, 32));
      res.end(Buffer.alloc(2 * 1024 * 1024, 32));
    });
    servers.push(s.server);
    const r = await client().list([`${s.base}/big.json`]);
    expect(r.entries).toEqual([]);
    expect(r.errors[0]?.message).toMatch(/larger than/);
  });

  it('does not forward the token across a redirect to a non-GitHub host', async () => {
    const seen: Array<{ host: string; auth: string | null }> = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      seen.push({ host: u.hostname, auth: new Headers(init?.headers).get('authorization') });
      if (u.hostname === 'raw.githubusercontent.com') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.org/i.json' },
        });
      }
      return new Response(JSON.stringify(index));
    }) as typeof fetch;
    const r = await client({ token: 't', fetchFn }).list([OFFICIAL_CATALOG_URL]);
    expect(r.entries).toHaveLength(1);
    expect(seen).toEqual([
      { host: 'raw.githubusercontent.com', auth: 'Bearer t' },
      { host: 'cdn.example.org', auth: null },
    ]);
  });

  it('reads a file: catalog when allowed and refuses it otherwise', async () => {
    const file = join(dir, 'index.json');
    writeFileSync(file, JSON.stringify(index));
    const url = pathToFileURL(file).href;
    const ok = await client().list([url]);
    expect(ok.entries).toHaveLength(1);
    const refused = await client({ allowFileUrls: false }).list([url]);
    expect(refused.entries).toEqual([]);
    expect(refused.errors).toEqual([
      { catalogUrl: url, message: 'file: catalogs are not allowed in production' },
    ]);
  });

  describe('signed catalogs', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const key: SigningKey = {
      id: 'k1',
      publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
    };
    const sigFor = (body: string) =>
      JSON.stringify({
        schema: 1,
        alg: 'ed25519',
        keyId: 'k1',
        signature: sign(null, Buffer.from(body), privateKey).toString('base64'),
      });
    const good = JSON.stringify(index);
    const withSig = (version: string) =>
      JSON.stringify({
        ...index,
        plugins: [
          {
            ...index.plugins[0],
            versions: [
              {
                ...index.plugins[0]?.versions[0],
                version,
                signature: 'https://example.com/b.js.sig',
              },
            ],
          },
        ],
      });

    it('lists a signed index as signed and carries the version signature through find()', async () => {
      const body = withSig('1.0.0');
      const s = await serve((hit, res) => {
        res.end(hit.url?.endsWith('.sig') ? sigFor(body) : body);
      });
      servers.push(s.server);
      const c = client({ keysFor: () => [key] });
      const url = `${s.base}/index.json`;
      const r = await c.list([url]);
      expect(r.errors).toEqual([]);
      expect(r.entries[0]?.signed).toBe(true);
      expect((await c.find([url], 'example', '1.0.0'))?.signature).toBe(
        'https://example.com/b.js.sig',
      );
      expect((await client().list([url])).entries[0]?.signed).toBe(false);
    });

    it('an absent version signature reads as null', async () => {
      const s = await serve((_h, res) => res.end(good));
      servers.push(s.server);
      const r = await client().list([`${s.base}/i.json`]);
      expect(r.entries[0]?.versions[0]?.signature).toBeNull();
    });

    it('a .sig that answers 404 is "catalog signature missing", even over a valid unsigned cache', async () => {
      const s = await serve((_h, res) => {
        res.end(good);
      });
      servers.push(s.server);
      const url = `${s.base}/index.json`;
      // an unsigned client caches the index first (no sig stored)
      expect((await client().list([url])).entries).toHaveLength(1);
      s.server.removeAllListeners('request');
      s.server.on('request', (req, res) => {
        if (req.url?.endsWith('.sig')) {
          res.statusCode = 404;
          res.end('nope');
        } else res.end(good);
      });
      const r = await client({ keysFor: () => [key] }).list([url], { refresh: true });
      expect(r.entries).toEqual([]);
      expect(r.errors[0]?.message).toBe('catalog signature missing');
      // and without refresh the unsigned cache is not served as fresh either
      const again = await client({ keysFor: () => [key] }).list([url]);
      expect(again.entries).toEqual([]);
      expect(again.errors[0]?.message).toBe('catalog signature missing');
    });

    it('an unknown key never falls back to a verified cache', async () => {
      let mode: 'ok' | 'other' = 'ok';
      const other = generateKeyPairSync('ed25519').privateKey;
      const s = await serve((_h, res) => res.end(good));
      servers.push(s.server);
      s.server.removeAllListeners('request');
      s.server.on('request', (req, res) => {
        if (!req.url?.endsWith('.sig')) return void res.end(good);
        res.end(
          mode === 'ok'
            ? sigFor(good)
            : JSON.stringify({
                schema: 1,
                alg: 'ed25519',
                keyId: 'rotated',
                signature: sign(null, Buffer.from(good), other).toString('base64'),
              }),
        );
      });
      const url = `${s.base}/index.json`;
      const c = client({ keysFor: () => [key] });
      expect((await c.list([url])).entries).toHaveLength(1);
      mode = 'other';
      const r = await c.list([url], { refresh: true });
      expect(r.entries).toEqual([]);
      expect(r.errors[0]?.message).toBe(
        'catalog signature invalid: signed with an unknown key rotated',
      );
    });

    it('retries a mismatching pair once with no-cache, then serves the verified cache', async () => {
      let phase: 'first' | 'skew' | 'heals' = 'first';
      const bad = `${good} `;
      const bodies: string[] = [];
      const inm: Array<[string, string | undefined]> = [];
      const s = await serve((_h, res) => res.end(good));
      servers.push(s.server);
      s.server.removeAllListeners('request');
      s.server.on('request', (req, res) => {
        const isSig = req.url?.endsWith('.sig') === true;
        inm.push([isSig ? 'sig' : 'doc', req.headers['if-none-match']]);
        res.setHeader('etag', '"e1"');
        if (!isSig) bodies.push(String(req.headers['cache-control']));
        if (isSig) return void res.end(sigFor(good));
        res.end(
          phase === 'first' ? good : phase === 'heals' && req.headers['cache-control'] ? good : bad,
        );
      });
      const url = `${s.base}/index.json`;
      const c = client({ keysFor: () => [key] });
      expect((await c.list([url])).entries).toHaveLength(1);

      phase = 'skew';
      bodies.length = 0;
      inm.length = 0;
      const r = await c.list([url], { refresh: true });
      expect(bodies).toEqual(['undefined', 'no-cache']);
      // the first pair is conditional on the document only; the retry and every .sig are not
      expect(inm).toEqual([
        ['doc', '"e1"'],
        ['sig', undefined],
        ['doc', undefined],
        ['sig', undefined],
      ]);
      expect(r.entries).toHaveLength(1); // the cached verified index
      expect(r.errors[0]?.message).toBe('catalog signature invalid: signature does not match');

      phase = 'heals';
      bodies.length = 0;
      const healed = await c.list([url], { refresh: true });
      expect(bodies).toEqual(['undefined', 'no-cache']);
      expect(healed.errors).toEqual([]);
      expect(healed.entries).toHaveLength(1);
    });

    it('a network error after a verified cache serves it with the error string', async () => {
      let fail = false;
      const s = await serve((_h, res) => res.end(good));
      servers.push(s.server);
      s.server.removeAllListeners('request');
      s.server.on('request', (req, res) => {
        if (fail) {
          res.statusCode = 500;
          return void res.end('boom');
        }
        res.end(req.url?.endsWith('.sig') ? sigFor(good) : good);
      });
      const url = `${s.base}/index.json`;
      const c = client({ keysFor: () => [key] });
      await c.list([url]);
      fail = true;
      const r = await c.list([url], { refresh: true });
      expect(r.entries).toHaveLength(1);
      expect(r.errors).toEqual([{ catalogUrl: url, message: 'catalog fetch failed: HTTP 500' }]);
    });

    it('refuses a verified index older than the cached verified one and keeps the cache', async () => {
      const newer = JSON.stringify({ ...index, generated: '2026-10-18T00:00:00.000Z' });
      let body = newer;
      const s = await serve((hit, res) => res.end(hit.url?.endsWith('.sig') ? sigFor(body) : body));
      servers.push(s.server);
      const url = `${s.base}/index.json`;
      const warnings: unknown[] = [];
      const log = { warn: (o: unknown) => warnings.push(o) } as never;
      const c = client({ keysFor: () => [key], log });
      expect((await c.list([url])).errors).toEqual([]);

      body = good; // validly signed, but generated a day earlier: a replay
      const r = await c.list([url], { refresh: true });
      expect(r.entries).toHaveLength(1);
      expect(r.errors[0]?.message).toBe(
        'catalog index older than the cached one (generated 2026-10-17T00:00:00.000Z, cached 2026-10-18T00:00:00.000Z)',
      );
      expect(warnings).toHaveLength(1);
      // the cache still holds the newer index: a later replay is refused too
      const again = await client({ keysFor: () => [key] }).list([url], { refresh: true });
      expect(again.errors[0]?.message).toMatch(/^catalog index older than the cached one/);

      body = JSON.stringify({ ...index, generated: '2026-10-19T00:00:00.000Z' });
      expect((await c.list([url], { refresh: true })).errors).toEqual([]);
    });

    it('an unsigned catalog may go back in time', async () => {
      let body = JSON.stringify({ ...index, generated: '2026-10-18T00:00:00.000Z' });
      const s = await serve((_h, res) => res.end(body));
      servers.push(s.server);
      const url = `${s.base}/index.json`;
      const c = client();
      await c.list([url]);
      body = good;
      expect((await c.list([url], { refresh: true })).errors).toEqual([]);
    });

    it('a signed file: catalog is verified and an unsigned one is refused', async () => {
      const file = join(dir, 'index.json');
      writeFileSync(file, good);
      const url = pathToFileURL(file).href;
      const keyed = client({ keysFor: () => [key] });
      const refused = await keyed.list([url]);
      expect(refused.entries).toEqual([]);
      expect(refused.errors[0]?.message).toBe('catalog signature missing');
      writeFileSync(`${file}.sig`, sigFor(good));
      expect((await keyed.list([url])).entries).toHaveLength(1);
    });

    describe('cache integrity', () => {
      const cacheFiles = () => {
        const d = join(dir, '.catalog');
        return readdirSync(d)
          .filter((f) => f.endsWith('.json'))
          .map((f) => join(d, f));
      };
      const flaky = async (body: Buffer, sigOver?: () => { status: number; body: string }) => {
        let down = false;
        const s = await serve((hit, res) => {
          if (down) {
            res.statusCode = 500;
            return void res.end('boom');
          }
          if (hit.url?.endsWith('.sig')) {
            const o = sigOver?.();
            res.statusCode = o?.status ?? 200;
            return void res.end(o?.body ?? sigFor2(body));
          }
          res.end(body);
        });
        servers.push(s.server);
        return { s, url: `${s.base}/index.json`, setDown: (v: boolean) => (down = v) };
      };
      const sigFor2 = (body: Buffer) =>
        JSON.stringify({
          schema: 1,
          alg: 'ed25519',
          keyId: 'k1',
          signature: sign(null, body, privateKey).toString('base64'),
        });

      it('keeps the exact bytes: a signed body with a non-UTF-8 byte verifies from the cache', async () => {
        const [head = '', rest = ''] = JSON.stringify(index).split('"d"');
        const body = Buffer.concat([
          Buffer.from(`${head}"d`),
          Buffer.from([0xff]),
          Buffer.from(`"${rest}`),
        ]);
        const f = await flaky(body);
        const c = client({ keysFor: () => [key] });
        expect((await c.list([f.url])).errors).toEqual([]);
        f.setDown(true);
        const again = await c.list([f.url]); // fresh cache: re-verified, no request
        expect(again.errors).toEqual([]);
        expect(again.entries).toHaveLength(1);
        const stale = await c.list([f.url], { refresh: true });
        expect(stale.entries).toHaveLength(1);
        expect(stale.errors[0]?.message).toBe('catalog fetch failed: HTTP 500');
      });

      it('treats a cache tampered on disk (body or sig) or in the old format as no cache', async () => {
        const f = await flaky(Buffer.from(good));
        const c = client({ keysFor: () => [key] });
        await c.list([f.url]);
        f.setDown(true);
        const [file] = cacheFiles();
        const orig = readFileSync(file as string, 'utf8');
        const cache = JSON.parse(orig) as { bodyB64: string; sig: string; [k: string]: unknown };
        const variants: Record<string, unknown> = {
          body: { ...cache, bodyB64: Buffer.from(`${good} `).toString('base64') },
          sig: { ...cache, sig: cache.sig.replace('"k1"', '"k2"') },
          'sig bytes': { ...cache, sig: sigFor2(Buffer.from('other')) },
          'old format': { fetchedAt: cache.fetchedAt, etag: null, body: good, sig: cache.sig },
        };
        for (const [name, v] of Object.entries(variants)) {
          writeFileSync(file as string, JSON.stringify(v));
          const r = await c.list([f.url]);
          expect(r.entries, name).toEqual([]);
          expect(r.errors[0]?.message, name).toBe('catalog fetch failed: HTTP 500');
        }
        writeFileSync(file as string, orig);
        expect((await c.list([f.url])).entries).toHaveLength(1);
      });

      it('a missing .sig over a verified cache does not fall back', async () => {
        let missing = false;
        const f = await flaky(Buffer.from(good), () =>
          missing ? { status: 404, body: 'nope' } : { status: 200, body: sigFor(good) },
        );
        const c = client({ keysFor: () => [key] });
        expect((await c.list([f.url])).entries).toHaveLength(1);
        missing = true;
        const r = await c.list([f.url], { refresh: true });
        expect(r.entries).toEqual([]);
        expect(r.errors[0]?.message).toBe('catalog signature missing');
      });

      it('a 5xx .sig is a fetch error and serves the verified cache; a 403 is missing', async () => {
        let status = 200;
        const f = await flaky(Buffer.from(good), () => ({
          status,
          body: status === 200 ? sigFor(good) : 'x',
        }));
        const c = client({ keysFor: () => [key] });
        await c.list([f.url]);
        status = 503;
        const r = await c.list([f.url], { refresh: true });
        expect(r.entries).toHaveLength(1);
        expect(r.errors[0]?.message).toBe('catalog fetch failed: signature HTTP 503');
        status = 403;
        const r2 = await c.list([f.url], { refresh: true });
        expect(r2.entries).toEqual([]);
        expect(r2.errors[0]?.message).toBe('catalog signature missing');
      });
    });
  });
});
