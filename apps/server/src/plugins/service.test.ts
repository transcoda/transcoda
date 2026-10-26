// PluginService over the real built host: a local catalog (node:http) serves the Task 6 fixture
// bundles (and edited copies of them), the test app wires the service to a real database.
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fakeHookContext } from '@transcoda/sdk/testing';
import type { PluginManifest } from '@transcoda/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginIsolation } from '../config.ts';
import { findPlugin, findPluginSettings, listCatalogs } from '../db/repos/plugins.ts';
import { tempDir } from '../engine/fixtures.ts';
import { createCoreRegistry } from '../nodes/registry.ts';
import { createTestApp, type TestApp } from '../test-app.ts';
import { chain, edge, mainGraph, node } from '../workflows/test-helpers.ts';
import { OFFICIAL_BLOCKLIST_URL } from './catalog-url.ts';
import { checkPluginBundle } from './check-plugin.ts';
import { BLOCKLIST_INERT_WARNING } from './official-keys.ts';
import { type PluginServiceDeps, PluginServiceError } from './service.ts';
import type { SigningKey } from './signature.ts';
import { type FixtureName, fixturePluginPath, hostPath } from './testing/build.ts';
import { signText } from './testing/sign.ts';

const { readFileSync } = await import('node:fs');

interface Served {
  name: string;
  version: string;
  bundle: string;
  manifest: PluginManifest;
  /** The index's claim (default: the manifest's). */
  indexSdk?: string;
  /** Overrides the sha256 the index promises. */
  sha256?: string;
}

const served = new Map<string, Served>();
let server: Server;
let base = '';
let indexUrl = '';

// A signing key for the signed-catalog tests: `signing.on` makes the index carry bundle
// signatures and the server answer `.sig` requests (`/index.json.sig`, `/custom.json.sig`, `<k>.js.sig`).
const signing: {
  on: boolean;
  noBundleSig: boolean;
  /** The key id the test server names in the signature files it makes. */
  keyId: string;
  privateKey: KeyObject;
  keys: SigningKey[];
  /** `<id>:<hex>`, the format a custom catalog is added with. */
  keySpec: string;
  publicHex: string;
} = (() => {
  const pair = generateKeyPairSync('ed25519');
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  const publicHex = spki.subarray(spki.length - 32).toString('hex');
  return {
    on: false,
    noBundleSig: false,
    keyId: 'k1',
    privateKey: pair.privateKey,
    keys: [{ id: 'k1', publicKey: publicHex }],
    keySpec: `k1:${publicHex}`,
    publicHex,
  };
})();

/** What the test server answers at /blocklist.json (null: 404). */
const blocklistServed: { body: string | null } = { body: null };

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const key = (name: string, version: string): string => `${name}-${version}`;

function index(): string {
  const byName = new Map<string, Served[]>();
  for (const s of served.values()) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  return JSON.stringify({
    schema: 1,
    generated: '2026-10-17T10:00:00.000Z',
    plugins: [...byName].map(([name, versions]) => ({
      name,
      title: name,
      description: `the ${name} plugin`,
      latest: versions.at(-1)?.version,
      versions: versions.map((v) => ({
        version: v.version,
        sdk: v.indexSdk ?? v.manifest.sdk,
        coreTested: ['1.0.0'],
        url: `${base}/${key(v.name, v.version)}.js`,
        manifestUrl: `${base}/${key(v.name, v.version)}.manifest.json`,
        sha256: v.sha256 ?? sha(v.bundle),
        size: Buffer.byteLength(v.bundle),
        attestation: null,
        ...(signing.on && !signing.noBundleSig
          ? { signature: `${base}/${key(v.name, v.version)}.js.sig` }
          : {}),
        releasedAt: '2026-10-17T10:00:00.000Z',
      })),
    })),
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '').slice(1);
    if (path === 'blocklist.json' && blocklistServed.body !== null) {
      res.end(blocklistServed.body);
      return;
    }
    if (path === 'index.json' || path === 'custom.json') {
      res.setHeader('content-type', 'application/json').end(index());
      return;
    }
    if ((path === 'index.json.sig' || path === 'custom.json.sig') && signing.on) {
      res.end(signText(Buffer.from(index()), signing.privateKey, signing.keyId));
      return;
    }
    const match = /^(.+)\.(manifest\.json|js|js\.sig)$/.exec(path);
    const hit = match ? served.get(match[1] ?? '') : undefined;
    if (!hit) {
      res.statusCode = 404;
      res.end('no');
      return;
    }
    if (match?.[2] === 'js.sig' && signing.on) {
      res.end(signText(Buffer.from(hit.bundle), signing.privateKey, signing.keyId));
      return;
    }
    res.end(match?.[2] === 'js' ? hit.bundle : JSON.stringify(hit.manifest));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  indexUrl = `${base}/index.json`;
});
afterAll(() => {
  server.close();
});

const manifests = new Map<FixtureName, PluginManifest>();

/** The bundle's own manifest, read the way the CLI reads it. */
async function manifestOf(fixture: FixtureName): Promise<PluginManifest> {
  const known = manifests.get(fixture);
  if (known) return known;
  const r = await checkPluginBundle(fixturePluginPath(fixture), { hostPath: hostPath() });
  if (!r.ok) throw new Error(r.error);
  const m: PluginManifest = {
    name: r.name,
    version: r.version,
    sdk: r.sdk,
    nodes: r.nodes,
    integration: r.integration,
    triggers: r.triggers,
    hooks: r.hooks,
  };
  manifests.set(fixture, m);
  return m;
}

const text = (fixture: FixtureName): string => readFileSync(fixturePluginPath(fixture), 'utf8');

/** Serves a built fixture as `<name>@<version>`; `edit` may rewrite the bundle text. */
async function serve(
  fixture: FixtureName,
  version = '0.1.0',
  opts: {
    edit?: (code: string) => string;
    manifest?: Partial<PluginManifest>;
    indexSdk?: string;
    sha256?: string;
  } = {},
): Promise<Served> {
  const m = await manifestOf(fixture);
  let bundle = text(fixture);
  // The plugin definition's version, not a node's.
  bundle = bundle.replace(
    `name: "${m.name}",\n\tversion: "0.1.0"`,
    `name: "${m.name}",\n\tversion: "${version}"`,
  );
  if (opts.edit) bundle = opts.edit(bundle);
  const entry: Served = {
    name: m.name,
    version,
    bundle,
    manifest: { ...m, version, ...opts.manifest },
    ...(opts.indexSdk ? { indexSdk: opts.indexSdk } : {}),
    ...(opts.sha256 ? { sha256: opts.sha256 } : {}),
  };
  served.set(key(m.name, version), entry);
  return entry;
}

afterEach(() => {
  served.clear();
  blocklistServed.body = null;
  signing.on = false;
  signing.noBundleSig = false;
  signing.keyId = 'k1';
});

const EMPTY_BLOCKLIST = JSON.stringify({
  schema: 1,
  generated: '2026-10-17T00:00:00.000Z',
  entries: [],
});
let blocklistDir = '';
let blocklists = 0;
beforeAll(() => {
  blocklistDir = mkdtempSync(join(tmpdir(), 'tc-svc-blocklist-'));
});
afterAll(() => {
  rmSync(blocklistDir, { recursive: true, force: true });
});

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function matchingIdentity(iso: PluginIsolation): NonNullable<PluginServiceDeps['identityOf']> {
  return async () => ({
    uid: iso.uid,
    gid: iso.gid,
    capEff: '0000000000000000',
    capPrm: '0000000000000000',
    capAmb: '0000000000000000',
    noNewPrivs: 1,
  });
}

function setup(
  over: {
    db?: TestApp['db'];
    pluginsDir?: string;
    libraryRoots?: () => string[];
    plugins?: {
      devPlugins?: string[];
      identityOf?: PluginServiceDeps['identityOf'];
      fetchAddresses?: PluginServiceDeps['fetchAddresses'];
    };
    isolation?: PluginIsolation | null;
    /** Keys the official catalog is verified with (default: unsigned). */
    catalogKeys?: SigningKey[] | null;
    /** Overrides the blocklist url (default: this app's own local file, empty, in `blocklistFile`). */
    blocklistUrl?: string;
    nodes?: ReturnType<typeof createCoreRegistry>['list'] extends () => infer R ? R : never;
    log?: { info(m: unknown): void; warn(m: unknown): void; error(m: unknown): void };
  } = {},
): TestApp & { events: Array<Record<string, unknown>>; blocklistFile: string } {
  const blocklistFile = join(blocklistDir, `blocklist-${++blocklists}.json`);
  writeFileSync(blocklistFile, EMPTY_BLOCKLIST);
  const app = createTestApp({
    ...(over.db ? { db: over.db } : {}),
    ...(over.plugins || over.isolation
      ? {
          plugins: {
            ...over.plugins,
            // The fake setpriv does not change the uid: report the identity a real one gives.
            ...(over.isolation && !over.plugins?.identityOf
              ? { identityOf: matchingIdentity(over.isolation) }
              : {}),
          },
        }
      : {}),
    ...(over.nodes ? { nodes: over.nodes } : {}),
    ...(over.libraryRoots ? { libraryRoots: over.libraryRoots } : {}),
    log: over.log ?? { info: () => {}, warn: () => {}, error: () => {} },
    config: {
      pluginCatalogUrl: indexUrl,
      ...(over.catalogKeys !== undefined ? { pluginCatalogKeys: over.catalogKeys } : {}),
      pluginBlocklistUrl: over.blocklistUrl ?? pathToFileURL(blocklistFile).href,
      ...(over.isolation !== undefined ? { pluginIsolation: over.isolation } : {}),
      ...(over.pluginsDir ? { pluginsDir: over.pluginsDir } : {}),
    },
  });
  const events: Array<Record<string, unknown>> = [];
  const publish = app.deps.engine.events.publish.bind(app.deps.engine.events);
  vi.spyOn(app.deps.engine.events, 'publish').mockImplementation((e) => {
    events.push(e as unknown as Record<string, unknown>);
    publish(e);
  });
  apps.push(app);
  return Object.assign(app, { events, blocklistFile });
}

/** The service caches the catalog index: look at what the test server serves now. */
const refresh = (app: TestApp) => app.deps.plugins.catalog(true);

const install = async (app: TestApp, name: string, version = '0.1.0') => {
  await refresh(app);
  return app.deps.plugins.install({ name, version, catalogUrl: indexUrl });
};

const update = async (app: TestApp, name: string, version: string) => {
  await refresh(app);
  return app.deps.plugins.update(name, version);
};

