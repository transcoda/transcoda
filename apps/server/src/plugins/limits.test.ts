import { DEFAULT_LIMITS } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { setSetting } from '../db/repos/settings.ts';
import { createTestDb } from '../db/test-db.ts';
import { hostLimits, loadLimits } from './limits.ts';

describe('loadLimits', () => {
  it('returns the defaults when no rows exist', () => {
    expect(loadLimits(createTestDb())).toEqual(DEFAULT_LIMITS);
  });

  it('applies a stored override', () => {
    const db = createTestDb();
    setSetting(db, 'plugins.limits.heapMb', 64, new Date());
    expect(loadLimits(db).heapMb).toBe(64);
    expect(loadLimits(db).rssMb).toBe(DEFAULT_LIMITS.rssMb);
  });

  it('ignores a row that is not a positive integer', () => {
    const db = createTestDb();
    setSetting(db, 'plugins.limits.heapMb', 1.5, new Date());
    setSetting(db, 'plugins.limits.rssMb', 'big', new Date());
    setSetting(db, 'plugins.limits.maxCrashes', -2, new Date());
    const l = loadLimits(db);
    expect(l.heapMb).toBe(DEFAULT_LIMITS.heapMb);
    expect(l.rssMb).toBe(DEFAULT_LIMITS.rssMb);
    expect(l.maxCrashes).toBe(DEFAULT_LIMITS.maxCrashes);
  });
});

describe('loadLimits bounds and bad cells', () => {
  it('falls back above the upper bound', () => {
    const db = createTestDb();
    setSetting(db, 'plugins.limits.heapMb', 4097, new Date());
    setSetting(db, 'plugins.limits.fetchConcurrency', 17, new Date());
    setSetting(db, 'plugins.limits.callTimeoutMs', 3_600_001, new Date());
    setSetting(db, 'plugins.limits.rssMb', 2049, new Date());
    setSetting(db, 'plugins.limits.maxHosts', 257, new Date());
    const l = loadLimits(db);
    expect(l.heapMb).toBe(DEFAULT_LIMITS.heapMb);
    expect(l.fetchConcurrency).toBe(DEFAULT_LIMITS.fetchConcurrency);
    expect(l.callTimeoutMs).toBe(DEFAULT_LIMITS.callTimeoutMs);
    expect(l.rssMb).toBe(DEFAULT_LIMITS.rssMb);
    expect(l.maxHosts).toBe(DEFAULT_LIMITS.maxHosts);
  });

  it('accepts rssMb and maxHosts at their bounds', () => {
    const db = createTestDb();
    setSetting(db, 'plugins.limits.rssMb', 2048, new Date());
    setSetting(db, 'plugins.limits.maxHosts', 256, new Date());
    const l = loadLimits(db);
    expect(l.rssMb).toBe(2048);
    expect(l.maxHosts).toBe(256);
  });

  it('ignores a cell that is not valid JSON', () => {
    const db = createTestDb();
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      'plugins.limits.heapMb',
      '{not json',
      new Date().toISOString(),
    );
    expect(loadLimits(db).heapMb).toBe(DEFAULT_LIMITS.heapMb);
  });
});

describe('hostLimits', () => {
  it('is the init subset', () => {
    expect(Object.keys(hostLimits(DEFAULT_LIMITS)).sort()).toEqual(
      [
        'cacheBytes',
        'cacheEntries',
        'callTimeoutMs',
        'fetchDefaultTimeoutMs',
        'fetchMaxTimeoutMs',
        'finishRunTimeoutMs',
        'hookTimeoutMs',
        'testTimeoutMs',
        'triggerTimeoutMs',
      ].sort(),
    );
  });
});
