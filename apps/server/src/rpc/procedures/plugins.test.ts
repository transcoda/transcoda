import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PluginManifest } from '@transcoda/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkPluginBundle } from '../../plugins/check-plugin.ts';
import { fixturePluginPath, hostPath } from '../../plugins/testing/build.ts';
import { createTestApp, type TestApp } from '../../test-app.ts';
import { asSession, bearer, createToken, login, type Session, send } from '../../test-http.ts';

const KEY = 'sk-live-REST-secret-4821';
const ALL_SCOPES = ['read', 'plan', 'jobs:create', 'jobs:manage', 'workflows:write'];

let t: TestApp;
let s: Session;
let token: string;

// A local catalog serving the `secrets` fixture (a plugin with an integration), so the plugin has
// a real row and real stored settings. `example` is a dev plugin (no row, no settings).
let server: Server;
let indexUrl = '';
const served = new Map<string, { bundle: string; manifest: PluginManifest }>();

beforeAll(async () => {
  for (const fixture of ['secrets', 'setupfail'] as const) {
    const checked = await checkPluginBundle(fixturePluginPath(fixture), { hostPath: hostPath() });
    if (!checked.ok) throw new Error(checked.error);
    served.set(fixture, {
      bundle: readFileSync(fixturePluginPath(fixture), 'utf8'),
      manifest: {
        name: checked.name,
        version: checked.version,
        sdk: checked.sdk,
        nodes: checked.nodes,
        integration: checked.integration,
        triggers: checked.triggers,
        hooks: checked.hooks,
      },
    });
  }
  server = createServer((req, res) => {
    const path = req.url ?? '';
    const root = indexUrl.replace('/index.json', '');
    if (path === '/index.json') {
      res.setHeader('content-type', 'application/json').end(
        JSON.stringify({
          schema: 1,
          generated: '2026-10-17T10:00:00.000Z',
          plugins: [...served].map(([name, { bundle, manifest }]) => ({
            name,
            title: name,
            description: `the ${name} plugin`,
            latest: '0.1.0',
            versions: [
              ...(name === 'secrets'
                ? [
                    {
                      // A later release, listed so an update check has something to look at.
                      version: '0.2.0',
                      sdk: manifest.sdk,
                      coreTested: ['1.0.0'],
                      url: `${root}/${name}-next.js`,
                      manifestUrl: `${root}/${name}-next.manifest.json`,
                      sha256: createHash('sha256').update(bundle).digest('hex'),
                      size: Buffer.byteLength(bundle),
                      attestation: null,
                      releasedAt: '2026-10-18T10:00:00.000Z',
                    },
                  ]
                : []),
              {
                version: '0.1.0',
                sdk: manifest.sdk,
                coreTested: ['1.0.0'],
                url: `${root}/${name}.js`,
                manifestUrl: `${root}/${name}.manifest.json`,
                sha256: createHash('sha256').update(bundle).digest('hex'),
                size: Buffer.byteLength(bundle),
                attestation: null,
                releasedAt: '2026-10-17T10:00:00.000Z',
              },
            ],
          })),
        }),
      );
      return;
    }
    const m = /^\/([a-z]+)(-next)?\.(js|manifest\.json)$/.exec(path);
    const hit = m ? served.get(m[1] ?? '') : undefined;
    if (!hit) {
      res.statusCode = 404;
      res.end('no');
      return;
    }
    const manifest = m?.[2]
      ? { ...hit.manifest, version: '0.2.0', nodeVersions: [] }
      : hit.manifest;
    res.end(m?.[3] === 'js' ? hit.bundle : JSON.stringify(manifest));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  indexUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/index.json`;
});
afterAll(() => {
  server.close();
});

beforeEach(async () => {
  t = createTestApp({
    plugins: { devPlugins: [fixturePluginPath('example')] },
    config: { pluginCatalogUrl: indexUrl },
  });
  await t.deps.plugins.start();
  s = await login(t);
  ({ token } = await createToken(t, s, { name: 'all', scopes: ALL_SCOPES }));
  // Install `secrets` as the admin would (session, CSRF).
  await t.deps.plugins.catalog(true);
  const res = await send(t, 'POST', '/plugins', {
    body: { name: 'secrets', version: '0.1.0', catalogUrl: indexUrl },
    headers: asSession(s, true),
  });
  expect(res.status, await res.clone().text()).toBe(200);
});

afterEach(async () => {
  await t.close();
});

const mapping = { local: '/tmp', remote: '/x' };

/** Every plugins procedure except `list`, with a valid request each. */
const SESSION_ONLY: Array<[string, 'GET' | 'POST' | 'PUT' | 'DELETE', string, unknown?]> = [
  ['get', 'GET', '/plugins/example'],
  ['catalog', 'GET', '/plugins/catalog'],
  ['install', 'POST', '/plugins', { name: 'x', version: '1.0.0', catalogUrl: 'https://c.test/i' }],
  ['update', 'POST', '/plugins/example/update', { version: '1.0.0' }],
  ['updateCheck', 'POST', '/plugins/example/update-check', { version: '1.0.0' }],
  ['remove', 'DELETE', '/plugins/example', { confirm: true }],
  ['enable', 'POST', '/plugins/example/enable'],
  ['disable', 'POST', '/plugins/example/disable'],
  ['restart', 'POST', '/plugins/example/restart'],
  ['settingsGet', 'GET', '/plugins/secrets/settings'],
  ['settingsSave', 'PUT', '/plugins/secrets/settings', { settings: { apiKey: KEY } }],
  ['settingsTest', 'POST', '/plugins/secrets/settings/test', { settings: { apiKey: KEY } }],
  ['testMapping', 'POST', '/plugins/secrets/settings/test-mapping', { mapping }],
  ['catalogsAdd', 'POST', '/plugins/catalogs', { url: 'https://c.test/index.json' }],
  ['catalogsRemove', 'DELETE', '/plugins/catalogs', { url: 'https://c.test/index.json' }],
];

describe('plugins REST: session only', () => {
  it.each(SESSION_ONLY)(
    '%s: a token with every scope is 403 FORBIDDEN',
    async (_n, method, path, body) => {
      const res = await send(t, method, path, {
        headers: bearer(token),
        ...(body === undefined ? {} : { body }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('FORBIDDEN');
    },
  );

  it.each(SESSION_ONLY)('%s: no credentials is 401', async (_n, method, path, body) => {
    const res = await send(t, method, path, body === undefined ? {} : { body });
    expect(res.status).toBe(401);
  });

  it.each(SESSION_ONLY.filter(([, m]) => m !== 'GET'))(
    '%s: a session without the CSRF header is 403 CSRF_FAILED and changes nothing',
    async (_n, method, path, body) => {
      const before = JSON.stringify(t.deps.plugins.list());
      const res = await send(t, method, path, {
        headers: { ...asSession(s, false), origin: 'http://localhost:8080' },
        ...(body === undefined ? {} : { body }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('CSRF_FAILED');
      expect(JSON.stringify(t.deps.plugins.list())).toBe(before);
    },
  );

  it('a token cannot disable or remove a plugin: it stays installed and running', async () => {
    for (const [method, path, body] of [
      ['POST', '/plugins/example/disable', undefined],
      ['DELETE', '/plugins/example', { confirm: true }],
    ] as const) {
      const res = await send(t, method, path, {
        headers: bearer(token),
        ...(body === undefined ? {} : { body }),
      });
      expect(res.status).toBe(403);
    }
    expect(t.deps.plugins.list().find((p) => p.name === 'example')?.state).toBe('running');
  });
});

describe('plugins REST: list', () => {
  it('a read token lists the plugins; the body has no settings key anywhere', async () => {
    const { token: readToken } = await createToken(t, s, { name: 'r', scopes: ['read'] });
    // A stored secret exists, to prove it cannot show up here.
    expect(
      (
        await send(t, 'PUT', '/plugins/secrets/settings', {
          body: { settings: { apiKey: KEY } },
          headers: asSession(s, true),
        })
      ).status,
    ).toBe(200);
    const res = await send(t, 'GET', '/plugins', { headers: bearer(readToken) });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as {
      plugins: Array<Record<string, unknown>>;
      missing: unknown[];
    };
    expect(body.plugins.map((p) => p.name)).toEqual(['example', 'secrets']);
    expect(body.missing).toEqual([]);
    expect(raw).not.toMatch(/settings/i);
    expect(raw).not.toContain(KEY);
    // Not even the hint the settings form shows.
    expect(raw).not.toContain(KEY.slice(-4));
    expect(body.plugins[0]).toMatchObject({ name: 'example', enabled: true, state: 'running' });
  });

  it('GET /plugins with no credentials is 401', async () => {
    const res = await send(t, 'GET', '/plugins');
    expect(res.status).toBe(401);
  });

  it('a token without the read scope is 403; a session lists too', async () => {
    const { token: other } = await createToken(t, s, { name: 'p', scopes: ['plan'] });
    expect((await send(t, 'GET', '/plugins', { headers: bearer(other) })).status).toBe(403);
    const res = await send(t, 'GET', '/plugins', { headers: asSession(s, false) });
    expect(res.status).toBe(200);
  });
});

describe('plugins REST: session', () => {
  const h = () => asSession(s, true);

  it('static routes win over /plugins/{name}: catalog, catalogs and a named plugin all answer', async () => {
    const cat = await send(t, 'GET', '/plugins/catalog', { headers: asSession(s, false) });
    expect(cat.status).toBe(200);
    expect(((await cat.json()) as { catalogs: unknown[] }).catalogs).toBeInstanceOf(Array);
    const get = await send(t, 'GET', '/plugins/example', { headers: asSession(s, false) });
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ name: 'example', state: 'running' });
    const url = 'https://c.test/index.json';
    const add = await send(t, 'POST', '/plugins/catalogs', { body: { url }, headers: h() });
    expect(add.status).toBe(200);
    expect(
      ((await add.json()) as { catalogs: Array<{ catalogUrl: string }> }).catalogs.map(
        (c) => c.catalogUrl,
      ),
    ).toContain(url);
    const del = await send(t, 'DELETE', '/plugins/catalogs', { body: { url }, headers: h() });
    expect(del.status).toBe(200);
    expect(
      ((await del.json()) as { catalogs: Array<{ catalogUrl: string }> }).catalogs.map(
        (c) => c.catalogUrl,
      ),
    ).not.toContain(url);
  });

  it('an unknown plugin is 404 NOT_FOUND', async () => {
    const res = await send(t, 'GET', '/plugins/nope', { headers: asSession(s, false) });
    expect(res.status).toBe(404);
    const en = await send(t, 'POST', '/plugins/nope/enable', { headers: h() });
    expect(en.status).toBe(404);
    const st = await send(t, 'GET', '/plugins/nope/settings', { headers: asSession(s, false) });
    expect(st.status).toBe(404);
  });

  it('install failure is 422 PLUGIN_INSTALL_FAILED with the reason', async () => {
    const res = await send(t, 'POST', '/plugins', {
      body: { name: 'nothing', version: '1.0.0', catalogUrl: 'https://not-configured.test/i' },
      headers: h(),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: 'PLUGIN_INSTALL_FAILED',
      data: { reason: 'that catalog is not one of the configured catalogs' },
    });
  });

  it('installing the same plugin again is 422; an installed plugin can be removed (200) and is gone', async () => {
    const again = await send(t, 'POST', '/plugins', {
      body: { name: 'secrets', version: '0.1.0', catalogUrl: indexUrl },
      headers: h(),
    });
    expect(again.status).toBe(422);
    expect(await again.json()).toMatchObject({
      code: 'PLUGIN_INSTALL_FAILED',
      data: { reason: 'plugin secrets is already installed' },
    });
    const rm = await send(t, 'DELETE', '/plugins/secrets', {
      body: { confirm: true },
      headers: h(),
    });
    expect(rm.status).toBe(200);
    expect(await rm.json()).toEqual({ ok: true });
    expect(
      (await send(t, 'GET', '/plugins/secrets', { headers: asSession(s, false) })).status,
    ).toBe(404);
  });

  it('update of an unknown plugin is 404', async () => {
    expect(
      (await send(t, 'POST', '/plugins/nope/update', { body: { version: '1.0.0' }, headers: h() }))
        .status,
    ).toBe(404);
  });

  it('update-check: a session gets the shape (the output schema holds), a refusal is 422 with the reason, an unknown plugin 404; update_check is not an API a token reaches', async () => {
    await t.deps.plugins.catalog(true);
    const ok = await send(t, 'POST', '/plugins/secrets/update-check', {
      body: { version: '0.2.0' },
      headers: h(),
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toEqual({ wouldBreak: [], needsReview: [], unknown: false });
    const same = await send(t, 'POST', '/plugins/secrets/update-check', {
      body: { version: '0.1.0' },
      headers: h(),
    });
    expect(same.status).toBe(422);
    expect(await same.json()).toMatchObject({
      code: 'PLUGIN_INSTALL_FAILED',
      data: { reason: 'secrets 0.1.0 is already installed' },
    });
    expect(
      (
        await send(t, 'POST', '/plugins/nope/update-check', {
          body: { version: '1.0.0' },
          headers: h(),
        })
      ).status,
    ).toBe(404);
    const refused = await send(t, 'POST', '/plugins/secrets/update-check', {
      body: { version: '0.2.0' },
      headers: bearer(token),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ message: 'Plugin management is a UI action' });
  });

  it('remove without confirm is 400; remove of a dev plugin is 422 with the reason', async () => {
    const no = await send(t, 'DELETE', '/plugins/example', { body: {}, headers: h() });
    expect(no.status).toBe(400);
    const no2 = await send(t, 'DELETE', '/plugins/example', {
      body: { confirm: false },
      headers: h(),
    });
    expect(no2.status).toBe(400);
    const dev = await send(t, 'DELETE', '/plugins/example', {
      body: { confirm: true },
      headers: h(),
    });
    expect(dev.status).toBe(422);
    expect(await dev.json()).toMatchObject({ code: 'PLUGIN_INSTALL_FAILED' });
  });

  it('disable, enable and restart answer the plugin detail and the state follows', async () => {
    const off = await send(t, 'POST', '/plugins/example/disable', { headers: h() });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ name: 'example', state: 'disabled' });
    const on = await send(t, 'POST', '/plugins/example/enable', { headers: h() });
    expect(await on.json()).toMatchObject({ enabled: true, state: 'running' });
    const stored = await send(t, 'POST', '/plugins/secrets/disable', { headers: h() });
    expect(await stored.json()).toMatchObject({
      name: 'secrets',
      enabled: false,
      state: 'disabled',
    });
    await send(t, 'POST', '/plugins/secrets/enable', { headers: h() });
    const re = await send(t, 'POST', '/plugins/example/restart', { headers: h() });
    expect(re.status).toBe(200);
    expect(await re.json()).toMatchObject({ state: 'running' });
  });

  it('settings: save masks, get never returns the stored secret, { set: true } keeps it', async () => {
    const empty = await send(t, 'GET', '/plugins/secrets/settings', {
      headers: asSession(s, false),
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ settings: {}, lastTest: null, needsReview: null });

    const saved = await send(t, 'PUT', '/plugins/secrets/settings', {
      body: { settings: { apiKey: KEY } },
      headers: h(),
    });
    expect(saved.status).toBe(200);
    const savedText = await saved.text();
    expect(savedText).not.toContain(KEY);
    expect(JSON.parse(savedText)).toMatchObject({ settings: { apiKey: { set: true } } });

    const got = await send(t, 'GET', '/plugins/secrets/settings', { headers: asSession(s, false) });
    const gotText = await got.text();
    expect(gotText).not.toContain(KEY);
    expect(JSON.parse(gotText).settings).toEqual({ apiKey: { set: true, endsWith: '4821' } });

    // Saving the marker keeps the stored value: the test with { set: true } still sees the key.
    const kept = await send(t, 'PUT', '/plugins/secrets/settings', {
      body: { settings: { apiKey: { set: true } } },
      headers: h(),
    });
    expect(kept.status).toBe(200);
    const tested = await send(t, 'POST', '/plugins/secrets/settings/test', {
      body: { settings: { apiKey: { set: true } } },
      headers: h(),
    });
    expect(tested.status).toBe(200);
    const testedText = await tested.text();
    expect(JSON.parse(testedText)).toMatchObject({ ok: true });
    // The plugin's own message echoes what it received; the response is still masked or absent
    // of the secret only if the service redacts it.
    expect(testedText).not.toContain(KEY);
    // The plugin's test() echoed the key; neither the answer nor the stored last test has it.
    const candidate = await send(t, 'POST', '/plugins/secrets/settings/test', {
      body: { settings: { apiKey: 'CANDIDATE-KEY-5521' } },
      headers: h(),
    });
    const candidateText = await candidate.text();
    expect(JSON.parse(candidateText)).toMatchObject({ ok: true });
    expect(candidateText).not.toContain('CANDIDATE-KEY-5521');
    expect(candidateText).not.toContain(KEY);
    const rows = JSON.stringify(t.db.prepare('SELECT * FROM plugin_settings').all());
    expect(rows).toContain('last_test_json');
    expect(rows).not.toContain(KEY);
    expect(rows).not.toContain('CANDIDATE-KEY-5521');
    const afterGet = await (
      await send(t, 'GET', '/plugins/secrets/settings', { headers: asSession(s, false) })
    ).text();
    expect(JSON.parse(afterGet).lastTest).not.toBeNull();
    expect(afterGet).not.toContain(KEY);
    expect(afterGet).not.toContain('CANDIDATE-KEY-5521');
    // And the plugin detail, the list and the catalog never carry it either.
    for (const path of ['/plugins/secrets', '/plugins', '/plugins/catalog']) {
      const r = await send(t, 'GET', path, { headers: asSession(s, false) });
      expect(await r.text(), path).not.toContain(KEY);
    }
  });

  it('invalid settings are 422 PLUGIN_SETTINGS_INVALID with issues and no value', async () => {
    const res = await send(t, 'PUT', '/plugins/secrets/settings', {
      body: { settings: { apiKey: '' } },
      headers: h(),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; data: { issues: unknown[] } };
    expect(body.code).toBe('PLUGIN_SETTINGS_INVALID');
    expect(body.data.issues.length).toBeGreaterThan(0);
    const bad = await send(t, 'POST', '/plugins/secrets/settings/test', {
      body: { settings: 'x' },
      headers: h(),
    });
    expect(bad.status).toBe(422);
  });

  it('a settings test while the plugin is not running is 409 PLUGIN_NOT_RUNNING', async () => {
    await send(t, 'POST', '/plugins/secrets/disable', { headers: h() });
    const res = await send(t, 'POST', '/plugins/secrets/settings/test', {
      body: { settings: { apiKey: KEY } },
      headers: h(),
    });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text).code).toBe('PLUGIN_NOT_RUNNING');
    expect(text).not.toContain(KEY);
  });

  it('settings of a plugin without an integration are 404', async () => {
    const res = await send(t, 'GET', '/plugins/example/settings', { headers: asSession(s, false) });
    expect(res.status).toBe(404);
  });

  it('testMapping answers ok false for a directory outside every library', async () => {
    const res = await send(t, 'POST', '/plugins/secrets/settings/test-mapping', {
      body: { mapping },
      headers: h(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false });
  });
});

describe('plugins REST: dev plugin settings', () => {
  it('save, get and test work for a dev plugin (kept in memory, no plugins row); a token is refused with the plugin message', async () => {
    const dev = createTestApp({ plugins: { devPlugins: [fixturePluginPath('secrets')] } });
    try {
      await dev.deps.plugins.start();
      const ds = await login(dev);
      const h = () => asSession(ds, true);
      const saved = await send(dev, 'PUT', '/plugins/secrets/settings', {
        body: { settings: { apiKey: KEY } },
        headers: h(),
      });
      expect(saved.status, await saved.clone().text()).toBe(200);
      expect(JSON.parse(await saved.text()).settings).toEqual({
        apiKey: { set: true, endsWith: '4821' },
      });
      const got = await send(dev, 'GET', '/plugins/secrets/settings', {
        headers: asSession(ds, false),
      });
      const gotText = await got.text();
      expect(gotText).not.toContain(KEY);
      expect(JSON.parse(gotText).settings).toEqual({ apiKey: { set: true, endsWith: '4821' } });
      const tested = await send(dev, 'POST', '/plugins/secrets/settings/test', {
        body: { settings: { apiKey: { set: true } } },
        headers: h(),
      });
      expect(tested.status).toBe(200);
      const testedText = await tested.text();
      expect(JSON.parse(testedText)).toMatchObject({ ok: true });
      expect(testedText).not.toContain(KEY);
      // Never persisted.
      expect(dev.db.prepare('SELECT COUNT(*) AS n FROM plugin_settings').get()).toEqual({ n: 0 });
      const { token: tk } = await createToken(dev, ds, { name: 'all', scopes: ALL_SCOPES });
      const refused = await send(dev, 'GET', '/plugins/secrets/settings', { headers: bearer(tk) });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ message: 'Plugin management is a UI action' });
    } finally {
      await dev.close();
    }
  });
});

describe('plugins REST: what a failure shows', () => {
  it('a plugin that fails to start with the key in its error: the state reason, the list and the not-running error carry no key and no path', async () => {
    const h = () => asSession(s, true);
    const KEY2 = 'sk-setupfail-77123';
    await t.deps.plugins.catalog(true);
    const inst = await send(t, 'POST', '/plugins', {
      body: { name: 'setupfail', version: '0.1.0', catalogUrl: indexUrl },
      headers: h(),
    });
    expect(inst.status, await inst.clone().text()).toBe(200);
    const saved = await send(t, 'PUT', '/plugins/setupfail/settings', {
      body: { settings: { apiKey: KEY2 } },
      headers: h(),
    });
    expect(saved.status).toBe(200);
    // The next start fails with the key in the plugin's own error text.
    const restart = await send(t, 'POST', '/plugins/setupfail/restart', { headers: h() });
    const texts: string[] = [await restart.text()];
    for (const path of ['/plugins', '/plugins/setupfail']) {
      texts.push(await (await send(t, 'GET', path, { headers: asSession(s, false) })).text());
    }
    const test = await send(t, 'POST', '/plugins/setupfail/settings/test', {
      body: { settings: { apiKey: { set: true } } },
      headers: h(),
    });
    texts.push(await test.text());
    const reason = t.deps.plugins.list().find((p) => p.name === 'setupfail')?.stateReason ?? '';
    texts.push(reason);
    for (const text of texts) {
      expect(text).not.toContain(KEY2);
      expect(text).not.toMatch(
        /\/Users\/|\/private\/|\/tmp\/|\.local\/plugin-host|plugin-host\.js/,
      );
    }
    expect(reason).toMatch(/rejected key/);
  });
});

describe('plugins REST: custom catalog keys', () => {
  const url = 'https://c.test/index.json';
  const KEYS = `k1:${'ab'.repeat(32)}`;

  it('catalogsAdd stores the signing keys verbatim; the catalog list says signed and by which ids', async () => {
    const h = () => asSession(s, true);
    const res = await send(t, 'POST', '/plugins/catalogs', {
      body: { url, signingKeys: KEYS },
      headers: h(),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(t.db.prepare('SELECT signing_keys FROM plugin_catalogs WHERE url = ?').get(url)).toEqual(
      {
        signing_keys: KEYS,
      },
    );
    const out = (await res.json()) as {
      catalogs: Array<{ catalogUrl: string; signed: boolean; keyIds: string[] }>;
    };
    const mine = out.catalogs.find((c) => c.catalogUrl === url);
    expect(mine?.signed).toBe(true);
    expect(mine?.keyIds).toEqual(['k1']);
  });

  it('signing keys that are not <keyId>:<64 lowercase hex> are refused and nothing is stored', async () => {
    const h = () => asSession(s, true);
    for (const signingKeys of ['abc', 'AB'.repeat(32), `k1:${'zz'.repeat(32)}`]) {
      const res = await send(t, 'POST', '/plugins/catalogs', {
        body: { url, signingKeys },
        headers: h(),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM plugin_catalogs').get()).toEqual({ n: 0 });
  });
});
