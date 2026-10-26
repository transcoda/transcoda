import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_LIMITS, type FetchPolicy, type SupervisorLimits } from '@transcoda/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerHookContext } from '../nodes/remote.ts';
import { wireContext } from '../nodes/remote.ts';
import { FetchProxy } from './fetch-proxy.ts';
import { PluginCallError } from './process.ts';
import {
  type PluginFetcher,
  type PluginRuntime,
  type PluginStatus,
  PluginSupervisor,
} from './supervisor.ts';
import { type FixtureName, fixturePluginPath, hostPath } from './testing/build.ts';

const policy: FetchPolicy = { allowedOrigins: [], allowInsecureTls: false };
const supervisors: PluginSupervisor[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((s) => s.stopAll()));
});

function make(
  limits: Partial<SupervisorLimits> = {},
  proxyFor?: (name: string, policy: FetchPolicy) => PluginFetcher,
) {
  const logs: string[] = [];
  const entries: Array<{ message: string; jobId: string | null }> = [];
  const states: PluginStatus[] = [];
  const supervisor = new PluginSupervisor({
    limits: { ...DEFAULT_LIMITS, backoffMinMs: 50, backoffMaxMs: 200, ...limits },
    hostPath: hostPath(),
    now: () => new Date(),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    rssPollMs: 50,
    fetchProxyFor:
      proxyFor ??
      (() => ({
        fetch: async () => ({ ok: false, error: { kind: 'refused', message: 'no' } }),
        setPolicy: () => {},
        setSecrets: () => {},
      })),
    onState: (s) => states.push(s),
    onLog: (_n, _l, message, jobId) => {
      logs.push(message);
      entries.push({ message, jobId });
    },
  });
  supervisors.push(supervisor);
  return { supervisor, logs, entries, states };
}

function runtime(
  fixture: FixtureName,
  nodes: string[],
  integration: string | null,
  settings: PluginRuntime['settings'] = {},
): PluginRuntime {
  return {
    name: fixture,
    version: '0.1.0',
    bundlePath: fixturePluginPath(fixture),
    sha256: 'x',
    manifest: {
      name: fixture,
      version: '0.1.0',
      sdk: '^1',
      nodes,
      integration,
      triggers: [],
      hooks: [],
    },
    settings,
    policy,
    enabled: true,
  };
}

