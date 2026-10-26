import { fakeHookContext } from '@transcoda/sdk/testing';
import type { HostMessage, JsonValue } from '@transcoda/shared';
import { PROTOCOL_VERSION } from '@transcoda/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type FixtureName, fixturePluginPath, hostPath } from '../plugins/testing/build.ts';
import {
  type HostHandle,
  type SpawnedHost,
  spawnHost,
  startHost,
} from '../plugins/testing/spawn.ts';

const started: HostHandle[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((h) => h.stop()));
});

async function host(
  name: FixtureName,
  settings: JsonValue = {},
  extra: { heapMb?: number } = {},
): Promise<SpawnedHost> {
  const h = await spawnHost({
    hostPath: hostPath(),
    bundlePath: fixturePluginPath(name),
    settings,
    ...extra,
  });
  started.push(h);
  return h;
}

let counter = 0;
const nextId = () => `t-${++counter}`;

type Result = Extract<HostMessage, { type: 'result' }>;

async function ask(h: HostHandle, body: Record<string, unknown>): Promise<Result> {
  const id = nextId();
  h.send({ v: PROTOCOL_VERSION, id, ...body });
  const result = (await h.next('result')) as Result;
  expect(result.id).toBe(id);
  return result;
}

const { log: _log, plugin: _plugin, ...jsonContext } = fakeHookContext();
const hookCtx = (over: Record<string, unknown> = {}) => ({
  ...jsonContext,
  file: { ...jsonContext.file, path: '/a/b.mkv' },
  ...over,
});

describe('plugin host, example plugin', () => {
  it('announces the manifest and node metadata in ready', async () => {
    const h = await host('example');
    expect(h.ready.manifest).toEqual({
      name: 'example',
      version: '0.1.0',
      sdk: '^1',
      nodes: ['example:extension-is', 'example:note', 'example:fixed-language'],
      nodeVersions: [
        { type: 'example:extension-is', version: 1, migrations: [] },
        { type: 'example:note', version: 1, migrations: [] },
        { type: 'example:fixed-language', version: 1, migrations: [] },
      ],
      nodeInfo: [
        { type: 'example:extension-is', kind: 'condition', title: 'Extension is' },
        { type: 'example:note', kind: 'finish', title: 'Note' },
        { type: 'example:fixed-language', kind: 'data', title: 'Fixed language' },
      ],
      integration: null,
      triggers: [],
      hooks: [],
    });
    const nodes = h.ready.nodes as Array<{ type: string; hooks: string[]; finishPhase: unknown }>;
    expect(nodes.map((n) => [n.type, n.hooks, n.finishPhase])).toEqual([
      ['example:extension-is', ['decide'], null],
      ['example:note', ['finish', 'run'], 'notify'],
      ['example:fixed-language', ['data'], null],
    ]);
    expect(h.ready.integration).toBeNull();
  });

  it('validates node settings with the plugin own zod', async () => {
    const h = await host('example');
    const ok = await ask(h, { type: 'validate', nodeType: 'example:extension-is', settings: {} });
    expect(ok).toMatchObject({ ok: true, result: { ok: true, value: { extensions: ['mkv'] } } });
    const bad = await ask(h, {
      type: 'validate',
      nodeType: 'example:extension-is',
      settings: { extensions: 1 },
    });
    expect(bad).toMatchObject({
      ok: true,
      result: { ok: false, issues: [{ path: 'extensions', missing: false }] },
    });
  });

  it('calls decide, finish and data, and the finish run after the write', async () => {
    const h = await host('example');
    const decide = await ask(h, {
      type: 'call',
      hook: 'decide',
      nodeType: 'example:extension-is',
      nodeVersion: 1,
      ctx: hookCtx({ now: 0 }),
      settings: {},
    });
    expect(decide).toMatchObject({ ok: true, result: { port: 'pass' } });

    const finish = await ask(h, {
      type: 'call',
      hook: 'finish',
      nodeType: 'example:note',
      nodeVersion: 1,
      ctx: hookCtx(),
      settings: { text: 'x', required: true },
    });
    expect(finish).toMatchObject({
      ok: true,
      result: { actions: [{ kind: 'plugin', description: 'note x', required: true }] },
    });

    const run = await ask(h, {
      type: 'call',
      hook: 'run',
      nodeType: 'example:note',
      nodeVersion: 1,
      ctx: hookCtx({
        originalPath: '/x/in.mkv',
        newPath: '/x/out.mkv',
        replacedTo: null,
        beforeBytes: 2,
        afterBytes: 1,
        outcome: 'replaced',
        containerChanged: false,
        problemsSoFar: [],
      }),
      settings: {},
    });
    expect(run).toMatchObject({ ok: true, result: { ok: true, message: 'noted /x/out.mkv' } });

    const data = await ask(h, {
      type: 'call',
      hook: 'data',
      nodeType: 'example:fixed-language',
      nodeVersion: 1,
      ctx: hookCtx(),
      settings: { language: 'jpn' },
    });
    expect(data).toMatchObject({ ok: true, result: { value: 'jpn', reason: 'fixed' } });
  });

  it('answers an unusable call with an error and stays alive', async () => {
    const h = await host('example');
    const missing = await ask(h, {
      type: 'call',
      hook: 'build',
      nodeType: 'example:extension-is',
      nodeVersion: 1,
      ctx: hookCtx(),
      settings: {},
    });
    expect(missing).toMatchObject({ ok: false, error: { message: /no build hook/ } });
    const badSettings = await ask(h, {
      type: 'call',
      hook: 'decide',
      nodeType: 'example:extension-is',
      nodeVersion: 1,
      ctx: hookCtx(),
      settings: { extensions: 1 },
    });
    expect(badSettings).toMatchObject({ ok: false, error: { message: /invalid settings/ } });
    expect(await ask(h, { type: 'cancel' })).toMatchObject({ ok: true });
  });

  it('forwards logs with the job id', async () => {
    const h = await host('example');
    await ask(h, {
      type: 'call',
      hook: 'decide',
      nodeType: 'example:extension-is',
      nodeVersion: 1,
      ctx: hookCtx({ job: { id: 'job-7', attempt: 2 } }),
      settings: {},
    });
    expect(await h.next('log')).toMatchObject({
      level: 'debug',
      message: 'example 0.1.0 loaded',
      jobId: null,
    });
    expect(await h.next('log')).toMatchObject({
      level: 'debug',
      message: 'checking /a/b.mkv',
      jobId: 'job-7',
    });
  });

  it('rejects a message with another protocol version', async () => {
    const h = await host('example');
    const id = nextId();
    h.send({ v: 2, id, type: 'cancel' });
    expect(await h.next('result')).toMatchObject({
      id,
      ok: false,
      error: { message: expect.stringContaining('invalid message') },
    });
  });

  it('ignores an invalid message that has no id', async () => {
    const h = await host('example');
    h.send({ nonsense: true });
    expect(await ask(h, { type: 'cancel' })).toMatchObject({ ok: true });
  });
});

