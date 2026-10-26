import {
  DEFAULT_LIMITS,
  type FetchInput,
  HOST_ENV_KEYS,
  PROTOCOL_VERSION,
} from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeChild, fakeFork, TEST_MANIFEST } from './fake-child.ts';
import {
  classifyExit,
  describeExit,
  PluginCallError,
  PluginProcess,
  PluginStartError,
  type ProcessDeps,
} from './process.ts';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const init = { settings: {}, manifest: TEST_MANIFEST, sha256: 'abc' };

function setup(
  configure: (c: FakeChild) => void = () => {},
  over: Partial<ProcessDeps> = {},
): {
  proc: PluginProcess;
  children: FakeChild[];
  deps: ProcessDeps;
  logs: string[];
} {
  const { fork, children } = fakeFork(configure);
  const logs: string[] = [];
  const deps: ProcessDeps = {
    fork,
    rssOf: async () => null,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    log: quiet,
    limits: DEFAULT_LIMITS,
    fetch: async () => ({ ok: false, error: { kind: 'refused', message: 'no' } }),
    onLog: (_level, message) => logs.push(message),
    ...over,
  };
  return {
    proc: new PluginProcess('example', '/b/example.js', '/h/host.js', deps),
    children,
    deps,
    logs,
  };
}

const echo = { type: 'data' } as never;
const callMsg = {
  type: 'call',
  hook: 'decide',
  nodeType: 'example:echo',
  nodeVersion: 1,
  ctx: {},
  settings: {},
} as never;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PluginProcess.start', () => {
  it('sends init first and resolves on ready', async () => {
    const { proc, children } = setup();
    const ready = await proc.start(init);
    expect(ready.type).toBe('ready');
    expect(children[0]?.sent[0]).toMatchObject({ type: 'init', v: PROTOCOL_VERSION });
    expect(proc.state).toBe('running');
    expect(proc.pid).toBe(10_000);
  });

  it('forks with the host flags and an env of exactly PATH and NODE_ENV', async () => {
    const { proc, children } = setup();
    await proc.start(init);
    const opts = children[0]?.opts;
    expect(opts?.execArgv).toContain('--permission');
    expect(opts?.execArgv).toContain('--allow-fs-read=/h/host.js');
    expect(opts?.execArgv).toContain('--allow-fs-read=/b/example.js');
    expect(opts?.execArgv).toContain('--disallow-code-generation-from-strings');
    expect(opts?.execArgv).toContain(`--max-old-space-size=${DEFAULT_LIMITS.heapMb}`);
    expect(Object.keys(opts?.env ?? {}).sort()).toEqual([...HOST_ENV_KEYS].sort());
  });

  it('passes the isolation (null by default) through to fork', async () => {
    const plain = setup();
    await plain.proc.start(init);
    expect(plain.children[0]?.opts.isolation).toBeNull();
    const iso = { uid: 65001, gid: 65001, runDir: '/run/x', setprivPath: '/usr/bin/setpriv' };
    const isolated = setup(() => {}, { isolation: iso });
    await isolated.proc.start(init);
    expect(isolated.children[0]?.opts.isolation).toEqual(iso);
    // The host flags do not change with isolation: only the process wrapper does.
    expect(isolated.children[0]?.opts.execArgv).toEqual(plain.children[0]?.opts.execArgv);
  });

  it('kills a host whose manifest differs and reports bad-manifest', async () => {
    const { proc, children } = setup((c) => {
      c.manifest = { ...TEST_MANIFEST, version: '9.9.9' };
    });
    const err = await proc.start(init).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginStartError);
    expect((err as PluginStartError).reason).toMatchObject({ kind: 'bad-manifest' });
    expect((err as PluginStartError).reason).toEqual({
      kind: 'bad-manifest',
      message: 'manifest in bundle says example 9.9.9, catalog says 1.0.0',
    });
    expect(children[0]?.signals).toContain('SIGKILL');
    expect(await proc.exit).toMatchObject({ kind: 'bad-manifest' });
  });

  it('names both plugins when the bundle is another plugin altogether', async () => {
    const { proc } = setup((c) => {
      c.manifest = { ...TEST_MANIFEST, name: 'other' };
    });
    const err = (await proc.start(init).catch((e: unknown) => e)) as PluginStartError;
    expect(err.reason).toMatchObject({
      message: 'manifest in bundle says other 1.0.0, catalog says example 1.0.0',
    });
  });

  it('names the keys when only the contents of the manifest differ', async () => {
    const { proc } = setup((c) => {
      c.manifest = { ...TEST_MANIFEST, nodes: ['example:other'] };
    });
    const err = (await proc.start(init).catch((e: unknown) => e)) as PluginStartError;
    expect(err.reason).toEqual({
      kind: 'bad-manifest',
      message: "the bundle's own manifest differs from the catalog entry in: nodes",
    });
  });

  it('accepts any manifest when none is expected (--check-plugin, dev plugins)', async () => {
    const { proc } = setup((c) => {
      c.manifest = { ...TEST_MANIFEST, name: 'anything', version: '9.9.9' };
    });
    const ready = await proc.start({ ...init, manifest: null });
    expect(ready.manifest.name).toBe('anything');
    expect(proc.state).toBe('running');
  });

  it('kills and reports start-timeout when ready never comes', async () => {
    const { proc, children } = setup((c) => {
      c.autoReady = false;
    });
    const started = proc.start(init).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.startTimeoutMs);
    const err = await started;
    expect((err as PluginStartError).reason).toEqual({
      kind: 'start-timeout',
      afterMs: DEFAULT_LIMITS.startTimeoutMs,
    });
    expect(children[0]?.signals).toEqual(['SIGKILL']);
  });

  it('turns a fatal message into the start failure', async () => {
    const { proc } = setup((c) => {
      c.autoReady = false;
    });
    const started = proc.start(init).catch((e: unknown) => e);
    const child = (proc as unknown as { child: FakeChild }).child;
    child.deliver({
      v: PROTOCOL_VERSION,
      id: 'host',
      type: 'fatal',
      reason: 'bundle has no plugin default export',
    });
    const err = (await started) as PluginStartError;
    expect(describeExit(err.reason)).toBe('crashed: bundle has no plugin default export');
  });

  it('fails when the host dies before ready', async () => {
    const { proc } = setup((c) => {
      c.autoReady = false;
    });
    const started = proc.start(init).catch((e: unknown) => e);
    const child = (proc as unknown as { child: FakeChild }).child;
    child.exit(3);
    expect(((await started) as PluginStartError).reason).toEqual({ kind: 'exit', code: 3 });
  });
});