async function until(fn: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function files(app: TestApp): Promise<string[]> {
  return (await readdir(app.deps.config.pluginsDir).catch(() => [])).filter(
    (f) => !f.startsWith('.'),
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidOf(app: TestApp, name: string): number {
  const pid = app.deps.plugins.pid(name);
  if (!pid) throw new Error(`${name} has no process`);
  return pid;
}

describe('install', () => {
  it('installs example from the catalog: files written, row enabled, nodes registered, state running, plugins.changed emitted, nodes.list shows source plugin', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    const result = await install(t, 'example');
    if (!result.ok) throw new Error(result.reason);

    expect(result.plugin).toMatchObject({
      name: 'example',
      version: '0.1.0',
      enabled: true,
      state: 'running',
      stateReason: null,
      hasIntegration: false,
      catalogUrl: indexUrl,
      nodes: ['example:extension-is', 'example:note', 'example:fixed-language'],
      provenance: { coreTested: ['1.0.0'], attestation: null },
    });
    expect(await files(t)).toEqual(['example-0.1.0.js', 'example-0.1.0.manifest.json']);
    const row = findPlugin(t.db, 'example');
    expect(row).toMatchObject({ enabled: true, version: '0.1.0', catalogUrl: indexUrl });
    expect(row?.nodes.map((n) => n.type)).toEqual(result.plugin.nodes);
    expect(t.events).toContainEqual({
      type: 'plugins.changed',
      name: 'example',
      state: 'running',
      stateReason: null,
    });
    const listed = t.deps.workflows.listNodes().find((n) => n.type === 'example:note');
    expect(listed).toMatchObject({ source: { kind: 'plugin', name: 'example', version: '0.1.0' } });
    expect(listed?.availability).toEqual({ available: true });
    expect(t.deps.plugins.list().map((p) => [p.name, p.state])).toEqual([['example', 'running']]);
    expect(t.deps.plugins.get('nope')).toBeNull();
  });

  it('refuses: checksum mismatch, sdk ^2, manifest name/version mismatch, crash on start, a bundle with no plugin export — each with the exact reason, no files, no row, no nodes', async () => {
    const t = setup();
    await t.deps.plugins.start();
    const nodesBefore = t.deps.nodes.list().length;
    const clean = async (name: string) => {
      expect(await files(t), name).toEqual([]);
      expect(findPlugin(t.db, name)).toBeNull();
      expect(t.deps.plugins.list()).toEqual([]);
      expect(t.deps.nodes.list()).toHaveLength(nodesBefore);
    };

    await serve('example', '0.1.0', { sha256: 'a'.repeat(64) });
    expect(await install(t, 'example')).toEqual({ ok: false, reason: 'checksum mismatch' });
    await clean('example');

    await serve('example', '0.1.0', { manifest: { sdk: '^2' }, indexSdk: '^1' });
    expect(await install(t, 'example')).toEqual({
      ok: false,
      reason: 'sdk ^2 is not supported by this server (sdk 1.0.0)',
    });
    await serve('example', '0.1.0', { indexSdk: '^2' });
    expect(await install(t, 'example')).toEqual({
      ok: false,
      reason: 'sdk ^2 is not supported by this server (sdk 1.0.0)',
    });
    await clean('example');

    await serve('example', '0.1.0', {
      edit: (c) => c.replace('version: "0.1.0"', 'version: "0.9.0"'),
    });
    expect(await install(t, 'example')).toEqual({
      ok: false,
      reason: 'manifest in bundle says example 0.9.0, catalog says 0.1.0',
    });
    await clean('example');

    await serve('example', '0.1.0', {
      edit: (c) => c.replace('await ctx.log("debug", "example 0.1.0 loaded");', 'process.exit(3);'),
    });
    expect(await install(t, 'example')).toEqual({
      ok: false,
      reason: 'plugin crashed on start: exited with code 3',
    });
    await clean('example');

    // Review focus 1: valid JavaScript without a definePlugin default export.
    served.set('badexport-0.1.0', {
      name: 'badexport',
      version: '0.1.0',
      bundle: text('badexport'),
      manifest: {
        name: 'badexport',
        version: '0.1.0',
        sdk: '^1',
        nodes: [],
        integration: null,
        triggers: [],
        hooks: [],
      },
    });
    expect(await install(t, 'badexport')).toEqual({
      ok: false,
      reason: 'plugin crashed on start: crashed: bundle has no plugin default export',
    });
    await clean('badexport');

    expect(await install(t, 'example', '9.9.9')).toEqual({
      ok: false,
      reason: 'example 9.9.9 is not in that catalog',
    });
    expect(
      await t.deps.plugins.install({
        name: 'example',
        version: '0.1.0',
        catalogUrl: 'https://x.test/i.json',
      }),
    ).toMatchObject({ ok: false });
  });

  it('refuses a bundle whose node type collides with core and rolls back', async () => {
    await serve('example');
    const core = createCoreRegistry().list();
    const stand = core[0];
    if (!stand) throw new Error('no core node');
    const t = setup({
      nodes: [...core, { def: { ...stand.def, type: 'example:note' }, source: { kind: 'core' } }],
    });
    await t.deps.plugins.start();
    const before = t.deps.nodes.list().length;
    expect(await install(t, 'example')).toEqual({
      ok: false,
      reason: 'node type example:note is already provided by core',
    });
    expect(await files(t)).toEqual([]);
    expect(findPlugin(t.db, 'example')).toBeNull();
    expect(t.deps.nodes.list()).toHaveLength(before);
    expect(t.deps.nodes.get('example:note')?.source).toEqual({ kind: 'core' });
    expect(t.deps.plugins.list()).toEqual([]);
  });

  it('refuses a second install of the same name and clears files a crash left behind', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    // A leftover with no row (the process died between the rename and the insert).
    await mkdir(t.deps.config.pluginsDir, { recursive: true });
    await writeFile(join(t.deps.config.pluginsDir, 'example-0.1.0.js'), 'stale');
    expect((await install(t, 'example')).ok).toBe(true);
    expect(await install(t, 'example')).toEqual({
      ok: false,
      reason: 'plugin example is already installed',
    });
  });
});

describe('start, restart and shutdown', () => {
  it('stop() finishes the operation in flight, then install, update and the rest refuse; the processes are gone', async () => {
    await serve('example');
    await serve('secrets');
    const t = setup();
    await t.deps.plugins.start();
    await refresh(t);
    const installing = t.deps.plugins.install({
      name: 'example',
      version: '0.1.0',
      catalogUrl: indexUrl,
    });
    await new Promise((r) => setTimeout(r, 5));
    const stopping = t.deps.plugins.stop();
    // Queued behind the install, and after the stop began.
    const late = t.deps.plugins.install({
      name: 'secrets',
      version: '0.1.0',
      catalogUrl: indexUrl,
    });
    expect((await installing).ok).toBe(true);
    await stopping;
    expect(await late).toEqual({ ok: false, reason: 'the server is shutting down' });
    expect(await t.deps.plugins.update('example', '0.2.0')).toEqual({
      ok: false,
      reason: 'the server is shutting down',
    });
    await expect(t.deps.plugins.disable('example')).rejects.toMatchObject({ code: 'invalid' });
    await expect(t.deps.plugins.saveSettings('example', {})).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(findPlugin(t.db, 'secrets')).toBeNull();
    expect(t.deps.plugins.pid('example')).toBeNull();
  });

  it('restart on boot: a second service over the same db and dir starts the plugin again; a bundle whose sha256 changed on disk is stopped with "bundle changed on disk; reinstall"', async () => {
    await serve('example');
    const first = setup();
    await first.deps.plugins.start();
    expect((await install(first, 'example')).ok).toBe(true);
    await first.deps.plugins.stop();

    const second = setup({ db: first.db, pluginsDir: first.deps.config.pluginsDir });
    await second.deps.plugins.start();
    expect(second.deps.plugins.get('example')).toMatchObject({ state: 'running', enabled: true });
    expect(second.deps.nodes.get('example:note')?.unavailable?.()).toBeNull();
    await second.deps.plugins.stop();

    const tampered = join(first.deps.config.pluginsDir, 'example-0.1.0.js');
    await writeFile(tampered, `${text('example')}\n// changed`);
    const third = setup({ db: first.db, pluginsDir: first.deps.config.pluginsDir });
    await third.deps.plugins.start();
    expect(third.deps.plugins.get('example')).toMatchObject({
      state: 'stopped',
      stateReason: 'bundle changed on disk; reinstall',
      enabled: true,
    });
    // Its nodes stay known, and say why they cannot run.
    expect(third.deps.nodes.get('example:note')?.unavailable?.()).toBe(
      'plugin example is not running: bundle changed on disk; reinstall',
    );
    // A restart re-checks the file too.
    await expect(third.deps.plugins.restart('example')).resolves.toMatchObject({
      state: 'stopped',
    });
  });

  it('crash-loop guard: a plugin started by three boots that never got past the stable mark is disabled on the next boot, with the reason', async () => {
    await serve('example');
    const first = setup();
    await first.deps.plugins.start();
    expect((await install(first, 'example')).ok).toBe(true);
    await first.deps.plugins.stop();
    // Three boots that each die (no stop(), nothing reaches the stable mark) while it runs.
    for (let i = 0; i < 3; i += 1) {
      const boot = setup({ db: first.db, pluginsDir: first.deps.config.pluginsDir });
      await boot.deps.plugins.start();
      expect(boot.deps.plugins.get('example')).toMatchObject({ state: 'running' });
    }
    const guarded = setup({ db: first.db, pluginsDir: first.deps.config.pluginsDir });
    await guarded.deps.plugins.start();
    expect(guarded.deps.plugins.get('example')).toMatchObject({
      state: 'disabled',
      enabled: false,
      stateReason:
        'disabled: the server stopped unexpectedly 3 times in a row while this plugin was starting or running; enable it to try again',
    });
    expect(findPlugin(first.db, 'example')?.enabled).toBe(false);
    // Enabling is the explicit retry: it runs again, and the count starts over.
    await expect(guarded.deps.plugins.enable('example')).resolves.toMatchObject({
      state: 'running',
    });
    const after = setup({ db: first.db, pluginsDir: first.deps.config.pluginsDir });
    await after.deps.plugins.start();
    expect(after.deps.plugins.get('example')).toMatchObject({ state: 'running' });
  });

  it('crash-loop guard: a clean shutdown resets the count', async () => {
    await serve('example');
    const first = setup();
    await first.deps.plugins.start();
    expect((await install(first, 'example')).ok).toBe(true);
    await first.deps.plugins.stop();
    for (let i = 0; i < 4; i += 1) {
      const boot = setup({ db: first.db, pluginsDir: first.deps.config.pluginsDir });
      await boot.deps.plugins.start();
      expect(boot.deps.plugins.get('example')).toMatchObject({ state: 'running' });
      await boot.deps.plugins.stop();
    }
  });

  it('a stored plugin whose node type core now provides is stopped with that reason, its other nodes unavailable', async () => {
    await serve('example');
    const first = setup();
    await first.deps.plugins.start();
    await install(first, 'example');
    await first.deps.plugins.stop();

    const core = createCoreRegistry().list();
    const stand = core[0];
    if (!stand) throw new Error('no core node');
    const errors: unknown[] = [];
    const second = setup({
      db: first.db,
      pluginsDir: first.deps.config.pluginsDir,
      nodes: [...core, { def: { ...stand.def, type: 'example:note' }, source: { kind: 'core' } }],
      log: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
    });
    await second.deps.plugins.start();
    expect(second.deps.plugins.get('example')).toMatchObject({
      state: 'stopped',
      stateReason:
        'its nodes cannot be registered: node type example:note is already provided by core',
    });
    expect(errors).toContainEqual(
      expect.objectContaining({ msg: 'plugin stopped', plugin: 'example' }),
    );
    expect(second.deps.nodes.get('example:note')?.source).toEqual({ kind: 'core' });
  });

  it('disable → nodes PLUGIN_UNAVAILABLE ("plugin example is disabled"), enable → running again', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    const pid = pidOf(t, 'example');
    const disabled = await t.deps.plugins.disable('example');
    expect(disabled).toMatchObject({ enabled: false, state: 'disabled' });
    expect(findPlugin(t.db, 'example')?.enabled).toBe(false);
    expect(alive(pid)).toBe(false);
    expect(t.deps.nodes.get('example:note')?.unavailable?.()).toBe('plugin example is disabled');
    expect(
      t.deps.workflows.listNodes().find((n) => n.type === 'example:note')?.availability,
    ).toEqual({
      available: false,
      reason: 'plugin example is disabled',
    });
    const enabled = await t.deps.plugins.enable('example');
    expect(enabled).toMatchObject({ enabled: true, state: 'running' });
    expect(findPlugin(t.db, 'example')?.enabled).toBe(true);
    expect(t.deps.nodes.get('example:note')?.unavailable?.()).toBeNull();
    const restarted = await t.deps.plugins.restart('example');
    expect(restarted.state).toBe('running');
  });

  it('a disabled plugin stays disabled across a restart of the server', async () => {
    await serve('example');
    const first = setup();
    await first.deps.plugins.start();
    await install(first, 'example');
    await first.deps.plugins.disable('example');
    await first.deps.plugins.stop();
    const second = setup({ db: first.db, pluginsDir: first.deps.config.pluginsDir });
    await second.deps.plugins.start();
    expect(second.deps.plugins.get('example')).toMatchObject({ state: 'disabled', enabled: false });
  });

  it('stop() kills every plugin process (no pid alive afterwards)', async () => {
    await serve('example');
    await serve('secrets');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    await install(t, 'secrets');
    const pids = [pidOf(t, 'example'), pidOf(t, 'secrets')];
    expect(pids.every(alive)).toBe(true);
    await t.deps.plugins.stop();
    expect(pids.some(alive)).toBe(false);
  });

  it('start() logs one summary line and makes the plugins directory', async () => {
    const info: unknown[] = [];
    const t = setup({ log: { info: (m) => info.push(m), warn: () => {}, error: () => {} } });
    await t.deps.plugins.start();
    expect(info).toContain('plugins: 0 installed, 0 running, 0 stopped, 0 restarting, 0 disabled');
    expect(await readdir(t.deps.config.pluginsDir)).toEqual([]);
  });
});

