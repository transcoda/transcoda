import type { HostResult } from '@transcoda/shared';
import { describe, expect, it, vi } from 'vitest';
import { PluginCallError } from '../runtime/process.ts';
import { pluginTrigger, TRIGGER_MAX_FILES } from './triggers.ts';
import type { Installed } from './types.ts';

const rec = (auth: unknown): Installed =>
  ({
    name: 'arr',
    triggers: [{ id: 'import', title: 'I', description: 'd', icon: 'i', settingsSchema: {}, auth }],
  }) as unknown as Installed;

function supervisor(answer: () => Promise<HostResult>, state = 'running') {
  return {
    call: vi.fn(answer),
    status: vi.fn(() => ({ state }) as never),
  };
}
const ok = (result: unknown) => async () => ({ id: '1', ok: true, result }) as HostResult;
const request = { method: 'POST', headers: {}, body: { eventType: 'Download' } };

describe('pluginTrigger', () => {
  it('is null for an unknown plugin, trigger id or auth', () => {
    const sup = supervisor(ok(null));
    expect(pluginTrigger(sup, null, 'import')).toBeNull();
    expect(pluginTrigger(sup, rec({ basic: true }), 'other')).toBeNull();
    expect(pluginTrigger(sup, rec({ query: 'key' }), 'import')).toBeNull();
    expect(pluginTrigger(sup, rec({ header: '' }), 'import')).toBeNull();
  });

  it('calls the plugin with the request and empty settings, and returns a checked answer', async () => {
    const files = [{ path: '/tv/a.mkv', note: 'imported' }];
    const sup = supervisor(ok({ kind: 'files', files }));
    const trigger = pluginTrigger(sup, rec({ basic: true }), 'import');
    expect(trigger?.auth).toEqual({ basic: true });
    expect(await trigger?.call(request)).toEqual({ ok: true, answer: { kind: 'files', files } });
    expect(sup.call).toHaveBeenCalledWith('arr', {
      type: 'trigger',
      triggerId: 'import',
      request: { ...request, settings: {} },
    });
  });

  it('an answer that breaks the shape or names too many files fails', async () => {
    const many = Array.from({ length: TRIGGER_MAX_FILES + 1 }, () => ({ path: '/a', note: '' }));
    for (const bad of [
      null,
      { kind: 'files' },
      { kind: 'files', files: [{ path: '', note: '' }] },
      { kind: 'files', files: many },
      { kind: 'queue-everything' },
      { kind: 'test', message: 'x'.repeat(2001) },
    ]) {
      const trigger = pluginTrigger(supervisor(ok(bad)), rec({ basic: true }), 'import');
      expect(await trigger?.call(request)).toMatchObject({ ok: false, kind: 'failed' });
    }
  });

  it('a plugin that is not running is unavailable, without a call', async () => {
    const sup = supervisor(ok(null), 'stopped');
    const trigger = pluginTrigger(sup, rec({ basic: true }), 'import');
    expect(await trigger?.call(request)).toEqual({
      ok: false,
      kind: 'unavailable',
      message: 'plugin arr is stopped',
    });
    expect(sup.call).not.toHaveBeenCalled();
  });

  it('a timeout fails; a restart under way is unavailable; an error answer fails with its text', async () => {
    const timeout = supervisor(async () => {
      throw new PluginCallError('plugin arr timed out after 5 s', false);
    });
    const restart = supervisor(async () => {
      throw new PluginCallError('plugin arr restarted', true);
    });
    const thrown = supervisor(
      async () => ({ id: '1', ok: false, error: { message: 'boom' } }) as HostResult,
    );
    const call = (sup: ReturnType<typeof supervisor>) =>
      pluginTrigger(sup, rec({ basic: true }), 'import')?.call(request);
    expect(await call(timeout)).toMatchObject({ ok: false, kind: 'failed' });
    expect(await call(restart)).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(await call(thrown)).toEqual({ ok: false, kind: 'failed', message: 'boom' });
  });
});
