import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  FetchInputSchema,
  FINISH_PHASES,
  finishPhaseRank,
  hostExecArgv,
  hostSpawn,
  iso1Of,
  languageFromName,
  MAX_MESSAGE_BYTES,
  messageBytes,
  normalizeLanguageValue,
  PLUGIN_ICON_MAX_LENGTH,
  PluginManifestSchema,
  parseHostMessage,
  parseServerMessage,
  TraceEntrySchema,
} from '../index.ts';

const manifest = {
  name: 'sonarr',
  version: '1.0.0',
  sdk: '^1',
  nodes: ['a'],
  integration: null,
  triggers: [],
  hooks: [],
};

describe('plugin vocabulary', () => {
  it('FINISH_PHASES order is gate < write < library-manager < media-server < notify', () => {
    expect(FINISH_PHASES.map(finishPhaseRank)).toEqual([0, 1, 2, 3, 4]);
  });

  it('PluginManifestSchema rejects a name with a colon or an upper-case letter and accepts "sonarr"', () => {
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true);
    expect(PluginManifestSchema.safeParse({ ...manifest, name: 'a:b' }).success).toBe(false);
    const nodeVersions = [
      { type: 'x:a', version: 2, migrations: [{ from: 1, to: 2, risk: 'safe' }] },
    ];
    expect(PluginManifestSchema.safeParse({ ...manifest, nodeVersions }).success).toBe(true);
    const extra = [
      { type: 'x:a', version: 2, extra: 1, migrations: [{ from: 1, to: 2, risk: 'safe', n: 1 }] },
    ];
    expect(PluginManifestSchema.safeParse({ ...manifest, nodeVersions: extra }).success).toBe(true);
    const maybe = [{ type: 'x:a', version: 2, migrations: [{ from: 1, to: 2, risk: 'maybe' }] }];
    expect(PluginManifestSchema.safeParse({ ...manifest, nodeVersions: maybe }).success).toBe(
      false,
    );
    expect(PluginManifestSchema.safeParse({ ...manifest, name: 'Sonarr' }).success).toBe(false);
  });

  it('PluginManifestSchema takes an optional SVG icon and refuses one that is not SVG or too large', () => {
    const icon =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
    expect(PluginManifestSchema.safeParse({ ...manifest, icon }).success).toBe(true);
    expect(
      PluginManifestSchema.safeParse({ ...manifest, icon: `<?xml version="1.0"?>\n${icon}` })
        .success,
    ).toBe(true);
    expect(PluginManifestSchema.safeParse({ ...manifest, icon: 'logo.svg' }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...manifest, icon: '<img src=x>' }).success).toBe(
      false,
    );
    expect(PluginManifestSchema.safeParse({ ...manifest, icon: '<svg>\ud800</svg>' }).success).toBe(
      false,
    );
    const huge = `<svg>${' '.repeat(PLUGIN_ICON_MAX_LENGTH)}</svg>`;
    expect(PluginManifestSchema.safeParse({ ...manifest, icon: huge }).success).toBe(false);
  });

  it('PluginManifestSchema takes optional node info (type, kind, title) to show nodes before an install', () => {
    const nodeInfo = [{ type: 'sonarr:rescan', kind: 'finish', title: 'Rescan in Sonarr' }];
    expect(PluginManifestSchema.parse({ ...manifest, nodeInfo }).nodeInfo).toEqual(nodeInfo);
    expect(PluginManifestSchema.parse(manifest).nodeInfo).toBeUndefined();
    expect(
      PluginManifestSchema.safeParse({ ...manifest, nodeInfo: [{ type: 'sonarr:rescan' }] })
        .success,
    ).toBe(false);
  });

  it('PluginManifestSchema refuses the reserved names catalog and catalogs', () => {
    expect(PluginManifestSchema.safeParse({ ...manifest, name: 'catalog' }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...manifest, name: 'catalogs' }).success).toBe(false);
  });

  it('hostExecArgv throws for a path containing a comma or a star', () => {
    const base = { hostPath: '/h/main.js', bundlePath: '/p/x.js', heapMb: 128, inspect: false };
    expect(() => hostExecArgv({ ...base, bundlePath: '/p/a,b.js' })).toThrow();
    expect(() => hostExecArgv({ ...base, hostPath: '/h/*' })).toThrow();
  });

  it('DEFAULT_LIMITS carries the spec values', () => {
    expect(DEFAULT_LIMITS.callTimeoutMs).toBe(30_000);
    expect(DEFAULT_LIMITS.finishRunTimeoutMs).toBe(300_000);
    expect(DEFAULT_LIMITS.heapMb).toBe(128);
    expect(DEFAULT_LIMITS.rssMb).toBe(256);
    expect(DEFAULT_LIMITS.maxHosts).toBe(16);
    expect(DEFAULT_LIMITS.cancelGraceMs).toBe(5_000);
    expect(DEFAULT_LIMITS.fetchBodyBytes).toBe(16 * 1024 * 1024);
  });

  it('hostSpawn without isolation is a plain fork of the host module', () => {
    expect(
      hostSpawn({
        execPath: '/usr/local/bin/node',
        execArgv: ['--permission', '--max-old-space-size=128'],
        hostPath: '/h/main.js',
        bundlePath: '/p/x.js',
        isolation: null,
      }),
    ).toEqual({
      command: '/usr/local/bin/node',
      args: ['--permission', '--max-old-space-size=128', '/h/main.js', '/p/x.js'],
      viaFork: true,
    });
  });

  it('hostSpawn with isolation wraps node in setpriv: exact argv, no --bounding-set', () => {
    const out = hostSpawn({
      execPath: '/usr/local/bin/node',
      execArgv: ['--permission'],
      hostPath: '/h/main.js',
      bundlePath: '/run/transcoda/plugins/x-1.0.0.js',
      isolation: { uid: 65001, gid: 65002, setprivPath: '/usr/bin/setpriv' },
    });
    expect(out).toEqual({
      command: '/usr/bin/setpriv',
      args: [
        '--reuid=65001',
        '--regid=65002',
        '--clear-groups',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--no-new-privs',
        '--',
        '/usr/local/bin/node',
        '--permission',
        '/h/main.js',
        '/run/transcoda/plugins/x-1.0.0.js',
      ],
      viaFork: false,
    });
    // Dropping the bounding set needs CAP_SETPCAP, which the server lacks: the host would not start.
    expect(out.args.some((a) => a.startsWith('--bounding-set'))).toBe(false);
  });

  it('hostSpawn without isolation but with a cap-drop setpriv wraps node in it: no uid change, no caps', () => {
    expect(
      hostSpawn({
        execPath: '/usr/local/bin/node',
        execArgv: ['--permission'],
        hostPath: '/h/main.js',
        bundlePath: '/p/x.js',
        isolation: null,
        capDropSetpriv: '/usr/bin/setpriv',
      }),
    ).toEqual({
      command: '/usr/bin/setpriv',
      args: [
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--no-new-privs',
        '--',
        '/usr/local/bin/node',
        '--permission',
        '/h/main.js',
        '/p/x.js',
      ],
      viaFork: false,
    });
  });

  it('hostExecArgv is exactly the five flags, plus the two inspector flags only when asked', () => {
    const base = { hostPath: '/h/main.js', bundlePath: '/p/x.js', heapMb: 128 };
    expect(hostExecArgv({ ...base, inspect: false })).toEqual([
      '--permission',
      '--allow-fs-read=/h/main.js',
      '--allow-fs-read=/p/x.js',
      '--disallow-code-generation-from-strings',
      '--max-old-space-size=128',
    ]);
    expect(hostExecArgv({ ...base, inspect: true }).slice(5)).toEqual([
      '--allow-inspector',
      '--inspect',
    ]);
  });
});

