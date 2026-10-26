import { secretPaths } from '@transcoda/sdk';
import type {
  FetchInput,
  FetchPolicy,
  FetchResult,
  HostReady,
  HostResult,
  JsonValue,
  PluginManifest,
  PluginState,
  SupervisorLimits,
} from '@transcoda/shared';
import type { PluginIsolation } from '../config.ts';
import type { Logger } from '../logger.ts';
import { createRedactor } from '../plugin-host/redact.ts';
import { secretValues } from './crypto.ts';
import { isolationViolation, type ProcessIdentity, processIdentity } from './isolation.ts';
import {
  type CallOptions,
  type ChildLike,
  defaultRssOf,
  describeExit,
  type ExitReason,
  type ForkOptions,
  forkHost,
  PluginCallError,
  PluginProcess,
  PluginStartError,
  type ServerBody,
} from './process.ts';

export interface PluginRuntime {
  name: string;
  version: string;
  bundlePath: string;
  sha256: string;
  manifest: PluginManifest;
  /** Opened (decrypted) settings. */
  settings: Record<string, JsonValue>;
  policy: FetchPolicy;
  enabled: boolean;
  /** false: the host runs as the server's user even when isolation is configured (dev plugins). Default true. */
  isolated?: boolean | undefined;
  /** Top-level secret setting keys, when the caller knows them; until `ready` brings the schema, every string value is treated as a secret. */
  secretKeys?: string[] | undefined;
}

/** A started-but-unadopted process of a new version (see `startCandidate`). */
export interface Candidate {
  ready: HostReady;
  /** The new version takes over (the old process is stopped); a disabled plugin only takes the new bundle. */
  commit(): Promise<void>;
  /** Stops the process without ever adopting it. */
  discard(): Promise<void>;
}

export interface PluginStatus {
  name: string;
  state: PluginState;
  stateReason: string | null;
  pid: number | null;
  nextRestartAt: string | null;
  crashes: number;
}

/** Structural view of Task 4/6b's FetchProxy (Task 11 passes the real class). */
export interface PluginFetcher {
  fetch(
    input: FetchInput,
    opts: {
      signal?: AbortSignal | undefined;
      override?: FetchPolicy | undefined;
      secrets?: Record<string, string> | undefined;
    },
  ): Promise<FetchResult>;
  setPolicy(p: FetchPolicy): void;
  /** The plugin's own secret values by field path; throws (field names only) when two paths are ambiguous. */
  setSecrets(values: Record<string, string>): void;
}

export interface SupervisorDeps {
  limits: SupervisorLimits;
  hostPath: string;
  now(): Date;
  log: Logger;
  fork?: (opts: ForkOptions) => ChildLike;
  rssOf?: (pid: number) => Promise<number | null>;
  rssPollMs?: number;
  fetchProxyFor(name: string, policy: FetchPolicy): PluginFetcher;
  /**
   * Before every (re)start: a reason not to start (the bundle changed on disk), or the bundle path
   * to run (the verified copy, which may be staged elsewhere for the plugin user).
   */
  verify?(
    rt: PluginRuntime,
  ): Promise<{ ok: true; bundlePath: string } | { ok: false; reason: string }>;
  /** Hosts run as this user (via setpriv); null or absent: as the server's user. */
  isolation?: PluginIsolation | null | undefined;
  /** Reads a host's OS identity for the post-start isolation check (default: `/proc/<pid>/status`). */
  identityOf?: ((pid: number | undefined) => Promise<ProcessIdentity | null>) | undefined;
  /** Host with an inspector (dev only). */
  inspect?: boolean | undefined;
  onState(status: PluginStatus): void;
  onLog(
    name: string,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    jobId: string | null,
  ): void;
}

type StartResult = HostReady | { error: ExitReason };

interface Entry {
  rt: PluginRuntime;
  proc: PluginProcess | null;
  ready: HostReady | null;
  fetcher: PluginFetcher;
  state: PluginState;
  stateReason: string | null;
  crashes: number[];
  nextRestartAt: number | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  stableTimer: ReturnType<typeof setTimeout> | null;
  /** null until the schema is known (rt.secretKeys, or the `ready` message). */
  secretKeys: string[] | null;
  /** Current and rotated-out secrets: all stay redacted. */
  secrets: string[];
  redact: (text: string) => string;
  output: Window;
  logs: Window;
}