async function until(fn: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const dataCall = (nodeType: string) =>
  ({ type: 'call', hook: 'data', nodeType, nodeVersion: 1, ctx: {}, settings: {} }) as never;

describe('PluginSupervisor with the real host', () => {
  it('a spinning data call times out, the process is killed and comes back', async () => {
    const { supervisor, states } = make({ callTimeoutMs: 300 });
    const r = await supervisor.add(runtime('spin', ['spin:spin'], null));
    expect('error' in (r ?? {})).toBe(false);
    const err = (await supervisor
      .call('spin', dataCall('spin:spin'))
      .catch((e: unknown) => e)) as PluginCallError;
    expect(err).toBeInstanceOf(PluginCallError);
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('plugin spin timed out after 0.3 s');
    await until(() => states.some((s) => s.state === 'restarting'));
    expect(states.find((s) => s.state === 'restarting')?.stateReason).toBe(
      'timed out after 0.3 s in data',
    );
    await until(() => supervisor.status('spin')?.state === 'running');
  });

  it('a memory hog is killed by the rss watchdog', async () => {
    const { supervisor, states } = make({ rssMb: 128 });
    await supervisor.add(runtime('hog', ['hog:hog', 'hog:big-result'], null));
    void supervisor.call('hog', dataCall('hog:hog'), { timeoutMs: 20_000 }).catch(() => {});
    await until(() => states.some((s) => s.stateReason?.startsWith('ran out of memory (rss')));
    const reason =
      states.find((s) => s.stateReason?.startsWith('ran out of memory (rss'))?.stateReason ?? '';
    expect(Number(/rss (\d+) MB/.exec(reason)?.[1])).toBeGreaterThanOrEqual(128);
  });

  it('a plugin that exits in setup is restarted three times, then stopped', async () => {
    const { supervisor } = make({ maxCrashes: 4 });
    const r = await supervisor.add(runtime('crash', [], 'crash', { mode: 'exit' }));
    // The first start already fails: stopped with the reason, the service decides what to do.
    expect(r).toEqual({ error: { kind: 'exit', code: 3 } });
    expect(supervisor.status('crash')).toMatchObject({
      state: 'stopped',
      stateReason: 'exited with code 3',
    });
  });

  it('a plugin that starts, then crashes on a timer, is restarted then stopped', async () => {
    const { supervisor } = make();
    await supervisor.add(runtime('crash', [], 'crash', { mode: 'timer' }));
    // The timer fires 20 ms into setup, before ready: every start fails, so it stops at once.
    await until(() => supervisor.status('crash')?.state === 'stopped');
    expect(supervisor.status('crash')?.stateReason).toContain('crash from a timer');
  });

  it('a plugin that writes a malformed frame to its channel fd in setup is stopped; this process lives on', async () => {
    const { supervisor } = make();
    const r = await supervisor.add(runtime('crash', [], 'crash', { mode: 'garbage' }));
    expect(r).toMatchObject({ error: { kind: 'protocol' } });
    expect(supervisor.status('crash')).toMatchObject({ state: 'stopped' });
    expect(supervisor.status('crash')?.stateReason).toContain('malformed message frame');
  });

  it('a running plugin that writes a malformed frame is stopped at once, never restarted', async () => {
    const { supervisor, states } = make();
    const r = await supervisor.add(runtime('crash', [], 'crash', { mode: 'garbage-later' }));
    expect('error' in (r ?? {})).toBe(false);
    await until(() => supervisor.status('crash')?.state === 'stopped');
    expect(states.some((s) => s.state === 'restarting')).toBe(false);
    expect(supervisor.status('crash')?.stateReason).toContain('malformed message frame');
  });

  it('never lets the integration secret through logs or error messages', async () => {
    const { supervisor, logs } = make();
    await supervisor.add(
      runtime('leaky', ['leaky:leak', 'leaky:findings', 'leaky:throws', 'leaky:echo'], 'leaky', {
        apiKey: 'K-SECRET-9',
      }),
    );
    const a = await supervisor.call('leaky', dataCall('leaky:leak'));
    const b = await supervisor.call('leaky', dataCall('leaky:throws'));
    expect(JSON.stringify(a)).not.toContain('K-SECRET-9');
    expect(JSON.stringify(b)).not.toContain('K-SECRET-9');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain('K-SECRET-9');
  });

  it('test() with a candidate that differs from the stored secret never echoes the candidate', async () => {
    const { supervisor } = make();
    await supervisor.add(runtime('secrets', [], 'secrets', { apiKey: 'K-SECRET-9' }));
    const r = await supervisor.test('secrets', { apiKey: 'K-CANDIDATE-7' });
    expect(r).toMatchObject({ ok: true, result: { ok: true, message: 'key is [redacted]' } });
    expect(JSON.stringify(r)).not.toContain('K-CANDIDATE-7');
  });

  it('test() answers with the secret redacted', async () => {
    const { supervisor } = make();
    await supervisor.add(runtime('secrets', [], 'secrets', { apiKey: 'K-SECRET-9' }));
    const r = await supervisor.test('secrets', { apiKey: 'K-SECRET-9' });
    expect(r).toMatchObject({ ok: true, result: { ok: true, message: 'key is [redacted]' } });
  });

  describe('fetches belong to the call that issued them', () => {
    interface Recorded {
      path: string;
      key: string | undefined;
      closed: boolean;
    }
    interface Local {
      server: Server;
      origin: string;
      seen: Recorded[];
      /** Answers every held request ('/slow' and '/hang'). */
      release(): void;
    }
    const locals: Local[] = [];
    afterEach(async () => {
      for (const l of locals.splice(0)) {
        l.release();
        await new Promise<void>((resolve) => {
          l.server.closeAllConnections();
          l.server.close(() => resolve());
        });
      }
    });

    async function local(): Promise<Local> {
      const held: ServerResponse[] = [];
      const seen: Recorded[] = [];
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const rec: Recorded = {
          path: req.url ?? '',
          key: req.headers['x-api-key'] as string | undefined,
          closed: false,
        };
        seen.push(rec);
        res.on('close', () => {
          rec.closed = true;
        });
        if (rec.path === '/slow' || rec.path === '/hang') {
          held.push(res);
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end('{}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const l: Local = {
        server,
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        seen,
        release: () => {
          for (const r of held.splice(0)) {
            r.setHeader('content-type', 'application/json');
            r.end('{}');
          }
        },
      };
      locals.push(l);
      return l;
    }

    function realProxy(secrets: Record<string, string>) {
      return (name: string, policy: FetchPolicy): PluginFetcher => {
        // The local services listen on loopback, which the proxy refuses: stand them in for LAN ones.
        const proxy = new FetchProxy(name, { limits: DEFAULT_LIMITS, classify: () => 'private' });
        proxy.setPolicy(policy);
        proxy.setSecrets(secrets);
        return proxy;
      };
    }

    const nodeCall = (nodeType: string, url: string, waitMs = 0) =>
      ({
        type: 'call',
        hook: 'data',
        nodeType,
        nodeVersion: 1,
        ctx: {},
        settings: { url, waitMs },
      }) as never;

    const fetcherRuntime = (origin: string) =>
      runtime('fetcher', ['fetcher:get', 'fetcher:fire', 'fetcher:late'], 'fetcher', {
        apiKey: 'K-STORED-1',
        url: origin,
      });

    it('test() uses the candidate origins and secrets; a concurrent node call keeps the stored ones', async () => {
      const stored = await local();
      const candidate = await local();
      const { supervisor } = make({}, realProxy({ apiKey: 'K-STORED-1' }));
      await supervisor.add({
        ...fetcherRuntime(stored.origin),
        policy: { allowedOrigins: [stored.origin], allowInsecureTls: false },
      });
      const override: FetchPolicy = { allowedOrigins: [candidate.origin], allowInsecureTls: false };
      const testing = supervisor.test(
        'fetcher',
        { apiKey: 'K-CANDIDATE-7', url: candidate.origin },
        override,
      );
      await until(() => candidate.seen.length === 1);
      // The candidate's request carried the candidate key.
      expect(candidate.seen[0]).toMatchObject({ path: '/slow', key: 'K-CANDIDATE-7' });

      // Meanwhile the same plugin serves a node call: the candidate origin is refused...
      const refused = await supervisor.call(
        'fetcher',
        nodeCall('fetcher:get', `${candidate.origin}/stolen`),
      );
      expect(refused).toMatchObject({ ok: true, result: { value: { failed: 'refused' } } });
      expect(candidate.seen.map((r) => r.path)).toEqual(['/slow']);
      // ...and the stored origin is served with the stored key.
      const served = await supervisor.call(
        'fetcher',
        nodeCall('fetcher:get', `${stored.origin}/ok`),
      );
      expect(served).toMatchObject({ ok: true, result: { value: { status: 200 } } });
      expect(stored.seen).toEqual([{ path: '/ok', key: 'K-STORED-1', closed: expect.anything() }]);

      candidate.release();
      const r = await testing;
      expect(r).toMatchObject({ ok: true, result: { ok: true, message: 'status 200' } });
      expect(JSON.stringify(r)).not.toContain('K-CANDIDATE-7');
      // Afterwards the candidate origin is still refused for everyone.
      const after = await supervisor.call(
        'fetcher',
        nodeCall('fetcher:get', `${candidate.origin}/again`),
      );
      expect(after).toMatchObject({ ok: true, result: { value: { failed: 'refused' } } });
    }, 30_000);

    it('a fetch fired without await is aborted when its call settles, and frees its slot', async () => {
      const origin = await local();
      const { supervisor } = make({}, realProxy({ apiKey: 'K-STORED-1' }));
      await supervisor.add({
        ...fetcherRuntime(origin.origin),
        policy: { allowedOrigins: [origin.origin], allowInsecureTls: false },
      });
      // Three fires against a concurrency of two: two reach the server, one queues.
      const fires = [1, 2, 3].map(() =>
        supervisor.call('fetcher', nodeCall('fetcher:fire', `${origin.origin}/hang`, 400)),
      );
      for (const r of await Promise.all(fires)) {
        expect(r).toMatchObject({ ok: true, result: { value: { fired: true } } });
      }
      // The calls have settled, so the socket the server sees closes.
      // (The queued third fetch may or may not reach the server before its abort: every request
      // the server saw must close, whatever their number.)
      await until(() => origin.seen.length >= 2 && origin.seen.every((r) => r.closed));
      expect(origin.seen.length).toBeLessThanOrEqual(3);
      // Both slots are free again: a normal fetch is served at once.
      const r = await supervisor.call('fetcher', nodeCall('fetcher:get', `${origin.origin}/ok`));
      expect(r).toMatchObject({ ok: true, result: { value: { status: 200 } } });
    }, 30_000);
  });

  it.each([
    { dryRun: true, job: { id: 'job-dry', attempt: 1 }, tag: 'dryRun=true job=job-dry#1' },
    { dryRun: false, job: { id: 'job-real', attempt: 2 }, tag: 'dryRun=false job=job-real#2' },
  ])('node hooks see dryRun and job as the server sent them ($tag)', async (c) => {
    const { supervisor, entries } = make();
    await supervisor.add(
      runtime(
        'ctxprobe',
        ['ctxprobe:decide', 'ctxprobe:build', 'ctxprobe:finish', 'ctxprobe:data'],
        null,
      ),
    );
    // The server's own context goes through the real wireContext, then over IPC to the real host.
    const server = {
      now: 0,
      probe: { streams: [] },
      file: { path: '/m/a.mkv', sizeBytes: 1, mtime: 'x', nlink: 1 },
      data: {},
      capabilities: { encoders: [], filters: [], hwaccels: [] },
      model: { container: 'mkv', streams: [], targets: [], inputArgs: [], globalArgs: [] },
      originalPath: '/m/a.mkv',
      newPath: '/m/a.mkv',
      replacedTo: null,
      beforeBytes: 2,
      afterBytes: 1,
      outcome: 'replaced',
      containerChanged: false,
      problemsSoFar: [],
      log: () => {},
      plugin: { job: c.job, dryRun: c.dryRun },
    } as unknown as ServerHookContext;
    const ctx = wireContext(server);
    const reasons: string[] = [];
    for (const [hook, type] of [
      ['decide', 'ctxprobe:decide'],
      ['build', 'ctxprobe:build'],
      ['finish', 'ctxprobe:finish'],
      ['data', 'ctxprobe:data'],
      ['run', 'ctxprobe:finish'],
    ] as const) {
      const r = (await supervisor.call('ctxprobe', {
        type: 'call',
        hook,
        nodeType: type,
        nodeVersion: 1,
        ctx,
        settings: {},
      })) as { ok: boolean; result: { reason?: string; message?: string } };
      expect(r.ok).toBe(true);
      reasons.push(r.result.reason ?? r.result.message ?? '');
    }
    expect(reasons).toEqual([c.tag, c.tag, c.tag, c.tag, c.tag]);
    for (const hook of ['decide', 'build', 'finish', 'data', 'run']) {
      expect(entries).toContainEqual({ message: `${hook} ${c.tag}`, jobId: c.job.id });
    }
  });
});
