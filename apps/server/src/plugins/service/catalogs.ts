import { join } from 'node:path';
import { NODE_KINDS, type NodeKind } from '@transcoda/sdk';
import type { PluginManifest } from '@transcoda/shared';
import semver from 'semver';
import { addCatalog, listCatalogs, removeCatalog } from '../../db/repos/plugins.ts';
import { parseSigningKeys, type SigningKey } from '../../platform/signing-keys.ts';
import { PluginServiceError } from '../errors.ts';
import type { Installer } from '../installer.ts';
import type { BlocklistClient } from '../trust/blocklist.ts';
import { CatalogClient, type CatalogEntry } from '../trust/catalog.ts';
import { messageOf } from './helpers.ts';
import type { Installed, PluginCatalogOutput, PluginServiceDeps, Provenance } from './types.ts';

// The plugin catalogs: the configured catalog list and its keys, the catalog the Plugins page
// shows, the lookup install and update start from, and the background update check.

/** The first background update check waits this long after start, so it never competes with boot. */
export const UPDATE_CHECK_DELAY_MS = 60_000;
/** Then the catalogs are asked for updates this often. */
export const UPDATE_CHECK_MS = 6 * 3_600_000;
/** The catalog waits this long for a build's manifest (its nodes and icon), then shows it without. */
const CATALOG_MANIFEST_TIMEOUT_MS = 10_000;
/** Catalog manifests fetched at the same time. */
const CATALOG_MANIFEST_CONCURRENCY = 4;

/** The newest compatible version, preferring the catalog's own `latest` when it is compatible. */
function latestOf(e: CatalogEntry): string | null {
  const compatible = e.versions.filter((v) => v.compatible);
  const newest = [...compatible].sort((a, b) => semver.rcompare(a.version, b.version))[0];
  const hinted = compatible.find((v) => v.version === e.latest);
  return (hinted ?? newest)?.version ?? null;
}

/** Runs `fn` over `items`, at most `limit` at a time. */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** What the catalogs need from the plugin service. */
export interface CatalogsDeps {
  deps: Pick<PluginServiceDeps, 'db' | 'config' | 'now' | 'log' | 'catalog'>;
  installer: Installer;
  blocklist: BlocklistClient;
  sdkVersion: string;
  /** Shared with the service: what the catalog says of each installed build. */
  provenance: Map<string, Provenance>;
  /** Installed plugin names, dev plugins included, sorted. */
  names(): string[];
  record(name: string): Installed | null;
  /** Publishes plugins.changed for the plugin. */
  publish(name: string): void;
  recheckBlocklist(): Promise<void>;
  stopping(): boolean;
}

export class PluginCatalogs {
  readonly client: CatalogClient;
  /** Newest compatible catalog version per installed plugin, from the last catalog fetch. */
  private readonly updates = new Map<string, string>();
  /**
   * Manifests of the catalogs' current builds by `<catalog> <name>@<version> <sha256>` (a build
   * never changes), for the nodes and icon the catalog shows; null: unreadable, tried again on a
   * refresh. Only the builds of the last catalog answer are kept.
   */
  private readonly catalogManifests = new Map<string, PluginManifest | null>();

  constructor(private readonly c: CatalogsDeps) {
    const { config } = c.deps;
    this.client =
      c.deps.catalog ??
      new CatalogClient({
        sdkVersion: c.sdkVersion,
        token: config.catalogToken,
        cacheDir: join(config.pluginsDir, '.catalog'),
        now: c.deps.now,
        allowFileUrls: config.nodeEnv !== 'production',
        keysFor: (url) => this.keysFor(url),
        log: c.deps.log,
      });
  }

  /** The newest catalog version of an installed plugin, when newer than the installed one. */
  updateOf(name: string): string | null {
    return this.updates.get(name) ?? null;
  }

  forgetUpdate(name: string): void {
    this.updates.delete(name);
  }

  urls(): string[] {
    return [
      ...new Set([
        this.c.deps.config.pluginCatalogUrl,
        ...listCatalogs(this.c.deps.db).map((c) => c.url),
      ]),
    ];
  }

  async catalog(refresh: boolean): Promise<PluginCatalogOutput> {
    const urls = this.urls();
    if (refresh) await this.c.recheckBlocklist();
    else await this.c.blocklist.refresh(false);
    const { entries, errors, catalogs } = await this.client.list(urls, { refresh });
    this.applyUpdates(entries, errors.length > 0);
    const installed = new Map(this.c.names().map((n) => [n, this.c.record(n)?.version ?? null]));
    const manifests = await this.catalogManifestsFor(entries, refresh);
    const out: PluginCatalogOutput = {
      catalogs: catalogs.map((c) => {
        const mine = entries.filter((e) => e.catalogUrl === c.catalogUrl);
        return {
          catalogUrl: c.catalogUrl,
          official: c.catalogUrl === this.c.deps.config.pluginCatalogUrl,
          signed: this.keysFor(c.catalogUrl) !== null,
          keyIds: this.keysFor(c.catalogUrl)?.map((k) => k.id) ?? [],
          error: errors.find((e) => e.catalogUrl === c.catalogUrl)?.message ?? null,
          ...(c.fetchedAt !== null ? { fetchedAt: c.fetchedAt } : {}),
          plugins: mine.map((e) =>
            this.catalogEntry(e, installed.get(e.name) ?? null, manifests.get(e) ?? null),
          ),
        };
      }),
      blocklist: { url: this.c.blocklist.url, ...this.c.blocklist.status() },
    };
    return out;
  }

