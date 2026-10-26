import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  allowInsecureTls,
  corePluginContext,
  createCache,
  createPaths,
  defineIntegration,
  defineNode,
  definePlugin,
  defineTrigger,
  FetchError,
  FetchFailed,
  FetchRefused,
  fetchErrorKind,
  integrationMetadata,
  lang,
  nodeMetadata,
  pathMappings,
  pluginManifest,
  SDK_VERSION,
  secret,
  secretPaths,
  triggerMetadata,
  url,
} from './index.ts';
import {
  fakeHookContext,
  fakePluginContext,
  runData,
  runDecide,
  runFinishRun,
  runTest,
  runTrigger,
} from './testing.ts';

const port = { id: 'file', label: 'File', type: 'file' } as const;

function node(type: string, extra: Record<string, unknown> = {}) {
  return defineNode({
    type,
    version: 1,
    kind: 'action',
    title: 'T',
    description: 'd',
    icon: 'x',
    inputs: [port],
    outputs: [port],
    settings: z.object({ n: z.number().default(1) }),
    ...extra,
  });
}

const finishNode = (type: string, phase: 'gate' | 'write' | 'notify' | 'library-manager') =>
  node(type, {
    kind: 'finish',
    finishPhase: phase,
    async finish() {
      return { actions: [], reason: 'r' };
    },
  });

const integration = defineIntegration({
  id: 'svc',
  title: 'Service',
  settings: z.object({
    url: url(),
    apiKey: secret(),
    pathMappings: pathMappings(),
    allowInsecureTls: allowInsecureTls(),
  }),
  allowedOrigins: ['$settings.url'],
  requires: { product: 'svc', minVersion: '1.0.0' },
  async test() {
    return { ok: true, message: 'fine' };
  },
});

const plugin = (over: Record<string, unknown> = {}) => ({
  name: 'example',
  version: '1.0.0',
  sdk: '^1',
  nodes: [node('example:a')],
  ...over,
});

