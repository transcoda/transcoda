import { nodeMetadata, parseSettings } from '@transcoda/sdk';
import type { HookName, JsonValue } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { filePort, passElse } from './core/common.ts';
import { videoIs } from './core/conditions.ts';
import {
  isRemoteDefinition,
  PluginMigrationPending,
  RemoteHookError,
  type RemoteHooks,
  remoteNodeDefinition,
  wireContext,
} from './remote.ts';

// The shape the plugin would send: z.toJSONSchema of its own settings, input side.
const pluginSettings = z.object({
  extensions: z.array(z.string()).min(1).default(['mkv']).describe('Extensions'),
  mode: z.enum(['loud', 'quiet']).default('quiet'),
  level: z.number().int().min(1).max(10).default(3),
  pattern: z
    .string()
    .regex(/^[a-z]+$/)
    .default('abc'),
  maps: z
    .array(z.object({ remote: z.string().startsWith('/'), local: z.string().startsWith('/') }))
    .default([]),
});
const settingsSchema = z.toJSONSchema(pluginSettings, { io: 'input' }) as JsonValue;

const meta = (kind: 'condition' | 'finish', hooks: HookName[]) => ({
  type: 'example:node',
  version: 1,
  kind,
  title: 'Example node',
  description: 'A plugin node.',
  icon: 'plug',
  inputs: [filePort],
  outputs: kind === 'condition' ? passElse : [filePort],
  settingsSchema,
  onNodeSettings: [],
  requires: {},
  migrations: [],
  finishPhase: kind === 'finish' ? ('notify' as const) : null,
  hooks,
});
const source = { kind: 'plugin', name: 'example', version: '1.0.0' } as const;
const limits = { callTimeoutMs: 1111, finishRunTimeoutMs: 2222 };

interface Call {
  hook: HookName;
  type: string;
  version: number;
  ctx: JsonValue;
  settings: JsonValue;
  opts: { timeoutMs?: number; jobId: string | null; signal?: AbortSignal | undefined };
}
function fake(
  reply: (call: Call) => ReturnType<RemoteHooks['call']> | Awaited<ReturnType<RemoteHooks['call']>>,
) {
  const calls: Call[] = [];
  const hooks: RemoteHooks = {
    async call(hook, type, version, ctx, settings, opts) {
      const call = { hook, type, version, ctx, settings, opts };
      calls.push(call);
      return reply(call);
    },
  };
  return { hooks, calls };
}

const baseCtx = (over: Record<string, unknown> = {}) =>
  ({
    probe: { streams: [] },
    file: { path: '/m/a.mkv', sizeBytes: 1, mtime: 'x', nlink: 1 },
    data: {},
    capabilities: { encoders: [], filters: [], hwaccels: [] },
    log: () => {},
    plugin: { job: { id: 'job-9', attempt: 1 }, dryRun: false },
    now: 5,
    ...over,
  }) as never;