describe('test app', () => {
  it('close() stops the plugins and removes the plugins directory it made', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    const dir = t.deps.config.pluginsDir;
    expect((await readdir(dir)).length).toBeGreaterThan(0);
    await t.close();
    await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(t.deps.plugins.pid('example')).toBeNull();
  });
});

describe('workflows that use a plugin', () => {
  it('[activation] usage() lists a workflow whose active version uses the node with active: true; after disable the workflow is active and not runnable, a real jobs.queue is WORKFLOW_INVALID, remove() still succeeds and the node is UNKNOWN_NODE_TYPE', async () => {
    await serve('example');
    const dir = await tempDir('plugin-usage-');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    expect(t.deps.plugins.usage('example')).toEqual([]);

    const graph = chain(
      'workflow',
      node('in', 'core:input-manual'),
      node('ro', 'core:replace-original'),
      node('pn', 'example:note', {}),
    );
    const wf = t.deps.workflows.create({ name: 'Notes', kind: 'workflow', graph }, 'u');
    const detail = t.deps.workflows.get(wf.id);
    expect(detail?.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(t.deps.plugins.usage('example')).toEqual([{ id: wf.id, name: 'Notes', active: false }]);
    expect(t.deps.workflows.activate(wf.id, 1, 'u').kind).toBe('ok');
    expect(t.deps.plugins.usage('example')).toEqual([{ id: wf.id, name: 'Notes', active: true }]);
    expect(t.deps.plugins.get('example')?.usedBy).toEqual([
      { id: wf.id, name: 'Notes', active: true },
    ]);

    const root = join(dir, 'lib');
    await mkdir(root, { recursive: true });
    const file = join(root, 'a.mkv');
    await writeFile(file, 'x');
    const old = new Date(Date.now() - 3_600_000);
    await utimes(file, old, old);
    const lib = await t.deps.engine.queue.createLibrary({
      name: 'TV',
      path: root,
    });
    if (!('id' in lib)) throw new Error('library not created');
    const queueReal = () =>
      t.deps.engine.queue.queue({
        path: file,
        workflowId: wf.id,
        dryRun: false,
        force: true,
        priority: 0,
        createdBy: 'u',
      });
    expect((await queueReal()).kind).toBe('queued');

    await t.deps.plugins.disable('example');
    const summary = t.deps.workflows.list().find((w) => w.id === wf.id);
    expect(summary?.active).toMatchObject({ version: 1, runnable: false });
    expect(t.deps.workflows.get(wf.id)?.activeIssues).toEqual([
      expect.objectContaining({ code: 'PLUGIN_UNAVAILABLE', nodeId: 'pn' }),
    ]);
    const refused = await queueReal();
    expect(refused).toMatchObject({ kind: 'workflow-invalid' });
    expect(refused.kind === 'workflow-invalid' && refused.issues.map((i) => i.code)).toContain(
      'PLUGIN_UNAVAILABLE',
    );
    expect(
      refused.kind === 'workflow-invalid' && refused.issues.map((i) => i.message).join(' '),
    ).toContain('plugin example is disabled');
    // The workflow is still listed as using the plugin.
    expect(t.deps.plugins.usage('example')).toEqual([{ id: wf.id, name: 'Notes', active: true }]);

    await t.deps.plugins.remove('example');
    // A removal is announced as disabled/removed (the state enum has no `removed`).
    expect(t.events.at(-1)).toEqual({
      type: 'plugins.changed',
      name: 'example',
      state: 'disabled',
      stateReason: 'removed',
    });
    expect(t.deps.plugins.get('example')).toBeNull();
    expect(await files(t)).toEqual([]);
    expect(t.deps.nodes.get('example:note')).toBeUndefined();
    const loaded = t.deps.workflows.loadForRun(wf.id, 1);
    expect(loaded.kind).toBe('invalid');
    expect(loaded.kind === 'invalid' && loaded.issues.map((i) => i.code)).toContain(
      'UNKNOWN_NODE_TYPE',
    );
    expect(await queueReal()).toMatchObject({ kind: 'workflow-invalid' });
    await rm(dir, { recursive: true, force: true });
  });

  it('usage() is [] before start() and never throws', async () => {
    const t = setup();
    expect(t.deps.plugins.usage('example')).toEqual([]);
    expect(t.deps.plugins.usage('nope')).toEqual([]);
    expect(t.deps.plugins.list()).toEqual([]);
    expect(t.deps.plugins.missing()).toEqual([]);
  });
});

describe('what the Plugins page shows', () => {
  const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="4"/></svg>';

  it('list() carries the manifest icon, the workflows using the plugin and the last test without its message', async () => {
    await serve('example', '0.1.0', { manifest: { icon: ICON } });
    await serve('secrets');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    await install(t, 'secrets');
    const graph = chain(
      'workflow',
      node('in', 'core:input-manual'),
      node('ro', 'core:replace-original'),
      node('pn', 'example:note', {}),
    );
    const wf = t.deps.workflows.create({ name: 'Notes', kind: 'workflow', graph }, 'u');
    const byName = () => new Map(t.deps.plugins.list().map((p) => [p.name, p]));
    expect(byName().get('example')).toMatchObject({
      icon: ICON,
      usedBy: [{ id: wf.id, name: 'Notes', active: false }],
      lastTest: null,
    });
    expect(byName().get('secrets')).toMatchObject({ icon: null, usedBy: [], lastTest: null });

    await t.deps.plugins.saveSettings('secrets', { apiKey: 'A-KEY-THAT-IS-LONG-1' });
    await t.deps.plugins.testSettings('secrets', { apiKey: { set: true } });
    const tested = byName().get('secrets')?.lastTest;
    expect(tested).toEqual({ at: expect.any(String), ok: true, kind: null });
    await t.deps.plugins.testSettings('secrets', { apiKey: '' });
    expect(byName().get('secrets')?.lastTest).toMatchObject({ ok: false, kind: 'other' });
    expect(JSON.stringify(t.deps.plugins.list())).not.toContain('A-KEY-THAT-IS-LONG-1');
  });

  it('missing() names the plugins whose nodes workflows use but that are not installed, with those workflows', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    const uses = (name: string, ...types: string[]) =>
      t.deps.workflows.create(
        {
          name,
          kind: 'workflow',
          graph: chain(
            'workflow',
            node('in', 'core:input-manual'),
            ...types.map((type, i) => node(`n${i}`, type, {})),
          ),
        },
        'u',
      );
    const tv = uses('TV cleanup', 'sonarr:original-language', 'jellyfin:refresh');
    const movies = uses('Movies', 'jellyfin:refresh', 'example:note');
    uses('Plain', 'core:replace-original');
    // A node type whose prefix is no plugin name names nothing to install (and would break the list).
    uses('Odd', '0x:y', '-a:b', `${'a'.repeat(41)}:c`);
    expect(t.deps.plugins.missing()).toEqual([
      { name: 'example', workflows: [{ id: movies.id, name: 'Movies' }] },
      {
        name: 'jellyfin',
        workflows: [
          { id: movies.id, name: 'Movies' },
          { id: tv.id, name: 'TV cleanup' },
        ],
      },
      { name: 'sonarr', workflows: [{ id: tv.id, name: 'TV cleanup' }] },
    ]);
    await install(t, 'example');
    expect(t.deps.plugins.missing().map((m) => m.name)).toEqual(['jellyfin', 'sonarr']);
    // The list answers both from one pass over the workflows.
    expect(t.deps.plugins.listing()).toEqual({
      plugins: t.deps.plugins.list(),
      missing: t.deps.plugins.missing(),
    });
    expect(t.deps.plugins.listing().plugins[0]?.usedBy).toEqual([
      { id: movies.id, name: 'Movies', active: false },
    ]);
  });

  it("a custom catalog's manifests are fetched only on an explicit refresh; the official one's as it is read", async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    t.deps.plugins.addCatalog(`${base}/custom.json`);
    const nodesBy = (out: Awaited<ReturnType<typeof t.deps.plugins.catalog>>) =>
      out.catalogs.map((c) => [c.official, c.plugins[0]?.nodes.length ?? 0]);
    expect(nodesBy(await t.deps.plugins.catalog(false))).toEqual([
      [true, 3],
      [false, 0],
    ]);
    expect(nodesBy(await t.deps.plugins.catalog(true))).toEqual([
      [true, 3],
      [false, 3],
    ]);
    // Kept while the catalog lists the build, and dropped with the catalog.
    expect(nodesBy(await t.deps.plugins.catalog(false))).toEqual([
      [true, 3],
      [false, 3],
    ]);
    t.deps.plugins.removeCatalog(`${base}/custom.json`);
    expect((await t.deps.plugins.catalog(false)).catalogs).toHaveLength(1);
    t.deps.plugins.addCatalog(`${base}/custom.json`);
    expect(nodesBy(await t.deps.plugins.catalog(false))).toEqual([
      [true, 3],
      [false, 0],
    ]);
  });

  it("catalog entries carry the latest version's icon and nodes from its manifest; kind and title come from the manifest, else from the installed plugin, else are null", async () => {
    await serve('example', '0.1.0');
    await serve('secrets', '0.1.0', {
      manifest: {
        icon: ICON,
        nodes: ['secrets:peek'],
        nodeInfo: [{ type: 'secrets:peek', kind: 'data', title: 'Peek' }],
      },
    });
    const t = setup();
    await t.deps.plugins.start();
    const entries = async () =>
      new Map((await t.deps.plugins.catalog(true)).catalogs[0]?.plugins.map((p) => [p.name, p]));
    const before = await entries();
    expect(before.get('secrets')).toMatchObject({
      icon: ICON,
      nodes: [{ type: 'secrets:peek', kind: 'data', title: 'Peek' }],
    });
    expect(before.get('example')).toMatchObject({
      icon: null,
      nodes: [
        { type: 'example:extension-is', kind: null, title: null },
        { type: 'example:note', kind: null, title: null },
        { type: 'example:fixed-language', kind: null, title: null },
      ],
    });
    await install(t, 'example');
    expect((await entries()).get('example')?.nodes).toEqual([
      { type: 'example:extension-is', kind: 'condition', title: 'Extension is' },
      { type: 'example:note', kind: 'finish', title: 'Note' },
      { type: 'example:fixed-language', kind: 'data', title: 'Fixed language' },
    ]);
  });

  it('a catalog entry whose manifest cannot be read has no icon and no nodes, and the catalog still answers', async () => {
    // A manifest for another plugin is refused, as the installer refuses it.
    await serve('example', '0.1.0', { manifest: { name: 'other', icon: ICON } });
    const t = setup();
    await t.deps.plugins.start();
    const out = await t.deps.plugins.catalog(true);
    expect(out.catalogs[0]?.error).toBeNull();
    expect(out.catalogs[0]?.plugins[0]).toMatchObject({ name: 'example', icon: null, nodes: [] });
  });
});

