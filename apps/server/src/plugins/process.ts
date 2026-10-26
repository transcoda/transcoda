import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import {
  type FetchInput,
  type FetchPolicy,
  type FetchResult,
  HOST_ENV_KEYS,
  type HostReady,
  type HostResult,
  hostExecArgv,
  hostSpawn,
  type JsonValue,
  type PluginLimits,
  type PluginManifest,
  PROTOCOL_VERSION,
  parseHostMessage,
  type ServerMessage,
  type SupervisorLimits,
} from '@transcoda/shared';
import type { PluginIsolation } from '../config.ts';
import { offModeSetpriv } from '../engine/child-caps.ts';
import type { Logger } from '../logger.ts';
import { redactJson } from '../plugin-host/redact.ts';
import { CHANNEL_ENV, openChannel } from './channel.ts';

export type ExitReason =
  | { kind: 'timeout'; hook: string; afterMs: number }
  | { kind: 'oom-heap' }
  | { kind: 'oom-rss'; rssMb: number }
  | { kind: 'killed' }
  | { kind: 'exit'; code: number }
  | { kind: 'uncaught'; message: string }
  | { kind: 'start-timeout'; afterMs: number }
  | { kind: 'bad-manifest'; message: string }
  /** The host wrote something to its channel that is not a message frame: it is not restarted. */
  | { kind: 'protocol'; message: string }
  | { kind: 'stopped' };

const seconds = (ms: number): string => String(Number((ms / 1000).toFixed(3)));

export function describeExit(r: ExitReason): string {
  switch (r.kind) {
    case 'timeout':
      return `timed out after ${seconds(r.afterMs)} s in ${r.hook}`;
    case 'oom-heap':
      return 'ran out of memory (heap)';
    case 'oom-rss':
      return `ran out of memory (rss ${r.rssMb} MB)`;
    case 'killed':
      return 'was killed';
    case 'exit':
      return `exited with code ${r.code}`;
    case 'uncaught':
      return `crashed: ${r.message}`;
    case 'start-timeout':
      return `did not start within ${seconds(r.afterMs)} s`;
    case 'bad-manifest':
      return `bundle manifest mismatch: ${r.message}`;
    case 'protocol':
      return `broke the message protocol: ${r.message}`;
    case 'stopped':
      return 'stopped';
  }
}

/** V8 aborts (SIGABRT, or exit 134 when a shell reports it) when the heap limit is hit. */
const HEAP_ABORT_EXIT_CODE = 134;

/** Our own kill reason wins; otherwise what the OS says. */
export function classifyExit(
  code: number | null,
  signal: string | null,
  killedBy: ExitReason | null,
): ExitReason {
  if (killedBy) return killedBy;
  if (signal === 'SIGABRT') return { kind: 'oom-heap' };
  if (signal === 'SIGKILL') return { kind: 'killed' };
  if (code === HEAP_ABORT_EXIT_CODE) return { kind: 'oom-heap' };
  if (code !== null) return { kind: 'exit', code };
  return { kind: 'killed' };
}

export class PluginCallError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PluginCallError';
  }
}

/** `start` failed: the process died, timed out, answered fatal or announced a different manifest. */
export class PluginStartError extends Error {
  constructor(readonly reason: ExitReason) {
    super(describeExit(reason));
    this.name = 'PluginStartError';
  }
}

export interface ChildLike {
  pid: number | undefined;
  connected: boolean;
  send(msg: unknown): boolean;
  kill(signal: NodeJS.Signals): boolean;
  /** `bad-frame` (a reason string): the host wrote something that is not a message frame. */
  on(
    event: 'message' | 'exit' | 'error' | 'disconnect' | 'bad-frame',
    // biome-ignore lint/suspicious/noExplicitAny: mirrors EventEmitter.on
    fn: (...a: any[]) => void,
  ): void;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
}

export interface ForkOptions {
  hostPath: string;
  bundlePath: string;
  execArgv: string[];
  env: Record<string, string>;
  /** Start the host as this user through setpriv; null runs it as the server's user. */
  isolation: PluginIsolation | null;
}

export type ServerBody = ServerMessage extends infer M
  ? M extends unknown
    ? Omit<M, 'v' | 'id'>
    : never
  : never;

