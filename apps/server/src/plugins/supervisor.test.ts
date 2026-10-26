import { DEFAULT_LIMITS, type FetchPolicy, type SupervisorLimits } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginIsolation } from '../config.ts';
import { type FakeChild, fakeFork, TEST_MANIFEST } from './fake-child.ts';
import type { ProcessIdentity } from './isolation.ts';
import { PluginCallError } from './process.ts';
import {
  type PluginFetcher,
  type PluginRuntime,
  type PluginStatus,
  PluginSupervisor,
} from './supervisor.ts';

const policy: FetchPolicy = { allowedOrigins: [], allowInsecureTls: false };

function runtime(name: string, over: Partial<PluginRuntime> = {}): PluginRuntime {
  return {
    name,
    version: '1.0.0',
    bundlePath: `/b/${name}.js`,
    sha256: 'abc',
    manifest: { ...TEST_MANIFEST, name },
    settings: {},
    policy,
    enabled: true,
    ...over,
  };
}

function isolatedIdentity(
  iso: PluginIsolation,
  over: Partial<ProcessIdentity> = {},
): ProcessIdentity {
  return {
    uid: iso.uid,
    gid: iso.gid,
    capEff: '0000000000000000',
    capPrm: '0000000000000000',
    capAmb: '0000000000000000',
    noNewPrivs: 1,
    ...over,
  };
}

function setup(
  limits: Partial<SupervisorLimits> = {},
  configure: (c: FakeChild, i: number) => void = () => {},
  extra: {
    rssOf?: (pid: number) => Promise<number | null>;
    verify?: (
      rt: PluginRuntime,
    ) => Promise<{ ok: true; bundlePath: string } | { ok: false; reason: string }>;
    isolation?: PluginIsolation | null;
    /** Defaults, with isolation on, to an identity that matches it exactly. */
    identityOf?: (pid: number | undefined) => Promise<ProcessIdentity | null>;
    setSecretsFails?: boolean;
  } = {},
) {
  const { fork, children } = fakeFork((c, i) => {
    // A child answers ready with its own manifest name, taken from the bundle path.
    c.manifest = {
      ...TEST_MANIFEST,
      name: /([^/]+)\.js$/.exec(c.opts.bundlePath)?.[1] ?? 'example',
    };
    configure(c, i);
  });
  const states: PluginStatus[] = [];
  const logs: Array<{ name: string; message: string }> = [];
  const policies = new Map<string, FetchPolicy[]>();
  const warnings: unknown[] = [];
  const fetches: Array<{ name: string; opts: Record<string, unknown> }> = [];
  const secretSets: Array<{ name: string; values: Record<string, string> }> = [];
  const supervisor = new PluginSupervisor({
    limits: { ...DEFAULT_LIMITS, ...limits },
    hostPath: '/h/host.js',
    now: () => new Date(),
    log: { info: (e) => warnings.push(e), warn: (e) => warnings.push(e), error: () => {} },
    fork,
    ...(extra.verify ? { verify: extra.verify } : {}),
    ...(extra.isolation !== undefined ? { isolation: extra.isolation } : {}),
    identityOf:
      extra.identityOf ??
      (async () => (extra.isolation ? isolatedIdentity(extra.isolation) : null)),
    ...(extra.rssOf ? { rssOf: extra.rssOf } : { rssOf: async () => null }),
    fetchProxyFor: (name): PluginFetcher => ({
      fetch: async (_input, opts) => {
        fetches.push({ name, opts });
        return { ok: false, error: { kind: 'refused', message: 'no' } };
      },
      setPolicy: (p) => policies.set(name, [...(policies.get(name) ?? []), p]),
      setSecrets: (values) => {
        if (extra.setSecretsFails) throw new Error('secret fields "a_b" and "a-b" are ambiguous');
        secretSets.push({ name, values });
      },
    }),
    onState: (s) => states.push(s),
    onLog: (name, _l, message) => logs.push({ name, message }),
  });
  return { supervisor, children, states, logs, policies, warnings, fetches, secretSets };
}