describe('settings', () => {
  const KEY = 'S3CRET-API-KEY-1';

  async function withSecrets() {
    await serve('secrets');
    const t = setup();
    await t.deps.plugins.start();
    const r = await install(t, 'secrets');
    if (!r.ok) throw new Error(r.reason);
    return t;
  }

  const encOf = (t: TestApp): string =>
    ((findPluginSettings(t.db, 'secrets')?.settings ?? {}) as { apiKey?: { $enc: string } }).apiKey
      ?.$enc ?? '';

  const storedJson = (t: TestApp): string =>
    JSON.stringify(findPluginSettings(t.db, 'secrets')?.settings ?? null);

  it('a token-like stored secret of 20 characters or more is shown by its last four; a shorter one or a passphrase only as set', async () => {
    const t = await withSecrets();
    await t.deps.plugins.saveSettings('secrets', { apiKey: 'abcdef0123456789f2a4' });
    expect(t.deps.plugins.getSettings('secrets').settings).toEqual({
      apiKey: { set: true, endsWith: 'f2a4' },
    });
    await t.deps.plugins.saveSettings('secrets', { apiKey: 'SHORT-KEY-1234567xy' });
    expect(t.deps.plugins.getSettings('secrets').settings).toEqual({ apiKey: { set: true } });
    await t.deps.plugins.saveSettings('secrets', { apiKey: 'correct horse battery staple' });
    expect(t.deps.plugins.getSettings('secrets').settings).toEqual({ apiKey: { set: true } });
    expect(JSON.stringify(t.deps.plugins.getSettings('secrets'))).not.toContain('aple');
    expect(JSON.stringify(t.deps.plugins.getSettings('secrets'))).not.toContain('SHORT');
  });

  it('save encrypts secrets (the row never contains the plaintext), get masks them as { set: true }, a save with { set: true } keeps the old value', async () => {
    const t = await withSecrets();
    expect(t.deps.plugins.getSettings('secrets')).toEqual({
      settings: {},
      lastTest: null,
      needsReview: null,
    });
    const saved = await t.deps.plugins.saveSettings('secrets', { apiKey: KEY });
    expect(saved).toEqual({
      settings: { apiKey: { set: true } },
      lastTest: null,
      needsReview: null,
    });

    const raw = storedJson(t);
    expect(raw).not.toContain(KEY);
    const stored = findPluginSettings(t.db, 'secrets')?.settings as { apiKey: { $enc: string } };
    expect(typeof stored.apiKey.$enc).toBe('string');
    // No row in the whole database carries the plaintext.
    const dump = JSON.stringify(t.db.prepare('SELECT * FROM plugin_settings').all());
    expect(dump).not.toContain(KEY);
    // Nothing the service answers carries it either.
    expect(JSON.stringify(t.deps.plugins.get('secrets'))).not.toContain(KEY);
    expect(JSON.stringify(t.deps.plugins.list())).not.toContain(KEY);

    const before = stored.apiKey.$enc;
    await t.deps.plugins.saveSettings('secrets', { apiKey: { set: true } });
    expect(encOf(t)).toBe(before);
    await t.deps.plugins.saveSettings('secrets', {});
    expect(encOf(t)).toBe(before);
    // A new value replaces it.
    await t.deps.plugins.saveSettings('secrets', { apiKey: 'ANOTHER-KEY-22' });
    expect(encOf(t)).not.toBe(before);
  });

  it("an invalid save is refused with the plugin's own issues and stores nothing", async () => {
    const t = await withSecrets();
    const err = (await t.deps.plugins
      .saveSettings('secrets', { apiKey: '' })
      .catch((e: unknown) => e)) as PluginServiceError;
    expect(err).toBeInstanceOf(PluginServiceError);
    expect(err.code).toBe('settings-invalid');
    expect(err.issues).toEqual([expect.objectContaining({ path: 'apiKey' })]);
    expect(findPluginSettings(t.db, 'secrets')).toBeNull();
    const notObject = (await t.deps.plugins
      .saveSettings('secrets', 'x')
      .catch((e: unknown) => e)) as PluginServiceError;
    expect(notObject.code).toBe('settings-invalid');
    const encrypted = (await t.deps.plugins
      .saveSettings('secrets', { apiKey: { $enc: 'AAAA' } })
      .catch((e: unknown) => e)) as PluginServiceError;
    expect(encrypted.code).toBe('settings-invalid');
    expect(findPluginSettings(t.db, 'secrets')).toBeNull();
  });

  it('test() runs on unsaved values and persists nothing but lastTest; the plugin process received the opened settings (its answer references them redacted)', async () => {
    const t = await withSecrets();
    // Nothing saved yet: the test runs on the form's values, and there is no row to note it on.
    const first = await t.deps.plugins.testSettings('secrets', { apiKey: 'UNSAVED-KEY-77' });
    expect(first).toEqual({ ok: true, message: 'key is [redacted]' });
    expect(findPluginSettings(t.db, 'secrets')).toBeNull();

    await t.deps.plugins.saveSettings('secrets', { apiKey: KEY });
    const rowBefore = storedJson(t);
    const viaStored = await t.deps.plugins.testSettings('secrets', { apiKey: { set: true } });
    expect(viaStored).toEqual({ ok: true, message: 'key is [redacted]' });
    const candidate = await t.deps.plugins.testSettings('secrets', { apiKey: 'CANDIDATE-KEY-9' });
    expect(candidate).toEqual({ ok: true, message: 'key is [redacted]' });
    expect(storedJson(t)).toBe(rowBefore);
    const row = findPluginSettings(t.db, 'secrets');
    expect(row?.lastTest).toMatchObject({ ok: true, message: 'key is [redacted]' });
    const got = t.deps.plugins.getSettings('secrets');
    expect(got.lastTest).toMatchObject({ result: { ok: true, message: 'key is [redacted]' } });
    const everything = JSON.stringify([first, viaStored, candidate, row, got]);
    for (const secret of [KEY, 'UNSAVED-KEY-77', 'CANDIDATE-KEY-9']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('a failing test() is stored without a secret in its message', async () => {
    const t = await withSecrets();
    await t.deps.plugins.saveSettings('secrets', { apiKey: KEY });
    // The plugin's schema refuses an empty key: the host's complaint is the message.
    const out = await t.deps.plugins.testSettings('secrets', { apiKey: '' });
    expect(out).toMatchObject({ ok: false, kind: 'other' });
    const saved = findPluginSettings(t.db, 'secrets')?.lastTest;
    expect(saved).toMatchObject({ ok: false, kind: 'other' });
    expect(JSON.stringify(saved)).not.toContain(KEY);
  });

  it('settings of a plugin without an integration, and of a stopped plugin, answer with errors', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    expect(() => t.deps.plugins.getSettings('example')).toThrow(/has no settings/);
    expect(() => t.deps.plugins.getSettings('ghost')).toThrow(/not installed/);

    await serve('secrets');
    await install(t, 'secrets');
    await t.deps.plugins.disable('secrets');
    await expect(
      t.deps.plugins.testSettings('secrets', { apiKey: 'x-key-1' }),
    ).rejects.toMatchObject({
      code: 'not-running',
    });
    // A save still works while it is down, validated against the stored schema.
    await expect(t.deps.plugins.saveSettings('secrets', { apiKey: '' })).rejects.toMatchObject({
      code: 'settings-invalid',
    });
    await t.deps.plugins.saveSettings('secrets', { apiKey: KEY });
    expect(storedJson(t)).not.toContain(KEY);
  });

  it('Review focus 5: settings needsReview when the stored shape no longer parses after an update; the old encrypted value stays, get still answers, the process keeps running', async () => {
    await serve('secrets');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'secrets');
    await t.deps.plugins.saveSettings('secrets', { apiKey: KEY });
    const stored = storedJson(t);

    // 0.2.0 renames the field.
    await serve('secrets', '0.2.0', { edit: (c) => c.replaceAll('apiKey', 'token') });
    const updated = await update(t, 'secrets', '0.2.0');
    if (!updated.ok) throw new Error(updated.reason);
    expect(updated.plugin).toMatchObject({ version: '0.2.0', state: 'running' });

    const got = t.deps.plugins.getSettings('secrets');
    expect(got.settings).toEqual({ apiKey: { set: true } });
    expect(got.needsReview).toMatch(/needs review: token:/);
    expect(JSON.stringify(got)).not.toContain(KEY);
    expect(storedJson(t)).toBe(stored);

    // Saving the new shape replaces it and clears the review.
    const saved = await t.deps.plugins.saveSettings('secrets', { token: 'NEW-TOKEN-55' });
    expect(saved).toMatchObject({ settings: { token: { set: true } }, needsReview: null });
    expect(storedJson(t)).not.toContain('NEW-TOKEN-55');
    expect(await t.deps.plugins.testSettings('secrets', { token: { set: true } })).toMatchObject({
      ok: true,
      message: 'key is [redacted]',
    });
  });

  it('settings that cannot be decrypted (the secret key changed) say so and start the plugin without them', async () => {
    const t = await withSecrets();
    await t.deps.plugins.saveSettings('secrets', { apiKey: KEY });
    await t.deps.plugins.stop();
    const warn: unknown[] = [];
    const other = setup({
      db: t.db,
      pluginsDir: t.deps.config.pluginsDir,
      log: { info: () => {}, warn: (m) => warn.push(m), error: () => {} },
    });
    // The stored value no longer opens (a different secret key, or a damaged row).
    t.db
      .prepare('UPDATE plugin_settings SET settings_json = ? WHERE plugin_name = ?')
      .run(
        JSON.stringify({ apiKey: { $enc: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }),
        'secrets',
      );
    await other.deps.plugins.start();
    expect(other.deps.plugins.get('secrets')?.state).toBe('running');
    expect(other.deps.plugins.getSettings('secrets').needsReview).toBe(
      'cannot decrypt secrets.apiKey',
    );
    expect(JSON.stringify(warn)).not.toContain(KEY);
  });

  it('testMapping: local must exist, be a directory and lie under a library root', async () => {
    await serve('example');
    const dir = await tempDir('plugin-map-');
    await mkdir(join(dir, 'lib', 'tv'), { recursive: true });
    await writeFile(join(dir, 'lib', 'file.txt'), 'x');
    const t = setup({ libraryRoots: () => [join(dir, 'lib')] });
    await t.deps.plugins.start();
    await install(t, 'example');
    const map = (local: string) => t.deps.plugins.testMapping('example', { remote: '/tv', local });
    expect(map(join(dir, 'lib', 'tv'))).toMatchObject({ ok: true });
    expect(map(join(dir, 'lib'))).toMatchObject({ ok: true });
    expect(map(join(dir, 'lib', 'nope'))).toEqual({
      ok: false,
      message: `${join(dir, 'lib', 'nope')} does not exist`,
    });
    expect(map(join(dir, 'lib', 'file.txt'))).toMatchObject({
      ok: false,
      message: expect.stringContaining('not a directory'),
    });
    expect(map(dir)).toMatchObject({
      ok: false,
      message: expect.stringContaining('not inside any library'),
    });
    // A look-alike sibling of the root is outside it.
    await mkdir(join(dir, 'lib2'), { recursive: true });
    expect(map(join(dir, 'lib2'))).toMatchObject({ ok: false });
    expect(() => t.deps.plugins.testMapping('ghost', { remote: '/a', local: '/b' })).toThrow(
      /not installed/,
    );
    await rm(dir, { recursive: true, force: true });
  });
});

describe('secrets in plugin fetches', () => {
  it('the stored key reaches the service for a node call and the form key for test(); the plugin never held either, and no log or answer carries them', async () => {
    const seen: Array<{ url: string; key: string | undefined }> = [];
    const target = createServer((req, res) => {
      seen.push({ url: req.url ?? '', key: req.headers['x-api-key'] as string | undefined });
      res.setHeader('content-type', 'application/json').end('{"ok":true}');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    try {
      await serve('fetcher', '0.1.0', {
        // The fixture allows no origin of its own: let it use the configured url.
        edit: (c) => c.replace('\tallowedOrigins: [],', '\tallowedOrigins: ["$settings.url"],'),
      });
      const lines: unknown[] = [];
      const t = setup({
        // The target listens on loopback, which the proxy refuses: stand it in for a LAN service.
        plugins: { fetchAddresses: { classify: () => 'private' } },
        log: {
          info: (m) => lines.push(m),
          warn: (m) => lines.push(m),
          error: (m) => lines.push(m),
        },
      });
      await t.deps.plugins.start();
      const installed = await install(t, 'fetcher');
      if (!installed.ok) throw new Error(installed.reason);

      const saved = await t.deps.plugins.saveSettings('fetcher', {
        apiKey: 'STORED-KEY-424242',
        url: origin,
      });
      expect(saved.settings).toEqual({ apiKey: { set: true }, url: origin });
      const get = t.deps.nodes.get('fetcher:get')?.def.data;
      if (!get) throw new Error('no data hook');
      const answer = await get(
        { ...fakeHookContext() } as never,
        { url: `${origin}/items`, waitMs: 1 } as never,
      );
      expect(answer).toMatchObject({ value: { status: 200 } });
      expect(seen).toEqual([{ url: '/items', key: 'STORED-KEY-424242' }]);

      // test(): the unsaved form's key, and its url's origin, for this call only.
      seen.length = 0;
      const tested = await t.deps.plugins.testSettings('fetcher', {
        apiKey: 'FORM-KEY-737373',
        url: origin,
      });
      expect(tested).toEqual({ ok: true, message: 'status 200' });
      expect(seen).toEqual([{ url: '/slow', key: 'FORM-KEY-737373' }]);
      // Nothing was saved by the test.
      const row = JSON.stringify(findPluginSettings(t.db, 'fetcher'));
      expect(row).not.toContain('FORM-KEY-737373');
      expect(row).not.toContain('STORED-KEY-424242');
      expect(JSON.stringify([lines, t.events, answer, tested])).not.toMatch(/STORED-KEY|FORM-KEY/);

      // A stored-key test after a candidate one still uses the stored key.
      seen.length = 0;
      await t.deps.plugins.testSettings('fetcher', { apiKey: { set: true }, url: origin });
      expect(seen).toEqual([{ url: '/slow', key: 'STORED-KEY-424242' }]);
    } finally {
      target.close();
    }
  });
});

describe('live limits', () => {
  it('applyLimits changes the timeout of the next plugin call, without a restart', async () => {
    const t = setup({ plugins: { devPlugins: [fixturePluginPath('spin')] } });
    await t.deps.plugins.start();
    const data = t.deps.nodes.get('spin:spin')?.def.data;
    if (!data) throw new Error('no data hook');
    t.deps.plugins.applyLimits({ callTimeoutMs: 400 });
    const started = Date.now();
    const err = await data({ ...fakeHookContext() } as never, {} as never).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: 'plugin spin timed out after 0.4 s' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('cancelling a plugin call', () => {
  it('a run whose job is already stopped is refused as cancelled, not retryable, and never reaches the plugin', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    const run = t.deps.nodes.get('example:note')?.def.run;
    if (!run) throw new Error('no run hook');
    const ctl = new AbortController();
    ctl.abort();
    const err = await run(
      { ...fakeHookContext(), signal: ctl.signal } as never,
      { text: 'x' } as never,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      message: 'call to plugin example was cancelled',
      retryable: false,
    });
    // A live signal runs the call.
    const live = await run(
      {
        ...fakeHookContext(),
        originalPath: '/m/a.mkv',
        newPath: '/m/a.mkv',
        signal: new AbortController().signal,
      } as never,
      { text: 'x' } as never,
    );
    expect(live).toEqual({ ok: true, message: 'noted /m/a.mkv' });
  });
});

describe('update', () => {
  it('a newer version takes over: new process, nodes re-registered, row updated, old files removed, plugins.changed emitted', async () => {
    await serve('example');
    await serve('example', '0.2.0');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    const oldPid = pidOf(t, 'example');
    t.events.length = 0;

    const r = await update(t, 'example', '0.2.0');
    if (!r.ok) throw new Error(r.reason);
    expect(r.plugin).toMatchObject({ version: '0.2.0', state: 'running' });
    expect(pidOf(t, 'example')).not.toBe(oldPid);
    await until(() => !alive(oldPid));
    expect(await files(t)).toEqual(['example-0.2.0.js', 'example-0.2.0.manifest.json']);
    expect(findPlugin(t.db, 'example')).toMatchObject({ version: '0.2.0' });
    expect(t.deps.nodes.get('example:note')?.source).toEqual({
      kind: 'plugin',
      name: 'example',
      version: '0.2.0',
    });
    expect(t.events.at(-1)).toEqual({
      type: 'plugins.changed',
      name: 'example',
      state: 'running',
      stateReason: null,
    });
    // The supervisor never showed a second name: only `example`.
    expect(t.deps.plugins.list().map((p) => p.name)).toEqual(['example']);
    expect(await update(t, 'example', '0.2.0')).toEqual({
      ok: false,
      reason: 'example 0.2.0 is already installed',
    });
  });

  it('the old process keeps running until the new one is ready; a failing new version leaves the old installed and running', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    const oldPid = pidOf(t, 'example');

    // 0.2.0 whose bundle still says 0.1.0.
    await serve('example', '0.2.0', {
      edit: (c) => c.replace('version: "0.2.0"', 'version: "0.1.0"'),
    });
    expect(await update(t, 'example', '0.2.0')).toEqual({
      ok: false,
      reason: 'manifest in bundle says example 0.1.0, catalog says 0.2.0',
    });
    // 0.3.0 that dies in setup.
    await serve('example', '0.3.0', {
      edit: (c) => c.replace('await ctx.log("debug", "example 0.1.0 loaded");', 'process.exit(4);'),
    });
    expect(await update(t, 'example', '0.3.0')).toEqual({
      ok: false,
      reason: 'plugin crashed on start: exited with code 4',
    });
    // A bad checksum.
    await serve('example', '0.4.0', { sha256: 'b'.repeat(64) });
    expect(await update(t, 'example', '0.4.0')).toEqual({ ok: false, reason: 'checksum mismatch' });

    expect(pidOf(t, 'example')).toBe(oldPid);
    expect(alive(oldPid)).toBe(true);
    expect(await files(t)).toEqual(['example-0.1.0.js', 'example-0.1.0.manifest.json']);
    expect(t.deps.plugins.get('example')).toMatchObject({ version: '0.1.0', state: 'running' });
    expect(findPlugin(t.db, 'example')?.version).toBe('0.1.0');
    expect(t.deps.nodes.get('example:note')?.source).toMatchObject({ version: '0.1.0' });
  });

  it('a dev plugin cannot be updated or removed', async () => {
    const t = setup({ plugins: { devPlugins: [fixturePluginPath('example')] } });
    await t.deps.plugins.start();
    expect(await update(t, 'example', '0.2.0')).toMatchObject({ ok: false });
    await expect(t.deps.plugins.remove('example')).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('plugin-aware updates [activation]', () => {
  const USER = 'u';
  // What the 0.2.0 release serves (the bundle announces the same through its host).
  const NEXT_NODE_VERSIONS = [
    {
      type: 'versioned:thing',
      version: 4,
      migrations: [
        { from: 2, to: 3, risk: 'behaviour' as const },
        { from: 3, to: 4, risk: 'safe' as const },
      ],
    },
  ];
  const thingGraph = (typeVersion: number, settings: Record<string, string>) =>
    mainGraph(
      [
        node('in', 'core:input-manual'),
        node('t', 'versioned:thing', settings, { typeVersion }),
        node('ro', 'core:replace-original'),
      ],
      [edge('in', 't'), edge('t', 'ro', { from: 'pass' })],
    );

  async function installed() {
    await serve('versioned');
    await serve('versioned2', '0.2.0', { manifest: { nodeVersions: NEXT_NODE_VERSIONS } });
    const t = setup();
    await t.deps.plugins.start();
    const r = await install(t, 'versioned');
    if (!r.ok) throw new Error(r.reason);
    return t;
  }

  /**
   * A workflow whose active version (2) is a graph pinned to `typeVersion`. Activation refuses a
   * version held for review, so the graph is activated current and then rewritten in the database,
   * as an older release's data would be.
   */
  function activeWorkflow(t: TestApp, name: string, typeVersion: number, settings = { old: 'a' }) {
    const wf = t.deps.workflows.create({ name, kind: 'workflow' }, USER);
    const saved = t.deps.workflows.save(
      { id: wf.id, baseVersion: wf.version, graph: thingGraph(3, { value: 'x' }) },
      USER,
    );
    expect(t.deps.workflows.activate(wf.id, saved.version, USER)).toMatchObject({ kind: 'ok' });
    t.db
      .prepare('UPDATE workflow_versions SET graph = ? WHERE workflow_id = ? AND version = ?')
      .run(JSON.stringify(thingGraph(typeVersion, settings)), wf.id, saved.version);
    return wf.id;
  }

  it('updateCheck lists the workflow whose active version a dropped node version breaks, and the one that gets a version to review', async () => {
    const t = await installed();
    const breaks = activeWorkflow(t, 'Breaks', 1);
    const wfReview = t.deps.workflows.create({ name: 'Review', kind: 'workflow' }, USER);
    t.deps.workflows.save(
      { id: wfReview.id, baseVersion: 1, graph: thingGraph(2, { mid: 'a' }) },
      USER,
    );
    const fine = activeWorkflow(t, 'Fine', 3, { value: 'x' } as never);
    const held = activeWorkflow(t, 'Held', 2, { mid: 'a' } as never);
    await refresh(t);
    const check = await t.deps.plugins.updateCheck('versioned', '0.2.0');
    expect(check).toEqual({
      ok: true,
      wouldBreak: [
        { id: breaks, name: 'Breaks', active: true, version: 2, reason: 'dropped' },
        { id: held, name: 'Held', active: true, version: 2, reason: 'behaviour' },
      ],
      needsReview: [{ id: wfReview.id, name: 'Review' }],
      unknown: false,
    });
    expect(fine).toBeTruthy();
    // Nothing was installed by looking.
    expect(t.deps.plugins.get('versioned')?.version).toBe('0.1.0');
  });

  it('updateCheck: a manifest without node versions is unknown; refusals are the ones update gives', async () => {
    const t = await installed();
    activeWorkflow(t, 'Breaks', 1);
    await serve('versioned2', '0.3.0');
    await refresh(t);
    expect(await t.deps.plugins.updateCheck('versioned', '0.3.0')).toEqual({
      ok: true,
      wouldBreak: [],
      needsReview: [],
      unknown: true,
    });
    expect(await t.deps.plugins.updateCheck('versioned', '0.1.0')).toEqual({
      ok: false,
      reason: 'versioned 0.1.0 is already installed',
    });
    expect(await t.deps.plugins.updateCheck('versioned', '9.9.9')).toEqual({
      ok: false,
      reason: 'versioned 9.9.9 is not in that catalog',
    });
    await expect(t.deps.plugins.updateCheck('nope', '1.0.0')).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('updateCheck refuses a dev plugin', async () => {
    const t = setup({ plugins: { devPlugins: [fixturePluginPath('versioned')] } });
    await t.deps.plugins.start();
    expect(await t.deps.plugins.updateCheck('versioned', '0.2.0')).toMatchObject({ ok: false });
  });

  it('after the update the active version is NODE_OUTDATED (no upgrade path) and not runnable; the reviewable workflow got a migrated new version through the host and keeps its active pointer', async () => {
    const t = await installed();
    const breaks = activeWorkflow(t, 'Breaks', 1);
    const review = activeWorkflow(t, 'Review', 2, { mid: 'a' } as never);
    const r = await update(t, 'versioned', '0.2.0');
    if (!r.ok) throw new Error(r.reason);

    const loaded = t.deps.workflows.loadForRun(breaks, 2);
    expect(loaded.kind).toBe('invalid');
    expect(
      loaded.kind === 'invalid' && loaded.issues.filter((i) => i.severity === 'error'),
    ).toEqual([
      expect.objectContaining({
        code: 'NODE_OUTDATED',
        nodeId: 't',
        message: expect.stringContaining('no upgrade path'),
      }),
    ]);
    expect(t.deps.workflows.get(breaks)?.active).toMatchObject({ version: 2, runnable: false });
    // A workflow with no path is not rewritten.
    expect(t.deps.workflows.get(breaks)?.currentVersion).toBe(2);

    const detail = t.deps.workflows.get(review);
    expect(detail?.currentVersion).toBe(3);
    // 2→3 changes behaviour: the active version is held, not run unreviewed.
    expect(detail?.active).toMatchObject({ version: 2, runnable: false });
    expect(detail?.activeIssues.map((i) => i.message)).toContain(
      'plugin update changes behaviour of Thing; review and activate a new version',
    );
    expect(detail?.graph.nodes.find((n) => n.id === 't')).toMatchObject({
      typeVersion: 4,
      settings: { value: 'a' },
    });
    // No job runs it: a real queue is refused with the hold as the reason.
    const dir = await tempDir('plugin-held-');
    const root = join(dir, 'lib');
    await mkdir(root, { recursive: true });
    const file = join(root, 'a.mkv');
    await writeFile(file, 'x');
    const old = new Date(Date.now() - 3_600_000);
    await utimes(file, old, old);
    const lib = await t.deps.engine.queue.createLibrary({
      name: 'TV',
      path: root,
    });
    if (!('id' in lib)) throw new Error('library not created');
    const refused = await t.deps.engine.queue.queue({
      path: file,
      workflowId: review,
      dryRun: false,
      force: true,
      priority: 0,
      createdBy: 'u',
    });
    expect(refused.kind).toBe('workflow-invalid');
    expect(
      refused.kind === 'workflow-invalid' && refused.issues.map((i) => i.message).join(' '),
    ).toContain('plugin update changes behaviour of Thing');
    await rm(dir, { recursive: true, force: true });
    expect(t.deps.workflows.versions(review)?.[0]).toMatchObject({
      createdBy: 'system:upgrade',
      note: expect.stringContaining('value is now required'),
    });
  });

  it('a workflow pinned to an older version is migrated at install and at start-up through the host, never refusing the plugin action', async () => {
    await serve('versioned');
    const t = setup();
    await t.deps.plugins.start();
    expect((await install(t, 'versioned')).ok).toBe(true);
    const wf = t.deps.workflows.create({ name: 'Old', kind: 'workflow' }, USER);
    t.deps.workflows.save({ id: wf.id, baseVersion: 1, graph: thingGraph(1, { old: 'a' }) }, USER);
    // Disable then enable: the upgrade runs once the plugin is back.
    await t.deps.plugins.disable('versioned');
    await t.deps.plugins.enable('versioned');
    const detail = t.deps.workflows.get(wf.id);
    expect(detail?.currentVersion).toBe(3);
    expect(detail?.graph.nodes.find((n) => n.id === 't')).toMatchObject({
      typeVersion: 3,
      settings: { value: 'a' },
    });
  });
});

describe('dev plugins', () => {
  it('load from TRANSCODA_DEV_PLUGINS, are never persisted and are listed with catalogUrl null', async () => {
    const t = setup({ plugins: { devPlugins: [fixturePluginPath('example')] } });
    await t.deps.plugins.start();
    expect(t.deps.plugins.list()).toEqual([
      expect.objectContaining({
        name: 'example',
        version: '0.1.0',
        catalogUrl: null,
        state: 'running',
        enabled: true,
        nodes: ['example:extension-is', 'example:note', 'example:fixed-language'],
      }),
    ]);
    expect(findPlugin(t.db, 'example')).toBeNull();
    expect(await files(t)).toEqual([]);
    expect(t.deps.nodes.get('example:note')?.source).toMatchObject({
      kind: 'plugin',
      name: 'example',
    });
    expect(t.deps.nodes.get('example:note')?.unavailable?.()).toBeNull();
    // Not in the catalog operations either: an install of the same name is refused.
    await serve('example');
    expect(await install(t, 'example')).toEqual({
      ok: false,
      reason: 'plugin example is already installed',
    });
  });

  it('a dev bundle that shadows an installed plugin is refused with a log line, not loaded', async () => {
    await serve('example');
    const first = setup();
    await first.deps.plugins.start();
    await install(first, 'example');
    await first.deps.plugins.stop();
    const errors: unknown[] = [];
    const second = setup({
      db: first.db,
      pluginsDir: first.deps.config.pluginsDir,
      plugins: { devPlugins: [fixturePluginPath('example')] },
      log: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
    });
    await second.deps.plugins.start();
    expect(errors).toContainEqual(
      expect.objectContaining({
        msg: 'dev plugin not loaded',
        reason: 'dev plugin example shadows the installed one; remove it first',
      }),
    );
    expect(second.deps.plugins.get('example')).toMatchObject({ catalogUrl: indexUrl });
  });
});

// Isolation, end to end over the real host, with a stand-in for setpriv: a script that records its
// argv and then execs what follows `--` (this machine is not Linux and has no capabilities). The
// real setpriv is exercised in the image check (Task 7 step 4).
describe('plugin isolation (staging)', () => {
  let scratch: string;
  let runDir: string;
  let invocations: string;
  let isolation: PluginIsolation;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'tc-iso-'));
    runDir = join(scratch, 'run');
    await mkdir(runDir);
    invocations = join(scratch, 'invocations.log');
    const fake = join(scratch, 'setpriv');
    await writeFile(
      fake,
      `#!/bin/sh\necho "$*" >> '${invocations}'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
    );
    await chmod(fake, 0o755);
    isolation = { uid: 65001, gid: 65001, runDir, setprivPath: fake };
  });
  afterEach(() => rm(scratch, { recursive: true, force: true }));

  const lines = async (): Promise<string[]> =>
    (await readFile(invocations, 'utf8').catch(() => '')).split('\n').filter((l) => l !== '');

  it('a host starts through setpriv from a staged copy under the run dir: mode 0640, real path in the sandbox grant', async () => {
    await serve('example');
    const t = setup({ isolation });
    await t.deps.plugins.start();
    const r = await install(t, 'example');
    if (!r.ok) throw new Error(r.reason);
    expect(r.plugin.state).toBe('running');
    const staged = join(await realpath(runDir), 'example-0.1.0.js');
    expect(await readdir(runDir)).toEqual(['example-0.1.0.js']);
    expect((await stat(staged)).mode & 0o777).toBe(0o640);
    expect(await readFile(staged, 'utf8')).toBe(text('example'));
    const [line] = await lines();
    expect(line).toMatch(
      /^--reuid=65001 --regid=65001 --clear-groups --inh-caps=-all --ambient-caps=-all --no-new-privs -- /,
    );
    expect(line).toContain(`--allow-fs-read=${staged}`);
    expect(line?.endsWith(` ${staged}`)).toBe(true);
    expect(line).not.toContain('/plugins/example-0.1.0.js');
  });

  it('a tampered bundle is refused before it is staged', async () => {
    await serve('example');
    const first = setup({ isolation });
    await first.deps.plugins.start();
    await install(first, 'example');
    await first.deps.plugins.stop();
    await writeFile(
      join(first.deps.config.pluginsDir, 'example-0.1.0.js'),
      `${text('example')}\n// x`,
    );
    const second = setup({
      db: first.db,
      pluginsDir: first.deps.config.pluginsDir,
      isolation,
    });
    await second.deps.plugins.start();
    expect(second.deps.plugins.get('example')).toMatchObject({
      state: 'stopped',
      stateReason: 'bundle changed on disk; reinstall',
    });
    expect(await readdir(runDir)).toEqual([]);
  });

  it('update: the candidate runs from its own staged copy, the old copy goes after the swap, a failed update leaves no new copy', async () => {
    await serve('example');
    await serve('example', '0.2.0');
    await serve('example', '0.3.0', {
      edit: (c) => c.replace('await ctx.log("debug", "example 0.1.0 loaded");', 'process.exit(4);'),
    });
    const t = setup({ isolation });
    await t.deps.plugins.start();
    await install(t, 'example');
    const real = await realpath(runDir);

    expect(await update(t, 'example', '0.3.0')).toMatchObject({ ok: false });
    expect(await readdir(runDir)).toEqual(['example-0.1.0.js']);

    const r = await update(t, 'example', '0.2.0');
    if (!r.ok) throw new Error(r.reason);
    const all = await lines();
    expect(all.at(-1)?.endsWith(` ${join(real, 'example-0.2.0.js')}`)).toBe(true);
    expect(await readdir(runDir)).toEqual(['example-0.2.0.js']);
    // A restart stages again from the installed copy.
    await t.deps.plugins.restart('example');
    expect(t.deps.plugins.get('example')?.state).toBe('running');
    expect(await readdir(runDir)).toEqual(['example-0.2.0.js']);
  });

  it('Review focus 5: a missing run dir stops that plugin with the reason, no restart loop, the other plugin keeps running', async () => {
    await serve('example');
    await serve('ctxprobe');
    const t = setup({ isolation });
    await t.deps.plugins.start();
    expect((await install(t, 'example')).ok).toBe(true);
    const other = (await manifestOf('ctxprobe')).name;
    expect((await install(t, other)).ok).toBe(true);
    const otherPid = pidOf(t, other);
    await rm(runDir, { recursive: true });
    const before = (await lines()).length;

    const detail = await t.deps.plugins.restart('example');
    expect(detail.state).toBe('stopped');
    expect(detail.stateReason).toMatch(/^cannot stage bundle: ENOENT/);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.deps.plugins.get('example')?.state).toBe('stopped');
    expect((await lines()).length).toBe(before);
    expect(t.deps.plugins.get(other)?.state).toBe('running');
    expect(alive(otherPid)).toBe(true);
  });

  it('disable and remove take the staged copy away; start() clears what an earlier run left', async () => {
    await serve('example');
    const t = setup({ isolation });
    await writeFile(join(runDir, 'leftover-9.9.9.js'), 'x');
    await t.deps.plugins.start();
    expect(await readdir(runDir)).toEqual([]);
    await install(t, 'example');
    expect(await readdir(runDir)).toEqual(['example-0.1.0.js']);
    await t.deps.plugins.disable('example');
    expect(await readdir(runDir)).toEqual([]);
    await t.deps.plugins.enable('example');
    expect(await readdir(runDir)).toEqual(['example-0.1.0.js']);
    await t.deps.plugins.remove('example');
    expect(await readdir(runDir)).toEqual([]);
  });

  it('a dev plugin is not isolated: no setpriv, run from its own path, never staged', async () => {
    const t = setup({ isolation, plugins: { devPlugins: [fixturePluginPath('example')] } });
    await t.deps.plugins.start();
    expect(t.deps.plugins.get('example')).toMatchObject({ state: 'running' });
    expect(await lines()).toEqual([]);
    expect(await readdir(runDir)).toEqual([]);
  });
});

describe('catalog', () => {
  it('an official catalog with an empty key list refuses an unsigned index with "catalog signature missing"', async () => {
    await serve('example');
    const t = createTestApp({
      log: { info: () => {}, warn: () => {}, error: () => {} },
      config: { pluginCatalogUrl: indexUrl, pluginCatalogKeys: [] },
    });
    apps.push(t);
    await t.deps.plugins.start();
    const out = await t.deps.plugins.catalog(true);
    expect(out.catalogs[0]).toMatchObject({
      catalogUrl: indexUrl,
      official: true,
      error: 'catalog signature missing',
      plugins: [],
    });
  });

  it('lists the catalogs with installed and update-available marks; custom catalogs can be added and removed, the official one cannot', async () => {
    await serve('example');
    await serve('example', '0.2.0');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    const out = await t.deps.plugins.catalog(true);
    expect(out.catalogs).toHaveLength(1);
    const c = out.catalogs[0];
    expect(c).toMatchObject({ catalogUrl: indexUrl, official: true, error: null });
    expect(c?.plugins[0]).toMatchObject({
      name: 'example',
      latest: '0.2.0',
      installed: '0.1.0',
      versions: [
        expect.objectContaining({
          version: '0.1.0',
          compatible: true,
          sdk: '^1',
          coreTested: ['1.0.0'],
        }),
        expect.objectContaining({ version: '0.2.0' }),
      ],
    });
    expect(t.deps.plugins.get('example')?.updateAvailable).toBe('0.2.0');

    const other = `${base}/index.json?other=1`;
    t.deps.plugins.addCatalog(other);
    expect(
      (await t.deps.plugins.catalog(false)).catalogs.map((x) => [
        x.catalogUrl === other,
        x.official,
      ]),
    ).toEqual([
      [false, true],
      [true, false],
    ]);
    t.deps.plugins.removeCatalog(other);
    expect((await t.deps.plugins.catalog(false)).catalogs).toHaveLength(1);
    expect(() => t.deps.plugins.removeCatalog(indexUrl)).toThrow(
      /official catalog cannot be removed/,
    );
    expect(() => t.deps.plugins.addCatalog('ftp://x.test/i.json')).toThrow(/https/);
    expect(() => t.deps.plugins.addCatalog('not a url')).toThrow(/not a url/);
    // Updating clears the mark.
    await update(t, 'example', '0.2.0');
    expect(t.deps.plugins.get('example')?.updateAvailable).toBeNull();
  });

  it('an unreachable catalog is an error line on that catalog, not a failure', async () => {
    const t = setup();
    t.deps.plugins.addCatalog('http://127.0.0.1:1/index.json');
    const out = await t.deps.plugins.catalog(true);
    expect(out.catalogs.find((x) => !x.official)?.error).toMatch(/catalog fetch failed/);
    expect(out.catalogs.find((x) => x.official)?.error).toBeNull();
  });
});

describe('signed bundles', () => {
  const customUrl = (): string => `${base}/custom.json`;
  const installFrom = async (app: TestApp, url: string, name = 'example') => {
    await refresh(app);
    return app.deps.plugins.install({ name, version: '0.1.0', catalogUrl: url });
  };

  it('installing from a signed catalog stores the signature and records the key', async () => {
    signing.on = true;
    await serve('example');
    const t = setup({ catalogKeys: signing.keys });
    await t.deps.plugins.start();
    const result = await install(t, 'example');
    if (!result.ok) throw new Error(result.reason);
    expect(result.plugin.provenance.signedBy).toBe('k1');
    expect(findPlugin(t.db, 'example')?.signedBy).toBe('k1');
    expect(await files(t)).toEqual([
      'example-0.1.0.js',
      'example-0.1.0.js.sig',
      'example-0.1.0.manifest.json',
    ]);
    const out = await t.deps.plugins.catalog(false);
    expect(out.catalogs[0]).toMatchObject({ official: true, signed: true });
    expect(out.catalogs[0]?.plugins[0]?.versions[0]?.signature).toBe(
      `${base}/example-0.1.0.js.sig`,
    );
  });

  it('an unsigned install records no key and the catalog says unsigned', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    const result = await install(t, 'example');
    if (!result.ok) throw new Error(result.reason);
    expect(result.plugin.provenance.signedBy).toBeNull();
    expect((await t.deps.plugins.catalog(false)).catalogs[0]?.signed).toBe(false);
  });

  it('a signed catalog whose version has no bundle signature is refused', async () => {
    await serve('example');
    signing.on = true;
    signing.noBundleSig = true;
    // the index is signed but carries no bundle signature url
    const t = setup({ catalogKeys: signing.keys });
    await t.deps.plugins.start();
    expect(await install(t, 'example')).toEqual({
      ok: false,
      reason: 'the catalog is signed but this version has no bundle signature',
    });
    expect(await files(t)).toEqual([]);
  });

  it('a .sig tampered with on disk stops the plugin at its next start', async () => {
    signing.on = true;
    await serve('example');
    const first = setup({ catalogKeys: signing.keys });
    await first.deps.plugins.start();
    expect((await install(first, 'example')).ok).toBe(true);
    await first.deps.plugins.stop();
    const sig = join(first.deps.config.pluginsDir, 'example-0.1.0.js.sig');
    await writeFile(sig, signText(Buffer.from('other'), signing.privateKey, signing.keyId));
    const second = setup({
      db: first.db,
      pluginsDir: first.deps.config.pluginsDir,
      catalogKeys: signing.keys,
    });
    await second.deps.plugins.start();
    expect(second.deps.plugins.get('example')).toMatchObject({
      state: 'stopped',
      stateReason: 'bundle signature invalid; reinstall',
    });
    await writeFile(sig, signText(Buffer.from('x'), signing.privateKey, signing.keyId));
    await rm(sig);
    await expect(second.deps.plugins.restart('example')).resolves.toMatchObject({
      state: 'stopped',
      stateReason: 'bundle signature missing; reinstall',
    });
  });

  it('a custom catalog added with a public key is verified; its install is signed by key k1', async () => {
    signing.on = true;
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    t.deps.plugins.addCatalog(customUrl(), signing.keySpec);
    const result = await installFrom(t, customUrl());
    if (!result.ok) throw new Error(result.reason);
    expect(result.plugin.provenance.signedBy).toBe('k1');
    expect(
      (await t.deps.plugins.catalog(false)).catalogs.map((c) => [c.official, c.signed, c.keyIds]),
    ).toEqual([
      [true, false, []],
      [false, true, ['k1']],
    ]);
  });

  it('B4: a signed custom catalog that is removed leaves the plugin stopped at its next start', async () => {
    signing.on = true;
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    t.deps.plugins.addCatalog(customUrl(), signing.keySpec);
    expect((await installFrom(t, customUrl())).ok).toBe(true);
    t.deps.plugins.removeCatalog(customUrl());
    await expect(t.deps.plugins.restart('example')).resolves.toMatchObject({
      state: 'stopped',
      stateReason: 'signed with an unknown key k1; update the plugin',
    });
  });

  it('a wrong key for a custom catalog is a catalog error, not an install', async () => {
    signing.on = true;
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    t.deps.plugins.addCatalog(customUrl(), generateKeyPairSyncHex());
    const out = await t.deps.plugins.catalog(true);
    expect(out.catalogs[1]?.error).toMatch(/catalog signature invalid/);
  });

  it('adding a known url with keys replaces them, without keys keeps them; bad keys, a query string and the official url are refused', async () => {
    const t = setup();
    t.deps.plugins.addCatalog(customUrl());
    expect(listCatalogs(t.db)).toEqual([{ url: customUrl(), signingKeys: null }]);
    t.deps.plugins.addCatalog(customUrl(), signing.keySpec);
    expect(listCatalogs(t.db)).toEqual([{ url: customUrl(), signingKeys: signing.keySpec }]);
    t.deps.plugins.addCatalog(customUrl());
    expect(listCatalogs(t.db)[0]?.signingKeys).toBe(signing.keySpec);
    for (const bad of ['abc', signing.publicHex, `k1:${'A'.repeat(64)}`, '']) {
      expect(() => t.deps.plugins.addCatalog(customUrl(), bad)).toThrow(/expected <id>:<64 hex>/);
    }
    expect(() => t.deps.plugins.addCatalog(`${customUrl()}?x=1`, signing.keySpec)).toThrow(
      'a signed catalog url may not have a query string',
    );
    expect(() => t.deps.plugins.addCatalog(indexUrl, signing.keySpec)).toThrow(
      "the official catalog's key is set by TRANSCODA_PLUGIN_CATALOG_KEY",
    );
    // without keys a query string stays fine
    t.deps.plugins.addCatalog(`${customUrl()}?x=1`);
    // unpinning is remove, then add
    t.deps.plugins.removeCatalog(customUrl());
    t.deps.plugins.addCatalog(customUrl());
    expect(listCatalogs(t.db).find((c) => c.url === customUrl())?.signingKeys).toBeNull();
  });
});

function generateKeyPairSyncHex(): string {
  const spki = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
  return `k1:${spki.subarray(spki.length - 32).toString('hex')}`;
}

describe('job hooks', () => {
  it('hookTarget reaches running plugins that declare the hook, through the supervisor', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    const target = t.deps.plugins.hookTarget();
    expect(target.running()).toEqual(['example']);
    expect(target.declaredHooks('example')).toEqual([]);
    expect(target.declaredHooks('ghost')).toEqual([]);
    // The hook goes to the process through the supervisor (which redacts the answer); a plugin
    // without that hook function answers ok.
    expect(
      await target.hook('example', 'onJobDone', { id: 'j1', dryRun: false } as never),
    ).toMatchObject({ ok: true });
    await t.deps.plugins.disable('example');
    expect(target.running()).toEqual([]);
  });
});

describe('secrets never leak into logs or events', () => {
  it('nothing the service logs or publishes carries a secret', async () => {
    const lines: unknown[] = [];
    await serve('secrets');
    const t = setup({
      log: { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) },
    });
    await t.deps.plugins.start();
    await install(t, 'secrets');
    await t.deps.plugins.saveSettings('secrets', { apiKey: 'LEAK-CHECK-KEY-3' });
    await t.deps.plugins.testSettings('secrets', { apiKey: 'LEAK-CHECK-KEY-4' });
    await t.deps.plugins.restart('secrets');
    await t.deps.plugins.stop();
    expect(JSON.stringify([lines, t.events])).not.toMatch(/LEAK-CHECK-KEY/);
  });
});

describe('blocklist', () => {
  const listed = (entries: unknown[]): string =>
    JSON.stringify({ schema: 1, generated: '2026-10-17T00:00:00.000Z', entries });
  const byName = (name: string) => ({
    id: 'bl-1',
    name,
    reason: 'test entry',
    url: 'https://example.com/advisory/1',
    added: '2026-10-17T00:00:00.000Z',
  });
  const bySha = (sha256: string) => ({
    id: 'bl-2',
    sha256,
    reason: 'test entry',
    url: null,
    added: '2026-10-17T00:00:00.000Z',
  });
  const recheck = (app: TestApp) => app.deps.plugins.recheckBlocklist();

  it('a listed sha256 stops the running plugin with the reason; plugins.changed is emitted and list() shows it', async () => {
    const entry = await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    expect((await install(t, 'example')).ok).toBe(true);
    expect(t.deps.plugins.list()[0]?.blocked).toBeNull();
    const pid = pidOf(t, 'example');
    t.events.length = 0;

    await writeFile(t.blocklistFile, listed([bySha(sha(entry.bundle))]));
    await recheck(t);

    expect(t.deps.plugins.get('example')).toMatchObject({
      state: 'stopped',
      stateReason: 'blocklisted: test entry',
      enabled: true,
    });
    expect(alive(pid)).toBe(false);
    expect(t.events).toContainEqual({
      type: 'plugins.changed',
      name: 'example',
      state: 'stopped',
      stateReason: 'blocklisted: test entry',
    });
    expect(t.deps.plugins.list()[0]?.blocked).toEqual({ reason: 'test entry', url: null });
    expect(t.deps.nodes.get('example:note')?.unavailable?.()).toBe(
      'plugin example is not running: blocklisted: test entry',
    );
    // Asking again changes nothing and publishes nothing.
    t.events.length = 0;
    await recheck(t);
    expect(t.events).toEqual([]);
  });

  it('catalog(refresh=true) also rechecks the blocklist: a running plugin newly listed is stopped at once', async () => {
    const entry = await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    const pid = pidOf(t, 'example');
    await writeFile(t.blocklistFile, listed([bySha(sha(entry.bundle))]));
    // catalog(false) fetches nothing new: the plugin keeps running.
    await t.deps.plugins.catalog(false);
    expect(t.deps.plugins.get('example')?.state).toBe('running');
    const out = await t.deps.plugins.catalog(true);
    expect(out.catalogs[0]?.plugins[0]?.versions[0]?.blocked).toEqual({
      reason: 'test entry',
      url: null,
    });
    expect(t.deps.plugins.get('example')).toMatchObject({
      state: 'stopped',
      stateReason: 'blocklisted: test entry',
    });
    expect(alive(pid)).toBe(false);
  });

  it('warns once at start when the official blocklist is configured with other catalog keys', async () => {
    const lines: unknown[] = [];
    const t = setup({
      blocklistUrl: OFFICIAL_BLOCKLIST_URL,
      catalogKeys: [{ id: 'mine', publicKey: 'a'.repeat(64) }],
      log: { info: () => {}, warn: (m) => lines.push(m), error: () => {} },
    });
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    try {
      await t.deps.plugins.start();
      await t.deps.plugins.stop();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(lines.filter((m) => String(m).includes('blocklist is inert'))).toEqual([
      BLOCKLIST_INERT_WARNING,
    ]);
  });

  it('enable and restart stay refused by the verify seam while the build is listed; removing the entry lets a restart through', async () => {
    const entry = await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    await writeFile(t.blocklistFile, listed([byName('example')]));
    await recheck(t);
    await expect(t.deps.plugins.enable('example')).resolves.toMatchObject({
      state: 'stopped',
      stateReason: 'blocklisted: test entry',
    });
    await expect(t.deps.plugins.restart('example')).resolves.toMatchObject({
      state: 'stopped',
      stateReason: 'blocklisted: test entry',
    });
    expect(findPlugin(t.db, 'example')?.sha256).toBe(sha(entry.bundle));
    await writeFile(t.blocklistFile, listed([]));
    await recheck(t);
    await expect(t.deps.plugins.restart('example')).resolves.toMatchObject({ state: 'running' });
    expect(t.deps.plugins.list()[0]?.blocked).toBeNull();
  });

  it('install of a listed name is refused before anything is downloaded: no files, no row, no nodes', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    await writeFile(t.blocklistFile, listed([byName('example')]));
    const result = await install(t, 'example');
    expect(result).toEqual({ ok: false, reason: 'blocklisted: test entry' });
    expect(await files(t)).toEqual([]);
    expect(findPlugin(t.db, 'example')).toBeNull();
    expect(t.deps.nodes.get('example:note')).toBeUndefined();
  });

  it('a version range blocks only the builds inside it, at install and at update', async () => {
    await serve('example');
    await serve('example', '0.2.0');
    const t = setup();
    await t.deps.plugins.start();
    await writeFile(
      t.blocklistFile,
      listed([{ ...byName('example'), versions: '>=0.2.0 <1.0.0' }]),
    );
    expect((await install(t, 'example', '0.1.0')).ok).toBe(true);
    expect(await update(t, 'example', '0.2.0')).toEqual({
      ok: false,
      reason: 'blocklisted: test entry',
    });
    expect(t.deps.plugins.get('example')).toMatchObject({ version: '0.1.0', state: 'running' });
    expect(await files(t)).toEqual(['example-0.1.0.js', 'example-0.1.0.manifest.json']);
  });

  it('the catalog answer marks blocked versions and carries the blocklist status', async () => {
    const entry = await serve('example');
    await serve('example', '0.2.0');
    const t = setup();
    await t.deps.plugins.start();
    await writeFile(t.blocklistFile, listed([bySha(sha(entry.bundle))]));
    const out = await t.deps.plugins.catalog(true);
    const versions = out.catalogs[0]?.plugins[0]?.versions ?? [];
    expect(versions.map((v) => [v.version, v.blocked])).toEqual([
      ['0.1.0', { reason: 'test entry', url: null }],
      ['0.2.0', null],
    ]);
    expect(out.blocklist).toEqual({
      url: t.deps.config.pluginBlocklistUrl,
      error: null,
      fetchedAt: '2026-01-01T00:00:00.000Z',
      entries: 1,
    });
  });

  it('a disabled plugin stays disabled when it is listed; enable is then refused', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    await t.deps.plugins.disable('example');
    t.events.length = 0;
    await writeFile(t.blocklistFile, listed([byName('example')]));
    await recheck(t);
    expect(t.deps.plugins.get('example')).toMatchObject({ state: 'disabled', enabled: false });
    expect(t.events).toEqual([]);
    expect(t.deps.plugins.list()[0]?.blocked?.reason).toBe('test entry');
    await expect(t.deps.plugins.enable('example')).resolves.toMatchObject({
      state: 'stopped',
      stateReason: 'blocklisted: test entry',
    });
  });

  it('the cached list is enforced at the next start, before the plugins boot, even with no network', async () => {
    await serve('example');
    const first = setup({ blocklistUrl: `${base}/blocklist.json` });
    blocklistServed.body = listed([]);
    await first.deps.plugins.start();
    await install(first, 'example');
    blocklistServed.body = listed([byName('example')]);
    await first.deps.plugins.catalog(true);
    expect(first.deps.plugins.list()[0]?.blocked?.reason).toBe('test entry');
    await first.deps.plugins.stop();

    const second = setup({
      db: first.db,
      pluginsDir: first.deps.config.pluginsDir,
      blocklistUrl: 'http://127.0.0.1:1/blocklist.json',
    });
    await second.deps.plugins.start();
    expect(second.deps.plugins.get('example')).toMatchObject({
      state: 'stopped',
      stateReason: 'blocklisted: test entry',
    });
  });

  it('fail-open: an unreachable blocklist does not stop an install, and start() does not wait for it', async () => {
    await serve('example');
    const silent = createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    try {
      const t = setup({
        blocklistUrl: `http://127.0.0.1:${(silent.address() as AddressInfo).port}/blocklist.json`,
      });
      const began = Date.now();
      await t.deps.plugins.start();
      expect(Date.now() - began).toBeLessThan(1500);
      const result = await install(t, 'example');
      expect(result.ok).toBe(true);
      expect(t.deps.plugins.list()[0]).toMatchObject({ state: 'running', blocked: null });
      expect((await t.deps.plugins.catalog(false)).blocklist).toMatchObject({
        entries: 0,
        fetchedAt: null,
      });
      expect((await t.deps.plugins.catalog(false)).blocklist.error).toMatch(
        /^blocklist fetch failed: /,
      );
    } finally {
      silent.closeAllConnections();
      silent.close();
    }
  }, 30_000);

  it('a dev plugin is never blocked by the list', async () => {
    const t = setup({ plugins: { devPlugins: [fixturePluginPath('example')] } });
    await writeFile(t.blocklistFile, listed([byName('example')]));
    await t.deps.plugins.start();
    expect(t.deps.plugins.get('example')).toMatchObject({ state: 'running', blocked: null });
    await recheck(t);
    expect(t.deps.plugins.get('example')).toMatchObject({ state: 'running', blocked: null });
  });
});