  /**
   * The background update check: asks every catalog afresh (at `UPDATE_CHECK_DELAY_MS` after
   * start, then every `UPDATE_CHECK_MS`), so the menu shows updates without the Plugins page being
   * opened. Never throws: a catalog that cannot be read keeps the updates last known.
   */
  async checkUpdates(): Promise<void> {
    const { log } = this.c.deps;
    try {
      const { entries, errors } = await this.client.list(this.urls(), {
        refresh: true,
      });
      if (this.c.stopping()) return;
      for (const e of errors)
        log.warn({ msg: 'plugin update check', catalog: e.catalogUrl, error: e.message });
      this.applyUpdates(entries, errors.length > 0);
    } catch (err) {
      log.warn({ msg: 'plugin update check failed', error: messageOf(err) });
    }
  }

  /**
   * Sets `updates` from a catalog answer: the newest catalog version of each installed plugin, when
   * newer than the installed one (a dev plugin never has one). With `partial` (a catalog could not
   * be read), a plugin no catalog listed keeps the update it had. Publishes plugins.changed for
   * every plugin whose update changed, so open pages and the menu badge follow.
   */
  private applyUpdates(entries: CatalogEntry[], partial: boolean): void {
    const installed = new Map<string, string>();
    for (const name of this.c.names()) {
      const rec = this.c.record(name);
      if (rec !== null && !rec.dev) installed.set(name, rec.version);
    }
    const next = new Map<string, string>();
    const listed = new Set(entries.map((e) => e.name));
    for (const name of installed.keys()) {
      const kept = this.updates.get(name);
      if (partial && !listed.has(name) && kept !== undefined) next.set(name, kept);
    }
    for (const e of entries) {
      const version = installed.get(e.name);
      const latest = latestOf(e);
      if (version === undefined || latest === null || !semver.gt(latest, version)) continue;
      const known = next.get(e.name);
      if (known === undefined || semver.gt(latest, known)) next.set(e.name, latest);
    }
    const changed = [...new Set([...this.updates.keys(), ...next.keys()])].filter(
      (name) => this.updates.get(name) !== next.get(name),
    );
    this.updates.clear();
    for (const [name, version] of next) this.updates.set(name, version);
    for (const name of changed) this.c.publish(name);
  }

  private catalogEntry(
    e: CatalogEntry,
    installed: string | null,
    manifest: PluginManifest | null,
  ): PluginCatalogOutput['catalogs'][number]['plugins'][number] {
    const latest = latestOf(e);
    if (installed !== null) {
      const known = this.provenanceOf(e, installed);
      if (known !== null) this.c.provenance.set(e.name, known);
    }
    return {
      name: e.name,
      title: e.title,
      description: e.description,
      latest,
      installed,
      versions: e.versions.map((v) => ({
        version: v.version,
        sdk: v.sdk,
        compatible: v.compatible,
        coreTested: v.coreTested,
        sha256: v.sha256,
        size: v.size,
        attestation: v.attestation,
        signature: v.signature,
        releasedAt: v.releasedAt,
        blocked: this.blockedVersion(e.name, v),
        network: v.network ?? null,
      })),
      icon: manifest?.icon ?? null,
      nodes: this.catalogNodes(e.name, manifest, installed !== null && installed === latest),
    };
  }