describe('plugin definition', () => {
  it('SDK_VERSION equals package.json version', () =>
    expect(SDK_VERSION).toBe(
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
    ));

  it('definePlugin refuses a node type outside the plugin prefix and a missing sdk range', () => {
    expect(() => definePlugin(plugin({ nodes: [node('x:y')] }))).toThrow(/example:/);
    expect(() => definePlugin(plugin({ sdk: undefined }))).toThrow(TypeError);
    expect(() => definePlugin(plugin({ nodes: 'nope' }))).toThrow(TypeError);
    const p = plugin();
    expect(definePlugin(p)).toBe(p);
  });

  it('pluginManifest lists node types, integration id, trigger ids and hook names', () => {
    const trigger = defineTrigger({
      id: 'hook',
      title: 'T',
      description: 'd',
      icon: 'i',
      settings: z.object({}),
      auth: { header: 'x-key' },
      async handle() {
        return { kind: 'ignore', reason: 'no' };
      },
    });
    const p = definePlugin(
      plugin({
        integration,
        triggers: [trigger],
        hooks: { async onJobDone() {}, async afterReplace() {} },
      }),
    );
    expect(pluginManifest(p)).toEqual({
      name: 'example',
      version: '1.0.0',
      sdk: '^1',
      nodes: ['example:a'],
      nodeVersions: [{ type: 'example:a', version: 1, migrations: [] }],
      nodeInfo: [{ type: 'example:a', kind: 'action', title: 'T' }],
      integration: 'svc',
      triggers: ['hook'],
      hooks: ['onJobDone', 'afterReplace'],
    });
    expect(pluginManifest(definePlugin(plugin()))).toMatchObject({
      integration: null,
      triggers: [],
      hooks: [],
    });
    expect(triggerMetadata(trigger)).toMatchObject({ id: 'hook', auth: { header: 'x-key' } });
  });

  it('pluginManifest carries the icon only when the plugin has one; definePlugin refuses an icon that is not SVG', () => {
    const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>';
    expect(pluginManifest(definePlugin(plugin({ icon }))).icon).toBe(icon);
    expect('icon' in pluginManifest(definePlugin(plugin()))).toBe(false);
    expect(() => definePlugin(plugin({ icon: 'icon.png' }))).toThrow(/icon must be SVG markup/);
    expect(() => definePlugin(plugin({ icon: `<svg>${'x'.repeat(20_000)}</svg>` }))).toThrow(
      TypeError,
    );
  });

  it('pluginManifest announces node versions and their migrations (from, to, risk only)', () => {
    const versioned = node('example:v', {
      version: 2,
      migrations: [{ from: 1, to: 2, risk: 'safe', note: 'n', migrate: (s: unknown) => s }],
    });
    expect(pluginManifest(definePlugin(plugin({ nodes: [versioned] }))).nodeVersions).toEqual([
      { type: 'example:v', version: 2, migrations: [{ from: 1, to: 2, risk: 'safe' }] },
    ]);
    expect(
      pluginManifest(definePlugin(plugin({ nodes: [node('example:p')] }))).nodeVersions,
    ).toEqual([{ type: 'example:p', version: 1, migrations: [] }]);
  });

  it('nodeMetadata carries finishPhase and hooks, and refuses a finish node without a phase and a node with a password setting', () => {
    expect(nodeMetadata(finishNode('example:f', 'notify'))).toMatchObject({
      finishPhase: 'notify',
      hooks: ['finish'],
    });
    expect(nodeMetadata(node('example:a'))).toMatchObject({ finishPhase: null, hooks: [] });
    const noPhase = node('example:f', {
      kind: 'finish',
      async finish() {
        return { actions: [], reason: 'r' };
      },
    });
    expect(() => nodeMetadata(noPhase)).toThrow('finish node example:f declares no finishPhase');
    const withSecret = node('example:s', { settings: z.object({ key: secret() }) });
    expect(() => nodeMetadata(withSecret)).toThrow(
      'node example:s: settings may not contain a secret (format password) — put it in the integration settings',
    );
    const asFormat = node('example:s', {
      settings: z.object({ key: z.string().meta({ format: 'password' }) }),
    });
    expect(() => nodeMetadata(asFormat)).toThrow(/secret/);
  });

  it('definePlugin refuses a plugin finish node with phase gate or write; defineIntegration refuses a nullable secret', () => {
    for (const phase of ['gate', 'write'] as const) {
      expect(() => definePlugin(plugin({ nodes: [finishNode('example:f', phase)] }))).toThrow(
        'plugin finish nodes may use library-manager, media-server or notify; only core writes files',
      );
    }
    expect(() =>
      definePlugin(plugin({ nodes: [finishNode('example:f', 'library-manager')] })),
    ).not.toThrow();
    expect(() =>
      defineIntegration({
        ...integration,
        settings: z.object({ url: url(), key: secret().nullable() }),
      }),
    ).toThrow('secret fields may be optional, not nullable');
    expect(() =>
      defineIntegration({
        ...integration,
        settings: z.object({ url: url(), key: secret().optional() }),
      }),
    ).not.toThrow();
  });

  it('secret detection never under-reports: format-only, nullable-in-anyOf and plain-object integrations', () => {
    const formatOnly = z.object({ url: url(), key: z.string().meta({ format: 'password' }) });
    expect(secretPaths(z.toJSONSchema(formatOnly, { io: 'input' }) as never)).toEqual(['key']);
    const wrapped = z.object({
      url: url(),
      a: secret().nullable(),
      b: z.string().meta({ format: 'password' }).optional(),
    });
    expect(secretPaths(z.toJSONSchema(wrapped, { io: 'input' }) as never)).toEqual(['a', 'b']);
    expect(() => defineIntegration({ ...integration, settings: formatOnly })).toThrow(/secret\(\)/);
    expect(() => defineIntegration({ ...integration, settings: wrapped })).toThrow(/secret/);
    const nullableFormat = z.object({
      url: url(),
      k: z.string().meta({ format: 'password' }).nullable(),
    });
    expect(() => defineIntegration({ ...integration, settings: nullableFormat })).toThrow(/secret/);
    // a plain object skips defineIntegration, definePlugin still checks it
    const plain = { ...integration, settings: formatOnly };
    expect(() => definePlugin(plugin({ integration: plain }))).toThrow(/secret\(\)/);
    const plainNullable = {
      ...integration,
      settings: z.object({ url: url(), k: secret().nullable() }),
    };
    expect(() => definePlugin(plugin({ integration: plainNullable }))).toThrow(/not nullable/);
  });

  it('definePlugin fails fast on a finish node without finishPhase and on run on a non-finish node', () => {
    const noPhase = node('example:f', { kind: 'finish' });
    expect(() => definePlugin(plugin({ nodes: [noPhase] }))).toThrow(/declares no finishPhase/);
    const runOnAction = node('example:r', {
      async run() {
        return { ok: true, message: 'm' };
      },
    });
    expect(() => definePlugin(plugin({ nodes: [runOnAction] }))).toThrow(/not a finish node/);
  });

  it('defineIntegration checks allowedOrigins entries', () => {
    const base = { ...integration, settings: z.object({ url: url() }) };
    expect(() => defineIntegration({ ...base, allowedOrigins: ['$settings.nope'] })).toThrow();
    expect(() => defineIntegration({ ...base, allowedOrigins: ['https://x.com/path'] })).toThrow();
    expect(() => defineIntegration({ ...base, allowedOrigins: ['ftp://x.com'] })).toThrow();
    expect(() =>
      defineIntegration({ ...base, allowedOrigins: ['https://api.example.com', '$settings.url'] }),
    ).not.toThrow();
  });
});