interface Window {
  second: number;
  lines: number;
  dropped: number;
}

const MAX_SECRETS = 32;
const OUTPUT_LINES_PER_SECOND = 100;

export class PluginSupervisor {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly deps: SupervisorDeps) {}

  async add(rt: PluginRuntime): Promise<StartResult | null> {
    if (this.entries.has(rt.name)) throw new Error(`plugin ${rt.name} is already supervised`);
    const entry: Entry = {
      rt,
      proc: null,
      ready: null,
      fetcher: this.deps.fetchProxyFor(rt.name, rt.policy),
      state: 'disabled',
      stateReason: null,
      crashes: [],
      nextRestartAt: null,
      restartTimer: null,
      stableTimer: null,
      secretKeys: rt.secretKeys ?? null,
      secrets: [],
      redact: (t) => t,
      output: { second: 0, lines: 0, dropped: 0 },
      logs: { second: 0, lines: 0, dropped: 0 },
    };
    this.entries.set(rt.name, entry);
    this.noteSecrets(entry, rt.settings);
    const ambiguous = this.applySecrets(entry);
    if (ambiguous !== null) {
      this.setState(entry, 'stopped', ambiguous);
      return { error: { kind: 'bad-manifest', message: ambiguous } };
    }
    if (!rt.enabled) {
      this.setState(entry, 'disabled', null);
      return null;
    }
    return this.launch(entry, false);
  }

  async remove(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) return;
    await this.halt(entry);
    this.entries.delete(name);
  }

  async enable(name: string): Promise<StartResult> {
    const entry = this.need(name);
    entry.rt.enabled = true;
    if (entry.state === 'running' && entry.ready) return entry.ready;
    await this.halt(entry);
    entry.crashes = [];
    return this.launch(entry, false);
  }

  async disable(name: string): Promise<void> {
    const entry = this.need(name);
    entry.rt.enabled = false;
    await this.halt(entry);
    this.setState(entry, 'disabled', null);
  }

  /** Disabled by the server itself (the crash-loop guard), with the reason it shows. */
  async markDisabled(name: string, reason: string): Promise<void> {
    const entry = this.need(name);
    entry.rt.enabled = false;
    await this.halt(entry);
    this.setState(entry, 'disabled', reason);
  }

  async restart(name: string): Promise<StartResult> {
    const entry = this.need(name);
    // A disabled plugin stays disabled: enable() is the way to start it.
    if (!entry.rt.enabled) throw new Error(`plugin ${name} is disabled`);
    await this.halt(entry);
    entry.crashes = [];
    return this.launch(entry, false);
  }

  /** Reaches only the named plugin; a stopped one picks the settings up on its next start. */
  async updateSettings(
    name: string,
    settings: Record<string, JsonValue>,
    policy: FetchPolicy,
  ): Promise<void> {
    const entry = this.need(name);
    entry.rt.settings = settings;
    entry.rt.policy = policy;
    entry.fetcher.setPolicy(policy);
    this.noteSecrets(entry, settings);
    const ambiguous = this.applySecrets(entry);
    if (ambiguous !== null) {
      await this.fail(entry, ambiguous);
      return;
    }
    if (entry.state === 'running' && entry.proc) await entry.proc.sendSettings(settings);
  }

  /** The plugin cannot run for a reason only the caller knows (its nodes could not be registered). */
  async markStopped(name: string, reason: string): Promise<void> {
    await this.fail(this.need(name), reason);
  }

  /** The fetch policy alone (the origins a plugin's `ctx.fetch` may reach); no message to the host. */
  setPolicy(name: string, policy: FetchPolicy): void {
    const entry = this.need(name);
    entry.rt.policy = policy;
    entry.fetcher.setPolicy(policy);
  }

  /**
   * Starts a process for another version of `name` beside the running one (not in the name map, so
   * no status ever shows it) and waits for `ready`. `commit()` then swaps it in.
   */
  async startCandidate(
    name: string,
    rt: PluginRuntime,
  ): Promise<Candidate | { error: ExitReason }> {
    const entry = this.need(name);
    // A candidate for a running plugin replaces its process; one for a stopped plugin takes a slot.
    const full = entry.proc === null ? this.overCap(entry) : null;
    if (full !== null) return { error: { kind: 'bad-manifest', message: full } };
    const proc = this.spawn(entry, rt);
    try {
      const ready = await proc.start({
        settings: entry.rt.settings,
        manifest: rt.manifest,
        sha256: rt.sha256,
      });
      const violation = await this.isolationViolationOf(proc, rt);
      if (violation !== null) {
        void proc.stop();
        return { error: { kind: 'bad-manifest', message: violation } };
      }
      return {
        ready,
        discard: () => proc.stop(),
        commit: () => this.adopt(entry, rt, proc, ready),
      };
    } catch (err) {
      void proc.stop();
      return {
        error:
          err instanceof PluginStartError
            ? err.reason
            : { kind: 'uncaught', message: entry.redact(String(err)) },
      };
    }
  }

  status(name: string): PluginStatus | null {
    const entry = this.entries.get(name);
    return entry ? this.statusOf(entry) : null;
  }

  statuses(): PluginStatus[] {
    return [...this.entries.values()].map((e) => this.statusOf(e));
  }

  /**
   * When some plugin is starting or in restart backoff: how many ms from now it may still take to be
   * running (the rest of its backoff plus the start timeout, at the latest). null when none is
   * coming back (running, stopped, disabled and removed plugins do not count).
   */
  comingBackIn(): number | null {
    const now = this.deps.now().getTime();
    let ms: number | null = null;
    for (const e of this.entries.values()) {
      if (e.state !== 'restarting' && e.state !== 'starting') continue;
      const left = Math.max(0, (e.nextRestartAt ?? now) - now) + this.deps.limits.startTimeoutMs;
      if (ms === null || left > ms) ms = left;
    }
    return ms;
  }

  running(): string[] {
    return [...this.entries.values()].filter((e) => e.state === 'running').map((e) => e.rt.name);
  }

  async call(
    name: string,
    msg: ServerBody,
    opts: { timeoutMs?: number } & CallOptions = {},
  ): Promise<HostResult> {
    const entry = this.entries.get(name);
    const proc = entry?.state === 'running' ? entry.proc : null;
    if (!proc) {
      const why = entry ? (entry.stateReason ?? entry.state) : 'not installed';
      // A plugin in backoff or starting is coming back: the call is worth retrying.
      const coming = entry?.state === 'restarting' || entry?.state === 'starting';
      throw new PluginCallError(`plugin ${name} is not running: ${why}`, coming);
    }
    return proc.call(msg, opts.timeoutMs ?? this.timeoutFor(msg), {
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  /** `settings` may be unsaved: `policyOverride` lets the candidate's origins through for this call only. */
  async test(name: string, settings: JsonValue, policyOverride?: FetchPolicy): Promise<HostResult> {
    const entry = this.need(name);
    this.noteCandidate(entry, settings);
    // This call's fetches only: a concurrent call on the same plugin keeps the stored policy.
    return this.call(
      name,
      { type: 'test', settings },
      { fetch: { override: policyOverride, secrets: this.candidateSecrets(entry, settings) } },
    );
  }

  hook(
    name: string,
    hookName: 'onJobDone' | 'onJobFailed' | 'afterReplace',
    job: JsonValue,
  ): Promise<HostResult> {
    return this.call(name, { type: 'hook', name: hookName, job });
  }

  validate(name: string, nodeType: string | null, settings: JsonValue): Promise<HostResult> {
    const entry = this.entries.get(name);
    if (entry && nodeType === null) this.noteCandidate(entry, settings);
    return this.call(name, { type: 'validate', nodeType, settings });
  }

  /** The host migrates `settings` of a node from version `from` to the node's current one. */
  migrate(name: string, nodeType: string, from: number, settings: JsonValue): Promise<HostResult> {
    return this.call(name, { type: 'migrate', nodeType, from, settings });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => this.halt(e)));
    for (const e of this.entries.values()) this.setState(e, 'stopped', 'server stopped');
  }

  private need(name: string): Entry {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`plugin ${name} is not installed`);
    return entry;
  }

  private timeoutFor(msg: ServerBody): number {
    const l = this.deps.limits;
    switch (msg.type) {
      case 'call':
        return msg.hook === 'run' ? l.finishRunTimeoutMs : l.callTimeoutMs;
      case 'test':
        return l.testTimeoutMs;
      case 'trigger':
        return l.triggerTimeoutMs;
      case 'hook':
        return l.hookTimeoutMs;
      default:
        return l.callTimeoutMs;
    }
  }

  private statusOf(e: Entry): PluginStatus {
    return {
      name: e.rt.name,
      state: e.state,
      stateReason: e.stateReason,
      pid: e.state === 'running' ? (e.proc?.pid ?? null) : null,
      nextRestartAt: e.nextRestartAt === null ? null : new Date(e.nextRestartAt).toISOString(),
      crashes: e.crashes.length,
    };
  }

  private setState(e: Entry, state: PluginState, reason: string | null): void {
    e.state = state;
    e.stateReason = reason;
    if (state !== 'restarting') e.nextRestartAt = null;
    this.deps.onState(this.statusOf(e));
  }

  /** Stops the process and every timer without counting a crash. */
  private async halt(e: Entry): Promise<void> {
    if (e.restartTimer) clearTimeout(e.restartTimer);
    if (e.stableTimer) clearTimeout(e.stableTimer);
    e.restartTimer = null;
    e.stableTimer = null;
    e.nextRestartAt = null;
    const proc = e.proc;
    e.proc = null;
    e.ready = null;
    await proc?.stop();
  }

  /** Unsaved integration settings: their secrets are redacted from before the call. */
  private noteCandidate(e: Entry, settings: JsonValue): void {
    if (settings !== null && typeof settings === 'object' && !Array.isArray(settings)) {
      this.noteSecrets(e, settings);
    }
  }

  /** The candidate's secret values by real path (empty when `settings` is not an object). */
  private candidateSecrets(e: Entry, settings: JsonValue): Record<string, string> {
    const out: Record<string, string> = {};
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return out;
    for (const key of e.secretKeys ?? Object.keys(settings)) {
      const v = settings[key];
      if (typeof v === 'string' && v !== '') out[key] = v;
    }
    return out;
  }

  private noteSecrets(e: Entry, settings: Record<string, JsonValue>): void {
    // Until the schema says which keys are secret, every string value counts as one.
    const keys = e.secretKeys ?? Object.keys(settings);
    const fresh = secretValues(settings, keys);
    e.secrets = [...new Set([...e.secrets, ...fresh])].slice(-MAX_SECRETS);
    e.redact = createRedactor(e.secrets);
  }

  /** The real secret values of the stored settings, handed to the fetch proxy; a reason when ambiguous. */
  private applySecrets(e: Entry): string | null {
    const values: Record<string, string> = {};
    for (const key of e.secretKeys ?? []) {
      const v = e.rt.settings[key];
      if (typeof v === 'string' && v !== '') values[key] = v;
    }
    try {
      e.fetcher.setSecrets(values);
      return null;
    } catch (err) {
      return `settings cannot be used: ${err instanceof Error ? err.message : 'ambiguous secret fields'}`;
    }
  }

  /**
   * `maxHosts` bounds how many host processes run at once (each may use up to `rssMb`): why `e`
   * may not start one more, else null. Live processes of other plugins count; one in backoff does not.
   */
  private overCap(e: Entry): string | null {
    const max = this.deps.limits.maxHosts;
    let live = 0;
    for (const other of this.entries.values()) if (other !== e && other.proc !== null) live += 1;
    return live < max
      ? null
      : `too many plugins running (at most ${max}); disable another plugin or raise plugins.limits.maxHosts`;
  }

  /** Stops the process and records why the plugin cannot run (nothing restarts it). */
  private async fail(e: Entry, reason: string): Promise<void> {
    await this.halt(e);
    this.setState(e, 'stopped', reason);
  }

  /** A process over `rt`'s bundle (the entry's own, or a candidate version's), wired to the entry. */
  private spawn(e: Entry, rt: PluginRuntime = e.rt): PluginProcess {
    const { deps } = this;
    return new PluginProcess(rt.name, rt.bundlePath, deps.hostPath, {
      fork: deps.fork ?? forkHost,
      rssOf: deps.rssOf ?? defaultRssOf,
      ...(deps.rssPollMs !== undefined ? { rssPollMs: deps.rssPollMs } : {}),
      now: () => deps.now().getTime(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      log: deps.log,
      limits: deps.limits,
      // The one place a host `fetch` reaches the proxy (its secrets are set by `applySecrets`).
      fetch: (input, opts) => e.fetcher.fetch(input, opts),
      onLog: (level, message, jobId) => this.hostLog(e, level, message, jobId),
      onOutput: (stream, line) => this.output(e, stream, line),
      // The one redaction layer: PluginProcess applies it to results, logs and output lines.
      redact: (t) => e.redact(t),
      inspect: deps.inspect,
      isolation: rt.isolated === false ? null : (deps.isolation ?? null),
    });
  }

  /** With isolation in effect for `rt`: why the started host is not isolated, else null. */
  private async isolationViolationOf(
    proc: PluginProcess,
    rt: PluginRuntime,
  ): Promise<string | null> {
    const iso = rt.isolated === false ? null : (this.deps.isolation ?? null);
    if (iso === null) return null;
    const id = await (this.deps.identityOf ?? processIdentity)(proc.pid);
    const why = isolationViolation(id, iso);
    return why === null ? null : `plugin host is not isolated: ${why}`;
  }

  /** The schema is known (`ready`): real secret keys replace the broad pre-ready guess. */
  private learnSchema(e: Entry, ready: HostReady): string | null {
    e.ready = ready;
    e.secretKeys = ready.integration ? secretPaths(ready.integration.settingsSchema) : [];
    e.secrets = [];
    this.noteSecrets(e, e.rt.settings);
    return this.applySecrets(e);
  }

  /** `proc` (ready) becomes the plugin's process; the old one, if any, is stopped. */
  private async adopt(
    e: Entry,
    rt: PluginRuntime,
    proc: PluginProcess,
    ready: HostReady,
  ): Promise<void> {
    const { deps } = this;
    if (this.entries.get(rt.name) !== e) {
      await proc.stop();
      return;
    }
    const old = e.proc;
    e.rt = { ...rt, settings: e.rt.settings, policy: e.rt.policy, enabled: e.rt.enabled };
    if (!e.rt.enabled) {
      // Disabled stays disabled: the new bundle takes effect on enable.
      await proc.stop();
      return;
    }
    if (e.restartTimer) clearTimeout(e.restartTimer);
    if (e.stableTimer) clearTimeout(e.stableTimer);
    e.restartTimer = null;
    e.crashes = [];
    e.proc = proc;
    const ambiguous = this.learnSchema(e, ready);
    if (ambiguous !== null) {
      await old?.stop();
      await this.fail(e, ambiguous);
      return;
    }
    e.stableTimer = setTimeout(() => {
      e.crashes = [];
    }, deps.limits.stableMs);
    this.setState(e, 'running', null);
    void proc.exit.then((reason) => this.onExit(e, proc, reason));
    await old?.stop();
  }

  private async launch(e: Entry, isRestart: boolean): Promise<StartResult> {
    const { deps } = this;
    this.setState(e, 'starting', null);
    // Awaited only when there is something to check: the fork stays in the same tick otherwise.
    const verdict = deps.verify ? await deps.verify(e.rt) : null;
    if (verdict !== null) {
      if (!verdict.ok) {
        this.setState(e, 'stopped', verdict.reason);
        return { error: { kind: 'bad-manifest', message: verdict.reason } };
      }
      e.rt.bundlePath = verdict.bundlePath;
    }
    // Checked in the same tick as the spawn below, so two launches cannot both take the last slot.
    const full = this.overCap(e);
    if (full !== null) {
      this.setState(e, 'stopped', full);
      return { error: { kind: 'bad-manifest', message: full } };
    }
    const proc = this.spawn(e);
    e.proc = proc;
    try {
      const ready = await proc.start({
        settings: e.rt.settings,
        manifest: e.rt.manifest,
        sha256: e.rt.sha256,
      });
      if (e.proc !== proc) return { error: { kind: 'stopped' } };
      // The host is up: confirm the OS really gave it the identity isolation promised. A failure
      // stops it for good (like a run-dir failure), it is not a crash to restart.
      const violation = await this.isolationViolationOf(proc, e.rt);
      if (violation !== null) {
        if (e.proc !== proc) return { error: { kind: 'stopped' } };
        e.proc = null;
        await proc.stop();
        this.setState(e, 'stopped', violation);
        return { error: { kind: 'bad-manifest', message: violation } };
      }
      if (e.proc !== proc) return { error: { kind: 'stopped' } };
      const ambiguous = this.learnSchema(e, ready);
      if (ambiguous !== null) {
        await this.fail(e, ambiguous);
        return { error: { kind: 'bad-manifest', message: ambiguous } };
      }
      e.stableTimer = setTimeout(() => {
        e.crashes = [];
      }, deps.limits.stableMs);
      this.setState(e, 'running', null);
      void proc.exit.then((reason) => this.onExit(e, proc, reason));
      return ready;
    } catch (err) {
      const reason: ExitReason =
        err instanceof PluginStartError
          ? err.reason
          : { kind: 'uncaught', message: e.redact(String(err)) };
      if (e.proc !== proc) return { error: reason };
      e.proc = null;
      void proc.stop();
      if (isRestart) {
        this.crashed(e, reason);
      } else {
        this.setState(e, 'stopped', describeExit(reason));
      }
      return { error: reason };
    }
  }

  private onExit(e: Entry, proc: PluginProcess, reason: ExitReason): void {
    if (e.proc !== proc) return;
    e.proc = null;
    e.ready = null;
    this.crashed(e, reason);
  }

  /** A process died on its own: back off and restart, or give up. */
  private crashed(e: Entry, reason: ExitReason): void {
    const { deps } = this;
    const l = deps.limits;
    const now = deps.now().getTime();
    if (e.stableTimer) clearTimeout(e.stableTimer);
    e.stableTimer = null;
    e.crashes = [...e.crashes.filter((t) => now - t < l.crashWindowMs), now];
    const why = describeExit(reason);
    deps.log.warn({ msg: 'plugin process ended', plugin: e.rt.name, reason: why });
    if (!e.rt.enabled) {
      this.setState(e, 'disabled', null);
      return;
    }
    // A host that broke the message protocol is not crashing, it is misbehaving: no restart.
    if (reason.kind === 'protocol') {
      this.setState(e, 'stopped', why);
      return;
    }
    if (e.crashes.length >= l.maxCrashes) {
      const minutes = Number((l.crashWindowMs / 60_000).toFixed(2));
      this.setState(e, 'stopped', `stopped: ${why} (${l.maxCrashes} crashes in ${minutes} min)`);
      return;
    }
    const backoff = Math.min(l.backoffMinMs * 2 ** (e.crashes.length - 1), l.backoffMaxMs);
    e.nextRestartAt = now + backoff;
    this.setState(e, 'restarting', why);
    e.restartTimer = setTimeout(() => {
      e.restartTimer = null;
      void this.launch(e, true);
    }, backoff);
  }

  /** At most 100 per second per window; the first line of the next second reports what was dropped. */
  private limited(w: Window, dropped: (n: number) => void, emit: () => void): void {
    const second = Math.floor(this.deps.now().getTime() / 1000);
    if (second !== w.second) {
      if (w.dropped > 0) dropped(w.dropped);
      w.second = second;
      w.lines = 0;
      w.dropped = 0;
    }
    if (w.lines >= OUTPUT_LINES_PER_SECOND) {
      w.dropped += 1;
      return;
    }
    w.lines += 1;
    emit();
  }

  /** stdout/stderr of a plugin, tagged, then one `dropped N lines`. Already redacted by the process. */
  private output(e: Entry, stream: 'stdout' | 'stderr', line: string): void {
    this.limited(
      e.output,
      (n) => this.emitLine(e, stream, `dropped ${n} lines`),
      () => this.emitLine(e, stream, line),
    );
  }

  private emitLine(e: Entry, stream: 'stdout' | 'stderr', text: string): void {
    // One log line per output line: `onLog` (the service) writes it to the server log.
    this.deps.onLog(e.rt.name, stream === 'stderr' ? 'warn' : 'info', text, null);
  }

  /** The plugin's own `ctx.log` messages (IPC), with the same per-second cap as its output. */
  private hostLog(
    e: Entry,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    jobId: string | null,
  ): void {
    this.limited(
      e.logs,
      (n) => this.deps.onLog(e.rt.name, 'warn', `dropped ${n} log messages`, null),
      () => this.deps.onLog(e.rt.name, level, message, jobId),
    );
  }
}
