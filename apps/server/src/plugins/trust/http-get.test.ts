import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpFetch } from './http-get.ts';

describe('httpFetch', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/r') {
        res.statusCode = 302;
        res.setHeader('location', '/ok');
        res.end();
      } else if (req.url === '/loop') {
        res.statusCode = 302;
        res.setHeader('location', '/loop');
        res.end();
      } else if (req.url === '/none') {
        res.statusCode = 204;
        res.end();
      } else res.end(`hello ${req.headers['x-t'] ?? ''}`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('follows redirects, or returns them with redirect: manual', async () => {
    const r = await httpFetch(`${base}/r`, { headers: { 'x-t': 'a' } });
    expect(await r.text()).toBe('hello a');
    const m = await httpFetch(`${base}/r`, { redirect: 'manual' });
    expect(m.status).toBe(302);
    expect(m.headers.get('location')).toBe('/ok');
    expect((await httpFetch(`${base}/none`)).status).toBe(204);
  });

  it('rejects a redirect loop, a refused connection and an abort', async () => {
    await expect(httpFetch(`${base}/loop`)).rejects.toThrow(/redirects/);
    await expect(httpFetch('http://127.0.0.1:1/')).rejects.toThrow();
    await expect(httpFetch(`${base}/ok`, { signal: AbortSignal.abort() })).rejects.toThrow();
  });
});
