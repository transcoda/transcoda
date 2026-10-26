import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient, isDefinedError, safe } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ApiClient } from '@transcoda/contract';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it, vi } from 'vitest';
import { type Config, loadConfig } from './config.ts';
import { createUser } from './db/repos/users.ts';
import { createTestDb } from './db/test-db.ts';
import { nodeFsOps } from './engine/fs-ops.ts';
import { ALWAYS_ALLOWED_HOSTS, createAllowedHosts } from './http/host-check.ts';
import { createTestApp } from './test-app.ts';

function makeApp(overrides: Partial<Config> = {}, opts: { withUser?: boolean } = {}) {
  const { app, db, clock } = createTestApp({ config: overrides });
  if (opts.withUser) createUser(db, { username: 'admin', passwordHash: 'x' }, clock.now());
  return app;
}

describe('app', () => {
  it('serves health over REST', async () => {
    const res = await makeApp().request('/api/v1/system/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: '9.9.9' });
  });

  describe('deep health', () => {
    const caps = {
      available: true as const,
      path: 'ffmpeg',
      version: '7',
      encoders: [],
      hwaccels: [],
      filters: [],
    };
    const deepApp = (over: { ffmpeg?: boolean } = {}) =>
      createTestApp({
        config: { transcodeDir: '/very/secret/transcode' },
        capabilities:
          over.ffmpeg === false
            ? { available: false, path: 'ffmpeg', error: 'no /bin/ffmpeg' }
            : caps,
        fsOps: { ...nodeFsOps, statfs: async () => ({ bavail: 1e9, bsize: 4096 }) },
      });

    it('documents the deep query and the 503 in the spec', async () => {
      const res = await deepApp().app.request('/api/openapi.json');
      const spec = (await res.json()) as {
        paths: Record<
          string,
          { get?: { parameters?: { name: string; in: string }[]; responses: object } }
        >;
      };
      const get = spec.paths['/system/health']?.get;
      expect(get?.parameters).toContainEqual(
        expect.objectContaining({ name: 'deep', in: 'query' }),
      );
      expect(Object.keys(get?.responses ?? {})).toContain('503');
    });

    it('liveness has no checks', async () => {
      const res = await deepApp().app.request('/api/v1/system/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', version: '9.9.9' });
    });

    it('?deep=1 returns the checks with 200 when all pass', async () => {
      const res = await deepApp().app.request('/api/v1/system/health?deep=1');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: 'ok',
        version: '9.9.9',
        checks: { database: 'ok', ffmpeg: 'ok', scratchSpace: 'ok', queue: 'ok' },
      });
    });

    it('?deep=true works too and a bad value is rejected', async () => {
      expect((await deepApp().app.request('/api/v1/system/health?deep=true')).status).toBe(200);
      expect((await deepApp().app.request('/api/v1/system/health?deep=2')).status).toBe(400);
    });

    it('answers 503 with names only when a check fails', async () => {
      const res = await deepApp({ ffmpeg: false }).app.request('/api/v1/system/health?deep=1');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        defined: true,
        code: 'UNHEALTHY',
        status: 503,
        message: 'Unhealthy',
        data: {
          status: 'fail',
          version: '9.9.9',
          checks: { database: 'ok', ffmpeg: 'fail', scratchSpace: 'ok', queue: 'ok' },
        },
      });
    });

    it('never reveals paths or messages', async () => {
      const bad = createTestApp({
        config: { transcodeDir: '/very/secret/transcode' },
        capabilities: { available: false, path: '/opt/ffmpeg', error: 'no /bin/ffmpeg' },
        fsOps: {
          ...nodeFsOps,
          statfs: async () => {
            throw new Error('ENOENT /very/secret/transcode');
          },
        },
      });
      const text = await (await bad.app.request('/api/v1/system/health?deep=1')).text();
      for (const leak of ['secret', 'transcode', 'ENOENT', '/opt', '/bin']) {
        expect(text).not.toContain(leak);
      }
    });

    it('stays public but behind the host check', async () => {
      const t = deepApp();
      createUser(t.db, { username: 'admin', passwordHash: 'x' }, t.clock.now());
      const ok = await t.app.request('/api/v1/system/health?deep=1', {
        headers: { host: 'localhost:8080' },
      });
      expect(ok.status).toBe(200);
      const evil = await t.app.request('/api/v1/system/health?deep=1', {
        headers: { host: 'evil.example' },
      });
      expect(evil.status).toBe(403);
    });
  });

  it('serves health over RPC via the client', async () => {
    const app = makeApp();
    const link = new RPCLink({
      url: 'http://localhost/rpc',
      fetch: (req) => Promise.resolve(app.request(req as Request)),
    });
    const client = createORPCClient<ApiClient>(link);
    expect(await client.system.health()).toEqual({ status: 'ok', version: '9.9.9' });
  });

  it('serves the OpenAPI spec', async () => {
    const res = await makeApp().request('/api/openapi.json');
    expect(res.status).toBe(200);
    const spec = (await res.json()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
    };
    expect(spec.openapi.startsWith('3.1')).toBe(true);
    expect(spec.paths['/system/health']?.get).toBeDefined();
    expect(spec.paths['/tokens/{id}']?.delete).toBeDefined();
  });

  it('lists the nodes and workflow paths in the spec', async () => {
    const res = await makeApp().request('/api/openapi.json');
    const spec = (await res.json()) as { paths: Record<string, Record<string, unknown>> };
    expect(spec.paths['/nodes']?.get).toBeDefined();
    expect(spec.paths['/workflows']?.get).toBeDefined();
    expect(spec.paths['/workflows']?.post).toBeDefined();
    expect(spec.paths['/workflows/validate']?.post).toBeDefined();
    expect(spec.paths['/workflows/{id}/activate']?.post).toBeDefined();
    expect(spec.paths['/workflows/{id}/deactivate']?.post).toBeDefined();
    expect(spec.paths['/workflows/{id}/mode']).toBeUndefined();
    expect(spec.paths['/workflows/{id}/versions']?.get).toBeDefined();
    expect(spec.paths['/workflows/{id}/duplicate']?.post).toBeDefined();
    for (const method of ['get', 'put', 'patch', 'delete']) {
      expect(spec.paths['/workflows/{id}']?.[method]).toBeDefined();
    }
  });

  it('lists the plugins paths in the spec, static routes beside /plugins/{name}', async () => {
    const res = await makeApp().request('/api/openapi.json');
    const spec = (await res.json()) as { paths: Record<string, Record<string, unknown>> };
    const expected: Record<string, string[]> = {
      '/plugins': ['get', 'post'],
      '/plugins/catalog': ['get'],
      '/plugins/catalogs': ['post', 'delete'],
      '/plugins/{name}': ['get', 'delete'],
      '/plugins/{name}/update': ['post'],
      '/plugins/{name}/enable': ['post'],
      '/plugins/{name}/disable': ['post'],
      '/plugins/{name}/restart': ['post'],
      '/plugins/{name}/settings': ['get', 'put'],
      '/plugins/{name}/settings/test': ['post'],
      '/plugins/{name}/settings/test-mapping': ['post'],
    };
    for (const [path, methods] of Object.entries(expected)) {
      for (const method of methods)
        expect(spec.paths[path]?.[method], `${method} ${path}`).toBeDefined();
    }
  });

  it('documents KIND_MISMATCH (400) on PUT /workflows/{id} in the spec', async () => {
    const res = await makeApp().request('/api/openapi.json');
    const spec = (await res.json()) as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    };
    const put = spec.paths['/workflows/{id}']?.put;
    expect(JSON.stringify(put?.responses?.['400'])).toContain('KIND_MISMATCH');
  });

  it('rejects request bodies over 2 MB on /api and /rpc with 413', async () => {
    const app = makeApp();
    const big = `"${'x'.repeat(2 * 1024 * 1024)}"`;
    for (const path of ['/api/v1/workflows/x', '/rpc/workflows/save']) {
      const res = await app.request(path, {
        method: path.startsWith('/rpc') ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: big,
      });
      expect(res.status).toBe(413);
      const body = (await res.json()) as { code?: string; json?: { code?: string } };
      expect(body.code ?? body.json?.code).toBe('PAYLOAD_TOO_LARGE');
    }
    const small = await app.request('/api/v1/workflows/x', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: `"${'x'.repeat(1024 * 1024)}"`,
    });
    expect(small.status).not.toBe(413);
  });

  it('marks only the public operations as needing no auth in the spec', async () => {
    const res = await makeApp().request('/api/openapi.json');
    const spec = (await res.json()) as {
      security: unknown;
      paths: Record<string, Record<string, { security?: unknown }>>;
    };
    expect(spec.security).toEqual([{ bearerAuth: [] }]);
    for (const [path, method] of [
      ['/system/health', 'get'],
      ['/auth/setup', 'post'],
      ['/auth/login', 'post'],
      ['/auth/me', 'get'],
    ] as const) {
      expect(spec.paths[path]?.[method]?.security).toEqual([]);
    }
    for (const [path, method] of [
      ['/system/capabilities', 'get'],
      ['/auth/logout', 'post'],
      ['/tokens', 'post'],
      ['/tokens', 'get'],
      ['/tokens/{id}', 'delete'],
    ] as const) {
      expect(spec.paths[path]?.[method]).toBeDefined();
      expect(spec.paths[path]?.[method]?.security).toBeUndefined();
    }
  });

  it('OpenAPI spec lists /jobs, /libraries, /runs, /queue, /events', async () => {
    const res = await makeApp().request('/api/openapi.json');
    const spec = (await res.json()) as { paths: Record<string, Record<string, unknown>> };
    for (const [path, method] of [
      ['/libraries', 'get'],
      ['/libraries', 'post'],
      ['/libraries/{id}', 'get'],
      ['/libraries/{id}', 'patch'],
      ['/libraries/{id}', 'delete'],
      ['/libraries/{id}/browse', 'get'],
      ['/jobs', 'post'],
      ['/jobs', 'get'],
      ['/jobs/stats', 'get'],
      ['/jobs/{id}', 'get'],
      ['/jobs/{id}/log', 'get'],
      ['/jobs/{id}/pause', 'post'],
      ['/jobs/{id}/resume', 'post'],
      ['/jobs/{id}/cancel', 'post'],
      ['/queue', 'get'],
      ['/queue/pause', 'post'],
      ['/queue/resume', 'post'],
      ['/runs', 'get'],
      ['/runs/{id}', 'get'],
      ['/events', 'get'],
    ] as const) {
      expect(spec.paths[path]?.[method], `${method} ${path}`).toBeDefined();
    }
    expect(JSON.stringify(spec.paths['/events'])).toContain('text/event-stream');
  });

  it('answers unauthenticated token management with 401', async () => {
    const res = await makeApp().request('/api/v1/tokens');
    expect(res.status).toBe(401);
  });

  it('returns 404 JSON for unknown paths', async () => {
    const res = await makeApp().request('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'NOT_FOUND' });
  });

  it('serves the SPA with fallback when webDistDir is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tcd-web-'));
    writeFileSync(join(dir, 'index.html'), '<html>transcoda-ui</html>');
    const app = makeApp({ webDistDir: dir });
    for (const path of ['/', '/settings/tokens']) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('transcoda-ui');
    }
    const api = await app.request('/api/v1/nope');
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: 'NOT_FOUND' });
    const rpc = await app.request('/rpc/nope');
    expect(rpc.status).toBe(404);
  });

  it('answers a missing asset with 404 instead of the SPA page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tcd-web-'));
    writeFileSync(join(dir, 'index.html'), '<html>transcoda-ui</html>');
    const app = makeApp({ webDistDir: dir });
    for (const path of ['/assets/missing.js', '/favicon.ico', '/a/b.c/d.png']) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('transcoda-ui');
    }
    // A dot in an earlier segment does not make a route a file.
    expect((await app.request('/v1.2/settings')).status).toBe(200);
  });

  describe('host check', () => {
    const get = (app: ReturnType<typeof makeApp>, host: string, path = '/api/v1/system/health') =>
      app.request(path, { headers: { host } });

    it('rejects unknown hosts once users exist', async () => {
      const app = makeApp({}, { withUser: true });
      const res = await get(app, 'evil.example');
      expect(res.status).toBe(403);
      const error = {
        defined: true,
        code: 'HOST_NOT_ALLOWED',
        status: 403,
        message: 'Host not allowed',
        data: { host: 'evil.example' },
      };
      expect(await res.json()).toEqual(error);
      const rpc = await get(app, 'evil.example:8080', '/rpc/system/health');
      expect(rpc.status).toBe(403);
      expect(await rpc.json()).toEqual({ json: error, meta: [] });
    });

    it('the oRPC client sees HOST_NOT_ALLOWED as a defined error carrying the host', async () => {
      const app = makeApp({}, { withUser: true });
      const link = new RPCLink({
        url: 'http://evil.example/rpc',
        fetch: (req) => {
          // A real HTTP request carries the Host header; a bare fetch Request does not.
          const headers = new Headers((req as Request).headers);
          headers.set('host', 'evil.example');
          return Promise.resolve(app.request(new Request(req as Request, { headers })));
        },
      });
      const client = createORPCClient<ApiClient>(link);
      const [err] = await safe(client.auth.me());
      expect(isDefinedError(err)).toBe(true);
      expect(err).toMatchObject({
        code: 'HOST_NOT_ALLOWED',
        status: 403,
        data: { host: 'evil.example' },
      });
    });

    it('checks X-Forwarded-Host only from a trusted proxy', async () => {
      const t = createTestApp({
        config: { trustedProxies: ['10.0.0.0/8'] },
        remoteAddr: '10.0.0.2',
      });
      createUser(t.db, { username: 'admin', passwordHash: 'x' }, t.clock.now());
      const req = (xfh: string) =>
        t.app.request('/api/v1/system/health', {
          headers: { host: 'localhost:8080', 'x-forwarded-host': xfh },
        });
      expect((await req('evil.example')).status).toBe(403);
      t.setRemoteAddr('203.0.113.9');
      expect((await req('evil.example')).status).toBe(200);
    });

    it('accepts localhost and configured hosts once users exist', async () => {
      const app = makeApp({ allowedHosts: ['media.example.com'] }, { withUser: true });
      expect((await get(app, 'localhost:8080')).status).toBe(200);
      expect((await get(app, 'Media.example.com')).status).toBe(200);
    });

    it('accepts any host while no users exist', async () => {
      expect((await get(makeApp(), 'anything.example')).status).toBe(200);
    });

    it('does not check hosts for non-API paths', async () => {
      const app = makeApp({}, { withUser: true });
      expect((await get(app, 'evil.example', '/nope')).status).toBe(404);
    });
  });

  it('treats a corrupt allowed_hosts setting as empty', () => {
    const db = createTestDb();
    createUser(db, { username: 'admin', passwordHash: 'x' }, new Date());
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('allowed_hosts', '{bad', 'x')",
    ).run();
    const config = { ...loadConfig({}), nodeEnv: 'test' as const };
    expect(createAllowedHosts(db, config)()).toEqual(ALWAYS_ALLOWED_HOSTS);
  });

  it('returns JSON 500 for errors under /api and /rpc', async () => {
    const app = makeApp();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    app.get('/api/boom', () => {
      throw new Error('kaboom');
    });
    app.get('/other/boom', () => {
      throw new Error('kaboom');
    });
    const res = await app.request('/api/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'INTERNAL' });
    expect((await app.request('/other/boom')).status).toBe(500);
    spy.mockRestore();
  });

  it('passes HTTPException responses through instead of a JSON 500', async () => {
    const app = makeApp();
    app.get('/api/teapot', () => {
      throw new HTTPException(418, { message: 'short and stout' });
    });
    const res = await app.request('/api/teapot');
    expect(res.status).toBe(418);
    expect(await res.text()).toBe('short and stout');
  });
});