describe('plugin context helpers', () => {
  it('createPaths: longest segment-aware prefix, trailing slash normalised, identity without a match, toLocal reverses toRemote', () => {
    const p = createPaths([
      { remote: '/shows', local: '/data/shows' },
      { remote: '/everything/', local: '/data/' },
    ]);
    expect(p.toRemote('/data/shows/A/e1.mkv')).toBe('/shows/A/e1.mkv');
    expect(p.toRemote('/data/other/e.mkv')).toBe('/everything/other/e.mkv');
    expect(p.toRemote('/data/showsx/e.mkv')).toBe('/everything/showsx/e.mkv');
    expect(p.toRemote('/elsewhere/x')).toBe('/elsewhere/x');
    expect(p.toLocal('/shows/A/e1.mkv')).toBe('/data/shows/A/e1.mkv');
    expect(p.toLocal('/elsewhere/x')).toBe('/elsewhere/x');
    expect(p.toLocal(p.toRemote('/data/shows/A/e1.mkv'))).toBe('/data/shows/A/e1.mkv');
    const only = createPaths([{ remote: '/shows', local: '/data/shows' }]);
    expect(only.toRemote('/data/showsx/e.mkv')).toBe('/data/showsx/e.mkv');
    expect(only.toRemote('/data/shows')).toBe('/shows');
    expect(only.toRemote('/elsewhere/x/')).toBe('/elsewhere/x/');
  });

  it('createPaths: a root mapping covers every path', () => {
    const root = createPaths([{ remote: '/', local: '/mnt' }]);
    expect(root.toRemote('/mnt/a/b.mkv')).toBe('/a/b.mkv');
    expect(root.toRemote('/mnt')).toBe('/');
    expect(root.toLocal('/a/b.mkv')).toBe('/mnt/a/b.mkv');
    expect(root.toLocal('/')).toBe('/mnt');
    const all = createPaths([{ remote: '/media', local: '/' }]);
    expect(all.toRemote('/x/y')).toBe('/media/x/y');
  });

  it('createCache: ttl expiry, entry cap evicts the oldest, byte cap refuses an oversize value', async () => {
    let now = 1000;
    const c = createCache({ entries: 2, bytes: 20 }, () => now);
    await c.set('a', 1, 100);
    expect(await c.get('a')).toBe(1);
    now += 100;
    expect(await c.get('a')).toBeUndefined();
    await c.set('a', 1, 1000);
    await c.set('b', 2, 1000);
    await c.set('c', 3, 1000);
    expect(await c.get('a')).toBeUndefined();
    expect(await c.get('b')).toBe(2);
    expect(await c.get('c')).toBe(3);
    await c.set('big', 'x'.repeat(30), 1000);
    expect(await c.get('big')).toBeUndefined();
    expect(await c.get('b')).toBe(2);
    await c.set('d', 'x'.repeat(14), 1000);
    expect(await c.get('b')).toBeUndefined();
    expect(await c.get('d')).toBe('x'.repeat(14));
    await c.set('o', { n: [1] }, 1000);
    const got = (await c.get('o')) as { n: number[] };
    got.n.push(2);
    expect(await c.get('o')).toEqual({ n: [1] });
  });

  it('lang bridges names, codes and values', () => {
    expect(lang.fromName('Japanese')).toBe('ja');
    expect(lang.fromName('Klingon')).toBeNull();
    expect(lang.toIso3('ja')).toBe('jpn');
    expect(lang.normalise('de')).toBe('deu');
    expect(lang.normalise(42)).toBe('unknown');
  });

  it('corePluginContext refuses fetch and is inert', async () => {
    const ctx = corePluginContext({ dryRun: true });
    await expect(ctx.fetch({ url: 'https://example.com' })).rejects.toThrow(FetchRefused);
    await expect(ctx.fetch({ url: 'https://example.com' })).rejects.toMatchObject({
      name: 'FetchRefused',
      kind: 'refused',
    });
    await expect(ctx.fetch({ url: 'https://example.com' })).rejects.toThrow(
      'core nodes have no integration',
    );
    await ctx.cache.set('k', 1, 1000);
    expect(await ctx.cache.get('k')).toBeUndefined();
    expect(ctx).toMatchObject({ settings: {}, dryRun: true, job: null });
    expect(ctx.paths.toRemote('/a/b')).toBe('/a/b');
  });
});