export interface ProcessDeps {
  fork(opts: ForkOptions): ChildLike;
  /** Resident set size in bytes, or null when it cannot be read. */
  rssOf(pid: number): Promise<number | null>;
  /** Watchdog interval; default 1 s. */
  rssPollMs?: number;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  log: Logger;
  limits: SupervisorLimits;
  /**
   * The host's `fetch` message. `signal` aborts when the issuing call settles or times out, or the
   * process dies or is stopped; `override` and `secrets` are that call's own (see `CallOptions`).
   */
  fetch(input: FetchInput, opts: FetchRouteOptions): Promise<FetchResult>;
  onLog(level: 'debug' | 'info' | 'warn' | 'error', message: string, jobId: string | null): void;
  /** One stdout/stderr line of the child. */
  onOutput?: (stream: 'stdout' | 'stderr', line: string) => void;
  /** Applied again, by value, to everything that comes back from the host. */
  redact?: (text: string) => string;
  /** Starts the host with an inspector (dev only; TRANSCODA_PLUGIN_INSPECT). */
  inspect?: boolean | undefined;
  /** Hosts run as this user (see `PluginIsolation`); null or absent: as the server's user. */
  isolation?: PluginIsolation | null | undefined;
}

const STOP_GRACE_MS = 5_000;
const RSS_POLL_MS = 1_000;
const MAX_LINE_CHARS = 2_000;

/** Detached children lead their own process group: kill it whole, in case a flag ever slipped. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
  // Once the child has exited its pid (and group id) may belong to someone else.
  if (child.exitCode !== null || child.signalCode !== null) return false;
  const pid = child.pid;
  if (pid !== undefined && pid > 1) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // The group is gone or was never made: fall back to the child itself.
    }
  }
  return child.kill(signal);
}

export function forkHost(opts: ForkOptions): ChildLike {
  const how = hostSpawn({
    execPath: process.execPath,
    execArgv: opts.execArgv,
    hostPath: opts.hostPath,
    bundlePath: opts.bundlePath,
    isolation: opts.isolation,
    // Isolation off: still no inheritable or ambient capabilities for the host (see child-caps.ts).
    capDropSetpriv: opts.isolation === null ? offModeSetpriv() : null,
  });
  // fd 3 is a plain pipe, not an 'ipc' entry: the host's Node opens it as its IPC channel (json),
  // and the server frames it itself (see channel.ts), so no frame can throw inside Node's reader.
  const stdio: ['ignore', 'pipe', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe', 'pipe'];
  const child = spawn(how.command, how.args, {
    env: { ...opts.env, ...CHANNEL_ENV },
    stdio,
    detached: true,
  });
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const emit = (event: string, ...args: unknown[]): void => {
    for (const fn of listeners.get(event) ?? []) fn(...args);
  };
  const socket = child.stdio[3] as Duplex | null | undefined;
  const channel = socket ? openChannel(socket, (event, arg) => emit(event, arg)) : null;
  return {
    get pid() {
      return child.pid;
    },
    get connected() {
      return channel?.connected ?? false;
    },
    send: (msg) => {
      if (!channel) throw new Error('ERR_IPC_CHANNEL_CLOSED');
      return channel.send(msg);
    },
    kill: (signal) => killTree(child, signal),
    on: (event, fn) => {
      if (event === 'exit' || event === 'error') {
        child.on(event as 'exit', fn);
        return;
      }
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    },
    stdout: child.stdout,
    stderr: child.stderr,
  };
}

function execFileText(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 2_000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/** Linux: VmRSS (kB) of /proc/<pid>/status; darwin and others: `ps -o rss=` (KiB). */
export async function defaultRssOf(pid: number): Promise<number | null> {
  if (process.platform === 'linux') {
    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const kib = Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1]);
      return Number.isFinite(kib) ? kib * 1024 : null;
    } catch {
      return null;
    }
  }
  const out = await execFileText('ps', ['-o', 'rss=', '-p', String(pid)]);
  const kib = Number(out?.trim());
  return out !== null && Number.isFinite(kib) && kib > 0 ? kib * 1024 : null;
}

interface Pending {
  id: string;
  hook: string;
  /** The node type of a `call`, for the log line of a hung cancelled call. */
  node?: string | undefined;
  timeoutMs: number;
  /** When the call's own timeout fires (`deps.now()` ms). */
  deadline: number;
  timer: unknown;
  /** Set once cancelled: how long the host was given to stop before the kill. */
  graceMs?: number | undefined;
  /** Removes the abort listener of a call made with a signal. */
  detach?: (() => void) | undefined;
  resolve(r: HostResult): void;
  reject(e: Error): void;
}

