// PluginService: the one place that ties the installer, the catalog, the supervisor, the settings
// crypto, the node registry and the plugin tables together. Install, update, remove, settings and
// the catalog are admin-session operations (the API layer enforces that; they are never a token
// scope and never an MCP tool). Secrets: stored only sealed, opened only to hand to a plugin
// process and the fetch proxy, never logged, never returned. Install and update are in
// `install.ts` and `update.ts`, the catalogs in `catalogs.ts`, the list rows in `listing.ts`.
import { join } from 'node:path';
import type {
  PluginDetail,
  PluginSettingsGetOutput,
  PluginSummary,
  PluginTestOutput,
  WorkflowRef,
} from '@transcoda/contract';
import { type NodeMetadata, SDK_VERSION, secretPaths } from '@transcoda/sdk';
import type { JsonValue, PathMapping, PluginState, SupervisorLimits } from '@transcoda/shared';
import {
  clearStartAttempts,
  deletePlugin,
  findPlugin,
  listPlugins,
  type PluginRow,
  setStartAttempts,
  startAttempts,
  updatePlugin,
} from '../../db/repos/plugins.ts';
import type { RegisteredNode } from '../../nodes/registry.ts';
import { type RemoteHooks, remoteNodeDefinition } from '../../nodes/remote.ts';
import type { SigningKey } from '../../platform/signing-keys.ts';
import { PluginServiceError } from '../errors.ts';
import { Installer } from '../installer.ts';
import { FetchProxy } from '../network/fetch-proxy.ts';
import { devPluginRuntimes } from '../runtime/dev.ts';
import type { HookTarget } from '../runtime/hooks.ts';
import { loadLimits } from '../runtime/limits.ts';
import { PluginCallError } from '../runtime/process.ts';
import type { RestartTarget } from '../runtime/restart-gate.ts';
import { type PluginRuntime, PluginSupervisor } from '../runtime/supervisor.ts';
import { openStoredSettings, PluginSettings, policyOf } from '../settings.ts';
import { BlocklistClient } from '../trust/blocklist.ts';
import { blocklistInertWarning } from '../trust/official-keys.ts';
import { PluginCatalogs, UPDATE_CHECK_DELAY_MS, UPDATE_CHECK_MS } from './catalogs.ts';
import { blockedReason, libraryCheck, messageOf, realOrSame } from './helpers.ts';
import { doInstall } from './install.ts';
import { detailOf, missingIn, type RowParts, summaryOf, usageIn } from './listing.ts';
import type { ServiceOps } from './ops.ts';
import { type PluginTrigger, pluginTrigger } from './triggers.ts';
import type {
  Installed,
  InstallResult,
  JsonObject,
  PluginCatalogOutput,
  PluginServiceDeps,
  Provenance,
  UpdateCheckResult,
  WorkflowTypes,
} from './types.ts';
import { doUpdate, updateCheck, upgradeWorkflows } from './update.ts';

export { PluginServiceError } from '../errors.ts';
export { UPDATE_CHECK_DELAY_MS, UPDATE_CHECK_MS } from './catalogs.ts';
export type { PluginServiceDeps } from './types.ts';

/** The blocklist is fetched at start in the background: an offline server never waits longer. */
const BLOCKLIST_TIMEOUT_MS = 3000;
const BLOCKLIST_RECHECK_MS = 3_600_000;
const SHUTTING_DOWN = 'the server is shutting down';

/** install/update answer a refusal as a result, like every other reason they cannot proceed. */
function refusedWhileStopping(err: unknown): InstallResult {
  if (err instanceof PluginServiceError && err.message === SHUTTING_DOWN) {
    return { ok: false, reason: SHUTTING_DOWN };
  }
  throw err;
}