describe('integration schema helpers', () => {
  it('secretPaths finds secret() fields; url()/pathMappings()/allowInsecureTls() carry their x-transcoda meta in toJSONSchema', () => {
    const meta = integrationMetadata(
      defineIntegration({
        ...integration,
        settings: z.object({
          url: url(),
          apiKey: secret(),
          token: secret().optional(),
          fallback: secret().default('x'),
          pathMappings: pathMappings(),
          allowInsecureTls: allowInsecureTls(),
          note: z.string(),
        }),
      }),
    );
    expect(secretPaths(meta.settingsSchema)).toEqual(['apiKey', 'token', 'fallback']);
    expect(meta.settingsSchema).toMatchObject({
      properties: {
        url: { 'x-transcoda': 'url' },
        apiKey: { format: 'password', 'x-transcoda': 'secret' },
        pathMappings: { 'x-transcoda': 'path-mappings', default: [] },
        allowInsecureTls: { 'x-transcoda': 'insecure-tls', default: false },
      },
    });
    expect(meta).toMatchObject({
      id: 'svc',
      allowedOrigins: ['$settings.url'],
      requires: { product: 'svc', minVersion: '1.0.0' },
    });
    expect(integrationMetadata({ ...integration, requires: undefined }).requires).toBeNull();
  });
});

describe('fetchErrorKind', () => {
  it('reads the kind of a fetch failure, by property, not by class', () => {
    expect(fetchErrorKind(new FetchRefused('x'))).toBe('refused');
    expect(fetchErrorKind(Object.assign(new Error('x'), { kind: 'timeout' }))).toBe('timeout');
    expect(fetchErrorKind({ kind: 'rate-limited' })).toBe('rate-limited');
    expect(fetchErrorKind({ kind: 'failed' })).toBe('failed');
  });
  it('is null for anything else', () => {
    expect(fetchErrorKind(new TypeError('boom'))).toBeNull();
    expect(fetchErrorKind(Object.assign(new Error('x'), { kind: 'weird' }))).toBeNull();
    expect(fetchErrorKind(null)).toBeNull();
    expect(fetchErrorKind(undefined)).toBeNull();
    expect(fetchErrorKind('refused')).toBeNull();
  });
});