describe('plugin host, leaky plugin', () => {
  const settings = { apiKey: 'K-SECRET-9' };
  const call = {
    type: 'call',
    hook: 'data',
    nodeType: 'leaky:leak',
    nodeVersion: 1,
    ctx: hookCtx(),
    settings: {},
  };

  it('answers a fetch from the host and the plugin sees status and body', async () => {
    const h = await host('leaky', settings);
    const id = nextId();
    h.send({ v: PROTOCOL_VERSION, id, ...call });
    const fetch = await h.next('fetch');
    // The fetch names the call whose handling issued it.
    expect(fetch).toMatchObject({ callId: id });
    h.send({
      v: PROTOCOL_VERSION,
      id: fetch.id,
      type: 'fetch-result',
      ok: true,
      response: { status: 200, headers: {}, body: { hello: 'world' } },
    });
    const result = (await h.next('result')) as Result;
    expect(result).toMatchObject({
      id,
      ok: true,
      result: { value: { status: 200, body: { hello: 'world' } } },
    });
  });

  it('a fetch fired without await still carries its call id, and calls do not mix', async () => {
    const h = await host('fetcher', { apiKey: 'K-1', url: 'http://127.0.0.1:1' });
    const body = (nodeType: string, url: string) => ({
      type: 'call',
      hook: 'data',
      nodeType,
      nodeVersion: 1,
      ctx: { ...jsonContext, job: { id: 'job-1', attempt: 1 } },
      settings: { url, waitMs: 50 },
    });
    const a = nextId();
    const b = nextId();
    h.send({ v: PROTOCOL_VERSION, id: a, ...body('fetcher:fire', 'http://127.0.0.1:1/a') });
    h.send({ v: PROTOCOL_VERSION, id: b, ...body('fetcher:fire', 'http://127.0.0.1:1/b') });
    const first = await h.next('fetch');
    const second = await h.next('fetch');
    const byUrl = (m: { input: { url: string } }) => m.input.url.slice(-1);
    const seen = Object.fromEntries([first, second].map((m) => [byUrl(m as never), m.callId]));
    expect(seen).toEqual({ a, b });
  });

  it('a cancel drops the answer of the call it names; the host stays usable', async () => {
    const h = await host('fetcher', { apiKey: 'K-1', url: 'http://127.0.0.1:1' });
    const id = nextId();
    h.send({
      v: PROTOCOL_VERSION,
      id,
      type: 'call',
      hook: 'data',
      nodeType: 'fetcher:get',
      nodeVersion: 1,
      ctx: hookCtx(),
      settings: { url: 'http://127.0.0.1:1/x' },
    });
    const fetch = await h.next('fetch');
    expect(fetch.callId).toBe(id);
    // No answer to the cancel itself: it names a call that is still running.
    h.send({ v: PROTOCOL_VERSION, id, type: 'cancel' });
    h.send({
      v: PROTOCOL_VERSION,
      id: fetch.id,
      type: 'fetch-result',
      ok: true,
      response: { status: 200, headers: {}, body: null },
    });
    // The only result that ever arrives is the ping's, not the cancelled call's.
    const ping = await ask(h, { type: 'cancel' });
    expect(ping).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h.queued('result')).toBe(0);
  });

  it('after a cancel the call can no longer start fetches', async () => {
    const h = await host('fetcher', { apiKey: 'K-1', url: 'http://127.0.0.1:1' });
    const id = nextId();
    h.send({
      v: PROTOCOL_VERSION,
      id,
      type: 'call',
      hook: 'data',
      nodeType: 'fetcher:late',
      nodeVersion: 1,
      ctx: hookCtx(),
      settings: { url: 'http://127.0.0.1:1/x', waitMs: 300 },
    });
    h.send({ v: PROTOCOL_VERSION, id, type: 'cancel' });
    // The plugin's own code runs on and tries its fetch: it fails inside the host, nothing is sent.
    expect(await h.next('log')).toMatchObject({ message: 'late fetch failed: failed' });
    expect(h.queued('fetch')).toBe(0);
    expect(await ask(h, { type: 'cancel' })).toMatchObject({ ok: true });
  });

  it.each(['refused', 'timeout', 'rate-limited', 'failed'] as const)(
    'a %s fetch failure reaches the plugin as an error whose fetchErrorKind is that kind',
    async (kind) => {
      const h = await host('fetcher', { apiKey: 'K-1', url: 'http://127.0.0.1:1' });
      const id = nextId();
      h.send({
        v: PROTOCOL_VERSION,
        id,
        type: 'call',
        hook: 'data',
        nodeType: 'fetcher:get',
        nodeVersion: 1,
        ctx: hookCtx(),
        settings: { url: 'http://127.0.0.1:1/x' },
      });
      const fetch = await h.next('fetch');
      h.send({
        v: PROTOCOL_VERSION,
        id: fetch.id,
        type: 'fetch-result',
        ok: false,
        error: { kind, message: 'nope' },
      });
      // The fixture answers `fetchErrorKind(e)` of what its fetch threw (the bundle's own SDK copy).
      expect(await h.next('result')).toMatchObject({
        id,
        ok: true,
        result: { value: { failed: kind } },
      });
    },
  );

  it('surfaces a refused fetch as FetchRefused', async () => {
    const h = await host('leaky', settings);
    const id = nextId();
    h.send({ v: PROTOCOL_VERSION, id, ...call });
    const fetch = await h.next('fetch');
    h.send({
      v: PROTOCOL_VERSION,
      id: fetch.id,
      type: 'fetch-result',
      ok: false,
      error: { kind: 'refused', message: 'origin not allowed' },
    });
    expect(await h.next('result')).toMatchObject({
      id,
      ok: false,
      error: { message: 'FetchRefused (refused): origin not allowed' },
    });
  });

  it('settings replaces the live settings', async () => {
    const h = await host('leaky', settings);
    expect(await ask(h, { type: 'settings', settings: { apiKey: 'NEW-KEY-123' } })).toMatchObject({
      ok: true,
    });
    const found = await ask(h, {
      type: 'call',
      hook: 'decide',
      nodeType: 'leaky:findings',
      nodeVersion: 1,
      ctx: hookCtx(),
      settings: {},
    });
    // The key is redacted on the way out; the old one is no longer a secret, so it never appears.
    expect(found).toMatchObject({ ok: true, result: { findings: { key: '[redacted]' } } });
  });
});

