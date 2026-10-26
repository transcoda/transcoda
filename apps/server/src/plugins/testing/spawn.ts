// Tests only: forks the real built host with the real permission flags (shared's hostExecArgv),
// on a json channel like the server's (see channel.ts).
import { type ChildProcess, fork } from 'node:child_process';
import {
  DEFAULT_LIMITS,
  HOST_ENV_KEYS,
  type HostMessage,
  type HostReady,
  hostExecArgv,
  type JsonValue,
  type PluginLimits,
  PROTOCOL_VERSION,
  parseHostMessage,
} from '@transcoda/shared';

const NEXT_TIMEOUT_MS = 20_000;

export function testPluginLimits(over: Partial<PluginLimits> = {}): PluginLimits {
  const d = DEFAULT_LIMITS;
  return {
    callTimeoutMs: d.callTimeoutMs,
    finishRunTimeoutMs: d.finishRunTimeoutMs,
    testTimeoutMs: d.testTimeoutMs,
    triggerTimeoutMs: d.triggerTimeoutMs,
    hookTimeoutMs: d.hookTimeoutMs,
    fetchDefaultTimeoutMs: d.fetchDefaultTimeoutMs,
    fetchMaxTimeoutMs: d.fetchMaxTimeoutMs,
    cacheEntries: d.cacheEntries,
    cacheBytes: d.cacheBytes,
    ...over,
  };
}

export interface SpawnOptions {
  hostPath: string;
  bundlePath: string;
  settings: JsonValue;
  limits?: Partial<PluginLimits> | undefined;
  /** Node's `--max-old-space-size`; default 128. */
  heapMb?: number | undefined;
  /** Extra environment on top of PATH and NODE_ENV (tests only). */
  env?: Record<string, string> | undefined;
}

export interface HostHandle {
  child: ChildProcess;
  send(msg: unknown): void;
  /** The next host message (of `type`/one of `type` when given; others are kept for later). */
  next<T extends HostMessage['type']>(type: T): Promise<Extract<HostMessage, { type: T }>>;
  next(type?: Array<HostMessage['type']>): Promise<HostMessage>;
  /** How many messages of `type` have arrived and are not yet taken by `next`. */
  queued(type: HostMessage['type']): number;
  /** Resolves when the process has exited. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout(): string;
  stderr(): string;
  /** Kills the process (SIGKILL) if it is alive and waits for it. */
  stop(): Promise<void>;
}

/** Forks the host and sends `init`; does not wait for `ready` (a bad bundle answers `fatal`). */
export function startHost(opts: SpawnOptions): HostHandle {
  const env: Record<string, string> = {};
  for (const key of HOST_ENV_KEYS) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  const child = fork(opts.hostPath, [opts.bundlePath], {
    execArgv: hostExecArgv({
      hostPath: opts.hostPath,
      bundlePath: opts.bundlePath,
      heapMb: opts.heapMb ?? DEFAULT_LIMITS.heapMb,
      inspect: false,
    }),
    env: { ...env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'json',
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (d: Buffer) => {
    out += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => {
    err += d.toString();
  });

  const queue: HostMessage[] = [];
  const waiters: Array<() => void> = [];
  child.on('message', (raw) => {
    const parsed = parseHostMessage(raw);
    if (!parsed.ok) throw new Error(`invalid host message: ${parsed.parseError}`);
    queue.push(parsed.message);
    for (const wake of waiters.splice(0)) wake();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
      for (const wake of waiters.splice(0)) wake();
    });
  });
  let gone = false;
  void exited.then(() => {
    gone = true;
  });

  const handle: HostHandle = {
    child,
    send: (msg) => child.send(msg as never),
    async next(type?: HostMessage['type'] | Array<HostMessage['type']>): Promise<never> {
      const deadline = Date.now() + NEXT_TIMEOUT_MS;
      for (;;) {
        const at = queue.findIndex((m) => type === undefined || [type].flat().includes(m.type));
        if (at >= 0) return queue.splice(at, 1)[0] as never;
        if (gone)
          throw new Error(
            `host exited while waiting for ${[type ?? 'a message'].flat().join('/')}`,
          );
        if (Date.now() > deadline)
          throw new Error(`timed out waiting for ${[type ?? 'a message'].flat().join('/')}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 200).unref();
        });
      }
    },
    queued: (type) => queue.filter((m) => m.type === type).length,
    exited,
    stdout: () => out,
    stderr: () => err,
    async stop() {
      if (!gone) child.kill('SIGKILL');
      await exited;
    },
  };
  handle.send({
    v: PROTOCOL_VERSION,
    id: 'init-1',
    type: 'init',
    settings: opts.settings,
    limits: testPluginLimits(opts.limits),
    dryRunDefaults: {},
  });
  return handle;
}

export type SpawnedHost = HostHandle & { ready: HostReady };

/** `startHost`, then waits for `ready` (throws with the host's `fatal` reason otherwise). */
export async function spawnHost(opts: SpawnOptions): Promise<SpawnedHost> {
  const host = startHost(opts);
  try {
    const first = await host.next(['ready', 'fatal']);
    if (first.type === 'fatal') throw new Error(`host fatal: ${first.reason}`);
    if (first.type !== 'ready') throw new Error(`expected ready, got ${first.type}`);
    return Object.assign(host, { ready: first });
  } catch (e) {
    await host.stop();
    throw e;
  }
}