export class PluginService {
  private readonly installer: Installer;
  private readonly catalogs: PluginCatalogs;
  private readonly supervisor: PluginSupervisor;
  private readonly limits: SupervisorLimits;
  private readonly sdkVersion: string;
  private readonly dev = new Map<string, Installed>();
  private readonly provenance = new Map<string, Provenance>();
  private readonly settings: PluginSettings;
  private readonly blocklist: BlocklistClient;
  /** What install and update work with (install.ts, update.ts). */
  private readonly ops: ServiceOps;
  /** What the list rows read (listing.ts). */
  private readonly rows: RowParts;
  private recheckTimer: ReturnType<typeof setInterval> | null = null;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private updateRun: Promise<void> = Promise.resolve();
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
    this.catalogs = new PluginCatalogs({
      deps,
      installer: this.installer,
      blocklist: this.blocklist,
      sdkVersion: this.sdkVersion,
      provenance: this.provenance,
      names: () => this.names(),
      record: (name) => this.record(name),
      publish: (name) => this.publish(name),
      recheckBlocklist: () => this.recheckBlocklist(),
      stopping: () => this.stopping,
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
      libraryCheck: (local) => libraryCheck(local, () => deps.libraryRoots()),
    });
    this.rows = {
      status: (rec) => this.statusOf(rec),
      blocked: (rec) => this.blockedOf(rec),
      updateOf: (name) => this.catalogs.updateOf(name),
      lastTest: (name) => this.settings.lastTest(name),
      provenance: (name) => this.provenance.get(name),
      workflowIndex: () => this.workflowIndex(),
    };
    this.ops = {
      deps,
      installer: this.installer,
      supervisor: this.supervisor,
      blocklist: this.blocklist,
      catalogs: this.catalogs,
      sdkVersion: this.sdkVersion,
      provenance: this.provenance,
      record: (name) => this.record(name),
      need: (name) => this.need(name),
      runtimeOf: (rec, settings) => this.runtimeOf(rec, settings),
      prepareBundle: (rt, keys) => this.prepareBundle(rt, keys),
      unstage: (name, version) => this.unstage(name, version),
      nodeEntries: (name, version, nodes) => this.nodeEntries(name, version, nodes),
      registerNodes: (name, version, nodes) => this.registerNodes(name, version, nodes),
      publish: (name) => this.publish(name),
      detailOrThrow: (name) => this.detailOrThrow(name),
    };
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
    for (const name of this.supervisor.running()) await upgradeWorkflows(this.ops, name);
    this.startupRecheck = this.recheckBlocklist();
    this.recheckTimer = setInterval(() => void this.recheckBlocklist(), BLOCKLIST_RECHECK_MS);
    this.recheckTimer.unref();
    this.scheduleUpdateCheck(UPDATE_CHECK_DELAY_MS);
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
    if (this.updateTimer !== null) clearTimeout(this.updateTimer);
    this.updateTimer = null;
    if (this.stableTimer !== null) clearTimeout(this.stableTimer);
    this.stableTimer = null;
    await this.blocklist.close();
    await this.startupRecheck;
    await this.updateRun;
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
      rec !== null && rec.signedBy !== null
        ? (this.catalogs.keysFor(rec.catalogUrl ?? '') ?? [])
        : null;
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
      return rec ? [summaryOf(rec, this.rows, index)] : [];
    });
    return { plugins, missing: missingIn(index, () => this.names()) };
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
    return rec ? detailOf(rec, this.rows) : null;
  }

  /** Trigger `id` of plugin `name`, ready to call when its webhook arrives; null when none. */
  trigger(name: string, id: string): PluginTrigger | null {
    return pluginTrigger(this.supervisor, this.record(name), id);
  }

  /** The pid of the plugin's running process, null when it has none (for tests and diagnostics). */
  pid(name: string): number | null {
    return this.supervisor.status(name)?.pid ?? null;
  }

  /** Workflows using this plugin's nodes, with whether an active version does. [] before `start()`. */
  usage(name: string): Array<WorkflowRef & { active: boolean }> {
    const rec = this.record(name);
    return rec ? usageIn(rec, this.workflowIndex()) : [];
  }

  /**
   * Plugins that are not installed but whose nodes live workflows use, by the `<plugin>:` prefix
   * of their node types (core's own `core:` aside), with those workflows; by name.
   */
  missing(): Array<{ name: string; workflows: WorkflowRef[] }> {
    return missingIn(this.workflowIndex(), () => this.names());
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

  // ---- catalog (catalogs.ts) ----

  catalog(refresh: boolean): Promise<PluginCatalogOutput> {
    return this.catalogs.catalog(refresh);
  }

  /** The background update check (see `PluginCatalogs.checkUpdates`); never throws. */
  checkUpdates(): Promise<void> {
    return this.catalogs.checkUpdates();
  }

  private scheduleUpdateCheck(ms: number): void {
    this.updateTimer = setTimeout(() => {
      this.updateRun = this.checkUpdates().then(() => {
        if (!this.stopping) this.scheduleUpdateCheck(UPDATE_CHECK_MS);
      });
    }, ms);
    this.updateTimer.unref();
  }

  addCatalog(url: string, signingKeys?: string): void {
    this.catalogs.add(url, signingKeys);
  }

  removeCatalog(url: string): void {
    this.catalogs.remove(url);
  }

  // ---- install, update, remove (install.ts, update.ts) ----

  install(input: { name: string; version: string; catalogUrl: string }): Promise<InstallResult> {
    return this.serial(() => doInstall(this.ops, input)).catch(refusedWhileStopping);
  }

  update(name: string, version: string): Promise<InstallResult> {
    return this.serial(() => doUpdate(this.ops, name, version)).catch(refusedWhileStopping);
  }

  /**
   * Which workflows an update to `version` would affect, from the new release's manifest alone
   * (nothing is installed or started). Refusals are the ones `update` gives.
   */
  updateCheck(name: string, version: string): Promise<UpdateCheckResult> {
    return updateCheck(this.ops, name, version);
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
      this.catalogs.forgetUpdate(name);
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
      await upgradeWorkflows(this.ops, name);
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
    return libraryCheck(mapping.local, () => this.deps.libraryRoots());
  }
}