const callMsg = {
  type: 'call',
  hook: 'decide',
  nodeType: 'example:echo',
  nodeVersion: 1,
  ctx: {},
  settings: {},
} as never;
/** Exits the child and lets the supervisor see it (the exit promise settles a microtask later). */
async function crashWith(c: FakeChild, code = 3): Promise<void> {
  c.exit(code);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PluginSupervisor crash handling', () => {
  it('restarts with 1 s, 2 s, 4 s backoff and reports restarting with the exit reason', async () => {
    const { supervisor, children } = setup({ maxCrashes: 5 });
    await supervisor.add(runtime('example'));
    expect(supervisor.status('example')?.state).toBe('running');

    await crashWith(children[0] as FakeChild);
    expect(supervisor.status('example')).toMatchObject({
      state: 'restarting',
      stateReason: 'exited with code 3',
      crashes: 1,
    });
    expect(supervisor.status('example')?.nextRestartAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(999);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(2);
    expect(supervisor.status('example')?.state).toBe('running');
    expect(supervisor.status('example')?.nextRestartAt).toBeNull();

    await crashWith(children[1] as FakeChild);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(3);

    await crashWith(children[2] as FakeChild);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(children).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(4);
    await supervisor.stopAll();
  });

  it('gives up after 3 crashes in 10 minutes; enable() starts again', async () => {
    const { supervisor, children } = setup();
    await supervisor.add(runtime('example'));
    await crashWith(children[0] as FakeChild);
    await vi.advanceTimersByTimeAsync(1_000);
    await crashWith(children[1] as FakeChild);
    await vi.advanceTimersByTimeAsync(2_000);
    await crashWith(children[2] as FakeChild);
    expect(supervisor.status('example')).toMatchObject({
      state: 'stopped',
      stateReason: 'stopped: exited with code 3 (3 crashes in 10 min)',
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(children).toHaveLength(3);
    const again = await supervisor.enable('example');
    expect('error' in again).toBe(false);
    expect(supervisor.status('example')?.state).toBe('running');
    expect(children).toHaveLength(4);
    await supervisor.stopAll();
  });

  it('5 minutes stable resets the crash count', async () => {
    const { supervisor, children } = setup();
    await supervisor.add(runtime('example'));
    await crashWith(children[0] as FakeChild);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(supervisor.status('example')?.crashes).toBe(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(supervisor.status('example')?.crashes).toBe(0);
    await crashWith(children[1] as FakeChild);
    // The count restarted: the backoff is 1 s again, not 2 s.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(3);
    await supervisor.stopAll();
  });

  it('kills a process whose rss exceeds the limit and records oom-rss', async () => {
    const { supervisor, children } = setup({}, () => {}, { rssOf: async () => 300 * 1024 * 1024 });
    await supervisor.add(runtime('example'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children[0]?.signals).toContain('SIGKILL');
    expect(supervisor.status('example')).toMatchObject({
      state: 'restarting',
      stateReason: 'ran out of memory (rss 300 MB)',
    });
    await supervisor.stopAll();
  });

  it('a failed first start leaves the plugin stopped with the reason and returns it', async () => {
    const { supervisor } = setup({}, (c) => {
      c.autoReady = false;
      queueMicrotask(() => c.exit(70));
    });
    const r = await supervisor.add(runtime('example'));
    expect(r).toEqual({ error: { kind: 'exit', code: 70 } });
    expect(supervisor.status('example')).toMatchObject({
      state: 'stopped',
      stateReason: 'exited with code 70',
    });
  });

  it('a disabled plugin is not started', async () => {
    const { supervisor, children } = setup();
    await supervisor.add(runtime('example', { enabled: false }));
    expect(children).toHaveLength(0);
    expect(supervisor.status('example')?.state).toBe('disabled');
    await supervisor.enable('example');
    expect(supervisor.running()).toEqual(['example']);
    await supervisor.disable('example');
    expect(supervisor.status('example')?.state).toBe('disabled');
    expect(children[0]?.signals).toEqual(['SIGTERM']);
  });
});

describe('PluginSupervisor isolation', () => {
  it('a dead plugin does not touch another: B keeps answering while A is restarting', async () => {
    const { supervisor, children } = setup({}, (c) => {
      c.onCall = () => ({ ok: true, result: 'pong' });
    });
    await supervisor.add(runtime('a'));
    await supervisor.add(runtime('b'));
    await crashWith(children[0] as FakeChild);
    const aErr = (await supervisor.call('a', callMsg).catch((e: unknown) => e)) as PluginCallError;
    expect(aErr).toBeInstanceOf(PluginCallError);
    // Restarting (backoff) is coming back: the call is retryable. A stopped plugin is not.
    expect(aErr.retryable).toBe(true);
    expect(aErr.message).toBe('plugin a is not running: exited with code 3');
    expect(supervisor.comingBackIn()).toBeGreaterThan(0);
    expect(await supervisor.call('b', callMsg)).toMatchObject({ ok: true, result: 'pong' });
    expect(supervisor.running()).toEqual(['b']);
    expect(supervisor.statuses().filter((s) => s.state === 'restarting')).toHaveLength(1);
    await supervisor.stopAll();
  });

  it('an unknown plugin is not running', async () => {
    const { supervisor } = setup();
    await expect(supervisor.call('nope', callMsg)).rejects.toThrow('plugin nope is not running');
  });

  it('updateSettings reaches only the named plugin', async () => {
    const { supervisor, children, policies } = setup({}, (c) => {
      c.onCall = () => ({ ok: true, result: null });
    });
    await supervisor.add(runtime('a'));
    await supervisor.add(runtime('b'));
    const next: FetchPolicy = { allowedOrigins: ['https://x.test'], allowInsecureTls: false };
    await supervisor.updateSettings('a', { url: 'https://x.test' }, next);
    const typesOf = (c?: FakeChild) => c?.sent.map((m) => m.type);
    expect(typesOf(children[0])).toEqual(['init', 'settings']);
    expect(typesOf(children[1])).toEqual(['init']);
    expect(policies.get('a')).toEqual([next]);
    expect(policies.get('b')).toBeUndefined();
    await supervisor.stopAll();
  });

  it('test() hands the candidate policy and secrets to that call only; the stored policy is never swapped', async () => {
    const { supervisor, children, policies, fetches } = setup({}, (c) => {
      c.integration = secretIntegration as never;
      c.onCall = (m) => {
        // The host issues a fetch while handling this message, with its id as the call id.
        c.deliver({
          v: 1,
          id: `f-${m.id}`,
          type: 'fetch',
          callId: m.id,
          input: { url: 'https://c.test/', method: 'GET', headers: {}, accept: 'json' },
        });
        return { ok: true, result: { ok: true, message: 'fine' } };
      };
    });
    await supervisor.add(runtime('a', { settings: { apiKey: 'K-STORED-1' } }));
    const candidate: FetchPolicy = { allowedOrigins: ['https://c.test'], allowInsecureTls: false };
    const r = await supervisor.test('a', { apiKey: 'K-CANDIDATE-7' }, candidate);
    expect(r).toMatchObject({ ok: true });
    expect(policies.get('a')).toBeUndefined();
    expect(fetches[0]?.opts).toMatchObject({
      override: candidate,
      secrets: { apiKey: 'K-CANDIDATE-7' },
    });
    // An ordinary call on the same plugin carries neither.
    await supervisor.call('a', callMsg);
    expect(fetches[1]?.opts.override).toBeUndefined();
    expect(fetches[1]?.opts.secrets).toBeUndefined();
    expect(children).toHaveLength(1);
    await supervisor.stopAll();
  });
});

describe('PluginSupervisor output and shutdown', () => {
  it('stdout lines are forwarded tagged and rate-limited', async () => {
    const { supervisor, children, logs, warnings } = setup();
    await supervisor.add(runtime('example'));
    const out = children[0]?.stdout;
    for (let i = 0; i < 150; i++) out?.write(`line ${i}\n`);
    await vi.advanceTimersByTimeAsync(0);
    expect(logs).toHaveLength(100);
    expect(logs[0]).toEqual({ name: 'example', message: 'line 0' });
    // Logged once, through onLog: the supervisor's own logger has no second copy.
    expect(JSON.stringify(warnings)).not.toContain('line 0');
    await vi.advanceTimersByTimeAsync(1_000);
    out?.write('after\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.at(-2)?.message).toBe('dropped 50 lines');
    expect(logs.at(-1)?.message).toBe('after');
    await supervisor.stopAll();
  });

  it('stopAll sends SIGTERM then SIGKILL after 5 s and rejects in-flight calls retryable', async () => {
    const { supervisor, children } = setup({}, (c) => {
      c.exitOnTerm = false;
    });
    await supervisor.add(runtime('example'));
    const inflight = supervisor.call('example', callMsg).catch((e: unknown) => e);
    const stopped = supervisor.stopAll();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
    expect(children[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(((await inflight) as PluginCallError).retryable).toBe(true);
    // stopping is not a crash: nothing restarts
    await vi.advanceTimersByTimeAsync(120_000);
    expect(children).toHaveLength(1);
  });

  it('remove stops the process and forgets the plugin', async () => {
    const { supervisor, children } = setup();
    await supervisor.add(runtime('example'));
    await supervisor.remove('example');
    expect(supervisor.status('example')).toBeNull();
    expect(children[0]?.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(children).toHaveLength(1);
  });

  it('redacts a secret on server-side output even if the host did not', async () => {
    const { supervisor, children, logs } = setup({}, (c) => {
      c.integration = {
        settingsSchema: {
          type: 'object',
          properties: { apiKey: { type: 'string', 'x-transcoda': 'secret' } },
        },
        allowedOrigins: [],
      };
    });
    await supervisor.add(runtime('example', { settings: { apiKey: 'K-SECRET-9' } }));
    children[0]?.stdout.write('key=K-SECRET-9\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.map((l) => l.message)).toEqual(['key=[redacted]']);
    await supervisor.stopAll();
  });
});

const secretIntegration = {
  settingsSchema: {
    type: 'object',
    properties: { apiKey: { type: 'string', 'x-transcoda': 'secret' }, url: { type: 'string' } },
  },
  allowedOrigins: [],
} as const;

describe('PluginSupervisor redaction and limits', () => {
  it('before ready, every string setting is treated as a secret', async () => {
    const { supervisor, children, logs } = setup({}, (c) => {
      c.autoReady = false;
      c.integration = secretIntegration as never;
    });
    const added = supervisor.add(
      runtime('example', { settings: { apiKey: 'K-SECRET-9', url: 'https://x.test/path' } }),
    );
    children[0]?.stdout.write('setup saw K-SECRET-9 and https://x.test/path\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.map((l) => l.message)).toEqual(['setup saw [redacted] and [redacted]']);
    children[0]?.emitReady('example-1');
    await added;
    // Once the schema is known only the real secret stays redacted.
    children[0]?.stdout.write('url https://x.test/path key K-SECRET-9\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.at(-1)?.message).toBe('url https://x.test/path key [redacted]');
    await supervisor.stopAll();
  });

  it('a runtime that knows its secret keys redacts only those from the start', async () => {
    const { supervisor, children, logs } = setup({}, (c) => {
      c.autoReady = false;
    });
    const added = supervisor.add(
      runtime('example', {
        settings: { apiKey: 'K-SECRET-9', url: 'https://x.test' },
        secretKeys: ['apiKey'],
      }),
    );
    children[0]?.stdout.write('K-SECRET-9 https://x.test\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.map((l) => l.message)).toEqual(['[redacted] https://x.test']);
    children[0]?.emitReady('example-1');
    await added;
    await supervisor.stopAll();
  });

  it('test() redacts a candidate secret that differs from the stored one', async () => {
    const { supervisor } = setup({}, (c) => {
      c.integration = secretIntegration as never;
      c.onCall = (m) => ({
        ok: true,
        result: { ok: true, message: `used ${JSON.stringify(m.settings)}` },
      });
    });
    await supervisor.add(runtime('example', { settings: { apiKey: 'K-STORED-1' } }));
    const r = await supervisor.test('example', { apiKey: 'K-CANDIDATE-7' });
    expect(JSON.stringify(r)).not.toContain('K-CANDIDATE-7');
    const v = await supervisor.validate('example', null, { apiKey: 'K-CANDIDATE-8' });
    expect(JSON.stringify(v)).not.toContain('K-CANDIDATE-8');
    await supervisor.stopAll();
  });

  it('migrate() sends a migrate message for the node and returns the host result', async () => {
    const { supervisor, children } = setup({}, (c) => {
      c.onCall = (m) => ({ ok: true, result: { settings: { value: 'migrated', from: m.type } } });
    });
    await supervisor.add(runtime('example'));
    const r = await supervisor.migrate('example', 'example:a', 1, { old: 'a' });
    expect(r).toMatchObject({ ok: true, result: { settings: { value: 'migrated' } } });
    const sent = children[0]?.sent.find((m) => m.type === 'migrate');
    expect(sent).toMatchObject({
      type: 'migrate',
      nodeType: 'example:a',
      from: 1,
      settings: { old: 'a' },
    });
    await supervisor.stopAll();
  });

  it('host log messages share a per-second cap and report what was dropped', async () => {
    const { supervisor, children, logs } = setup();
    await supervisor.add(runtime('example'));
    for (let i = 0; i < 150; i++) {
      children[0]?.deliver({
        v: 1,
        id: 'log',
        type: 'log',
        level: 'info',
        message: `m${i}`,
        jobId: null,
      });
    }
    expect(logs).toHaveLength(100);
    await vi.advanceTimersByTimeAsync(1_000);
    children[0]?.deliver({
      v: 1,
      id: 'log',
      type: 'log',
      level: 'info',
      message: 'after',
      jobId: null,
    });
    expect(logs.at(-2)?.message).toBe('dropped 50 log messages');
    expect(logs.at(-1)?.message).toBe('after');
    await supervisor.stopAll();
  });
});

describe('PluginSupervisor disabled plugins and in-flight calls', () => {
  it('restart() on a disabled plugin is refused and starts nothing', async () => {
    const { supervisor, children } = setup();
    await supervisor.add(runtime('example', { enabled: false }));
    await expect(supervisor.restart('example')).rejects.toThrow('plugin example is disabled');
    expect(children).toHaveLength(0);
    expect(supervisor.status('example')?.state).toBe('disabled');
  });

  it('a crash after the plugin was marked disabled ends in state disabled, not a restart', async () => {
    const { supervisor, children } = setup();
    await supervisor.add(runtime('example'));
    // Reaches into the entry: a disable() racing the crash cannot be scripted from outside.
    const entries = (
      supervisor as unknown as { entries: Map<string, { rt: { enabled: boolean } }> }
    ).entries;
    const entry = entries.get('example');
    if (entry) entry.rt.enabled = false;
    await crashWith(children[0] as FakeChild);
    expect(supervisor.status('example')).toMatchObject({ state: 'disabled', stateReason: null });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(children).toHaveLength(1);
  });

  it('a call to B in flight while A dies is unaffected', async () => {
    const { supervisor, children } = setup();
    await supervisor.add(runtime('a'));
    await supervisor.add(runtime('b'));
    const inflight = supervisor.call('b', callMsg);
    await vi.advanceTimersByTimeAsync(0);
    await crashWith(children[0] as FakeChild);
    const id = children[1]?.sent.at(-1)?.id as string;
    children[1]?.emitResult(id, { ok: true, result: 'still here' });
    expect(await inflight).toMatchObject({ ok: true, result: 'still here' });
    expect(supervisor.status('b')?.state).toBe('running');
    await supervisor.stopAll();
  });
});

describe('PluginSupervisor secrets for the fetch proxy', () => {
  it('hands the proxy the real secret values by field path: from the runtime keys at add, again from the schema at ready, on every settings change', async () => {
    const { supervisor, secretSets } = setup({}, (c) => {
      c.integration = secretIntegration as never;
      c.onCall = () => ({ ok: true, result: null });
    });
    await supervisor.add(
      runtime('example', {
        settings: { apiKey: 'K-ONE-1', url: 'https://x.test' },
        secretKeys: ['apiKey'],
      }),
    );
    expect(secretSets.map((s) => s.values)).toEqual([{ apiKey: 'K-ONE-1' }, { apiKey: 'K-ONE-1' }]);
    await supervisor.updateSettings(
      'example',
      { apiKey: 'K-TWO-2', url: 'https://x.test' },
      policy,
    );
    expect(secretSets.at(-1)?.values).toEqual({ apiKey: 'K-TWO-2' });
    // A cleared secret leaves the map.
    await supervisor.updateSettings('example', { url: 'https://x.test' }, policy);
    expect(secretSets.at(-1)?.values).toEqual({});
    await supervisor.stopAll();
  });

  it('a runtime without known keys starts with an empty map until ready brings the schema', async () => {
    const { supervisor, secretSets } = setup({}, (c) => {
      c.integration = secretIntegration as never;
    });
    await supervisor.add(runtime('example', { settings: { apiKey: 'K-ONE-1' } }));
    expect(secretSets.map((s) => s.values)).toEqual([{}, { apiKey: 'K-ONE-1' }]);
    await supervisor.stopAll();
  });

  it('ambiguous secret field names fail the plugin (stopped, with the reason and no secret) instead of starting it', async () => {
    const { supervisor, children } = setup({}, () => {}, { setSecretsFails: true });
    const r = await supervisor.add(
      runtime('example', { settings: { a_b: 'K-ONE-1' }, secretKeys: ['a_b'] }),
    );
    expect(r).toMatchObject({ error: { kind: 'bad-manifest' } });
    expect(children).toHaveLength(0);
    const status = supervisor.status('example');
    expect(status).toMatchObject({ state: 'stopped' });
    expect(status?.stateReason).toContain('ambiguous');
    expect(JSON.stringify(status)).not.toContain('K-ONE-1');
  });

  it('a settings change that makes the secret fields ambiguous stops the process', async () => {
    const { supervisor, children } = setup({ maxCrashes: 5 });
    await supervisor.add(
      runtime('example', { secretKeys: ['apiKey'], settings: { apiKey: 'K-1' } }),
    );
    const fetcherOf = (
      supervisor as unknown as { entries: Map<string, { fetcher: PluginFetcher }> }
    ).entries.get('example')?.fetcher;
    if (!fetcherOf) throw new Error('no entry');
    fetcherOf.setSecrets = () => {
      throw new Error('secret fields "a_b" and "a-b" are ambiguous');
    };
    await supervisor.updateSettings('example', { apiKey: 'K-2' }, policy);
    expect(supervisor.status('example')).toMatchObject({ state: 'stopped' });
    expect(children[0]?.signals).toContain('SIGTERM');
  });
});

describe('PluginSupervisor verify before every start', () => {
  it('a refusal stops the plugin with the reason without forking, at add, restart and after a crash', async () => {
    let bad: string | null = null;
    const { supervisor, children } = setup({}, () => {}, {
      verify: async (rt) =>
        bad === null ? { ok: true, bundlePath: rt.bundlePath } : { ok: false, reason: bad },
    });
    await supervisor.add(runtime('example'));
    expect(supervisor.status('example')?.state).toBe('running');
    bad = 'bundle changed on disk; reinstall';
    const r = await supervisor.restart('example');
    expect(r).toEqual({
      error: { kind: 'bad-manifest', message: 'bundle changed on disk; reinstall' },
    });
    expect(supervisor.status('example')).toMatchObject({
      state: 'stopped',
      stateReason: 'bundle changed on disk; reinstall',
    });
    expect(children).toHaveLength(1);

    bad = null;
    await supervisor.restart('example');
    expect(supervisor.status('example')?.state).toBe('running');
    // A crash restart re-checks too: the file changed in the meantime.
    bad = 'bundle changed on disk; reinstall';
    await crashWith(children[1] as FakeChild);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(supervisor.status('example')).toMatchObject({
      state: 'stopped',
      stateReason: 'bundle changed on disk; reinstall',
    });
    expect(children).toHaveLength(2);
  });

  it('the bundle path verify returns is the one the host is forked with, and the entry keeps it', async () => {
    const { supervisor, children } = setup({}, () => {}, {
      verify: async () => ({ ok: true, bundlePath: '/run/staged/example.js' }),
    });
    await supervisor.add(runtime('example', { bundlePath: '/config/plugins/example.js' }));
    expect(children[0]?.opts.bundlePath).toBe('/run/staged/example.js');
    expect(children[0]?.opts.execArgv).toContain('--allow-fs-read=/run/staged/example.js');
    expect(children[0]?.opts.execArgv).not.toContain('--allow-fs-read=/config/plugins/example.js');
  });

  it('isolation reaches the fork, except for a runtime with isolated: false', async () => {
    const iso = { uid: 65001, gid: 65001, runDir: '/run/x', setprivPath: '/usr/bin/setpriv' };
    const { supervisor, children } = setup({}, () => {}, { isolation: iso });
    await supervisor.add(runtime('example'));
    await supervisor.add(runtime('devplug', { isolated: false }));
    expect(children[0]?.opts.isolation).toEqual(iso);
    expect(children[1]?.opts.isolation).toBeNull();
  });

  describe('post-spawn identity check', () => {
    const iso = { uid: 65001, gid: 65001, runDir: '/run/x', setprivPath: '/usr/bin/setpriv' };

    it('a host that matches the isolation runs', async () => {
      const seen: Array<number | undefined> = [];
      const { supervisor } = setup({}, () => {}, {
        isolation: iso,
        identityOf: async (pid) => {
          seen.push(pid);
          return isolatedIdentity(iso);
        },
      });
      await supervisor.add(runtime('example'));
      expect(supervisor.status('example')?.state).toBe('running');
      expect(seen).toHaveLength(1);
      await supervisor.stopAll();
    });

    it.each([
      [{ uid: 1000 }, 'uid expected 65001, got 1000'],
      [{ gid: 0 }, 'gid expected 65001, got 0'],
      [{ capEff: '00000000000000e0' }, 'capEff expected 0000000000000000, got 00000000000000e0'],
      [{ capPrm: '0000000000000020' }, 'capPrm expected 0000000000000000, got 0000000000000020'],
      [{ capAmb: '0000000000000040' }, 'capAmb expected 0000000000000000, got 0000000000000040'],
      [{ noNewPrivs: 0 }, 'noNewPrivs expected 1, got 0'],
    ] as Array<[Partial<ProcessIdentity>, string]>)(
      'a host with %j is stopped, never restarted',
      async (over, detail) => {
        const { supervisor, children } = setup({}, () => {}, {
          isolation: iso,
          identityOf: async () => isolatedIdentity(iso, over),
        });
        const result = await supervisor.add(runtime('example'));
        const reason = `plugin host is not isolated: ${detail}`;
        expect(result).toEqual({ error: { kind: 'bad-manifest', message: reason } });
        expect(supervisor.status('example')).toMatchObject({
          state: 'stopped',
          stateReason: reason,
        });
        expect(children[0]?.signals).toContain('SIGTERM');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(children).toHaveLength(1);
        expect(supervisor.status('example')?.state).toBe('stopped');
      },
    );

    it('an unreadable identity is a failure too', async () => {
      const { supervisor } = setup({}, () => {}, { isolation: iso, identityOf: async () => null });
      await supervisor.add(runtime('example'));
      expect(supervisor.status('example')).toMatchObject({
        state: 'stopped',
        stateReason: 'plugin host is not isolated: identity expected readable, got unreadable',
      });
    });

    it('a candidate that is not isolated is refused', async () => {
      let bad = false;
      const { supervisor } = setup({}, () => {}, {
        isolation: iso,
        identityOf: async () => isolatedIdentity(iso, bad ? { uid: 0 } : {}),
      });
      await supervisor.add(runtime('example'));
      bad = true;
      const c = await supervisor.startCandidate('example', runtime('example'));
      expect(c).toEqual({
        error: {
          kind: 'bad-manifest',
          message: 'plugin host is not isolated: uid expected 65001, got 0',
        },
      });
      expect(supervisor.status('example')?.state).toBe('running');
      await supervisor.stopAll();
    });

    it('is not asked for a runtime with isolated: false or without isolation', async () => {
      const identityOf = vi.fn(async () => null);
      const a = setup({}, () => {}, { isolation: iso, identityOf });
      await a.supervisor.add(runtime('devplug', { isolated: false }));
      const b = setup({}, () => {}, { identityOf });
      await b.supervisor.add(runtime('example'));
      expect(identityOf).not.toHaveBeenCalled();
      expect(a.supervisor.status('devplug')?.state).toBe('running');
      expect(b.supervisor.status('example')?.state).toBe('running');
      await a.supervisor.stopAll();
      await b.supervisor.stopAll();
    });
  });

  it('a runtime that is added disabled is not verified', async () => {
    const verify = vi.fn(async () => ({ ok: false as const, reason: 'bad' }));
    const { supervisor } = setup({}, () => {}, { verify });
    await supervisor.add(runtime('example', { enabled: false }));
    expect(verify).not.toHaveBeenCalled();
    expect(supervisor.status('example')?.state).toBe('disabled');
  });
});

describe('PluginSupervisor calls with a signal', () => {
  it('passes the signal to the process: an abort cancels that call only', async () => {
    const { supervisor, children } = setup();
    await supervisor.add(runtime('example'));
    const ctl = new AbortController();
    const call = supervisor
      .call('example', callMsg, { signal: ctl.signal })
      .catch((e: unknown) => e);
    const sent = children[0]?.sent.at(-1);
    ctl.abort();
    expect(await call).toMatchObject({
      message: 'call to plugin example was cancelled',
      retryable: false,
    });
    expect(children[0]?.sent.at(-1)).toMatchObject({ type: 'cancel', id: sent?.id });
    expect(supervisor.status('example')?.state).toBe('running');
    await supervisor.stopAll();
  });
});

describe('PluginSupervisor candidates (updates)', () => {
  const candidateRuntime = (over: Partial<PluginRuntime> = {}) =>
    runtime('example', { version: '2.0.0', bundlePath: '/b/example.js', ...over });

  it('a candidate runs beside the old process, never shows in the statuses, and takes over on commit', async () => {
    const { supervisor, children, states } = setup();
    await supervisor.add(runtime('example'));
    const seen = states.length;
    const cand = await supervisor.startCandidate('example', candidateRuntime());
    if ('error' in cand) throw new Error('candidate failed');
    expect(children).toHaveLength(2);
    expect(supervisor.statuses().map((s) => [s.name, s.pid])).toEqual([['example', 10_000]]);
    expect(states.length).toBe(seen);
    expect(children[0]?.signals).toEqual([]);

    await cand.commit();
    expect(children[0]?.signals).toContain('SIGTERM');
    expect(supervisor.status('example')).toMatchObject({ state: 'running', pid: 10_001 });
    expect(supervisor.statuses()).toHaveLength(1);
    // The old process's exit is not a crash.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(supervisor.status('example')).toMatchObject({ state: 'running', crashes: 0 });
    expect(children).toHaveLength(2);
    await supervisor.stopAll();
  });

  it('a candidate that does not come up is an error and leaves the old one running', async () => {
    const { supervisor, children } = setup({}, (c, i) => {
      if (i === 1) c.manifest = { ...TEST_MANIFEST, name: 'example', version: '9.9.9' };
    });
    await supervisor.add(runtime('example'));
    const cand = await supervisor.startCandidate('example', candidateRuntime());
    expect(cand).toMatchObject({ error: { kind: 'bad-manifest' } });
    expect(supervisor.status('example')).toMatchObject({ state: 'running', pid: 10_000 });
    expect(children[0]?.signals).toEqual([]);
  });

  it('discard stops the candidate and nothing else; a commit on a disabled plugin keeps it disabled', async () => {
    const { supervisor, children } = setup();
    await supervisor.add(runtime('example'));
    const one = await supervisor.startCandidate('example', candidateRuntime());
    if ('error' in one) throw new Error('candidate failed');
    await one.discard();
    expect(children[1]?.signals).toContain('SIGTERM');
    expect(supervisor.status('example')).toMatchObject({ state: 'running', pid: 10_000 });

    await supervisor.disable('example');
    const two = await supervisor.startCandidate('example', candidateRuntime());
    if ('error' in two) throw new Error('candidate failed');
    await two.commit();
    expect(children[2]?.signals).toContain('SIGTERM');
    expect(supervisor.status('example')).toMatchObject({ state: 'disabled', pid: null });
    // The next enable runs the new bundle.
    await supervisor.enable('example');
    expect(children[3]?.opts.bundlePath).toBe('/b/example.js');
    expect(supervisor.status('example')?.state).toBe('running');
    await supervisor.stopAll();
  });

  it('a stopped plugin that is updated runs again on commit', async () => {
    const { supervisor } = setup({}, (c, i) => {
      if (i === 0) c.autoReady = false;
    });
    const first = supervisor.add(runtime('example'));
    await vi.advanceTimersByTimeAsync(60_000);
    await first;
    expect(supervisor.status('example')?.state).toBe('stopped');
    const cand = await supervisor.startCandidate('example', candidateRuntime());
    if ('error' in cand) throw new Error('candidate failed');
    await cand.commit();
    expect(supervisor.status('example')).toMatchObject({ state: 'running', crashes: 0 });
    await supervisor.stopAll();
  });

  it('setPolicy changes the fetch policy without a message to the host', async () => {
    const { supervisor, children, policies } = setup();
    await supervisor.add(runtime('example'));
    const sent = children[0]?.sent.length;
    const next = { allowedOrigins: ['https://api.x.test'], allowInsecureTls: false };
    supervisor.setPolicy('example', next);
    expect(policies.get('example')).toEqual([next]);
    expect(children[0]?.sent.length).toBe(sent);
    await supervisor.stopAll();
  });
});

describe('PluginSupervisor cap on running hosts (maxHosts)', () => {
  const capReason =
    'too many plugins running (at most 2); disable another plugin or raise plugins.limits.maxHosts';

  it('a start past the cap is refused without forking and leaves the plugin stopped; a freed slot lets it start', async () => {
    const { supervisor, children } = setup({ maxHosts: 2 });
    await supervisor.add(runtime('a'));
    await supervisor.add(runtime('b'));
    const r = await supervisor.add(runtime('c'));
    expect(r).toEqual({ error: { kind: 'bad-manifest', message: capReason } });
    expect(children).toHaveLength(2);
    expect(supervisor.status('c')).toMatchObject({ state: 'stopped', stateReason: capReason });
    expect(supervisor.running()).toEqual(['a', 'b']);

    await supervisor.disable('a');
    const again = await supervisor.enable('c');
    expect('error' in again).toBe(false);
    expect(supervisor.running()).toEqual(['b', 'c']);
    await supervisor.stopAll();
  });

  it('a restart after a crash counts against the cap too', async () => {
    const { supervisor, children } = setup({ maxHosts: 2 });
    await supervisor.add(runtime('a'));
    await supervisor.add(runtime('b'));
    await crashWith(children[0] as FakeChild);
    // While a is in backoff its slot is free: c takes it.
    await supervisor.add(runtime('c'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(3);
    expect(supervisor.status('a')).toMatchObject({ state: 'stopped', stateReason: capReason });
    await supervisor.stopAll();
  });

  it('a candidate that replaces a running process is allowed at the cap; one for a stopped plugin is not', async () => {
    const { supervisor, children } = setup({ maxHosts: 1 });
    await supervisor.add(runtime('a'));
    const cand = await supervisor.startCandidate(
      'a',
      runtime('a', { version: '2.0.0', bundlePath: '/b/a.js' }),
    );
    if ('error' in cand) throw new Error('candidate failed');
    await cand.commit();
    expect(supervisor.running()).toEqual(['a']);

    await supervisor.add(runtime('b'));
    expect(supervisor.status('b')?.state).toBe('stopped');
    const forks = children.length;
    const refused = await supervisor.startCandidate(
      'b',
      runtime('b', { version: '2.0.0', bundlePath: '/b/b.js' }),
    );
    expect(refused).toEqual({
      error: {
        kind: 'bad-manifest',
        message:
          'too many plugins running (at most 1); disable another plugin or raise plugins.limits.maxHosts',
      },
    });
    expect(children).toHaveLength(forks);
    await supervisor.stopAll();
  });
});
