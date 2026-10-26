// PluginService: the one place that ties the installer, the catalog, the supervisor, the settings
// crypto, the node registry and the plugin tables together. Install, update, remove, settings and
// the catalog are admin-session operations (the API layer enforces that; they are never a token
// scope and never an MCP tool). Secrets: stored only sealed, opened only to hand to a plugin
// process and the fetch proxy, never logged, never returned.
import { realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import type {
  PluginCatalogOutputSchema,
  PluginDetail,
  PluginSettingsGetOutput,
  PluginSummary,
  PluginTestOutput,
  WorkflowRef,
} from '@transcoda/contract';
import {
  NODE_KINDS,
  type NodeKind,
  type NodeMetadata,
  SDK_VERSION,
  secretPaths,
} from '@transcoda/sdk';
import {
  type HostReady,
  type JsonValue,
  type PathMapping,
  PLUGIN_NAME_PATTERN,
  type PluginManifest,
  type PluginState,
  type SupervisorLimits,
} from '@transcoda/shared';
import semver from 'semver';
import type { z } from 'zod';
import type { Config } from '../config.ts';
import type { Database } from '../db/open.ts';
import {
  addCatalog,
  clearStartAttempts,
  deletePlugin,
  findPlugin,
  insertPlugin,
  listCatalogs,
  listPlugins,
  type PluginIntegration,
  type PluginRow,
  removeCatalog,
  setStartAttempts,
  startAttempts,
  type TriggerMetadata,
  updatePlugin,
} from '../db/repos/plugins.ts';
import type { EngineEvents } from '../engine/events.ts';
import type { Logger } from '../logger.ts';
import type { NodeRegistry, RegisteredNode } from '../nodes/registry.ts';
import { type RemoteHooks, remoteNodeDefinition } from '../nodes/remote.ts';
import type { WorkflowService } from '../workflows/service.ts';
import { stepsBetween } from '../workflows/upgrade.ts';
import { BlocklistClient, type BlockMatch } from './blocklist.ts';
import { CatalogClient, type CatalogEntry } from './catalog.ts';
import { devPluginRuntimes } from './dev.ts';
import { FetchProxy, type FetchProxyDeps } from './fetch-proxy.ts';
import type { HookTarget } from './hooks.ts';
import { Installer } from './installer.ts';
import { loadLimits } from './limits.ts';
import { blocklistInertWarning } from './official-keys.ts';
import { describeExit, type ExitReason, PluginCallError } from './process.ts';
import type { RestartTarget } from './restart-gate.ts';
import { openStoredSettings, PluginSettings, policyOf } from './settings.ts';
import { parseSigningKeys, type SigningKey } from './signature.ts';
import { type PluginRuntime, PluginSupervisor, type SupervisorDeps } from './supervisor.ts';

export type PluginCatalogOutput = z.infer<typeof PluginCatalogOutputSchema>;
export type InstallResult = { ok: true; plugin: PluginDetail } | { ok: false; reason: string };
export type UpdateCheckResult =
  | {
      ok: true;
      /**
       * Workflows whose active version (`version`) would stop running: its node version is
       * dropped, or its migration path changes behaviour and needs a review first.
       */
      wouldBreak: Array<
        WorkflowRef & { active: boolean; version: number; reason: 'dropped' | 'behaviour' }
      >;
      /** Workflows whose newest (not active) version is affected; their active version is not. */
      needsReview: WorkflowRef[];
      /** The new manifest does not list node versions: nothing can be checked. */
      unknown: boolean;
    }
  | { ok: false; reason: string };

import { PluginServiceError } from './errors.ts';

export { PluginServiceError, type PluginServiceErrorCode } from './errors.ts';

export interface PluginServiceDeps {
  db: Database;
  config: Pick<
    Config,
    | 'pluginsDir'
    | 'pluginHostPath'
    | 'pluginCatalogUrl'
    | 'pluginCatalogKeys'
    | 'pluginBlocklistUrl'
    | 'catalogToken'
    | 'devPlugins'
    | 'pluginInspect'
    | 'pluginIsolation'
    | 'nodeEnv'
  >;
  secretKey: Buffer;
  registry: NodeRegistry;
  workflows: WorkflowService;
  events: EngineEvents;
  now(): Date;
  log: Logger;
  /** Default SDK_VERSION. */
  sdkVersion?: string | undefined;
  installer?: Installer | undefined;
  catalog?: CatalogClient | undefined;
  supervisor?: PluginSupervisor | undefined;
  /** Reads a host's OS identity for the isolation check (default `/proc`); tests inject one. */
  identityOf?: SupervisorDeps['identityOf'];
  /** Fetch-proxy name resolution and address classification (tests stand loopback in for a LAN). */
  fetchAddresses?: Pick<FetchProxyDeps, 'resolve' | 'classify'> | undefined;
  /** Library roots, for `testMapping`. */
  libraryRoots(): string[];
}

type JsonObject = Record<string, JsonValue>;
type WorkflowTypes = ReturnType<WorkflowService['nodeTypesInUse']>;

interface Installed {
  name: string;
  version: string;
  enabled: boolean;
  catalogUrl: string | null;
  sha256: string;
  manifest: PluginManifest;
  nodes: NodeMetadata[];
  integration: PluginIntegration | null;
  triggers: TriggerMetadata[];
  signedBy: string | null;
  installedAt: string;
  updatedAt: string;
  /** From TRANSCODA_DEV_PLUGINS: in memory only. */
  dev: boolean;
}

const NO_ORIGINS = { allowedOrigins: [], allowInsecureTls: false };
/** The blocklist is fetched at start in the background: an offline server never waits longer. */
const BLOCKLIST_TIMEOUT_MS = 3000;
const BLOCKLIST_RECHECK_MS = 3_600_000;
/** The catalog waits this long for a build's manifest (its nodes and icon), then shows it without. */
const CATALOG_MANIFEST_TIMEOUT_MS = 10_000;
/** Catalog manifests fetched at the same time. */
const CATALOG_MANIFEST_CONCURRENCY = 4;
const blockedReason = (m: BlockMatch): string => `blocklisted: ${m.reason}`;
const _MAX_TEST_TEXT = 500;
const SHUTTING_DOWN = 'the server is shutting down';

const isObject = (v: JsonValue | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const _isSetMarker = (v: JsonValue | undefined): boolean => isObject(v) && v.set === true;

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

/**
 * The sandbox's read grant is for the exact path the host imports: a parent directory that is a
 * symlink (macOS's /var, a /config mount) would otherwise make the grant miss the file.
 */
function realOrSame(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** install/update answer a refusal as a result, like every other reason they cannot proceed. */
function refusedWhileStopping(err: unknown): InstallResult {
  if (err instanceof PluginServiceError && err.message === SHUTTING_DOWN) {
    return { ok: false, reason: SHUTTING_DOWN };
  }
  throw err;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function _issuesText(issues: Array<{ path: string; message: string }>): string {
  return issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
}

/** What `install` and `update` answer when the process did not come up. */
function startFailure(reason: ExitReason): string {
  return reason.kind === 'bad-manifest'
    ? reason.message
    : `plugin crashed on start: ${describeExit(reason)}`;
}

export class PluginService {
  private readonly installer: Installer;
  private readonly catalogClient: CatalogClient;
  private readonly supervisor: PluginSupervisor;
  private readonly limits: SupervisorLimits;
  private readonly sdkVersion: string;
  private readonly dev = new Map<string, Installed>();
  private readonly provenance = new Map<
    string,
    { attestation: string | null; coreTested: string[] }
  >();
  /** Newest compatible catalog version per installed plugin, from the last catalog fetch. */
  private readonly updates = new Map<string, string>();
  /**
   * Manifests of the catalogs' current builds by `<catalog> <name>@<version> <sha256>` (a build
   * never changes), for the nodes and icon the catalog shows; null: unreadable, tried again on a
   * refresh. Only the builds of the last catalog answer are kept.
   */
  private readonly catalogManifests = new Map<string, PluginManifest | null>();
  private readonly settings: PluginSettings;
  private readonly blocklist: BlocklistClient;
  private recheckTimer: ReturnType<typeof setInterval> | null = null;
  /** Clears the crash-loop guard's counts once this boot has stayed up for `stableMs`. */
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private startupRecheck: Promise<void> = Promise.resolve();
  private started = false;
  private stopping = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PluginServiceDeps) {
    const { config } = deps;
    this.sdkVersion = deps.sdkVersion ?? SDK_VERSION;
    this.limits = loadLimits(deps.db);
    this.installer =
      deps.installer ??
      new Installer({
        pluginsDir: config.pluginsDir,
        token: config.catalogToken,
        allowHttp: config.nodeEnv !== 'production',
      });
    this.catalogClient =
      deps.catalog ??
      new CatalogClient({
        sdkVersion: this.sdkVersion,
        token: config.catalogToken,
        cacheDir: join(config.pluginsDir, '.catalog'),
        now: deps.now,
        allowFileUrls: config.nodeEnv !== 'production',
        keysFor: (url) => this.keysFor(url),
        log: deps.log,
      });
    this.blocklist = new BlocklistClient({
      url: config.pluginBlocklistUrl,
      keys: config.pluginCatalogKeys,
      cacheDir: join(config.pluginsDir, '.catalog'),
      token: config.catalogToken,
      now: deps.now,
      timeoutMs: BLOCKLIST_TIMEOUT_MS,
      allowFileUrls: config.nodeEnv !== 'production',
      log: deps.log,
    });
    this.supervisor =
      deps.supervisor ??
      new PluginSupervisor({
        limits: this.limits,
        hostPath: config.pluginHostPath,
        now: deps.now,
        log: deps.log,
        inspect: config.pluginInspect,
        isolation: config.pluginIsolation,
        identityOf: deps.identityOf,
        fetchProxyFor: (name, policy) => {
          const proxy = new FetchProxy(name, { limits: this.limits, ...deps.fetchAddresses });
          proxy.setPolicy(policy);
          return proxy;
        },
        verify: (rt) => this.verify(rt),
        onState: (s) =>
          deps.events.publish({
            type: 'plugins.changed',
            name: s.name,
            state: s.state,
            stateReason: s.stateReason,
          }),
        onLog: (name, level, message, jobId) => {
          const entry = { msg: 'plugin log', plugin: name, level, message, jobId };
          if (level === 'warn') deps.log.warn(entry);
          else if (level === 'error') deps.log.error(entry);
          else deps.log.info(entry);
        },
      });
    this.settings = new PluginSettings({
      db: deps.db,
      isDev: (name) => this.dev.has(name),
      secretKey: deps.secretKey,
      supervisor: this.supervisor,
      now: deps.now,
      log: deps.log,
      unavailable: (name) => this.unavailable(name),
    });
  }

  // ---- lifecycle ----

  async start(): Promise<void> {
    const { log } = this.deps;
    await this.installer.ensureDir();
    const iso = this.deps.config.pluginIsolation;
    const inert = blocklistInertWarning(
      this.deps.config.pluginBlocklistUrl,
      this.deps.config.pluginCatalogKeys,
    );
    if (inert !== null) log.warn(inert);
    // Nothing staged by an earlier run stays: every start stages its own copy.
    if (iso !== null) await this.installer.cleanRunDir(iso.runDir);
    for (const line of await this.installer.audit())
      log.warn({ msg: 'plugins directory', note: line });
    // Disk only: the cached blocklist is in force before any plugin boots, and nothing waits for the network.
    await this.blocklist.loadCache();
    const rows = listPlugins(this.deps.db);
    await Promise.all(rows.map((row) => this.boot(row)));
    await this.startDev(rows.map((r) => r.name));
    this.started = true;
    for (const name of this.supervisor.running()) await this.upgradeWorkflows(name);
    this.startupRecheck = this.recheckBlocklist();
    this.recheckTimer = setInterval(() => void this.recheckBlocklist(), BLOCKLIST_RECHECK_MS);
    this.recheckTimer.unref();
    this.stableTimer = setTimeout(() => this.clearStartAttempts(), this.limits.stableMs);
    this.stableTimer.unref();
    const states = this.supervisor.statuses().map((s) => s.state);
    const count = (state: PluginState): number => states.filter((s) => s === state).length;
    log.info(
      `plugins: ${states.length} installed, ${count('running')} running, ${count('stopped')} stopped, ${count('restarting')} restarting, ${count('disabled')} disabled`,
    );
  }

  /**
   * Shutdown: nothing new starts (install, update and the rest refuse), the operation in flight
   * finishes, then every process is stopped. Safe to call twice.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.recheckTimer !== null) clearInterval(this.recheckTimer);
    this.recheckTimer = null;
    if (this.stableTimer !== null) clearTimeout(this.stableTimer);
    this.stableTimer = null;
    await this.blocklist.close();
    await this.startupRecheck;
    await this.tail;
    await this.supervisor.stopAll();
    // A clean stop: whatever ran this boot did not take the server down.
    this.clearStartAttempts();
    const iso = this.deps.config.pluginIsolation;
    if (iso !== null) await this.installer.cleanRunDir(iso.runDir);
    this.settings.close();
  }

  /**
   * Updates the limits every supervisor and fetch proxy share (the same object), effective on the
   * next call. The plugin hosts get a copy in `init` but never read the call timeout, so no
   * restart is needed.
   */
  applyLimits(patch: Partial<Pick<SupervisorLimits, 'callTimeoutMs'>>): void {
    if (patch.callTimeoutMs !== undefined) this.limits.callTimeoutMs = patch.callTimeoutMs;
  }

  /** The engine's view of returning plugins (attached by deps.ts). */
  restartTarget(): RestartTarget {
    return { comingBackIn: () => this.supervisor.comingBackIn() };
  }

  /** The job-hook runner's view of the plugins (attached by deps.ts). */
  hookTarget(): HookTarget {
    return {
      running: () => this.supervisor.running(),
      declaredHooks: (name) => this.record(name)?.manifest.hooks ?? [],
      hook: (name, hook, job) =>
        this.supervisor.hook(
          name,
          hook as 'onJobDone' | 'onJobFailed' | 'afterReplace',
          job as unknown as JsonValue,
        ),
    };
  }

  private clearStartAttempts(): void {
    try {
      clearStartAttempts(this.deps.db);
    } catch (err) {
      this.deps.log.warn({ msg: 'could not clear plugin start attempts', error: messageOf(err) });
    }
  }

  /**
   * The crash-loop guard. Every boot counts each enabled plugin it starts; a clean stop or
   * `stableMs` of uptime clears the counts. A plugin the count says was running when the server
   * died `maxCrashes` boots in a row is disabled (in the database, with a reason) instead of being
   * started again, so a plugin that takes the server down cannot keep it down. Returns that reason.
   */
  private crashLoopGuard(row: PluginRow): string | null {
    if (!row.enabled) return null;
    const { db, log } = this.deps;
    const attempts = startAttempts(db, row.name);
    if (attempts < this.limits.maxCrashes) {
      setStartAttempts(db, row.name, attempts + 1);
      return null;
    }
    updatePlugin(db, row.name, { enabled: false }, this.deps.now());
    setStartAttempts(db, row.name, 0);
    log.error({ msg: 'plugin disabled by the crash-loop guard', plugin: row.name, attempts });
    return `disabled: the server stopped unexpectedly ${attempts} times in a row while this plugin was starting or running; enable it to try again`;
  }

  private async boot(row: PluginRow): Promise<void> {
    const { log } = this.deps;
    try {
      const { settings, error } = openStoredSettings(this.deps.db, this.deps.secretKey, row.name);
      if (error !== null)
        log.warn({ msg: 'plugin settings cannot be opened', plugin: row.name, error });
      const guarded = this.crashLoopGuard(row);
      const rec = this.fromRow(guarded === null ? row : { ...row, enabled: false });
      const starting = this.supervisor.add(this.runtimeOf(rec, settings));
      // Registered right after `add` has put the plugin in the supervisor (state `starting`), so
      // the nodes never read as "not installed"; a stopped plugin keeps its nodes, unavailable.
      try {
        this.registerNodes(row.name, row.version, row.nodes);
      } catch (err) {
        // A core update may have taken one of its node types: it must not run with half its nodes.
        await starting.catch(() => undefined);
        const reason = `its nodes cannot be registered: ${messageOf(err)}`;
        log.error({ msg: 'plugin stopped', plugin: row.name, reason });
        await this.supervisor.markStopped(row.name, reason);
        return;
      }
      await starting;
      if (guarded !== null) await this.supervisor.markDisabled(row.name, guarded);
    } catch (err) {
      log.error({ msg: 'plugin could not be loaded', plugin: row.name, error: messageOf(err) });
    }
  }

  private async startDev(installed: string[]): Promise<void> {
    const { config, log } = this.deps;
    if (config.devPlugins.length === 0) return;
    const { runtimes, refused } = await devPluginRuntimes(
      config.devPlugins,
      config.pluginHostPath,
      {
        installed,
        limits: this.limits,
        sdkVersion: this.sdkVersion,
      },
    );
    for (const r of refused) {
      log.error({ msg: 'dev plugin not loaded', path: r.path, reason: r.reason });
    }
    const ts = this.deps.now().toISOString();
    await Promise.all(
      runtimes.map(async (rt) => {
        const record: Installed = {
          name: rt.name,
          version: rt.version,
          enabled: true,
          catalogUrl: null,
          sha256: rt.sha256,
          manifest: rt.manifest,
          nodes: [],
          integration: null,
          triggers: [],
          signedBy: null,
          installedAt: ts,
          updatedAt: ts,
          dev: true,
        };
        this.dev.set(rt.name, record);
        log.warn({ msg: 'dev plugin', plugin: rt.name, version: rt.version, path: rt.bundlePath });
        const ready = await this.supervisor.add(rt);
        if (ready === null || 'error' in ready) return;
        record.nodes = ready.nodes as unknown as NodeMetadata[];
        record.integration = ready.integration;
        record.triggers = ready.triggers;
        try {
          this.registerNodes(rt.name, rt.version, record.nodes);
        } catch (err) {
          log.error({ msg: 'dev plugin nodes refused', plugin: rt.name, error: messageOf(err) });
        }
      }),
    );
  }

  /**
   * Fetches the blocklist now, then stops every installed, enabled, non-dev plugin it names with
   * `blocklisted: <reason>` (a disabled one stays disabled: its next start is refused by `verify`).
   * Runs at start (in the background), hourly, and in `catalog(refresh=true)` (so a card that shows
   * a plugin as blocked never sits beside a plugin that still runs); never throws: a blocklist
   * that cannot be read blocks nothing.
   */
  async recheckBlocklist(): Promise<void> {
    try {
      await this.blocklist.refresh(true);
      await this.serial(async () => {
        for (const row of listPlugins(this.deps.db)) {
          if (!row.enabled || this.dev.has(row.name)) continue;
          const match = this.blocklist.match(row);
          const status = this.supervisor.status(row.name);
          if (match === null || status === null) continue;
          const reason = blockedReason(match);
          if (status.state === 'stopped' && status.stateReason === reason) continue;
          this.deps.log.warn({ msg: 'plugin blocklisted', plugin: row.name, reason });
          // markStopped publishes plugins.changed through the supervisor's onState.
          await this.supervisor.markStopped(row.name, reason);
        }
      });
    } catch (err) {
      if (err instanceof PluginServiceError && err.message === SHUTTING_DOWN) return;
      this.deps.log.warn({ msg: 'blocklist recheck failed', error: messageOf(err) });
    }
  }

  /** The blocklist entry that names the installed build, for the read paths; null for a dev plugin. */
  private blockedOf(rec: Installed): { reason: string; url: string | null } | null {
    if (rec.dev) return null;
    const m = this.blocklist.match(rec);
    return m === null ? null : { reason: m.reason, url: m.url };
  }

  /**
   * Before every start: the installed bundle must still be the one that was installed. With
   * isolation, the verified bytes are staged for the plugin user and the staged path is what runs;
   * a dev bundle is whatever is on disk and runs from there as the server's user.
   */
  private async verify(
    rt: PluginRuntime,
  ): Promise<{ ok: true; bundlePath: string } | { ok: false; reason: string }> {
    if (this.dev.has(rt.name)) return { ok: true, bundlePath: rt.bundlePath };
    // The blocklist comes first: a listed build never runs, whatever else is true of it.
    const listed = this.blocklist.match(rt);
    if (listed !== null) return { ok: false, reason: blockedReason(listed) };
    // B4 (ruling 4): a signed install whose catalog is gone is verified against no keys at all.
    const rec = this.record(rt.name);
    const keys =
      rec !== null && rec.signedBy !== null ? (this.keysFor(rec.catalogUrl ?? '') ?? []) : null;
    return this.prepareBundle(rt, keys);
  }

  /** `verifyInstalled`, then (isolation on, runtime not opted out) `stage`. */
  private async prepareBundle(
    rt: PluginRuntime,
    keys: readonly SigningKey[] | null,
  ): Promise<{ ok: true; bundlePath: string } | { ok: false; reason: string }> {
    const verified = await this.installer.verifyInstalled(rt.name, rt.version, rt.sha256, keys);
    if (!verified.ok) return verified;
    const iso = this.deps.config.pluginIsolation;
    if (iso === null || rt.isolated === false) return { ok: true, bundlePath: rt.bundlePath };
    try {
      const staged = await this.installer.stage(rt.name, rt.version, verified.bytes, iso.runDir);
      return { ok: true, bundlePath: staged };
    } catch (err) {
      return { ok: false, reason: `cannot stage bundle: ${messageOf(err)}` };
    }
  }

  /** Best effort: the staged copy of `name@version` goes away (no-op without isolation). */
  private async unstage(name: string, version: string): Promise<void> {
    const iso = this.deps.config.pluginIsolation;
    if (iso !== null) await this.installer.unstage(name, version, iso.runDir);
  }

  /** One lifecycle change at a time: install, update, remove, enable, disable, restart, settings. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    // Checked when the turn comes, so an operation queued behind another also sees a stop.
    const turn = async (): Promise<T> => {
      if (this.stopping) throw new PluginServiceError('invalid', SHUTTING_DOWN);
      return fn();
    };
    const run = this.tail.then(turn, turn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  // ---- reads ----

  list(): PluginSummary[] {
    return this.listing().plugins;
  }

  /**
   * The plugin list and the plugins workflows miss, from one pass over the workflows (each
   * plugin's `usedBy` would otherwise parse every graph once per plugin).
   */
  listing(): {
    plugins: PluginSummary[];
    missing: Array<{ name: string; workflows: WorkflowRef[] }>;
  } {
    const index = this.workflowIndex();
    const plugins = this.names().flatMap((name) => {
      const rec = this.record(name);
      return rec ? [this.summaryOf(rec, index)] : [];
    });
    return { plugins, missing: this.missingIn(index) };
  }

  /** Which node types each workflow uses; null before `start()` or when the lookup fails. */
  private workflowIndex(): WorkflowTypes | null {
    if (!this.started) return null;
    try {
      return this.deps.workflows.nodeTypesInUse();
    } catch (err) {
      this.deps.log.warn({ msg: 'plugin usage lookup failed', error: messageOf(err) });
      return null;
    }
  }

  get(name: string): PluginDetail | null {
    const rec = this.record(name);
    return rec ? this.detailOf(rec) : null;
  }

  /** The pid of the plugin's running process, null when it has none (for tests and diagnostics). */
  pid(name: string): number | null {
    return this.supervisor.status(name)?.pid ?? null;
  }

  /** Workflows using this plugin's nodes, with whether an active version does. [] before `start()`. */
  usage(name: string): Array<WorkflowRef & { active: boolean }> {
    const rec = this.record(name);
    return rec ? this.usageIn(rec, this.workflowIndex()) : [];
  }

  private usageIn(
    rec: Installed,
    index: WorkflowTypes | null,
  ): Array<WorkflowRef & { active: boolean }> {
    if (index === null || rec.nodes.length === 0) return [];
    const mine = new Set(rec.nodes.map((n) => n.type));
    return index.flatMap(({ workflow, types, activeTypes }) =>
      types.some((t) => mine.has(t))
        ? [{ ...workflow, active: activeTypes.some((t) => mine.has(t)) }]
        : [],
    );
  }

  /**
   * Plugins that are not installed but whose nodes live workflows use, by the `<plugin>:` prefix
   * of their node types (core's own `core:` aside), with those workflows; by name.
   */
  missing(): Array<{ name: string; workflows: WorkflowRef[] }> {
    return this.missingIn(this.workflowIndex());
  }

  private missingIn(
    index: WorkflowTypes | null,
  ): Array<{ name: string; workflows: WorkflowRef[] }> {
    if (index === null) return [];
    const installed = new Set(this.names());
    const byPlugin = new Map<string, WorkflowRef[]>();
    for (const { workflow, types } of index) {
      const prefixes = new Set(types.map((t) => t.slice(0, t.indexOf(':'))));
      for (const name of prefixes) {
        // A node type's prefix may be no plugin name at all (`0x:y`): it names no plugin to install.
        if (name === 'core' || installed.has(name) || !PLUGIN_NAME_PATTERN.test(name)) continue;
        byPlugin.set(name, [...(byPlugin.get(name) ?? []), workflow]);
      }
    }
    return [...byPlugin]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, workflows]) => ({ name, workflows }));
  }

  private names(): string[] {
    const names = new Set<string>(this.dev.keys());
    for (const row of listPlugins(this.deps.db)) names.add(row.name);
    return [...names].sort();
  }

  private fromRow(row: PluginRow): Installed {
    return { ...row, dev: false };
  }

  private record(name: string): Installed | null {
    const dev = this.dev.get(name);
    if (dev) return dev;
    const row = findPlugin(this.deps.db, name);
    return row ? this.fromRow(row) : null;
  }

  private need(name: string): Installed {
    const rec = this.record(name);
    if (!rec) throw new PluginServiceError('not-found', `plugin ${name} is not installed`);
    return rec;
  }

  private statusOf(rec: Installed): {
    state: PluginState;
    stateReason: string | null;
    nextRestartAt: string | null;
  } {
    const s = this.supervisor.status(rec.name);
    if (s) return { state: s.state, stateReason: s.stateReason, nextRestartAt: s.nextRestartAt };
    return { state: rec.enabled ? 'starting' : 'disabled', stateReason: null, nextRestartAt: null };
  }

  private summaryOf(rec: Installed, index = this.workflowIndex()): PluginSummary {
    return {
      name: rec.name,
      version: rec.version,
      enabled: rec.enabled,
      ...this.statusOf(rec),
      blocked: this.blockedOf(rec),
      nodes: rec.nodes.map((n) => n.type),
      hasIntegration: rec.integration !== null,
      updateAvailable: this.updates.get(rec.name) ?? null,
      catalogUrl: rec.catalogUrl,
      installedAt: rec.installedAt,
      updatedAt: rec.updatedAt,
      icon: rec.manifest.icon ?? null,
      usedBy: this.usageIn(rec, index),
      lastTest: rec.integration ? this.settings.lastTest(rec.name) : null,
    };
  }

  private detailOf(rec: Installed): PluginDetail {
    const i = rec.integration;
    const id = i?.id ?? rec.manifest.integration ?? '';
    const known = this.provenance.get(rec.name);
    return {
      ...this.summaryOf(rec),
      manifest: rec.manifest,
      integration: i
        ? {
            id,
            title: i.title ?? id,
            settingsSchema: i.settingsSchema,
            requires: i.requires ?? null,
          }
        : null,
      triggers: rec.triggers.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        icon: t.icon,
      })),
      provenance: {
        sha256: rec.sha256,
        attestation: known?.attestation ?? null,
        coreTested: known?.coreTested ?? [],
        signedBy: rec.signedBy,
      },
    };
  }

  // ---- nodes ----

  private unavailable(name: string): string | null {
    const s = this.supervisor.status(name);
    if (!s) return `plugin ${name} is not installed`;
    if (s.state === 'running') return null;
    if (s.state === 'disabled') return `plugin ${name} is disabled`;
    return `plugin ${name} is not running: ${s.stateReason ?? s.state}`;
  }

  private hooksFor(name: string): RemoteHooks {
    return {
      call: async (hook, nodeType, nodeVersion, ctx, settings, opts) => {
        try {
          const r = await this.supervisor.call(
            name,
            { type: 'call', hook, nodeType, nodeVersion, ctx, settings },
            {
              ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
              signal: opts.signal,
            },
          );
          return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error };
        } catch (err) {
          if (err instanceof PluginCallError) {
            return { ok: false, error: { message: err.message, retryable: err.retryable } };
          }
          throw err;
        }
      },
    };
  }

  private nodeEntries(name: string, version: string, nodes: NodeMetadata[]): RegisteredNode[] {
    for (const meta of nodes) {
      if (!meta.type.startsWith(`${name}:`)) {
        throw new Error(`node type ${meta.type} does not start with ${name}:`);
      }
    }
    return nodes.map((meta) => ({
      def: remoteNodeDefinition(
        meta,
        { kind: 'plugin', name, version },
        this.hooksFor(name),
        this.limits,
      ),
      source: { kind: 'plugin', name, version },
      unavailable: () => this.unavailable(name),
    }));
  }

  private registerNodes(name: string, version: string, nodes: NodeMetadata[]): void {
    this.deps.registry.add(this.nodeEntries(name, version, nodes));
  }

  // ---- runtime assembly ----

  private runtimeOf(rec: Installed, settings: JsonObject): PluginRuntime {
    return {
      name: rec.name,
      version: rec.version,
      bundlePath: rec.dev ? '' : realOrSame(this.installer.bundlePath(rec.name, rec.version)),
      sha256: rec.sha256,
      manifest: rec.manifest,
      settings,
      policy: policyOf(rec.integration, settings),
      enabled: rec.enabled,
      secretKeys: rec.integration ? secretPaths(rec.integration.settingsSchema) : [],
    };
  }

  // ---- catalog ----

  private catalogUrls(): string[] {
    return [
      ...new Set([
        this.deps.config.pluginCatalogUrl,
        ...listCatalogs(this.deps.db).map((c) => c.url),
      ]),
    ];
  }

  async catalog(refresh: boolean): Promise<PluginCatalogOutput> {
    const urls = this.catalogUrls();
    if (refresh) await this.recheckBlocklist();
    else await this.blocklist.refresh(false);
    const { entries, errors, catalogs } = await this.catalogClient.list(urls, { refresh });
    this.updates.clear();
    const installed = new Map(this.names().map((n) => [n, this.record(n)?.version ?? null]));
    const manifests = await this.catalogManifestsFor(entries, refresh);
    const out: PluginCatalogOutput = {
      catalogs: catalogs.map((c) => {
        const mine = entries.filter((e) => e.catalogUrl === c.catalogUrl);
        return {
          catalogUrl: c.catalogUrl,
          official: c.catalogUrl === this.deps.config.pluginCatalogUrl,
          signed: this.keysFor(c.catalogUrl) !== null,
          keyIds: this.keysFor(c.catalogUrl)?.map((k) => k.id) ?? [],
          error: errors.find((e) => e.catalogUrl === c.catalogUrl)?.message ?? null,
          ...(c.fetchedAt !== null ? { fetchedAt: c.fetchedAt } : {}),
          plugins: mine.map((e) =>
            this.catalogEntry(e, installed.get(e.name) ?? null, manifests.get(e) ?? null),
          ),
        };
      }),
      blocklist: { url: this.blocklist.url, ...this.blocklist.status() },
    };
    return out;
  }

  private catalogEntry(
    e: CatalogEntry,
    installed: string | null,
    manifest: PluginManifest | null,
  ): PluginCatalogOutput['catalogs'][number]['plugins'][number] {
    const latest = latestOf(e);
    if (installed !== null) {
      const known = this.provenanceOf(e, installed);
      if (known !== null) this.provenance.set(e.name, known);
      if (latest !== null && semver.gt(latest, installed)) this.updates.set(e.name, latest);
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
    const official = this.deps.config.pluginCatalogUrl;
    const wanted = builds.filter(({ e, key }) => {
      const known = this.catalogManifests.get(key);
      if (known !== undefined && (known !== null || !refresh)) return false;
      return refresh || e.catalogUrl === official;
    });
    await eachLimited(wanted, CATALOG_MANIFEST_CONCURRENCY, async ({ e, v, key }) => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), CATALOG_MANIFEST_TIMEOUT_MS);
      try {
        const r = await this.installer.fetchManifest(
          { name: e.name, version: v.version, manifestUrl: v.manifestUrl },
          this.sdkVersion,
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
      (sameAsInstalled ? (this.record(name)?.nodes ?? []) : []).map((n) => [n.type, n]),
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
    const m = this.blocklist.match({ name, version: v.version, sha256: v.sha256 });
    return m === null ? null : { reason: m.reason, url: m.url };
  }

  private provenanceOf(
    e: CatalogEntry,
    version: string,
  ): { attestation: string | null; coreTested: string[] } | null {
    const v = e.versions.find((x) => x.version === version);
    return v ? { attestation: v.attestation, coreTested: v.coreTested } : null;
  }

  addCatalog(url: string, signingKeys?: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PluginServiceError('invalid', 'the catalog url is not a url');
    }
    const insecureOk = this.deps.config.nodeEnv !== 'production';
    const fine =
      parsed.protocol === 'https:' ||
      (insecureOk && (parsed.protocol === 'http:' || parsed.protocol === 'file:'));
    if (!fine) {
      throw new PluginServiceError('invalid', 'catalog urls must be https');
    }
    if (signingKeys !== undefined) {
      if (url === this.deps.config.pluginCatalogUrl) {
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
    addCatalog(this.deps.db, url, signingKeys ?? null, this.deps.now());
  }

  /**
   * Keys a catalog must be signed with; null: unsigned. The official catalog uses the pinned keys,
   * a custom catalog the `<id>:<hex>[,...]` keys it was added with.
   */
  private keysFor(url: string): readonly SigningKey[] | null {
    if (url === this.deps.config.pluginCatalogUrl) return this.deps.config.pluginCatalogKeys;
    const stored = listCatalogs(this.deps.db).find((c) => c.url === url)?.signingKeys ?? null;
    if (stored === null) return null;
    try {
      return parseSigningKeys(stored);
    } catch {
      return []; // unreadable stored keys verify nothing: never "unsigned"
    }
  }

  removeCatalog(url: string): void {
    if (url === this.deps.config.pluginCatalogUrl) {
      throw new PluginServiceError('invalid', 'the official catalog cannot be removed');
    }
    removeCatalog(this.deps.db, url);
  }

  // ---- install, update, remove ----

  install(input: { name: string; version: string; catalogUrl: string }): Promise<InstallResult> {
    return this.serial(() => this.doInstall(input)).catch(refusedWhileStopping);
  }

  private async doInstall(input: {
    name: string;
    version: string;
    catalogUrl: string;
  }): Promise<InstallResult> {
    const { name, version, catalogUrl } = input;
    const { db, registry } = this.deps;
    if (this.record(name) !== null)
      return { ok: false, reason: `plugin ${name} is already installed` };
    if (!this.catalogUrls().includes(catalogUrl)) {
      return { ok: false, reason: 'that catalog is not one of the configured catalogs' };
    }
    const found = await this.findInCatalog(catalogUrl, name, version);
    if (!found.ok) return found;
    const listed = this.blocklist.match({ name, version, sha256: found.version.sha256 });
    if (listed !== null) return { ok: false, reason: blockedReason(listed) };
    // No row, so any files under this name are leftovers of a crash: clear them for a clean write.
    await this.installer.remove(name, version).catch(() => undefined);
    const dl = await this.installer.download(
      { name, ...found.version, keys: this.keysFor(catalogUrl) },
      this.sdkVersion,
    );
    if (!dl.ok) {
      return { ok: false, reason: dl.reason === 'checksum' ? 'checksum mismatch' : dl.message };
    }
    const runtime: PluginRuntime = {
      name,
      version,
      bundlePath: realOrSame(dl.bundlePath),
      sha256: found.version.sha256,
      manifest: dl.manifest,
      settings: {},
      policy: { ...NO_ORIGINS },
      enabled: true,
      secretKeys: [],
    };
    const rollback = async (reason: string): Promise<InstallResult> => {
      await this.supervisor.remove(name).catch(() => undefined);
      registry.removeBySource(name);
      deletePlugin(db, name);
      await this.installer.remove(name, version).catch(() => undefined);
      await this.unstage(name, version);
      return { ok: false, reason };
    };
    let ready: HostReady | { error: ExitReason } | null;
    try {
      ready = await this.supervisor.add(runtime);
    } catch (err) {
      return rollback(messageOf(err));
    }
    if (ready === null || 'error' in ready) {
      return rollback(startFailure(ready === null ? { kind: 'stopped' } : ready.error));
    }
    const nodes = ready.nodes as unknown as NodeMetadata[];
    try {
      this.registerNodes(name, version, nodes);
      insertPlugin(
        db,
        {
          name,
          version,
          enabled: true,
          catalogUrl,
          sha256: found.version.sha256,
          manifest: dl.manifest,
          nodes,
          integration: ready.integration,
          triggers: ready.triggers,
          signedBy: dl.signedBy,
        },
        this.deps.now(),
      );
    } catch (err) {
      return rollback(messageOf(err));
    }
    // Fresh install: no settings yet, but literal origins (an API host) apply from the start.
    this.supervisor.setPolicy(name, policyOf(ready.integration, {}));
    this.provenance.set(name, {
      attestation: found.version.attestation,
      coreTested: found.version.coreTested,
    });
    this.publish(name);
    this.deps.log.info({ msg: 'plugin installed', plugin: name, version });
    await this.upgradeWorkflows(name);
    return { ok: true, plugin: this.detailOrThrow(name) };
  }

  update(name: string, version: string): Promise<InstallResult> {
    return this.serial(() => this.doUpdate(name, version)).catch(refusedWhileStopping);
  }

  private async doUpdate(name: string, version: string): Promise<InstallResult> {
    const { db, registry } = this.deps;
    const rec = this.need(name);
    if (rec.dev) return { ok: false, reason: `${name} is a dev plugin; rebuild it instead` };
    if (rec.version === version)
      return { ok: false, reason: `${name} ${version} is already installed` };
    if (rec.catalogUrl === null || !this.catalogUrls().includes(rec.catalogUrl)) {
      return { ok: false, reason: 'the catalog this plugin came from is no longer configured' };
    }
    const found = await this.findInCatalog(rec.catalogUrl, name, version);
    if (!found.ok) return found;
    const listed = this.blocklist.match({ name, version, sha256: found.version.sha256 });
    if (listed !== null) return { ok: false, reason: blockedReason(listed) };
    const dl = await this.installer.download(
      { name, ...found.version, keys: this.keysFor(rec.catalogUrl) },
      this.sdkVersion,
    );
    if (!dl.ok) {
      return { ok: false, reason: dl.reason === 'checksum' ? 'checksum mismatch' : dl.message };
    }
    const discardFiles = async () => {
      await this.installer.remove(name, version).catch(() => undefined);
      await this.unstage(name, version);
    };
    const { settings } = openStoredSettings(this.deps.db, this.deps.secretKey, name);
    const next: PluginRuntime = {
      ...this.runtimeOf(rec, settings),
      version,
      bundlePath: realOrSame(dl.bundlePath),
      sha256: found.version.sha256,
      manifest: dl.manifest,
    };
    // `startCandidate` bypasses the supervisor's verify seam: the same verify-and-stage runs here.
    const prepared = await this.prepareBundle(
      next,
      dl.signedBy === null ? null : this.keysFor(rec.catalogUrl),
    );
    if (!prepared.ok) {
      await discardFiles();
      return { ok: false, reason: prepared.reason };
    }
    next.bundlePath = prepared.bundlePath;
    const candidate = await this.supervisor.startCandidate(name, next);
    if ('error' in candidate) {
      await discardFiles();
      return { ok: false, reason: startFailure(candidate.error) };
    }
    const nodes = candidate.ready.nodes as unknown as NodeMetadata[];
    let entries: RegisteredNode[];
    try {
      // Everything that can refuse happens before the old version is touched.
      const types = new Set<string>();
      for (const meta of nodes) {
        if (types.has(meta.type)) throw new Error(`node type ${meta.type} is provided twice`);
        types.add(meta.type);
        const existing = registry.get(meta.type);
        if (existing && !(existing.source.kind === 'plugin' && existing.source.name === name)) {
          const by = existing.source.kind === 'core' ? 'core' : `plugin ${existing.source.name}`;
          throw new Error(`node type ${meta.type} is already provided by ${by}`);
        }
      }
      entries = this.nodeEntries(name, version, nodes);
    } catch (err) {
      await candidate.discard();
      await discardFiles();
      return { ok: false, reason: messageOf(err) };
    }
    const oldNodes = registry
      .list()
      .filter((n) => n.source.kind === 'plugin' && n.source.name === name);
    // The swap: the new process takes over, and in the same tick the new definitions replace the old.
    const committed = candidate.commit();
    registry.removeBySource(name);
    try {
      registry.add(entries);
    } catch (err) {
      // Not expected (checked above); if it happens the old definitions are back, and the plugin,
      // already running the new bundle, is stopped rather than serving them.
      registry.add(oldNodes);
      await committed.catch(() => undefined);
      await this.supervisor.markStopped(
        name,
        `update could not register its nodes: ${messageOf(err)}`,
      );
      return { ok: false, reason: messageOf(err) };
    }
    await committed;
    updatePlugin(
      db,
      name,
      {
        version,
        sha256: found.version.sha256,
        manifest: dl.manifest,
        nodes,
        integration: candidate.ready.integration,
        triggers: candidate.ready.triggers,
        signedBy: dl.signedBy,
      },
      this.deps.now(),
    );
    this.supervisor.setPolicy(name, policyOf(candidate.ready.integration, settings));
    await this.unstage(name, rec.version);
    // A disabled plugin only took the new bundle: it stages again when it is enabled.
    if (!rec.enabled) await this.unstage(name, version);
    await this.installer.remove(name, rec.version).catch((err: unknown) => {
      this.deps.log.warn({
        msg: 'old plugin files not removed',
        plugin: name,
        error: messageOf(err),
      });
    });
    this.provenance.set(name, {
      attestation: found.version.attestation,
      coreTested: found.version.coreTested,
    });
    this.updates.delete(name);
    this.publish(name);
    this.deps.log.info({ msg: 'plugin updated', plugin: name, from: rec.version, to: version });
    await this.upgradeWorkflows(name);
    return { ok: true, plugin: this.detailOrThrow(name) };
  }

  /**
   * Writes new workflow versions for plugin nodes pinned to older node versions, through the
   * plugin's own `migrate`. Best effort: a failure is logged and never refuses the plugin action.
   */
  private async upgradeWorkflows(name: string): Promise<void> {
    const rec = this.record(name);
    if (!rec || rec.nodes.length === 0 || this.supervisor.status(name)?.state !== 'running') return;
    try {
      await this.deps.workflows.upgradePluginNodes(
        rec.nodes.map((n) => n.type),
        async (nodeType, from, settings) => {
          const r = await this.supervisor.migrate(name, nodeType, from, settings);
          if (!r.ok) throw new Error(r.error.message);
          const out = r.result;
          if (!isObject(out) || out.settings === undefined) {
            throw new Error(`plugin ${name} answered migrate without settings`);
          }
          return out.settings;
        },
      );
    } catch (err) {
      this.deps.log.warn({
        msg: 'plugin node upgrades failed',
        plugin: name,
        error: messageOf(err),
      });
    }
  }

  /**
   * Which workflows an update to `version` would affect, from the new release's manifest alone
   * (nothing is installed or started). Refusals are the ones `update` gives.
   */
  async updateCheck(name: string, version: string): Promise<UpdateCheckResult> {
    const rec = this.need(name);
    if (rec.dev) return { ok: false, reason: `${name} is a dev plugin; rebuild it instead` };
    if (rec.version === version)
      return { ok: false, reason: `${name} ${version} is already installed` };
    if (rec.catalogUrl === null || !this.catalogUrls().includes(rec.catalogUrl)) {
      return { ok: false, reason: 'the catalog this plugin came from is no longer configured' };
    }
    const found = await this.findInCatalog(rec.catalogUrl, name, version);
    if (!found.ok) return found;
    const fetched = await this.installer.fetchManifest({ name, ...found.version }, this.sdkVersion);
    if (!fetched.ok) return { ok: false, reason: fetched.message };
    const served = fetched.manifest.nodeVersions;
    if (served === undefined) return { ok: true, wouldBreak: [], needsReview: [], unknown: true };
    const wouldBreak = new Map<
      string,
      WorkflowRef & { active: boolean; version: number; reason: 'dropped' | 'behaviour' }
    >();
    const needsReview = new Map<string, WorkflowRef>();
    for (const entry of this.deps.workflows.pinnedNodes(rec.nodes.map((n) => n.type))) {
      let noPath = false;
      let behaviour = false;
      for (const node of entry.nodes) {
        const next = served.find((s) => s.type === node.type);
        const steps = next ? stepsBetween(next.migrations, node.typeVersion, next.version) : null;
        if (steps === null) noPath = true;
        else if (steps.some((st) => st.risk !== 'safe')) behaviour = true;
      }
      const ref = { id: entry.workflow.id, name: entry.workflow.name };
      if (entry.active && (noPath || behaviour)) {
        // Never "keeps running": a dropped version has no path, a behaviour step is held.
        const dropped = noPath || wouldBreak.get(ref.id)?.reason === 'dropped';
        wouldBreak.set(ref.id, {
          ...ref,
          active: true,
          version: entry.version,
          reason: dropped ? 'dropped' : 'behaviour',
        });
      } else if (noPath || behaviour) needsReview.set(ref.id, ref);
    }
    const byName = (a: WorkflowRef, b: WorkflowRef) => a.name.localeCompare(b.name);
    return {
      ok: true,
      wouldBreak: [...wouldBreak.values()].sort(byName),
      needsReview: [...needsReview.values()].filter((w) => !wouldBreak.has(w.id)).sort(byName),
      unknown: false,
    };
  }

  remove(name: string): Promise<void> {
    return this.serial(async () => {
      const rec = this.need(name);
      if (rec.dev) {
        throw new PluginServiceError(
          'invalid',
          `${name} is a dev plugin: remove it from TRANSCODA_DEV_PLUGINS`,
        );
      }
      await this.supervisor.remove(name);
      this.deps.registry.removeBySource(name);
      deletePlugin(this.deps.db, name);
      await this.unstage(name, rec.version);
      await this.installer.remove(name, rec.version);
      this.provenance.delete(name);
      this.updates.delete(name);
      // The state enum has no `removed` (widening it would reach the contract and the web), so a
      // removal is `disabled` with the reason `removed`; clients refetch the list on any
      // plugins.changed and the plugin is simply gone from it.
      this.deps.events.publish({
        type: 'plugins.changed',
        name,
        state: 'disabled',
        stateReason: 'removed',
      });
      this.deps.log.info({ msg: 'plugin removed', plugin: name, version: rec.version });
    });
  }

  enable(name: string): Promise<PluginDetail> {
    return this.serial(async () => {
      const rec = this.need(name);
      if (!rec.dev) {
        updatePlugin(this.deps.db, name, { enabled: true }, this.deps.now());
        // An explicit retry: the crash-loop guard starts counting again.
        setStartAttempts(this.deps.db, name, 0);
      }
      await this.supervisor.enable(name);
      await this.upgradeWorkflows(name);
      return this.detailOrThrow(name);
    });
  }

  disable(name: string): Promise<PluginDetail> {
    return this.serial(async () => {
      const rec = this.need(name);
      if (!rec.dev) updatePlugin(this.deps.db, name, { enabled: false }, this.deps.now());
      await this.supervisor.disable(name);
      if (!rec.dev) await this.unstage(name, rec.version);
      return this.detailOrThrow(name);
    });
  }

  restart(name: string): Promise<PluginDetail> {
    return this.serial(async () => {
      this.need(name);
      try {
        await this.supervisor.restart(name);
      } catch (err) {
        throw new PluginServiceError('not-running', messageOf(err));
      }
      return this.detailOrThrow(name);
    });
  }

  private detailOrThrow(name: string): PluginDetail {
    const detail = this.get(name);
    if (!detail) throw new PluginServiceError('not-found', `plugin ${name} is not installed`);
    return detail;
  }

  private publish(name: string): void {
    const s = this.supervisor.status(name);
    this.deps.events.publish({
      type: 'plugins.changed',
      name,
      state: s?.state ?? 'disabled',
      stateReason: s?.stateReason ?? null,
    });
  }

  private async findInCatalog(
    catalogUrl: string,
    name: string,
    version: string,
  ): Promise<
    | { ok: true; version: NonNullable<Awaited<ReturnType<CatalogClient['find']>>> }
    | { ok: false; reason: string }
  > {
    // A cached index may predate the release: look again, once, before saying it is not there.
    const v =
      (await this.catalogClient.find([catalogUrl], name, version)) ??
      (await this.catalogClient.find([catalogUrl], name, version, { refresh: true }));
    if (v === null) return { ok: false, reason: `${name} ${version} is not in that catalog` };
    if (!semver.satisfies(this.sdkVersion, v.sdk, { includePrerelease: true })) {
      return {
        ok: false,
        reason: `sdk ${v.sdk} is not supported by this server (sdk ${this.sdkVersion})`,
      };
    }
    return { ok: true, version: v };
  }

  // ---- settings (plugins/settings.ts) ----

  getSettings(name: string): PluginSettingsGetOutput {
    return this.settings.get(this.need(name));
  }

  saveSettings(name: string, input: JsonValue): Promise<PluginSettingsGetOutput> {
    return this.serial(() => this.settings.save(this.need(name), input));
  }

  testSettings(name: string, input: JsonValue): Promise<PluginTestOutput> {
    return this.serial(() => this.settings.test(this.need(name), input));
  }

  /** The local side of a path mapping must be a directory inside a library root. */
  testMapping(name: string, mapping: PathMapping): { ok: boolean; message: string } {
    this.need(name);
    let real: string;
    try {
      real = realpathSync(mapping.local);
    } catch {
      return { ok: false, message: `${mapping.local} does not exist` };
    }
    try {
      if (!statSync(real).isDirectory()) {
        return { ok: false, message: `${mapping.local} is not a directory` };
      }
    } catch {
      return { ok: false, message: `${mapping.local} cannot be read` };
    }
    for (const root of this.deps.libraryRoots()) {
      let rootReal: string;
      try {
        rootReal = realpathSync(root);
      } catch {
        continue;
      }
      if (
        real === rootReal ||
        real.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep)
      ) {
        return { ok: true, message: `${mapping.local} is inside the library ${root}` };
      }
    }
    return { ok: false, message: `${mapping.local} is not inside any library` };
  }
}