describe('plugin host, integration settings validation', () => {
  it('never returns a secret value, valid or not', async () => {
    const h = await host('leaky', { apiKey: 'K-SECRET-9' });
    const ok = await ask(h, {
      type: 'validate',
      nodeType: null,
      settings: { apiKey: 'CAND-KEY-77' },
    });
    expect(ok).toMatchObject({ ok: true, result: { ok: true, value: { apiKey: '[redacted]' } } });
    expect(JSON.stringify(ok)).not.toContain('CAND-KEY-77');

    const bad = await ask(h, { type: 'validate', nodeType: null, settings: { apiKey: '' } });
    expect(bad).toMatchObject({ ok: true, result: { ok: false, issues: [{ path: 'apiKey' }] } });
  });

  const echo = (text: string) => ({
    type: 'call',
    hook: 'data',
    nodeType: 'leaky:echo',
    nodeVersion: 1,
    ctx: hookCtx(),
    settings: { text },
  });

  it('redacts a validated candidate secret from then on (no test() involved)', async () => {
    const h = await host('leaky', { apiKey: 'K-SECRET-9' });
    const before = await ask(h, echo('CAND-KEY-77'));
    expect(before).toMatchObject({ ok: true, result: { value: 'CAND-KEY-77' } });
    await ask(h, { type: 'validate', nodeType: null, settings: { apiKey: 'CAND-KEY-77' } });
    const after = await ask(h, echo('see CAND-KEY-77'));
    expect(after).toMatchObject({ ok: true, result: { value: 'see [redacted]' } });
  });

  it('keeps redacting a secret after a settings rotation', async () => {
    const h = await host('leaky', { apiKey: 'OLD-KEY-111' });
    await ask(h, { type: 'settings', settings: { apiKey: 'NEW-KEY-222' } });
    const result = await ask(h, echo('old OLD-KEY-111 new NEW-KEY-222'));
    expect(result).toMatchObject({ ok: true, result: { value: 'old [redacted] new [redacted]' } });
  });
});