const envelope = (type: string) => ({ v: 1, id: '1', type });
const limits = {
  callTimeoutMs: 1,
  finishRunTimeoutMs: 1,
  testTimeoutMs: 1,
  triggerTimeoutMs: 1,
  hookTimeoutMs: 1,
  fetchDefaultTimeoutMs: 1,
  fetchMaxTimeoutMs: 1,
  cacheEntries: 1,
  cacheBytes: 1,
};

describe('IPC protocol', () => {
  it('parseServerMessage rejects v: 2 and an unknown type', () => {
    expect(parseServerMessage({ v: 2, id: '1', type: 'cancel' }).ok).toBe(false);
    expect(parseServerMessage({ v: 1, id: '1', type: 'bogus' }).ok).toBe(false);
    expect(parseServerMessage(envelope('cancel'))).toEqual({
      ok: true,
      message: envelope('cancel'),
    });
  });

  it('parses the init, settings, validate, call, test, trigger and hook shapes', () => {
    const msgs = [
      { ...envelope('init'), settings: { a: 1 }, limits, dryRunDefaults: {} },
      { ...envelope('settings'), settings: {} },
      { ...envelope('validate'), nodeType: null, settings: { x: 'y' } },
      { ...envelope('validate'), nodeType: 'example:n', settings: {} },
      { ...envelope('migrate'), nodeType: 'x:a', from: 1, settings: {} },
      {
        ...envelope('call'),
        hook: 'decide',
        nodeType: 'example:n',
        nodeVersion: 1,
        ctx: {},
        settings: {},
      },
      { ...envelope('test'), settings: {} },
      { ...envelope('trigger'), triggerId: 't', request: { body: null } },
      { ...envelope('hook'), name: 'onJobDone', job: { id: 'j' } },
    ];
    const migrate = envelope('migrate');
    const bad = [
      { ...migrate, nodeType: 'x:a', from: 1.5, settings: {} },
      { ...migrate, from: 1, settings: {} },
      { ...migrate, nodeType: 'x:a', from: 1, settings: {}, extra: true },
    ];
    for (const m of bad) expect(parseServerMessage(m).ok).toBe(false);
    for (const m of msgs) expect(parseServerMessage(m)).toEqual({ ok: true, message: m });
    expect(
      parseServerMessage({
        ...envelope('call'),
        hook: 'nope',
        nodeType: 'a',
        nodeVersion: 1,
        ctx: {},
        settings: {},
      }).ok,
    ).toBe(false);
    expect(parseServerMessage({ ...envelope('hook'), name: 'onNothing', job: {} }).ok).toBe(false);
    expect(
      parseServerMessage({
        ...envelope('init'),
        settings: {},
        limits: { ...limits, cacheBytes: 0 },
        dryRunDefaults: {},
      }).ok,
    ).toBe(false);
  });

  it('parseServerMessage handles both fetch-result shapes and refuses a mixed one', () => {
    const ok = {
      ...envelope('fetch-result'),
      ok: true,
      response: { status: 200, headers: {}, body: null },
    };
    const bad = {
      ...envelope('fetch-result'),
      ok: false,
      error: { kind: 'timeout', message: 'slow' },
    };
    expect(parseServerMessage(ok).ok).toBe(true);
    expect(parseServerMessage(bad).ok).toBe(true);
    expect(parseServerMessage({ ...bad, error: { kind: 'nope', message: 'x' } }).ok).toBe(false);
    expect(parseServerMessage({ ...envelope('fetch-result'), ok: true }).ok).toBe(false);
  });

  it('parseHostMessage round-trips ready/fatal/result/fetch/log; an ok:false result parses as ok:true', () => {
    const msgs = [
      { ...envelope('ready'), manifest, nodes: [], integration: null, triggers: [] },
      {
        ...envelope('ready'),
        manifest,
        nodes: [],
        integration: {
          settingsSchema: { type: 'object' },
          allowedOrigins: ['https://api.example.com'],
          id: 'main',
          title: 'Main',
          requires: { product: 'Sonarr', minVersion: '4.0.0' },
        },
        triggers: [],
      },
      { ...envelope('fatal'), reason: 'bundle has no plugin default export' },
      { ...envelope('result'), ok: true, result: { a: 1 } },
      { ...envelope('result'), ok: false, error: { message: 'boom', retryable: false } },
      {
        ...envelope('fetch'),
        callId: 'c-1',
        input: { url: 'https://example.com/x', method: 'GET', headers: {}, accept: 'json' },
      },
      {
        ...envelope('fetch'),
        callId: null,
        input: { url: 'https://example.com/x', method: 'GET', headers: {}, accept: 'json' },
      },
      { ...envelope('log'), level: 'info', message: 'hi', jobId: null },
    ];
    for (const m of msgs) expect(parseHostMessage(m)).toEqual({ ok: true, message: m });
    expect(parseHostMessage({ ...envelope('result'), ok: false }).ok).toBe(false);
  });

  it('refuses unknown keys on every message and non-http(s) fetch urls', () => {
    expect(parseServerMessage({ ...envelope('cancel'), extra: 1 }).ok).toBe(false);
    expect(
      parseHostMessage({ ...envelope('log'), level: 'info', message: 'x', jobId: null, extra: 1 })
        .ok,
    ).toBe(false);
    const fetchMsg = (url: string) => ({
      ...envelope('fetch'),
      callId: null,
      input: { url, method: 'GET', headers: {}, accept: 'json' },
    });
    expect(parseHostMessage(fetchMsg('file:///etc/passwd')).ok).toBe(false);
    expect(parseHostMessage(fetchMsg('http://localhost:8989/api')).ok).toBe(true);
  });

  it('a fetch message requires callId (string or null), strict', () => {
    const base = {
      ...envelope('fetch'),
      input: { url: 'https://example.com/x', method: 'GET', headers: {}, accept: 'json' },
    };
    expect(parseHostMessage(base).ok).toBe(false);
    expect(parseHostMessage({ ...base, callId: undefined }).ok).toBe(false);
    expect(parseHostMessage({ ...base, callId: 7 }).ok).toBe(false);
    expect(parseHostMessage({ ...base, callId: 'c-1' }).ok).toBe(true);
    expect(parseHostMessage({ ...base, callId: null }).ok).toBe(true);
    expect(parseHostMessage({ ...base, callId: null, extra: 1 }).ok).toBe(false);
  });

  it('truncates parseError to 500 chars and refuses a message over MAX_MESSAGE_BYTES', () => {
    const r = parseServerMessage({ v: 1, id: '1', type: 'bogus' });
    expect(!r.ok && r.parseError.length <= 500).toBe(true);
    const big = parseServerMessage({
      ...envelope('settings'),
      settings: { s: 'x'.repeat(MAX_MESSAGE_BYTES) },
    });
    expect(big.ok).toBe(false);
    expect(!big.ok && big.parseError).toContain('cap');
  });

  it('messageBytes counts UTF-8 bytes of the JSON form', () => {
    expect(messageBytes({ a: 'é' })).toBe(10);
  });
});

