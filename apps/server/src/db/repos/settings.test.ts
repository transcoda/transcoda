import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Database } from '../open.ts';
import { now, seededDb } from './jobs/testing.ts';
import {
  getSetting,
  getSettingOr,
  SETTING_DEFAULTS,
  SETTING_KEYS,
  setSetting,
} from './settings.ts';

let db: Database;
beforeEach(() => {
  db = seededDb();
});
afterEach(() => {
  db.close();
});

describe('settings', () => {
  it('getSettingOr falls back to the default and reads a stored value', () => {
    expect(getSettingOr(db, SETTING_KEYS.queuePaused, z.boolean(), false)).toBe(false);
    expect(SETTING_DEFAULTS).toEqual({
      queuePaused: false,
      recycleRetentionDays: 7,
      recycleMaxFreePercent: 25,
      serverName: null,
      theme: 'system',
      pluginCallTimeoutMs: 30_000,
      testEncodeKeepHours: 2,
      encodeDevice: 'auto',
      gpuOrder: [],
    });
    setSetting(db, SETTING_KEYS.queuePaused, true, now);
    expect(getSettingOr(db, SETTING_KEYS.queuePaused, z.boolean(), false)).toBe(true);
  });
});

describe('getSetting', () => {
  it('getSetting returns null when absent and parses JSON when present', () => {
    const schema = z.array(z.string());
    expect(getSetting(db, 'allowed_hosts', schema)).toBeNull();
    setSetting(db, 'allowed_hosts', ['a.example'], now);
    expect(getSetting(db, 'allowed_hosts', schema)).toEqual(['a.example']);
    setSetting(db, 'allowed_hosts', ['b.example'], now);
    expect(getSetting(db, 'allowed_hosts', schema)).toEqual(['b.example']);
  });
});