describe('plugin host, limits and failures', () => {
  it('answers an oversize result with an error and stays alive', async () => {
    const h = await host('hog');
    const result = await ask(h, {
      type: 'call',
      hook: 'data',
      nodeType: 'hog:big-result',
      nodeVersion: 1,
      ctx: hookCtx(),
      settings: {},
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/larger than 16 MB/) },
    });
    expect(await ask(h, { type: 'cancel' })).toMatchObject({ ok: true });
  });

  it('answers fatal and exits 70 for a bundle with no plugin default export', async () => {
    const h = startHost({
      hostPath: hostPath(),
      bundlePath: fixturePluginPath('badexport'),
      settings: {},
    });
    started.push(h);
    expect(await h.next()).toMatchObject({
      type: 'fatal',
      reason: 'bundle has no plugin default export',
    });
    expect(await h.exited).toMatchObject({ code: 70 });
  });

  it('answers fatal and exits 70 when a timer throws after ready', async () => {
    const h = await host('crash', { mode: 'timer' });
    expect(await h.next('fatal')).toMatchObject({
      reason: expect.stringContaining('crash from a timer'),
    });
    expect(await h.exited).toMatchObject({ code: 70 });
  });

  it('exits with the plugin own code when setup calls process.exit', async () => {
    const h = startHost({
      hostPath: hostPath(),
      bundlePath: fixturePluginPath('crash'),
      settings: { mode: 'exit' },
    });
    started.push(h);
    expect(await h.exited).toMatchObject({ code: 3 });
  });

  it('loads every fixture plugin', async () => {
    for (const name of ['denial', 'spin', 'hog'] as const) {
      const h = await host(name, name === 'denial' ? { otherBundle: '' } : {});
      expect(h.ready.manifest.name).toBe(name);
      await h.stop();
    }
  });
});

