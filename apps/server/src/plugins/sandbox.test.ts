import { fakeHookContext } from '@transcoda/sdk/testing';
import type { JsonValue } from '@transcoda/shared';
import { PROTOCOL_VERSION } from '@transcoda/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { sandboxExpectations } from './sandbox-expectations.ts';
import { type FixtureName, fixturePluginPath, hostPath } from './testing/build.ts';
import { type HostHandle, type SpawnedHost, spawnHost, startHost } from './testing/spawn.ts';

const started: HostHandle[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((h) => h.stop()));
});

async function host(name: FixtureName, settings: JsonValue, heapMb?: number): Promise<SpawnedHost> {
  const h = await spawnHost({
    hostPath: hostPath(),
    bundlePath: fixturePluginPath(name),
    settings,
    heapMb,
  });
  started.push(h);
  return h;
}

const { log: _log, plugin: _plugin, ...jsonContext } = fakeHookContext();
let counter = 0;

async function callData(h: HostHandle, nodeType: string, ctx: Record<string, unknown> = {}) {
  const id = `s-${++counter}`;
  h.send({
    v: PROTOCOL_VERSION,
    id,
    type: 'call',
    hook: 'data',
    nodeType,
    nodeVersion: 1,
    ctx: { ...jsonContext, ...ctx },
    settings: {},
  });
  return h.next('result');
}

describe('sandbox denial suite', () => {
  it('the host denies every filesystem, process, worker, addon, wasi and inspector probe', async () => {
    const other = fixturePluginPath('example');
    const h = await host('denial', { otherBundle: other });
    const result = await callData(h, 'denial:report');
    if (!result.ok) throw new Error(result.error.message);
    const report = (result.result as { value: Record<string, string> }).value;

    // Spawned directly (the server's own user): the plugin user's table is checked in the image.
    const expectations = sandboxExpectations({
      isolatedUid: null,
      ownUid: process.getuid?.() ?? null,
    });
    expect(Object.keys(report).sort()).toEqual(Object.keys(expectations).sort());
    expect(expectations.signalServer).toBe('OK');
    for (const [probe, expected] of Object.entries(expectations)) {
      const got = report[probe] ?? '(missing)';
      if (typeof expected === 'string') expect(got, probe).toBe(expected);
      else expect(got, probe).toMatch(expected);
    }
  });

  it('secrets never leave the process in clear: log, reason, findings, error message and fetch request are redacted', async () => {
    const h = await host('leaky', { apiKey: 'K-SECRET-9' });
    const seen: unknown[] = [h.ready];

    const leak = `s-${++counter}`;
    h.send({
      v: PROTOCOL_VERSION,
      id: leak,
      type: 'call',
      hook: 'data',
      nodeType: 'leaky:leak',
      nodeVersion: 1,
      ctx: { ...jsonContext, job: { id: 'job-1', attempt: 1 } },
      settings: {},
    });
    const fetch = await h.next('fetch');
    seen.push(fetch);
    // On the fetch channel only, a secret becomes a token the server substitutes back; the clear
    // value never appears in the message.
    expect(fetch).toMatchObject({
      input: {
        url: 'https://api.example.test/v1/__TRANSCODA_SECRET__apiKey__raw__/items',
        headers: { 'X-Api-Key': '__TRANSCODA_SECRET__apiKey__raw__' },
      },
    });
    expect(JSON.stringify(fetch)).not.toContain('K-SECRET-9');
    h.send({
      v: PROTOCOL_VERSION,
      id: fetch.id,
      type: 'fetch-result',
      ok: true,
      response: { status: 200, headers: {}, body: null },
    });
    const data = await h.next('result');
    seen.push(data);
    expect(data).toMatchObject({ ok: true, result: { reason: 'used [redacted]' } });
    for (const level of ['api key is [redacted]', 'key again [redacted]']) {
      const log = await h.next('log');
      seen.push(log);
      expect(log).toMatchObject({ message: level, jobId: 'job-1' });
    }

    const findings = await callOf(h, 'decide', 'leaky:findings');
    seen.push(findings);
    expect(findings).toMatchObject({
      ok: true,
      result: { reason: 'key [redacted]', findings: { key: '[redacted]' } },
    });

    const thrown = await callData(h, 'leaky:throws');
    seen.push(thrown);
    expect(thrown).toMatchObject({ ok: false, error: { message: 'failed with key [redacted]' } });

    const test = `s-${++counter}`;
    h.send({ v: PROTOCOL_VERSION, id: test, type: 'test', settings: { apiKey: 'K-SECRET-9' } });
    seen.push(await h.next('result'));

    expect(JSON.stringify(seen)).not.toContain('K-SECRET-9');
  });

  it('a candidate test() secret is used for that call only and redacted from the answer', async () => {
    const h = await host('secrets', { apiKey: 'SAVED-KEY-1' });
    const id = `s-${++counter}`;
    h.send({ v: PROTOCOL_VERSION, id, type: 'test', settings: { apiKey: 'CANDIDATE-KEY-2' } });
    const result = await h.next('result');
    expect(result).toMatchObject({ ok: true, result: { ok: true, message: 'key is [redacted]' } });
    expect(JSON.stringify(result)).not.toContain('CANDIDATE-KEY-2');
  });

  it('after init no server→host message is needed to carry the secret: call messages carry no apiKey, the hook still sees it', async () => {
    const h = await host('leaky', { apiKey: 'K-SECRET-9' });
    const sent: unknown[] = [];
    const send = h.send.bind(h);
    h.send = (msg) => {
      sent.push(msg);
      send(msg);
    };
    const found = await callOf(h, 'decide', 'leaky:findings');
    // The hook read ctx.plugin.settings.apiKey: it came out as the placeholder, proving it was there.
    expect(found).toMatchObject({ ok: true, result: { findings: { key: '[redacted]' } } });
    // Everything the server sent after init (the call included) holds no secret.
    expect(sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(sent)).not.toContain('K-SECRET-9');
  });

  it('a top-level captured fetch is the replaced one', async () => {
    const h = await host('denial', { otherBundle: '' });
    const result = await callData(h, 'denial:report');
    expect(result).toMatchObject({
      ok: true,
      result: { value: { topLevelFetch: 'use ctx.fetch' } },
    });
  });

  it('the heap cap aborts the process (SIGABRT) and the server sees no result', async () => {
    const h = startHost({
      hostPath: hostPath(),
      bundlePath: fixturePluginPath('crash'),
      settings: { mode: 'heap' },
      heapMb: 32,
    });
    started.push(h);
    const exit = await h.exited;
    expect(exit.signal).toBe('SIGABRT');
    await expect(h.next('result')).rejects.toThrow(/host exited/);
  });
});

async function callOf(h: HostHandle, hook: 'decide', nodeType: string) {
  const id = `s-${++counter}`;
  h.send({
    v: PROTOCOL_VERSION,
    id,
    type: 'call',
    hook,
    nodeType,
    nodeVersion: 1,
    ctx: { ...jsonContext, now: 0 },
    settings: {},
  });
  return h.next('result');
}