describe('remoteNodeDefinition', () => {
  it('reports the plugin schema verbatim, not the loose re-derived one', () => {
    const { hooks } = fake(() => ({ ok: true, result: null }));
    const def = remoteNodeDefinition(meta('finish', ['finish']), source, hooks, limits);
    expect(nodeMetadata(def).settingsSchema).toEqual(settingsSchema);
    expect(JSON.stringify(nodeMetadata(def).settingsSchema)).not.toContain('additionalProperties');
  });

  it('applies the schema defaults and reports a bad value with its path', () => {
    const { hooks } = fake(() => ({ ok: true, result: null }));
    const def = remoteNodeDefinition(meta('finish', ['finish']), source, hooks, limits);
    expect(parseSettings(def, {})).toEqual({
      ok: true,
      value: { extensions: ['mkv'], mode: 'quiet', level: 3, pattern: 'abc', maps: [] },
    });
    const bad = parseSettings(def, { extensions: 1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]?.path).toBe('extensions');
    const more = parseSettings(def, {
      extensions: [],
      mode: 'x',
      level: 11,
      pattern: 'A',
      maps: [{ remote: 'no', local: '/y' }],
    });
    if (more.ok) throw new Error('expected issues');
    // Patterns (here `regex` and `startsWith`) are the host's to check, never the server's.
    expect(more.issues.map((i) => i.path).sort()).toEqual(['extensions', 'level', 'mode'].sort());
  });

  it("never runs the plugin's settings patterns on the server (ReDoS)", () => {
    const { hooks } = fake(() => ({ ok: true, result: null }));
    const evil = {
      ...meta('finish', ['finish']),
      settingsSchema: {
        type: 'object',
        properties: { apiKey: { type: 'string', pattern: '^([a-f0-9]+)*X$' } },
      },
    };
    const def = remoteNodeDefinition(evil, source, hooks, limits);
    const started = performance.now();
    expect(parseSettings(def, { apiKey: 'a'.repeat(40) }).ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('exposes the settings shape for sub-workflow overrides', () => {
    const { hooks } = fake(() => ({ ok: true, result: null }));
    const def = remoteNodeDefinition(meta('finish', ['finish']), source, hooks, limits);
    expect(Object.keys(def.settings.shape)).toContain('extensions');
  });

  it('defines exactly the hooks the plugin declared', () => {
    const { hooks } = fake(() => ({ ok: true, result: null }));
    const def = remoteNodeDefinition(meta('finish', ['finish', 'run']), source, hooks, limits);
    expect(nodeMetadata(def).hooks).toEqual(['finish', 'run']);
    expect(def.decide).toBeUndefined();
    expect(def.migrations).toEqual([]);
  });

  it('a decide call sends the context without plugin and log, and returns the host result', async () => {
    const { hooks, calls } = fake(() => ({
      ok: true,
      result: { port: 'else', reason: 'nope', findings: { a: 1 } },
    }));
    const def = remoteNodeDefinition(meta('condition', ['decide']), source, hooks, limits);
    const result = await def.decide?.(baseCtx(), { mode: 'loud' });
    expect(result).toEqual({ port: 'else', reason: 'nope', findings: { a: 1 } });
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call).toMatchObject({
      hook: 'decide',
      type: 'example:node',
      version: 1,
      settings: { mode: 'loud' },
      opts: { timeoutMs: 1111, jobId: 'job-9' },
    });
    expect(Object.keys(call.ctx as object).sort()).toEqual(
      ['capabilities', 'data', 'dryRun', 'file', 'job', 'now', 'probe'].sort(),
    );
  });

  it("a call carries the node's stored version (for the host to migrate from) and never sends it in the context", async () => {
    const { hooks, calls } = fake(() => ({ ok: true, result: { port: 'else', reason: 'r' } }));
    const def = remoteNodeDefinition(
      { ...meta('condition', ['decide']), version: 3 },
      source,
      hooks,
      limits,
    );
    await def.decide?.(baseCtx({ nodeVersion: 1 }), { old: 'a' });
    await def.decide?.(baseCtx(), { mode: 'loud' });
    expect(calls.map((c) => c.version)).toEqual([1, 3]);
    expect(Object.keys((calls[0] as Call).ctx as object)).not.toContain('nodeVersion');
  });

  it('wireContext keeps the model for build and finish', () => {
    const wired = wireContext(baseCtx({ model: { container: 'mkv' } })) as Record<string, unknown>;
    expect(wired.model).toEqual({ container: 'mkv' });
    expect('plugin' in wired || 'log' in wired).toBe(false);
  });

  it('wireContext carries job and dryRun at the top level, where the host reads them', () => {
    const wired = wireContext(
      baseCtx({ plugin: { job: { id: 'job-3', attempt: 2 }, dryRun: true } }),
    ) as Record<string, unknown>;
    expect(wired.job).toEqual({ id: 'job-3', attempt: 2 });
    expect(wired.dryRun).toBe(true);
    const none = wireContext(baseCtx({ plugin: { job: null, dryRun: false } })) as Record<
      string,
      unknown
    >;
    expect(none).toMatchObject({ job: null, dryRun: false });
  });

  it('a signal on the context reaches the call and never the wire', async () => {
    const { hooks, calls } = fake(() => ({ ok: true, result: { ok: true, message: 'sent' } }));
    const def = remoteNodeDefinition(meta('finish', ['finish', 'run']), source, hooks, limits);
    const ctl = new AbortController();
    await def.run?.(baseCtx({ signal: ctl.signal }), {});
    expect(calls[0]?.opts.signal).toBe(ctl.signal);
    expect(Object.keys(calls[0]?.ctx as object)).not.toContain('signal');
    expect('signal' in (wireContext(baseCtx({ signal: ctl.signal })) as object)).toBe(false);
    await def.run?.(baseCtx(), {});
    expect(calls[1]?.opts.signal).toBeUndefined();
  });

  it('a decide result naming an undeclared port throws', async () => {
    const { hooks } = fake(() => ({ ok: true, result: { port: 'maybe', reason: 'r' } }));
    const def = remoteNodeDefinition(meta('condition', ['decide']), source, hooks, limits);
    await expect(def.decide?.(baseCtx(), {})).rejects.toThrow(
      'plugin example chose port maybe, which example:node does not declare',
    );
  });

  it('a failed call becomes a RemoteHookError carrying retryable', async () => {
    const { hooks } = fake(() => ({ ok: false, error: { message: 'timed out', retryable: true } }));
    const def = remoteNodeDefinition(meta('condition', ['decide']), source, hooks, limits);
    const err = await def.decide?.(baseCtx(), {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteHookError);
    expect(err).toMatchObject({ message: 'timed out', retryable: true });
  });

  it('a finish result may only hold plugin actions', async () => {
    const good = fake(() => ({
      ok: true,
      result: { actions: [{ kind: 'plugin', description: 'd', required: true }], reason: 'r' },
    }));
    const okDef = remoteNodeDefinition(meta('finish', ['finish']), source, good.hooks, limits);
    await expect(okDef.finish?.(baseCtx(), {})).resolves.toMatchObject({ reason: 'r' });
    const bad = fake(() => ({
      ok: true,
      result: { actions: [{ kind: 'replace', recycleFolder: null }], reason: 'r' },
    }));
    const badDef = remoteNodeDefinition(meta('finish', ['finish']), source, bad.hooks, limits);
    await expect(badDef.finish?.(baseCtx(), {})).rejects.toThrow(
      'plugin example returned a replace action; only plugin actions are allowed',
    );
  });

  it('run uses the finish-run timeout', async () => {
    const { hooks, calls } = fake(() => ({ ok: true, result: { ok: true, message: 'sent' } }));
    const def = remoteNodeDefinition(meta('finish', ['finish', 'run']), source, hooks, limits);
    await expect(def.run?.(baseCtx(), {})).resolves.toEqual({ ok: true, message: 'sent' });
    expect(calls[0]?.opts.timeoutMs).toBe(2222);
    expect(calls[0]?.hook).toBe('run');
  });

  it.each([
    ['no message', { ok: true }],
    ['a non-string message', { ok: true, message: 42 }],
    ['an oversize message', { ok: true, message: 'x'.repeat(2001) }],
    ['a non-boolean retryable', { ok: false, message: 'busy', retryable: 'yes' }],
    ['no ok', { message: 'hi' }],
  ])('a run answer with %s is a non-retryable RemoteHookError', async (_name, answer) => {
    const { hooks } = fake(() => ({ ok: true, result: answer as JsonValue }));
    const def = remoteNodeDefinition(meta('finish', ['finish', 'run']), source, hooks, limits);
    const err = await def.run?.(baseCtx(), {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RemoteHookError);
    expect((err as RemoteHookError).retryable).toBe(false);
    expect((err as Error).message).toMatch(/^plugin example sent an invalid run answer/);
  });

  it('a valid failed run answer keeps its retryable flag', async () => {
    const { hooks } = fake(() => ({
      ok: true,
      result: { ok: false, message: 'busy', retryable: true },
    }));
    const def = remoteNodeDefinition(meta('finish', ['finish', 'run']), source, hooks, limits);
    await expect(def.run?.(baseCtx(), {})).resolves.toEqual({
      ok: false,
      message: 'busy',
      retryable: true,
    });
  });

  describe('construction refuses inconsistent metadata', () => {
    const { hooks } = fake(() => ({ ok: true, result: null }));
    const build = (m: ReturnType<typeof meta>) => () =>
      remoteNodeDefinition(m, source, hooks, limits);

    it.each([null, 'gate', 'write'] as const)('a finish node with phase %s', (phase) => {
      expect(build({ ...meta('finish', ['finish']), finishPhase: phase } as never)).toThrow(
        /must declare finishPhase library-manager, media-server or notify/,
      );
    });

    it('accepts the three plugin phases', () => {
      for (const phase of ['library-manager', 'media-server', 'notify'] as const) {
        expect(build({ ...meta('finish', ['finish']), finishPhase: phase } as never)).not.toThrow();
      }
    });

    it('refuses the render phase', () => {
      expect(build({ ...meta('finish', ['finish']), finishPhase: 'render' } as never)).toThrow(
        /must declare finishPhase library-manager, media-server or notify \(got render\)/,
      );
    });

    it('run on a non-finish node', () => {
      expect(build(meta('condition', ['decide', 'run']))).toThrow(/declares run/);
    });

    it('decide on a non-condition node', () => {
      expect(build(meta('finish', ['decide', 'finish']))).toThrow(/declares decide/);
    });
  });
});

describe('remote node migrations', () => {
  const steps = [
    { from: 1, to: 2, risk: 'safe' as const, note: 'a' },
    { from: 2, to: 3, risk: 'behaviour' as const, note: 'b' },
  ];
  it('exposes the announced migrations; running one is a pending marker, never plugin code', () => {
    const def = remoteNodeDefinition(
      { ...meta('condition', ['decide']), version: 3, migrations: steps },
      source,
      fake(() => ({ ok: true, result: null })).hooks,
      limits,
    );
    expect(def.migrations).toHaveLength(2);
    expect(def.migrations?.map(({ from, to, risk, note }) => ({ from, to, risk, note }))).toEqual(
      steps,
    );
    expect(() => def.migrations?.[0]?.migrate({})).toThrow(PluginMigrationPending);
    expect(isRemoteDefinition(def)).toBe(true);
    expect(isRemoteDefinition(videoIs)).toBe(false);
  });
});
