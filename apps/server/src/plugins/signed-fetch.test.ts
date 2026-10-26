import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { SigningKey } from './signature.ts';
import { fetchSigned, SignatureError, sigUrlOf } from './signed-fetch.ts';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const key: SigningKey = {
  id: 'k1',
  publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
};
const doc = '{"hello":"world"}';
const sigFor = (body: string) =>
  JSON.stringify({
    schema: 1,
    alg: 'ed25519',
    keyId: 'k1',
    signature: sign(null, Buffer.from(body), privateKey).toString('base64'),
  });

describe('sigUrlOf', () => {
  it('appends .sig and refuses a query string or fragment', () => {
    expect(sigUrlOf('https://a/b.json')).toBe('https://a/b.json.sig');
    expect(() => sigUrlOf('https://a/b?x')).toThrow(
      'a signed document url may not have a query string',
    );
    expect(() => sigUrlOf('https://a/b#x')).toThrow(
      'a signed document url may not have a query string',
    );
  });
});

describe('fetchSigned', () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function serve(files: Record<string, { status?: number; body: string }>) {
    const paths: string[] = [];
    const conditional: Array<[string, string | undefined]> = [];
    const server = createServer((req, res) => {
      paths.push(req.url ?? '');
      conditional.push([req.url ?? '', req.headers['if-none-match']]);
      const f = files[req.url ?? ''];
      res.statusCode = f?.status ?? (f ? 200 : 404);
      res.setHeader('etag', '"e1"');
      res.end(f?.body ?? 'nope');
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return {
      base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      paths,
      conditional,
    };
  }

  it('without keys makes one request and returns no signature', async () => {
    const s = await serve({ '/d.json': { body: doc } });
    const r = await fetchSigned(fetch, `${s.base}/d.json`, {}, null, 1000, null);
    expect(r.body?.toString()).toBe(doc);
    expect(r).toMatchObject({ status: 200, etag: '"e1"', sigText: null, keyId: null });
    expect(s.paths).toEqual(['/d.json']);
  });

  it('with keys fetches and verifies the signature', async () => {
    const s = await serve({ '/d.json': { body: doc }, '/d.json.sig': { body: sigFor(doc) } });
    const r = await fetchSigned(fetch, `${s.base}/d.json`, {}, null, 1000, [key]);
    expect(r.body?.toString()).toBe(doc);
    expect(r).toMatchObject({ keyId: 'k1', sigText: sigFor(doc) });
    expect(s.paths).toEqual(['/d.json', '/d.json.sig']);
  });

  it('never sends the document conditional headers with the .sig request, but keeps the others', async () => {
    const s = await serve({ '/d.json': { body: doc }, '/d.json.sig': { body: sigFor(doc) } });
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const spy = ((u: string | URL | Request, i?: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(i?.headers).entries()));
      return fetch(u, i);
    }) as typeof fetch;
    await fetchSigned(
      spy,
      `${s.base}/d.json`,
      {
        headers: {
          'if-none-match': '"e1"',
          'If-Modified-Since': 'x',
          'cache-control': 'no-cache',
          accept: 'application/json',
        },
      },
      null,
      1000,
      [key],
    );
    expect(s.conditional).toEqual([
      ['/d.json', '"e1"'],
      ['/d.json.sig', undefined],
    ]);
    expect(seen[1]).toEqual({ 'cache-control': 'no-cache', accept: 'application/json' });
  });

  it('a 5xx signature is a fetch error, a 404 or 403 is missing', async () => {
    const s = await serve({
      '/d.json': { body: doc },
      '/d.json.sig': { status: 503, body: 'x' },
      '/e.json': { body: doc },
      '/e.json.sig': { status: 403, body: 'x' },
    });
    const err = await fetchSigned(fetch, `${s.base}/d.json`, {}, null, 1000, [key]).catch(
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(SignatureError);
    expect((err as Error).message).toBe('signature HTTP 503');
    await expect(
      fetchSigned(fetch, `${s.base}/e.json`, {}, null, 1000, [key]),
    ).rejects.toMatchObject({
      reason: 'missing',
      message: 'signature missing (HTTP 403)',
    });
  });

  it('a 404 signature is SignatureError missing', async () => {
    const s = await serve({ '/d.json': { body: doc } });
    const err = await fetchSigned(fetch, `${s.base}/d.json`, {}, null, 1000, [key]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SignatureError);
    expect(err).toMatchObject({ reason: 'missing', message: 'signature missing (HTTP 404)' });
  });

  it('a tampered body is a mismatch and an empty key list accepts nothing', async () => {
    const s = await serve({
      '/d.json': { body: `${doc} ` },
      '/d.json.sig': { body: sigFor(doc) },
    });
    await expect(
      fetchSigned(fetch, `${s.base}/d.json`, {}, null, 1000, [key]),
    ).rejects.toMatchObject({
      reason: 'mismatch',
      message: 'signature does not match',
    });
    await expect(fetchSigned(fetch, `${s.base}/d.json`, {}, null, 1000, [])).rejects.toMatchObject({
      reason: 'unknown-key',
    });
  });

  it('a 304 or an error status returns no body and fetches no signature', async () => {
    const s = await serve({
      '/d.json': { status: 304, body: '' },
      '/e.json': { status: 500, body: 'x' },
    });
    for (const [p, status] of [
      ['/d.json', 304],
      ['/e.json', 500],
    ] as const) {
      const r = await fetchSigned(fetch, `${s.base}${p}`, {}, null, 1000, [key]);
      expect(r).toMatchObject({ status, body: null, sigText: null });
    }
    expect(s.paths).toEqual(['/d.json', '/e.json']);
  });

  it('refuses a body over the limit', async () => {
    const s = await serve({ '/d.json': { body: doc } });
    await expect(fetchSigned(fetch, `${s.base}/d.json`, {}, null, 4, null)).rejects.toThrow(
      /larger than 4 bytes/,
    );
  });

  it('refuses an oversized file: document', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-sf-'));
    dirs.push(dir);
    const file = join(dir, 'd.json');
    writeFileSync(file, doc);
    await expect(fetchSigned(fetch, pathToFileURL(file).href, {}, null, 4, null)).rejects.toThrow(
      /larger than 4 bytes/,
    );
  });

  it('verifies a file: pair and reports a missing .sig', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-sf-'));
    dirs.push(dir);
    const file = join(dir, 'd.json');
    writeFileSync(file, doc);
    const url = pathToFileURL(file).href;
    await expect(fetchSigned(fetch, url, {}, null, 1000, [key])).rejects.toMatchObject({
      reason: 'missing',
    });
    writeFileSync(`${file}.sig`, sigFor(doc));
    const r = await fetchSigned(fetch, url, {}, null, 1000, [key]);
    expect(r).toMatchObject({ status: 200, keyId: 'k1' });
    expect(r.body?.toString()).toBe(doc);
  });
});
