// Shared setup for the PluginService tests (service*.test.ts), which run over the real built
// host: a local catalog (node:http) serves the Task 6 fixture bundles (and edited copies of them),
// the test app wires the service to a real database.
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginManifest } from '@transcoda/shared';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { createTestApp, type TestApp } from '../../app/testing/app.ts';
import type { createCoreRegistry } from '../../nodes/registry.ts';
import type { PluginIsolation } from '../../platform/config.ts';
import type { SigningKey } from '../../platform/signing-keys.ts';
import { checkPluginBundle } from '../runtime/check-plugin.ts';
import { type FixtureName, fixturePluginPath, hostPath } from '../testing/build.ts';
import { signText } from '../testing/sign.ts';
import type { PluginServiceDeps } from './service.ts';

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
  /** The index's network list (default: the manifest's; null: the entry has none). */
  indexNetwork?: PluginManifest['network'] | null;
}

export const served = new Map<string, Served>();
export let server: Server;
export let base = '';
export let indexUrl = '';

// A signing key for the signed-catalog tests: `signing.on` makes the index carry bundle
// signatures and the server answer `.sig` requests (`/index.json.sig`, `/custom.json.sig`, `<k>.js.sig`).
export const signing: {
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
export const blocklistServed: { body: string | null } = { body: null };
/** The catalog index answers 500 (an unreachable catalog). */
export const indexServed = { down: false };

export const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
export const key = (name: string, version: string): string => `${name}-${version}`;

export function index(): string {
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
        ...((v.indexNetwork === undefined ? v.manifest.network : v.indexNetwork) != null
          ? { network: v.indexNetwork ?? v.manifest.network }
          : {}),
      })),
    })),
  });
}

export const manifests = new Map<FixtureName, PluginManifest>();

/** The bundle's own manifest, read the way the CLI reads it. */
export async function manifestOf(fixture: FixtureName): Promise<PluginManifest> {
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
    network: r.network,
  };
  manifests.set(fixture, m);
  return m;
}

export const text = (fixture: FixtureName): string =>
  readFileSync(fixturePluginPath(fixture), 'utf8');

/** Serves a built fixture as `<name>@<version>`; `edit` may rewrite the bundle text. */
export async function serve(
  fixture: FixtureName,
  version = '0.1.0',
  opts: {
    edit?: (code: string) => string;
    manifest?: Partial<PluginManifest>;
    indexSdk?: string;
    sha256?: string;
    indexNetwork?: PluginManifest['network'] | null;
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
    ...(opts.indexNetwork !== undefined ? { indexNetwork: opts.indexNetwork } : {}),
  };
  served.set(key(m.name, version), entry);
  return entry;
}

const EMPTY_BLOCKLIST = JSON.stringify({
  schema: 1,
  generated: '2026-10-17T00:00:00.000Z',
  entries: [],
});
let blocklistDir = '';
let blocklists = 0;

export const apps: TestApp[] = [];

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

export function setup(
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
): TestApp & { events: Record<string, unknown>[]; blocklistFile: string } {
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
  const events: Record<string, unknown>[] = [];
  const publish = app.deps.engine.events.publish.bind(app.deps.engine.events);
  vi.spyOn(app.deps.engine.events, 'publish').mockImplementation((e) => {
    events.push(e as unknown as Record<string, unknown>);
    publish(e);
  });
  apps.push(app);
  return Object.assign(app, { events, blocklistFile });
}

/** The service caches the catalog index: look at what the test server serves now. */
export const refresh = (app: TestApp) => app.deps.plugins.catalog(true);

export const install = async (app: TestApp, name: string, version = '0.1.0') => {
  await refresh(app);
  return app.deps.plugins.install({ name, version, catalogUrl: indexUrl });
};

export const update = async (app: TestApp, name: string, version: string) => {
  await refresh(app);
  return app.deps.plugins.update(name, version);
};

export async function until(fn: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function files(app: TestApp): Promise<string[]> {
  return (await readdir(app.deps.config.pluginsDir).catch(() => [])).filter(
    (f) => !f.startsWith('.'),
  );
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function pidOf(app: TestApp, name: string): number {
  const pid = app.deps.plugins.pid(name);
  if (!pid) throw new Error(`${name} has no process`);
  return pid;
}

/**
 * Starts the test catalog server for the calling test file, and after each test resets what it
 * serves and closes the apps `setup` made. Call once at the top of a test file.
 */
export function useTestCatalog(): void {
  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '').slice(1);
      if (path === 'blocklist.json' && blocklistServed.body !== null) {
        res.end(blocklistServed.body);
        return;
      }
      if ((path === 'index.json' || path === 'custom.json') && indexServed.down) {
        res.statusCode = 500;
        res.end('down');
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

  afterEach(() => {
    served.clear();
    blocklistServed.body = null;
    indexServed.down = false;
    signing.on = false;
    signing.noBundleSig = false;
    signing.keyId = 'k1';
  });

  beforeAll(() => {
    blocklistDir = mkdtempSync(join(tmpdir(), 'tc-svc-blocklist-'));
  });
  afterAll(() => {
    rmSync(blocklistDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });
}
