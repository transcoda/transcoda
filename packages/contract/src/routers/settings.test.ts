import { describe, expect, it } from 'vitest';
import { contract, EncodeDeviceSchema, SettingsUpdateInputSchema } from '../index.ts';

describe('settings router', () => {
  it('exposes get and a session-only update, after system', () => {
    expect(Object.keys(contract.settings)).toEqual(['get', 'update']);
    const keys = Object.keys(contract);
    expect(keys.indexOf('settings')).toBe(keys.indexOf('system') + 1);
    expect(contract.settings.get['~orpc'].route).toMatchObject({
      method: 'GET',
      path: '/settings',
    });
    expect(contract.settings.update['~orpc'].route).toMatchObject({
      method: 'PATCH',
      path: '/settings',
    });
    expect(contract.auth.changePassword['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/auth/password',
    });
  });

  it('the update input is a strict allow-list with bounds', () => {
    const refused: unknown[] = [
      {},
      { queuePaused: true },
      { 'recycle.retentionDays': 3 },
      { pluginCallTimeoutMs: 999 },
      { pluginCallTimeoutMs: 3_600_001 },
      { recycleMaxFreePercent: 101 },
      { recycleRetentionDays: 1.5 },
      { testEncodeKeepHours: 73 },
      { testEncodeKeepHours: 1.5 },
      { testEncodeKeepHours: -1 },
      { serverName: 'a\nb' },
      { serverName: 'x'.repeat(65) },
      { theme: 'sepia' },
    ];
    for (const input of refused) {
      expect(SettingsUpdateInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
    const accepted: unknown[] = [
      { serverName: null },
      { serverName: 'x'.repeat(64) },
      { theme: 'light' },
      { recycleRetentionDays: 0, recycleMaxFreePercent: 100 },
      { pluginCallTimeoutMs: 1_000 },
      { pluginCallTimeoutMs: 3_600_000 },
      { testEncodeKeepHours: 0 },
      { testEncodeKeepHours: 72 },
    ];
    for (const input of accepted) {
      expect(SettingsUpdateInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(true);
    }
  });
});

describe('EncodeDeviceSchema', () => {
  it('accepts auto, cpu, nvidia:<n> and intel:<pci address>', () => {
    for (const v of ['auto', 'cpu', 'nvidia:0', 'intel:0000:07:00.0', 'intel:0000:0a:1f.7']) {
      expect(EncodeDeviceSchema.safeParse(v).success).toBe(true);
    }
  });
  it('rejects a short or out-of-range Intel address', () => {
    for (const v of ['intel:7:0.0', 'intel:0000:07:00.8', 'intel:0', 'intel:0000:07:00.0:x']) {
      expect(EncodeDeviceSchema.safeParse(v).success).toBe(false);
    }
  });
});