describe('PluginProcess.call', () => {
  it('correlates results by id', async () => {
    const { proc, children } = setup((c) => {
      c.onCall = (m) => ({ ok: true, result: { echoed: m.type } });
    });
    await proc.start(init);
    const a = proc.call(callMsg, 1000);
    const b = proc.call({ type: 'test', settings: {} }, 1000);
    expect(await a).toMatchObject({ ok: true, result: { echoed: 'call' } });
    expect(await b).toMatchObject({ ok: true, result: { echoed: 'test' } });
    const ids = children[0]?.sent.filter((m) => m.type !== 'init').map((m) => m.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('on timeout kills the host, rejects non-retryable and the other call retryable', async () => {
    const { proc, children } = setup();
    await proc.start(init);
    const slow = proc.call(callMsg, 30_000).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const other = proc.call({ type: 'test', settings: {} }, 60_000).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    const e1 = (await slow) as PluginCallError;
    const e2 = (await other) as PluginCallError;
    expect(children[0]?.signals).toContain('SIGKILL');
    expect(e1).toBeInstanceOf(PluginCallError);
    expect(e1.retryable).toBe(false);
    expect(e1.message).toBe('plugin example timed out after 30 s');
    expect(e2.retryable).toBe(true);
    expect(e2.message).toBe('plugin example restarted');
    expect(await proc.exit).toEqual({ kind: 'timeout', hook: 'decide', afterMs: 30_000 });
  });

  it('rejects retryable when the channel is closed', async () => {
    const { proc, children } = setup();
    await proc.start(init);
    (children[0] as FakeChild).sendError = Object.assign(new Error('closed'), {
      code: 'ERR_IPC_CHANNEL_CLOSED',
    });
    const err = (await proc.call(callMsg, 1000).catch((e: unknown) => e)) as PluginCallError;
    expect(err.retryable).toBe(true);
  });

  it('rejects when the process is not running', async () => {
    const { proc } = setup();
    const err = (await proc.call(echo, 1000).catch((e: unknown) => e)) as PluginCallError;
    expect(err).toBeInstanceOf(PluginCallError);
  });

  it('redacts secret values on everything that comes back, by value', async () => {
    const logs: string[] = [];
    const { proc, children } = setup(
      (c) => {
        c.onCall = () => ({ ok: false, message: 'bad key K-SECRET-9' });
      },
      {
        redact: (t) => t.split('K-SECRET-9').join('[redacted]'),
        onLog: (_l, m) => logs.push(m),
      },
    );
    await proc.start(init);
    const r = await proc.call(callMsg, 1000);
    expect(r).toMatchObject({ ok: false, error: { message: 'bad key [redacted]' } });
    children[0]?.deliver({
      v: PROTOCOL_VERSION,
      id: 'log',
      type: 'log',
      level: 'info',
      message: 'key K-SECRET-9',
      jobId: 'j1',
    });
    expect(logs).toEqual(['key [redacted]']);
  });

  it('forwards log messages to onLog', async () => {
    const { proc, children, logs } = setup();
    await proc.start(init);
    children[0]?.deliver({
      v: PROTOCOL_VERSION,
      id: 'log',
      type: 'log',
      level: 'warn',
      message: 'hello',
      jobId: null,
    });
    expect(logs).toEqual(['hello']);
  });
});

describe('PluginProcess.call with a signal', () => {
  it('an abort sends cancel with the call id, rejects not retryable and keeps the process running', async () => {
    const { proc, children } = setup();
    await proc.start(init);
    const ctl = new AbortController();
    const call = proc.call(callMsg, 30_000, { signal: ctl.signal }).catch((e: unknown) => e);
    const callId = children[0]?.sent.at(-1)?.id;
    ctl.abort();
    const err = (await call) as PluginCallError;
    expect(err).toBeInstanceOf(PluginCallError);
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('call to plugin example was cancelled');
    expect(children[0]?.sent.at(-1)).toMatchObject({
      type: 'cancel',
      id: callId,
      v: PROTOCOL_VERSION,
    });
    expect(children[0]?.signals).toEqual([]);
    expect(proc.state).toBe('running');
  });

  it('a cancelled call that never ends is killed after the cancel grace (5 s), not its full timeout: warn naming plugin and node, nothing rejected again', async () => {
    const warns: unknown[] = [];
    const { proc, children } = setup(() => {}, {
      log: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
    });
    await proc.start(init);
    const ctl = new AbortController();
    const call = proc.call(callMsg, 30_000, { signal: ctl.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    ctl.abort();
    expect(await call).toBeInstanceOf(PluginCallError);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(children[0]?.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(children[0]?.signals).toContain('SIGKILL');
    expect(warns).toEqual([
      expect.objectContaining({
        plugin: 'example',
        node: 'example:echo',
        hook: 'decide',
        afterMs: 5_000,
      }),
    ]);
    expect(await proc.exit).toEqual({ kind: 'timeout', hook: 'decide', afterMs: 5_000 });
  });

  it('the cancel grace never outlasts the call timeout, and follows cancelGraceMs', async () => {
    const { proc, children } = setup(() => {}, {
      limits: { ...DEFAULT_LIMITS, cancelGraceMs: 10_000 },
    });
    await proc.start(init);
    const ctl = new AbortController();
    const call = proc.call(callMsg, 30_000, { signal: ctl.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(28_000);
    ctl.abort();
    await call;
    await vi.advanceTimersByTimeAsync(1_999);
    expect(children[0]?.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(children[0]?.signals).toContain('SIGKILL');
  });

  it('a cancelled call that does answer disarms the reaper', async () => {
    const { proc, children } = setup();
    await proc.start(init);
    const ctl = new AbortController();
    const call = proc.call(callMsg, 30_000, { signal: ctl.signal }).catch((e: unknown) => e);
    const id = children[0]?.sent.at(-1)?.id ?? '';
    ctl.abort();
    await call;
    children[0]?.emitResult(id, { ok: true, result: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children[0]?.signals).toEqual([]);
    expect(proc.state).toBe('running');
  });

  it('a signal that is already aborted never sends the call', async () => {
    const { proc, children } = setup();
    await proc.start(init);
    const ctl = new AbortController();
    ctl.abort();
    const err = (await proc
      .call(callMsg, 1000, { signal: ctl.signal })
      .catch((e: unknown) => e)) as PluginCallError;
    expect(err.message).toBe('call to plugin example was cancelled');
    expect(children[0]?.sent.map((m) => m.type)).toEqual(['init']);
  });

  it("an abort ends the call's fetches, and an answer that comes late is ignored", async () => {
    const seen: AbortSignal[] = [];
    const { proc, children } = setup(() => {}, {
      fetch: (_input, opts) => {
        seen.push(opts.signal);
        return new Promise(() => {});
      },
    });
    await proc.start(init);
    const ctl = new AbortController();
    const call = proc.call(callMsg, 30_000, { signal: ctl.signal }).catch((e: unknown) => e);
    const callId = children[0]?.sent.at(-1)?.id ?? '';
    children[0]?.deliver({
      v: PROTOCOL_VERSION,
      id: 'fetch-1',
      type: 'fetch',
      callId,
      input: { url: 'https://api.example.test/x', method: 'GET', headers: {}, accept: 'json' },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen[0]?.aborted).toBe(false);
    ctl.abort();
    await call;
    expect(seen[0]?.aborted).toBe(true);
    // The host's own late answer to the cancelled call finds nothing waiting.
    children[0]?.emitResult(callId, { ok: true, result: 1 });
    expect(proc.state).toBe('running');
  });

  it('a call that settles first leaves no cancel behind', async () => {
    const { proc, children } = setup((c) => {
      c.onCall = () => ({ ok: true, result: 1 });
    });
    await proc.start(init);
    const ctl = new AbortController();
    await proc.call(callMsg, 1000, { signal: ctl.signal });
    ctl.abort();
    expect(children[0]?.sent.some((m) => m.type === 'cancel')).toBe(false);
  });
});

describe('PluginProcess misbehaving hosts', () => {
  it('kills a host that sent fatal while running but did not exit within 5 s', async () => {
    const { proc, children } = setup();
    await proc.start(init);
    children[0]?.deliver({ v: PROTOCOL_VERSION, id: 'host', type: 'fatal', reason: 'boom' });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(children[0]?.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(children[0]?.signals).toEqual(['SIGKILL']);
    expect(await proc.exit).toEqual({ kind: 'uncaught', message: 'boom' });
  });

  it('an unparseable answer to a known call rejects that call, not retryable', async () => {
    const { proc, children } = setup();
    await proc.start(init);
    const pending = proc.call(callMsg, 1000).catch((e: unknown) => e);
    const id = children[0]?.sent.at(-1)?.id;
    children[0]?.emit('message', { v: PROTOCOL_VERSION, id, type: 'result', ok: 'maybe' });
    const err = (await pending) as PluginCallError;
    expect(err).toBeInstanceOf(PluginCallError);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('invalid answer');
  });
});

describe('PluginProcess fetch routing', () => {
  it('calls deps.fetch with an abort signal and answers fetch-result with the same id', async () => {
    const seen: Array<{ input: FetchInput; signal: AbortSignal }> = [];
    const { proc, children } = setup(() => {}, {
      fetch: async (input, opts) => {
        seen.push({ input, signal: opts.signal });
        return { ok: true, response: { status: 200, headers: {}, body: { n: 1 } } };
      },
    });
    await proc.start(init);
    const input = {
      url: 'https://api.example.test/x',
      method: 'GET',
      headers: {},
      accept: 'json',
    } as FetchInput;
    children[0]?.deliver({
      v: PROTOCOL_VERSION,
      id: 'fetch-7',
      type: 'fetch',
      callId: null,
      input,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen[0]?.input.url).toBe('https://api.example.test/x');
    expect(seen[0]?.signal.aborted).toBe(false);
    expect(children[0]?.sent.at(-1)).toMatchObject({
      id: 'fetch-7',
      type: 'fetch-result',
      ok: true,
    });
    children[0]?.exit(1);
    expect(seen[0]?.signal.aborted).toBe(true);
  });

  it('answers a failed fetch without leaking the thrown message', async () => {
    const { proc, children } = setup(() => {}, {
      fetch: async () => {
        throw new Error('boom token=abc');
      },
    });
    await proc.start(init);
    const input = {
      url: 'https://api.example.test/x',
      method: 'GET',
      headers: {},
      accept: 'json',
    } as FetchInput;
    children[0]?.deliver({
      v: PROTOCOL_VERSION,
      id: 'fetch-1',
      type: 'fetch',
      callId: null,
      input,
    });
    await vi.advanceTimersByTimeAsync(0);
    const sent = children[0]?.sent.at(-1);
    expect(sent).toMatchObject({ id: 'fetch-1', ok: false, error: { kind: 'failed' } });
    expect(JSON.stringify(sent)).not.toContain('abc');
  });

  it("applies the issuing call's own override and secrets, aborts them when it settles", async () => {
    const seen: Array<{ override?: unknown; secrets?: unknown; signal: AbortSignal }> = [];
    const { proc, children } = setup(() => {}, {
      fetch: async (_input, opts) => {
        seen.push(opts);
        return { ok: true, response: { status: 200, headers: {}, body: null } };
      },
    });
    await proc.start(init);
    const override = { allowedOrigins: ['http://127.0.0.1:1'], allowInsecureTls: false };
    const secrets = { apiKey: 'cand' };
    const a = proc.call(callMsg, 1000, { fetch: { override, secrets } });
    const b = proc.call(callMsg, 1000);
    const [idA = '', idB = ''] = children[0]?.sent.slice(-2).map((m) => m.id) ?? [];
    const input = {
      url: 'https://api.example.test/x',
      method: 'GET',
      headers: {},
      accept: 'json',
    } as FetchInput;
    children[0]?.deliver({ v: PROTOCOL_VERSION, id: 'f1', type: 'fetch', callId: idA, input });
    children[0]?.deliver({ v: PROTOCOL_VERSION, id: 'f2', type: 'fetch', callId: idB, input });
    children[0]?.deliver({ v: PROTOCOL_VERSION, id: 'f3', type: 'fetch', callId: null, input });
    children[0]?.deliver({ v: PROTOCOL_VERSION, id: 'f4', type: 'fetch', callId: 'gone', input });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen[0]).toMatchObject({ override, secrets });
    expect(seen[1]?.override).toBeUndefined();
    expect(seen[1]?.secrets).toBeUndefined();
    for (const i of [2, 3]) {
      expect(seen[i]?.override).toBeUndefined();
      expect(seen[i]?.secrets).toBeUndefined();
    }
    // Per-call signals differ from each other and from the per-process one.
    expect(seen[0]?.signal).not.toBe(seen[1]?.signal);
    expect(seen[2]?.signal).toBe(seen[3]?.signal);
    expect(seen.map((x) => x.signal.aborted)).toEqual([false, false, false, false]);
    children[0]?.deliver({ v: PROTOCOL_VERSION, id: idA, type: 'result', ok: true, result: null });
    await a;
    expect(seen[0]?.signal.aborted).toBe(true);
    expect(seen[1]?.signal.aborted).toBe(false);
    children[0]?.deliver({ v: PROTOCOL_VERSION, id: idB, type: 'result', ok: true, result: null });
    await b;
    expect(seen[1]?.signal.aborted).toBe(true);
    expect(seen[2]?.signal.aborted).toBe(false);
  });

  it('aborts a call’s fetches when the call times out', async () => {
    const seen: AbortSignal[] = [];
    const { proc, children } = setup(() => {}, {
      fetch: async (_input, opts) => {
        seen.push(opts.signal);
        return new Promise(() => {});
      },
    });
    await proc.start(init);
    const pending = proc.call(callMsg, 1000).catch((e: unknown) => e);
    const id = children[0]?.sent.at(-1)?.id ?? '';
    const input = {
      url: 'https://api.example.test/x',
      method: 'GET',
      headers: {},
      accept: 'json',
    } as FetchInput;
    children[0]?.deliver({ v: PROTOCOL_VERSION, id: 'f1', type: 'fetch', callId: id, input });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(seen[0]?.aborted).toBe(true);
  });
});

describe('PluginProcess watchdog and stop', () => {
  it('kills a host whose rss is over the limit', async () => {
    const { proc, children } = setup(() => {}, {
      rssOf: async () => 300 * 1024 * 1024,
    });
    await proc.start(init);
    await vi.advanceTimersByTimeAsync(1000);
    expect(children[0]?.signals).toEqual(['SIGKILL']);
    expect(await proc.exit).toEqual({ kind: 'oom-rss', rssMb: 300 });
  });

  it('stop sends SIGTERM, then SIGKILL after 5 s if the host hangs, and rejects calls retryable', async () => {
    const { proc, children } = setup((c) => {
      c.exitOnTerm = false;
    });
    await proc.start(init);
    const inflight = proc.call(callMsg, 60_000).catch((e: unknown) => e);
    const stopped = proc.stop();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(children[0]?.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(children[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(((await inflight) as PluginCallError).retryable).toBe(true);
    expect(await proc.exit).toEqual({ kind: 'stopped' });
  });

  it('forwards stdout lines, split on newlines', async () => {
    const lines: string[] = [];
    const { proc, children } = setup(() => {}, { onOutput: (_s, l) => lines.push(l) });
    await proc.start(init);
    children[0]?.stdout.write('one\ntw');
    children[0]?.stdout.write('o\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(lines).toEqual(['one', 'two']);
  });
});

describe('a malformed channel frame', () => {
  it('fails the start with a protocol reason and kills the host', async () => {
    const { proc, children } = setup((c) => {
      c.autoReady = false;
    });
    const started = proc.start(init).catch((e: unknown) => e);
    children[0]?.badFrame('malformed message frame: not JSON');
    const err = (await started) as PluginStartError;
    expect(err).toBeInstanceOf(PluginStartError);
    expect(err.reason).toEqual({ kind: 'protocol', message: 'malformed message frame: not JSON' });
    expect(children[0]?.signals).toContain('SIGKILL');
    expect(await proc.exit).toEqual(err.reason);
  });

  it('ends a running host with a protocol reason; pending calls are rejected', async () => {
    const { proc, children } = setup();
    await proc.start(init);
    const pending = proc.call(echo, 30_000).catch((e: unknown) => e);
    children[0]?.badFrame('malformed message frame: not JSON');
    expect(await proc.exit).toEqual({
      kind: 'protocol',
      message: 'malformed message frame: not JSON',
    });
    expect(await pending).toBeInstanceOf(PluginCallError);
    expect(describeExit(await proc.exit)).toBe(
      'broke the message protocol: malformed message frame: not JSON',
    );
  });
});

describe('describeExit and classifyExit', () => {
  it('describes every reason', () => {
    expect(describeExit({ kind: 'timeout', hook: 'decide', afterMs: 30_000 })).toBe(
      'timed out after 30 s in decide',
    );
    expect(describeExit({ kind: 'oom-heap' })).toBe('ran out of memory (heap)');
    expect(describeExit({ kind: 'oom-rss', rssMb: 300 })).toBe('ran out of memory (rss 300 MB)');
    expect(describeExit({ kind: 'killed' })).toBe('was killed');
    expect(describeExit({ kind: 'exit', code: 3 })).toBe('exited with code 3');
    expect(describeExit({ kind: 'uncaught', message: 'x' })).toBe('crashed: x');
    expect(describeExit({ kind: 'start-timeout', afterMs: 60_000 })).toBe(
      'did not start within 60 s',
    );
    expect(describeExit({ kind: 'bad-manifest', message: 'm' })).toBe(
      'bundle manifest mismatch: m',
    );
    expect(describeExit({ kind: 'stopped' })).toBe('stopped');
  });

  it('classifies', () => {
    expect(classifyExit(null, 'SIGABRT', null)).toEqual({ kind: 'oom-heap' });
    const t = { kind: 'timeout', hook: 'data', afterMs: 1 } as const;
    expect(classifyExit(null, 'SIGKILL', t)).toEqual(t);
    expect(classifyExit(null, 'SIGKILL', null)).toEqual({ kind: 'killed' });
    expect(classifyExit(3, null, null)).toEqual({ kind: 'exit', code: 3 });
  });
});