/** What the server applies to the fetches one call issues; unknown or null call ids get none. */
export interface CallOptions {
  /** Abandons the call: the host is told to `cancel` it and the promise rejects `cancelled`. */
  signal?: AbortSignal | undefined;
  fetch?: {
    override?: FetchPolicy | undefined;
    /** Candidate secret values by real field path (an integration `test` call). */
    secrets?: Record<string, string> | undefined;
  };
}

export interface FetchRouteOptions {
  signal: AbortSignal;
  override?: FetchPolicy | undefined;
  secrets?: Record<string, string> | undefined;
}

interface CallFetchContext {
  controller: AbortController;
  override?: FetchPolicy | undefined;
  secrets?: Record<string, string> | undefined;
}

type InitMessage = Extract<ServerMessage, { type: 'init' }>;

const MANIFEST_KEYS = [
  'name',
  'version',
  'sdk',
  'nodes',
  'integration',
  'triggers',
  'hooks',
] as const;

function pluginLimits(l: SupervisorLimits): PluginLimits {
  return {
    callTimeoutMs: l.callTimeoutMs,
    finishRunTimeoutMs: l.finishRunTimeoutMs,
    testTimeoutMs: l.testTimeoutMs,
    triggerTimeoutMs: l.triggerTimeoutMs,
    hookTimeoutMs: l.hookTimeoutMs,
    fetchDefaultTimeoutMs: l.fetchDefaultTimeoutMs,
    fetchMaxTimeoutMs: l.fetchMaxTimeoutMs,
    cacheEntries: l.cacheEntries,
    cacheBytes: l.cacheBytes,
  };
}

/** One host process: init handshake, correlated calls with timeouts, fetch routing, RSS watchdog. */
export class PluginProcess {
  private child: ChildLike | null = null;
  private status: 'starting' | 'running' | 'exited' = 'starting';
  private killedBy: ExitReason | null = null;
  private counter = 0;
  private readonly pending = new Map<string, Pending>();
  /** Cancelled calls whose timeout is still armed: the plugin may never finish them (the reaper). */
  private readonly cancelled = new Map<string, Pending>();
  private readonly fetches = new AbortController();
  private readonly callFetch = new Map<string, CallFetchContext>();
  private startTimer: unknown = null;
  private rssTimer: unknown = null;
  private fatalTimer: unknown = null;
  private failStart: ((reason: ExitReason) => void) | null = null;
  private settleStart: ((ready: HostReady) => void) | null = null;
  private expected: PluginManifest | null = null;
  private resolveExit: (r: ExitReason) => void = () => {};
  private started = false;
  readonly exit: Promise<ExitReason>;

  constructor(
    readonly name: string,
    private readonly bundlePath: string,
    private readonly hostPath: string,
    private readonly deps: ProcessDeps,
  ) {
    this.exit = new Promise<ExitReason>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get state(): 'starting' | 'running' | 'exited' {
    return this.status;
  }

  private redact(text: string): string {
    return this.deps.redact ? this.deps.redact(text) : text;
  }

  start(init: {
    settings: Record<string, JsonValue>;
    /** What the bundle must say about itself; null accepts any (`--check-plugin`, dev plugins). */
    manifest: PluginManifest | null;
    sha256: string;
  }): Promise<HostReady> {
    if (this.started) return Promise.reject(new Error(`plugin ${this.name} was already started`));
    this.started = true;
    this.expected = init.manifest;
    const { deps } = this;
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      NODE_ENV: process.env.NODE_ENV ?? 'production',
    };
    for (const key of Object.keys(env)) {
      if (!(HOST_ENV_KEYS as readonly string[]).includes(key)) delete env[key];
    }
    let child: ChildLike;
    try {
      child = deps.fork({
        hostPath: this.hostPath,
        bundlePath: this.bundlePath,
        execArgv: hostExecArgv({
          hostPath: this.hostPath,
          bundlePath: this.bundlePath,
          heapMb: deps.limits.heapMb,
          inspect: deps.inspect === true && env.NODE_ENV !== 'production',
        }),
        env,
        isolation: deps.isolation ?? null,
      });
    } catch (e) {
      this.status = 'exited';
      const reason: ExitReason = {
        kind: 'uncaught',
        message: this.redact(e instanceof Error ? e.message : String(e)),
      };
      this.resolveExit(reason);
      return Promise.reject(new PluginStartError(reason));
    }
    this.child = child;
    this.wire(child);

    const ready = new Promise<HostReady>((resolve, reject) => {
      this.settleStart = resolve;
      this.failStart = (reason) => {
        this.killedBy ??= reason;
        reject(new PluginStartError(reason));
      };
    });
    this.startTimer = deps.setTimer(() => {
      this.failStart?.({ kind: 'start-timeout', afterMs: deps.limits.startTimeoutMs });
      this.kill();
    }, deps.limits.startTimeoutMs);
    try {
      this.send({
        v: PROTOCOL_VERSION,
        id: this.nextId(),
        type: 'init',
        settings: init.settings,
        limits: pluginLimits(deps.limits),
        dryRunDefaults: {},
      } satisfies InitMessage);
    } catch (e) {
      this.failStart?.({
        kind: 'uncaught',
        message: `could not reach the plugin host: ${e instanceof Error ? e.message : String(e)}`,
      });
      this.kill();
    }
    return ready;
  }