describe('testing helpers', () => {
  it('ctx.fetch accepts a structured auth and the fake records it', async () => {
    const ctx = fakePluginContext({ responses: [{ match: { url: 'http://svc/a' } }] });
    await ctx.fetch({ url: 'http://svc/a', auth: { basic: { username: 'u', password: 'p:é' } } });
    expect(ctx.calls[0]?.auth).toEqual({ basic: { username: 'u', password: 'p:é' } });
  });

  it('fakePluginContext scripts fetch by url/method and records calls; an unscripted call throws FetchFailed', async () => {
    const ctx = fakePluginContext({
      settings: { url: 'http://svc' },
      responses: [
        { match: { url: 'http://svc/a' }, body: { n: 1 } },
        { match: { url: /\/b$/, method: 'POST' }, status: 201, headers: { x: 'y' } },
        { match: { url: 'http://svc/a' }, body: { n: 2 } },
      ],
      mappings: [{ remote: '/r', local: '/l' }],
    });
    expect(await ctx.fetch({ url: 'http://svc/a' })).toEqual({
      status: 200,
      headers: {},
      body: { n: 1 },
    });
    expect(await ctx.fetch({ url: 'http://svc/b', method: 'POST' })).toEqual({
      status: 201,
      headers: { x: 'y' },
      body: null,
    });
    expect((await ctx.fetch({ url: 'http://svc/a' })).body).toEqual({ n: 2 });
    const failure = await ctx.fetch({ url: 'http://svc/a' }).catch((e: unknown) => e);
    // Like a bundle sees the host's errors: named and kinded, but not the SDK's classes.
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(FetchFailed);
    expect(failure).not.toBeInstanceOf(FetchError);
    expect(failure).toMatchObject({ name: 'FetchFailed', kind: 'failed' });
    expect(fetchErrorKind(failure)).toBe('failed');
    await expect(ctx.fetch({ url: 'http://svc/b' })).rejects.toThrow(
      'no scripted response for GET http://svc/b',
    );
    expect(ctx.calls).toHaveLength(5);
    await ctx.log('info', 'hi');
    expect(ctx.logs).toEqual([['info', 'hi']]);
    expect(ctx.paths.toRemote('/l/x')).toBe('/r/x');
  });

  it('fakeHookContext is a complete DecideContext, clock included', async () => {
    const n = node('t:clock', {
      kind: 'condition',
      outputs: [{ id: 'pass', label: 'Pass', type: 'file' }],
      async decide(c: { now: number }) {
        return { port: 'pass', reason: `at ${c.now}` };
      },
    });
    expect(typeof fakeHookContext().now).toBe('number');
    expect(await runDecide(n, fakeHookContext({ now: 5 }), {})).toEqual({
      port: 'pass',
      reason: 'at 5',
    });
    expect((await runDecide(n, fakeHookContext(), {})).reason).toMatch(/^at \d+$/);
  });

  it('runFinishRun passes parsed settings and the run context', async () => {
    let seen: unknown;
    const n = node('example:r', {
      kind: 'finish',
      finishPhase: 'notify',
      settings: z.object({ timeout: z.number().default(5) }),
      async run(ctx: { newPath: string }, s: { timeout: number }) {
        seen = [ctx.newPath, s.timeout];
        return { ok: true, message: 'done' };
      },
    });
    const ctx = {
      ...fakeHookContext(),
      originalPath: '/a.mkv',
      newPath: '/a.mp4',
      replacedTo: null,
      beforeBytes: 2,
      afterBytes: 1,
      outcome: 'replaced' as const,
      containerChanged: true,
      problemsSoFar: [],
      jobUrl: null,
      workflowName: 'WF',
    };
    expect(await runFinishRun(n, ctx, {})).toEqual({ ok: true, message: 'done' });
    expect(seen).toEqual(['/a.mp4', 5]);
    await expect(runFinishRun(n, ctx, { timeout: 'x' })).rejects.toThrow();
    await expect(runDecide(n, { ...ctx, now: 0 }, {})).rejects.toThrow('has no decide hook');
  });

  it('runData, runTrigger and runTest call through with parsed settings', async () => {
    const d = node('example:d', {
      kind: 'data',
      async data(_c: unknown, s: { n: number }) {
        return { value: s.n, reason: 'r' };
      },
    });
    expect(await runData(d, fakeHookContext(), {})).toEqual({ value: 1, reason: 'r' });
    const t = defineTrigger({
      id: 't',
      title: 'T',
      description: 'd',
      icon: 'i',
      settings: z.object({ k: z.string().default('v') }),
      auth: { basic: true },
      async handle(_c, req, s) {
        return { kind: 'test', message: `${req.method} ${s.k}` };
      },
    });
    expect(
      await runTrigger(t, fakePluginContext(), { method: 'POST', headers: {}, body: null }, {}),
    ).toEqual({ kind: 'test', message: 'POST v' });
    expect(await runTest(integration, fakePluginContext())).toEqual({ ok: true, message: 'fine' });
    const hc = fakeHookContext();
    expect(hc.probe.streams.map((s) => s.type)).toEqual(['video', 'audio']);
    expect(hc.file.path).toBe('/media/a.mkv');
  });
});