describe('plugin host, node versions', () => {
  const call = (h: HostHandle, nodeVersion: number, settings: Record<string, unknown>) =>
    ask(h, {
      type: 'call',
      hook: 'decide',
      nodeType: 'versioned:thing',
      nodeVersion,
      ctx: hookCtx(),
      settings,
    });

  it('announces every node version and migration in ready', async () => {
    const h = await host('versioned');
    expect(h.ready.manifest.nodeVersions?.[0]).toEqual({
      type: 'versioned:thing',
      version: 3,
      migrations: [
        { from: 1, to: 2, risk: 'safe' },
        { from: 2, to: 3, risk: 'behaviour' },
      ],
    });
  });

  it('migrates a call from the pinned node version to the current one', async () => {
    const h = await host('versioned');
    expect(await call(h, 1, { old: 'a' })).toMatchObject({
      ok: true,
      result: { port: 'pass', reason: 'value is a' },
    });
    expect(await call(h, 2, { mid: 'm' })).toMatchObject({
      ok: true,
      result: { reason: 'value is m' },
    });
    expect(await call(h, 3, { value: 'b' })).toMatchObject({
      ok: true,
      result: { reason: 'value is b' },
    });
  });

  it('refuses a node version with no migration path', async () => {
    const h = await host('versioned');
    const r = await call(h, 0, { value: 'x' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toMatch(/no migration path from v0 to v3 for versioned:thing/);
  });

  it('answers a migrate message with the migrated settings', async () => {
    const h = await host('versioned');
    const r = await ask(h, {
      type: 'migrate',
      nodeType: 'versioned:thing',
      from: 1,
      settings: { old: 'a' },
    });
    expect(r).toMatchObject({ ok: true, result: { settings: { value: 'a' } } });
    const bad = await ask(h, {
      type: 'migrate',
      nodeType: 'versioned:thing',
      from: 0,
      settings: {},
    });
    expect(bad.ok).toBe(false);
  });

  const migrate = (
    h: HostHandle,
    nodeType: string,
    from: number,
    settings: Record<string, unknown>,
  ) => ask(h, { type: 'migrate', nodeType, from, settings });
  const errorOf = (r: Result) => (r.ok ? '' : r.error.message);

  it('refuses from above the current version and a migrated result that does not validate', async () => {
    const h = await host('versioned');
    expect(errorOf(await migrate(h, 'versioned:thing', 4, {}))).toMatch(
      /no migration path from v4/,
    );
    expect(errorOf(await migrate(h, 'versioned:flaky', 1, { mode: 'invalid' }))).toMatch(
      /not valid for v2/,
    );
    expect(errorOf(await migrate(h, 'versioned:flaky', 1, { mode: 'undefined' }))).toMatch(
      /not valid for v2/,
    );
  });

  it('turns a throwing, asynchronous or oversize step into a clear error', async () => {
    const h = await host('versioned');
    expect(errorOf(await migrate(h, 'versioned:flaky', 1, { mode: 'throw' }))).toBe('boom');
    expect(errorOf(await migrate(h, 'versioned:flaky', 1, { mode: 'promise' }))).toMatch(
      /migrations must be synchronous/,
    );
    expect(errorOf(await migrate(h, 'versioned:flaky', 1, { mode: 'big' }))).toMatch(
      /larger than 256 KB/,
    );
    expect(await migrate(h, 'versioned:flaky', 1, { mode: 'ok' })).toMatchObject({
      ok: true,
      result: { settings: { value: 'ok' } },
    });
  });

  it('refuses an ambiguous chain and a step that overshoots', async () => {
    const h = await host('versioned');
    expect(errorOf(await migrate(h, 'versioned:ambiguous', 1, {}))).toMatch(/no migration path/);
    expect(errorOf(await migrate(h, 'versioned:overshoot', 1, {}))).toMatch(/no migration path/);
  });

  it('does not run the hook when call-time migration fails', async () => {
    const h = await host('versioned');
    for (const mode of ['throw', 'promise', 'invalid']) {
      const r = await ask(h, {
        type: 'call',
        hook: 'decide',
        nodeType: 'versioned:flaky',
        nodeVersion: 1,
        ctx: hookCtx(),
        settings: { mode },
      });
      expect(r.ok).toBe(false);
    }
    expect(h.queued('log')).toBe(0);
    const ok = await ask(h, {
      type: 'call',
      hook: 'decide',
      nodeType: 'versioned:flaky',
      nodeVersion: 1,
      ctx: hookCtx(),
      settings: { mode: 'ok' },
    });
    expect(ok.ok).toBe(true);
    expect(await h.next('log')).toMatchObject({ message: 'decide-ran' });
  });
});