describe('fetch auth', () => {
  const base = { url: 'http://svc/x' };

  it('accepts each of the four strict auth shapes and none', () => {
    const shapes = [
      { basic: { username: 'u', password: 'p' } },
      { bearer: 'tok' },
      { header: { name: 'X-Api-Key', value: 'k' } },
      { query: { name: 'apikey', value: 'k' } },
    ];
    for (const auth of shapes) {
      expect(FetchInputSchema.parse({ ...base, auth }).auth).toEqual(auth);
    }
    expect(FetchInputSchema.parse(base).auth).toBeUndefined();
  });

  it('rejects unknown keys, two variants at once and a missing part', () => {
    const bad = [
      { bearer: 'a', extra: 1 },
      { bearer: 'a', basic: { username: 'u', password: 'p' } },
      { basic: { username: 'u' } },
      { header: { name: '', value: 'v' } },
      { query: { name: 'k', value: 'v', more: true } },
      {},
    ];
    for (const auth of bad)
      expect(FetchInputSchema.safeParse({ ...base, auth }).success).toBe(false);
  });
});

describe('language names', () => {
  it('languageFromName: Japanese→jpn, german→deu, Unknown/Original/""→null', () => {
    expect(languageFromName('Japanese')).toBe('jpn');
    expect(languageFromName(' german ')).toBe('deu');
    expect(languageFromName('Mandarin')).toBe('zho');
    expect(languageFromName('Portuguese (Brazil)')).toBe('por');
    for (const n of ['Unknown', 'Original', 'Any', '', 'Klingon'])
      expect(languageFromName(n)).toBeNull();
  });

  it('iso1Of(jpn)→ja, eng→en, null→null', () => {
    expect(iso1Of('jpn')).toBe('ja');
    expect(iso1Of('eng')).toBe('en');
    expect(iso1Of(null)).toBeNull();
    expect(iso1Of('und')).toBeNull();
  });

  it('normalizeLanguageValue: "ja"→jpn, "xx"/"und"/null/42→unknown', () => {
    expect(normalizeLanguageValue('ja')).toBe('jpn');
    for (const v of ['xx', 'und', 'zxx', 'unknown', '', null, 42])
      expect(normalizeLanguageValue(v)).toBe('unknown');
  });
});

describe('trace source', () => {
  it('TraceEntrySchema accepts an entry without source and one with plugin', () => {
    const entry = {
      seq: 1,
      attempt: 1,
      nodeId: 'n1',
      workflowPath: [],
      phase: 'decide',
      port: null,
      reason: 'r',
      findings: {},
      startedAt: '2026-10-17T10:00:00.000Z',
      endedAt: '2026-10-17T10:00:01.000Z',
    };
    expect(TraceEntrySchema.safeParse(entry).success).toBe(true);
    expect(TraceEntrySchema.safeParse({ ...entry, source: 'plugin' }).success).toBe(true);
    expect(TraceEntrySchema.safeParse({ ...entry, source: 'x' }).success).toBe(false);
  });
});