  /**
   * The manifests of the entries' latest builds, for the nodes and icon the cards show (null: not
   * fetched, or unreadable).
   *
   * A manifest is UNAUTHENTICATED here: the index carries no checksum or signature for it, so it is
   * display data only and must never decide anything security-relevant (what runs, what is
   * trusted, which origins a plugin may reach). The installer reads the installed manifest anew.
   *
   * The official catalog's manifests are fetched as it is read; a custom catalog's only on an
   * explicit refresh, so merely opening the page never makes the server fetch addresses a custom
   * catalog chose. At most CATALOG_MANIFEST_CONCURRENCY at a time, each aborted after
   * CATALOG_MANIFEST_TIMEOUT_MS; a timed-out fetch is not remembered (tried again next time).
   */
  private async catalogManifestsFor(
    entries: CatalogEntry[],
    refresh: boolean,
  ): Promise<Map<CatalogEntry, PluginManifest | null>> {
    const builds = entries.flatMap((e) => {
      const v = e.versions.find((x) => x.version === latestOf(e));
      return v ? [{ e, v, key: `${e.catalogUrl} ${e.name}@${v.version} ${v.sha256}` }] : [];
    });
    const official = this.c.deps.config.pluginCatalogUrl;
    const wanted = builds.filter(({ e, key }) => {
      const known = this.catalogManifests.get(key);
      if (known !== undefined && (known !== null || !refresh)) return false;
      return refresh || e.catalogUrl === official;
    });
    await eachLimited(wanted, CATALOG_MANIFEST_CONCURRENCY, async ({ e, v, key }) => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), CATALOG_MANIFEST_TIMEOUT_MS);
      try {
        const r = await this.c.installer.fetchManifest(
          { name: e.name, version: v.version, manifestUrl: v.manifestUrl },
          this.c.sdkVersion,
          abort.signal,
        );
        if (r.ok) this.catalogManifests.set(key, r.manifest);
        else if (!abort.signal.aborted) this.catalogManifests.set(key, null);
      } finally {
        clearTimeout(timer);
      }
    });
    const current = new Set(builds.map((b) => b.key));
    for (const key of [...this.catalogManifests.keys()]) {
      if (!current.has(key)) this.catalogManifests.delete(key);
    }
    return new Map(builds.map(({ e, key }) => [e, this.catalogManifests.get(key) ?? null]));
  }

  /**
   * The nodes a catalog build adds: kind and title from its manifest, or from the installed
   * plugin when it is that same version (older manifests carry neither), else null.
   */
  private catalogNodes(
    name: string,
    manifest: PluginManifest | null,
    sameAsInstalled: boolean,
  ): Array<{ type: string; kind: NodeKind | null; title: string | null }> {
    if (manifest === null) return [];
    const known = new Map<string, { kind: string; title: string }>(
      (sameAsInstalled ? (this.c.record(name)?.nodes ?? []) : []).map((n) => [n.type, n]),
    );
    for (const n of manifest.nodeInfo ?? []) known.set(n.type, n);
    return manifest.nodes.map((type) => {
      const n = known.get(type);
      const kind = NODE_KINDS.find((k) => k === n?.kind) ?? null;
      return { type, kind, title: n?.title ?? null };
    });
  }

  private blockedVersion(
    name: string,
    v: { version: string; sha256: string },
  ): { reason: string; url: string | null } | null {
    const m = this.c.blocklist.match({ name, version: v.version, sha256: v.sha256 });
    return m === null ? null : { reason: m.reason, url: m.url };
  }

  private provenanceOf(e: CatalogEntry, version: string): Provenance | null {
    const v = e.versions.find((x) => x.version === version);
    return v ? { attestation: v.attestation, coreTested: v.coreTested } : null;
  }

  add(url: string, signingKeys?: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PluginServiceError('invalid', 'the catalog url is not a url');
    }
    const insecureOk = this.c.deps.config.nodeEnv !== 'production';
    const fine =
      parsed.protocol === 'https:' ||
      (insecureOk && (parsed.protocol === 'http:' || parsed.protocol === 'file:'));
    if (!fine) {
      throw new PluginServiceError('invalid', 'catalog urls must be https');
    }
    if (signingKeys !== undefined) {
      if (url === this.c.deps.config.pluginCatalogUrl) {
        throw new PluginServiceError(
          'invalid',
          "the official catalog's key is set by TRANSCODA_PLUGIN_CATALOG_KEY",
        );
      }
      try {
        if (parseSigningKeys(signingKeys).length === 0) throw new Error('expected <id>:<64 hex>');
      } catch (err) {
        throw new PluginServiceError('invalid', messageOf(err));
      }
      if (url.includes('?') || url.includes('#')) {
        throw new PluginServiceError('invalid', 'a signed catalog url may not have a query string');
      }
    }
    addCatalog(this.c.deps.db, url, signingKeys ?? null, this.c.deps.now());
  }

  /**
   * Keys a catalog must be signed with; null: unsigned. The official catalog uses the pinned keys,
   * a custom catalog the `<id>:<hex>[,...]` keys it was added with.
   */
  keysFor(url: string): readonly SigningKey[] | null {
    if (url === this.c.deps.config.pluginCatalogUrl) return this.c.deps.config.pluginCatalogKeys;
    const stored = listCatalogs(this.c.deps.db).find((c) => c.url === url)?.signingKeys ?? null;
    if (stored === null) return null;
    try {
      return parseSigningKeys(stored);
    } catch {
      return []; // unreadable stored keys verify nothing: never "unsigned"
    }
  }

  remove(url: string): void {
    if (url === this.c.deps.config.pluginCatalogUrl) {
      throw new PluginServiceError('invalid', 'the official catalog cannot be removed');
    }
    removeCatalog(this.c.deps.db, url);
  }

  async find(
    catalogUrl: string,
    name: string,
    version: string,
  ): Promise<
    | { ok: true; version: NonNullable<Awaited<ReturnType<CatalogClient['find']>>> }
    | { ok: false; reason: string }
  > {
    // A cached index may predate the release: look again, once, before saying it is not there.
    const v =
      (await this.client.find([catalogUrl], name, version)) ??
      (await this.client.find([catalogUrl], name, version, { refresh: true }));
    if (v === null) return { ok: false, reason: `${name} ${version} is not in that catalog` };
    if (!semver.satisfies(this.c.sdkVersion, v.sdk, { includePrerelease: true })) {
      return {
        ok: false,
        reason: `sdk ${v.sdk} is not supported by this server (sdk ${this.c.sdkVersion})`,
      };
    }
    return { ok: true, version: v };
  }
}