  private nextId(): string {
    this.counter += 1;
    return `${this.name}-${this.counter}`;
  }

  private send(msg: unknown): void {
    const child = this.child;
    if (!child?.connected) throw new Error('ERR_IPC_CHANNEL_CLOSED');
    child.send(msg);
  }

  private kill(): void {
    try {
      this.child?.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }

  private wire(child: ChildLike): void {
    child.on('message', (raw: unknown) => this.onMessage(raw));
    child.on('exit', (code: number | null, signal: string | null) => this.onExit(code, signal));
    child.on('error', (e: Error) => {
      // A spawn failure never produces `exit`.
      if (child.pid === undefined) this.onExit(null, null, e);
    });
    child.on('disconnect', () => {});
    child.on('bad-frame', (why: string) => this.onBadFrame(why));
    this.lines(child.stdout, 'stdout');
    this.lines(child.stderr, 'stderr');
  }

  private lines(stream: NodeJS.ReadableStream | null, which: 'stdout' | 'stderr'): void {
    if (!stream) return;
    let rest = '';
    const emit = (line: string): void => {
      this.deps.onOutput?.(which, this.redact(line.slice(0, MAX_LINE_CHARS)));
    };
    stream.on('data', (chunk: Buffer | string) => {
      rest += String(chunk);
      const parts = rest.split('\n');
      rest = parts.pop() ?? '';
      for (const line of parts) if (line !== '') emit(line);
    });
    stream.on('end', () => {
      if (rest !== '') emit(rest);
      rest = '';
    });
  }

  /** Not a message frame: the stream cannot be trusted any more, so the host goes, for good. */
  private onBadFrame(why: string): void {
    if (this.status === 'exited') return;
    const message = this.redact(why);
    this.deps.log.warn({
      msg: 'plugin broke the message protocol',
      plugin: this.name,
      error: message,
    });
    this.killedBy ??= { kind: 'protocol', message };
    this.failStart?.(this.killedBy);
    this.kill();
  }

  private onMessage(raw: unknown): void {
    const parsed = parseHostMessage(raw);
    if (!parsed.ok) {
      const id = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined;
      const p = typeof id === 'string' ? this.pending.get(id) : undefined;
      if (p) {
        this.finish(p);
        p.reject(
          new PluginCallError(
            `plugin ${this.name} sent an invalid answer: ${this.redact(parsed.parseError)}`,
            false,
          ),
        );
      }
      this.deps.log.warn({
        msg: 'plugin sent an invalid message',
        plugin: this.name,
        error: this.redact(parsed.parseError),
      });
      return;
    }
    const m = parsed.message;
    switch (m.type) {
      case 'ready':
        this.onReady(m);
        return;
      case 'fatal':
        // The host exits by itself right after; a running process's exit then classifies as this.
        this.killedBy ??= { kind: 'uncaught', message: this.redact(m.reason) };
        this.failStart?.(this.killedBy);
        // Gives the host a moment to flush and exit by itself, then makes sure.
        this.fatalTimer ??= this.deps.setTimer(() => this.kill(), STOP_GRACE_MS);
        return;
      case 'result': {
        const gone = this.cancelled.get(m.id);
        if (gone) {
          // It did end after all: nothing to reap.
          this.deps.clearTimer(gone.timer);
          this.cancelled.delete(m.id);
          return;
        }
        const p = this.pending.get(m.id);
        if (!p) return;
        this.finish(p);
        p.resolve(this.redactResult(m));
        return;
      }
      case 'fetch':
        void this.routeFetch(m.id, m.callId, m.input);
        return;
      case 'log':
        this.deps.onLog(m.level, this.redact(m.message), m.jobId);
        return;
    }
  }

  private redactResult(m: HostResult): HostResult {
    const redact = (t: string): string => this.redact(t);
    return m.ok
      ? { ...m, result: redactJson(redact, m.result) }
      : { ...m, error: { ...m.error, message: redact(m.error.message) } };
  }

  private onReady(ready: HostReady): void {
    if (this.status !== 'starting') return;
    const expected = this.expected;
    const differs =
      expected === null
        ? []
        : MANIFEST_KEYS.filter((k) => !isDeepStrictEqual(ready.manifest[k], expected[k]));
    if (expected !== null && differs.length > 0) {
      const identity =
        ready.manifest.name !== expected.name || ready.manifest.version !== expected.version;
      this.failStart?.({
        kind: 'bad-manifest',
        message: identity
          ? `manifest in bundle says ${ready.manifest.name} ${ready.manifest.version}, catalog says ${
              ready.manifest.name === expected.name
                ? expected.version
                : `${expected.name} ${expected.version}`
            }`
          : `the bundle's own manifest differs from the catalog entry in: ${differs.join(', ')}`,
      });
      this.kill();
      return;
    }
    if (this.startTimer !== null) this.deps.clearTimer(this.startTimer);
    this.startTimer = null;
    this.status = 'running';
    this.scheduleRss();
    this.settleStart?.(ready);
  }

  /** The host asked for a fetch: answered with the same id, never with the request logged. */
  private async routeFetch(id: string, callId: string | null, input: FetchInput): Promise<void> {
    let result: FetchResult;
    try {
      const entry = callId === null ? undefined : this.callFetch.get(callId);
      result = entry
        ? await this.deps.fetch(input, {
            signal: entry.controller.signal,
            override: entry.override,
            secrets: entry.secrets,
          })
        : // Outside any call, or its call is already gone: the stored policy, no candidate secrets.
          await this.deps.fetch(input, { signal: this.fetches.signal });
    } catch {
      result = { ok: false, error: { kind: 'failed', message: 'fetch failed' } };
    }
    const msg =
      result.ok === true
        ? { v: PROTOCOL_VERSION, id, type: 'fetch-result', ok: true, response: result.response }
        : { v: PROTOCOL_VERSION, id, type: 'fetch-result', ok: false, error: result.error };
    try {
      this.send(msg);
    } catch {
      // The process is gone; nobody is waiting.
    }
  }

  private scheduleRss(): void {
    const { deps } = this;
    this.rssTimer = deps.setTimer(() => {
      const pid = this.child?.pid;
      if (this.status === 'exited' || pid === undefined) return;
      deps
        .rssOf(pid)
        .then((rss) => {
          if (this.status === 'exited') return;
          if (rss !== null && rss > deps.limits.rssMb * 1024 * 1024) {
            this.killedBy ??= { kind: 'oom-rss', rssMb: Math.round(rss / (1024 * 1024)) };
            this.kill();
            return;
          }
          this.scheduleRss();
        })
        .catch(() => this.scheduleRss());
    }, deps.rssPollMs ?? RSS_POLL_MS);
  }

  private finish(p: Pending): void {
    this.deps.clearTimer(p.timer);
    p.detach?.();
    this.pending.delete(p.id);
    this.endCallFetches(p.id);
  }

  /** Aborts what the call left running (a fetch fired without await) and forgets its context. */
  private endCallFetches(id: string): void {
    const entry = this.callFetch.get(id);
    if (!entry) return;
    this.callFetch.delete(id);
    entry.controller.abort();
  }

  call(msg: ServerBody, timeoutMs: number, opts: CallOptions = {}): Promise<HostResult> {
    if (this.status !== 'running') {
      return Promise.reject(new PluginCallError(`plugin ${this.name} is not running`, true));
    }
    const { signal } = opts;
    if (signal?.aborted) {
      return Promise.reject(
        new PluginCallError(`call to plugin ${this.name} was cancelled`, false),
      );
    }
    const id = this.nextId();
    const hook = msg.type === 'call' ? msg.hook : msg.type;
    return new Promise<HostResult>((resolve, reject) => {
      const p: Pending = {
        id,
        hook,
        node: msg.type === 'call' ? msg.nodeType : undefined,
        timeoutMs,
        deadline: this.deps.now() + timeoutMs,
        resolve,
        reject,
        timer: this.deps.setTimer(() => this.onTimeout(p), timeoutMs),
      };
      this.pending.set(id, p);
      this.callFetch.set(id, {
        controller: new AbortController(),
        override: opts.fetch?.override,
        secrets: opts.fetch?.secrets,
      });
      if (signal) {
        const onAbort = (): void => this.cancel(p);
        signal.addEventListener('abort', onAbort, { once: true });
        p.detach = () => signal.removeEventListener('abort', onAbort);
      }
      try {
        this.send({ v: PROTOCOL_VERSION, id, ...msg });
      } catch {
        this.finish(p);
        reject(new PluginCallError(`plugin ${this.name} restarted`, true));
      }
    });
  }

  /**
   * The caller no longer wants the answer (a cancelled job). Best effort: the host stops that
   * call's fetches and drops its answer, but cannot interrupt the plugin's own code. So a reaper
   * replaces the call's timeout: the host gets `cancelGraceMs` (never past the original timeout)
   * to answer, and a cancelled call still running then kills the process (see `onTimeout`), so a
   * plugin that ignores `cancel` does not hold its slot and memory for the full call timeout.
   */
  private cancel(p: Pending): void {
    if (!this.pending.has(p.id)) return;
    p.detach?.();
    this.pending.delete(p.id);
    this.endCallFetches(p.id);
    const { deps } = this;
    const graceMs = Math.max(0, Math.min(deps.limits.cancelGraceMs, p.deadline - deps.now()));
    deps.clearTimer(p.timer);
    p.graceMs = graceMs;
    p.timer = deps.setTimer(() => this.onTimeout(p), graceMs);
    this.cancelled.set(p.id, p);
    try {
      this.send({ v: PROTOCOL_VERSION, id: p.id, type: 'cancel' });
    } catch {
      // The process is gone; its exit clears the reaper.
    }
    p.reject(new PluginCallError(`call to plugin ${this.name} was cancelled`, false));
  }

  private onTimeout(p: Pending): void {
    if (this.cancelled.delete(p.id)) {
      // Nobody waits for it any more, but the plugin is still busy with it: loudly, kill it.
      const afterMs = p.graceMs ?? p.timeoutMs;
      this.deps.log.warn({
        msg: 'cancelled plugin call did not stop within its grace period; killing the plugin',
        plugin: this.name,
        node: p.node ?? null,
        hook: p.hook,
        afterMs,
      });
      this.killedBy ??= { kind: 'timeout', hook: p.hook, afterMs };
      this.kill();
      return;
    }
    if (!this.pending.has(p.id)) return;
    this.pending.delete(p.id);
    this.endCallFetches(p.id);
    this.killedBy ??= { kind: 'timeout', hook: p.hook, afterMs: p.timeoutMs };
    // This call timed out (not retryable); the others are only collateral, rejected on exit.
    p.reject(
      new PluginCallError(`plugin ${this.name} timed out after ${seconds(p.timeoutMs)} s`, false),
    );
    this.kill();
  }

  async sendSettings(settings: Record<string, JsonValue>): Promise<void> {
    const r = await this.call({ type: 'settings', settings }, this.deps.limits.callTimeoutMs);
    if (!r.ok) throw new PluginCallError(r.error.message, r.error.retryable);
  }

  private onExit(code: number | null, signal: string | null, spawnError?: Error): void {
    if (this.status === 'exited') return;
    this.status = 'exited';
    const { deps } = this;
    for (const t of [this.startTimer, this.rssTimer, this.fatalTimer]) {
      if (t !== null) deps.clearTimer(t);
    }
    this.fatalTimer = null;
    this.startTimer = null;
    this.rssTimer = null;
    if (spawnError)
      this.killedBy ??= { kind: 'uncaught', message: this.redact(spawnError.message) };
    const reason = classifyExit(code, signal, this.killedBy);
    this.fetches.abort();
    for (const p of this.cancelled.values()) deps.clearTimer(p.timer);
    this.cancelled.clear();
    for (const p of [...this.pending.values()]) {
      this.finish(p);
      p.reject(new PluginCallError(`plugin ${this.name} restarted`, true));
    }
    this.failStart?.(reason);
    this.resolveExit(reason);
  }

  async stop(): Promise<void> {
    if (this.status === 'exited') return;
    this.killedBy ??= { kind: 'stopped' };
    const child = this.child;
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    const timer = this.deps.setTimer(() => this.kill(), STOP_GRACE_MS);
    await this.exit;
    this.deps.clearTimer(timer);
  }
}
