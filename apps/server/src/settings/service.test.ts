import type { Capabilities, Gpu } from '@transcoda/contract';
import { DEFAULT_LIMITS } from '@transcoda/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Config, loadConfig } from '../config.ts';
import type { Database } from '../db/open.ts';
import { insertRecycled } from '../db/repos/jobs.ts';
import { setSetting } from '../db/repos/settings.ts';
import { createTestDb } from '../db/test-db.ts';
import type { Logger } from '../logger.ts';
import { readAppearance, readSettings, type SettingsDeps, updateSettings } from './service.ts';

const NOW = new Date('2026-10-19T10:00:00.000Z');
const SECRET_HEX = 'ab'.repeat(32);
const CATALOG_TOKEN = 'catalog-token-5e1f7a';

let db: Database;
let deps: SettingsDeps;
type ApplyLimits = (p: { callTimeoutMs: number }) => void;
let applyLimits: ReturnType<typeof vi.fn<ApplyLimits>>;
let warnings: unknown[];

const RTX = {
  id: 'nvidia:0',
  vendor: 'nvidia',
  index: 0,
  name: 'NVIDIA GeForce RTX 3060',
} as const;
const withGpus = (gpus: Gpu[], encoders = ['libx265', 'hevc_nvenc']): Capabilities => ({
  available: true,
  path: 'ffmpeg',
  version: '7.1',
  encoders,
  hwaccels: ['cuda'],
  filters: [],
  gpus,
});

function make(
  over: { config?: Partial<Config>; envSet?: string[]; capabilities?: Capabilities } = {},
): SettingsDeps {
  warnings = [];
  const log: Logger = { info: () => {}, warn: (e) => void warnings.push(e), error: () => {} };
  applyLimits = vi.fn<ApplyLimits>();
  return {
    db,
    config: {
      ...loadConfig({}),
      secretKeyHex: SECRET_HEX,
      catalogToken: CATALOG_TOKEN,
      ...over.config,
    },
    envSet: new Set(over.envSet ?? []),
    version: '1.2.3',
    plugins: { applyLimits },
    capabilities: () => over.capabilities ?? withGpus([], ['libx265']),
    now: () => NOW,
    log,
  };
}

beforeEach(() => {
  db = createTestDb();
  deps = make();
});

describe('readSettings: encoding device', () => {
  it('defaults to auto; the choices are auto, CPU only and each detected GPU', () => {
    const s = readSettings(
      make({ capabilities: withGpus([RTX, { ...RTX, id: 'nvidia:1', index: 1 }]) }),
    );
    expect(s.queue.encodeDevice).toEqual({
      value: 'auto',
      default: 'auto',
      source: { kind: 'default' },
    });
    expect(s.queue.encodeDevices).toEqual([
      { id: 'auto', label: 'Auto', missing: false },
      { id: 'cpu', label: 'CPU only', missing: false },
      { id: 'nvidia:0', label: 'GPU 0 · NVIDIA GeForce RTX 3060', missing: false },
      { id: 'nvidia:1', label: 'GPU 1 · NVIDIA GeForce RTX 3060', missing: false },
    ]);
  });

  it('lanes: one encode slot per GPU on auto with two GPUs, else the one encode lane', () => {
    const two = make({ capabilities: withGpus([RTX, { ...RTX, id: 'nvidia:1', index: 1 }]) });
    expect(readSettings(two).queue.lanes).toEqual([
      { id: 'encode', label: 'Encode ×2 (one per GPU)' },
      { id: 'quick', label: 'Quick' },
    ]);
    setSetting(db, 'engine.encodeDevice', 'cpu', NOW);
    expect(readSettings(two).queue.lanes[0]).toEqual({ id: 'encode', label: 'Encode' });
  });

  it('no GPU: auto and CPU only', () => {
    expect(readSettings(deps).queue.encodeDevices.map((d) => d.id)).toEqual(['auto', 'cpu']);
  });

  it('NVENC without nvidia-smi offers an unnamed GPU 0', () => {
    const s = readSettings(make({ capabilities: withGpus([]) }));
    expect(s.queue.encodeDevices.at(-1)).toEqual({
      id: 'nvidia:0',
      label: 'GPU 0',
      missing: false,
    });
  });

  it('a stored GPU that is gone stays listed, marked missing', () => {
    setSetting(db, 'engine.encodeDevice', 'nvidia:2', NOW);
    const s = readSettings(make({ capabilities: withGpus([RTX]) }));
    expect(s.queue.encodeDevice.value).toBe('nvidia:2');
    expect(s.queue.encodeDevices.at(-1)).toEqual({
      id: 'nvidia:2',
      label: 'GPU 2 (not found: encodes on the CPU)',
      missing: true,
    });
  });

  it('a row that is not a device reads as the default', () => {
    setSetting(db, 'engine.encodeDevice', 'gpu-please', NOW);
    expect(readSettings(deps).queue.encodeDevice.source).toEqual({ kind: 'default' });
  });

  it('updateSettings writes it', () => {
    const s = updateSettings(deps, { encodeDevice: 'cpu' });
    expect(s.queue.encodeDevice).toEqual({
      value: 'cpu',
      default: 'auto',
      source: { kind: 'database' },
    });
  });
});

describe('readSettings', () => {
  it('answers the defaults on an empty table, each with source default', () => {
    const s = readSettings(deps);
    expect(s.general.serverName).toEqual({
      value: null,
      default: null,
      source: { kind: 'default' },
    });
    expect(s.general.theme).toEqual({
      value: 'system',
      default: 'system',
      source: { kind: 'default' },
    });
    expect(s.recycle.retentionDays).toEqual({ value: 7, default: 7, source: { kind: 'default' } });
    expect(s.recycle.maxFreePercent).toEqual({
      value: 25,
      default: 25,
      source: { kind: 'default' },
    });
    expect(s.plugins.callTimeoutMs).toEqual({
      value: DEFAULT_LIMITS.callTimeoutMs,
      default: DEFAULT_LIMITS.callTimeoutMs,
      source: { kind: 'default' },
    });
    expect(s.plugins.finishRunTimeoutMs).toEqual({
      value: DEFAULT_LIMITS.finishRunTimeoutMs,
      source: { kind: 'default' },
    });
    expect(s.queue.testEncodeKeepHours).toEqual({
      value: 2,
      default: 2,
      source: { kind: 'default' },
    });
    expect(s.queue.paused).toBe(false);
    expect(s.queue.lanes).toEqual([
      { id: 'encode', label: 'Encode' },
      { id: 'quick', label: 'Quick' },
    ]);
    expect(s.recycle.usage).toEqual({ files: 0, bytes: 0 });
    expect(s.about).toEqual({ version: '1.2.3', node: process.versions.node });
  });

  it('a row reads as source database', () => {
    setSetting(db, 'ui.theme', 'light', NOW);
    setSetting(db, 'server.name', 'Basement', NOW);
    setSetting(db, 'plugins.limits.finishRunTimeoutMs', 90_000, NOW);
    setSetting(db, 'queue.paused', true, NOW);
    const s = readSettings(deps);
    expect(s.general.theme).toEqual({
      value: 'light',
      default: 'system',
      source: { kind: 'database' },
    });
    expect(s.general.serverName.value).toBe('Basement');
    expect(s.general.serverName.source).toEqual({ kind: 'database' });
    expect(s.plugins.finishRunTimeoutMs).toEqual({ value: 90_000, source: { kind: 'database' } });
    expect(s.queue.paused).toBe(true);
  });

  it('a corrupt row reads as the default with source default, never throws, and warns once', () => {
    setSetting(db, 'ui.theme', 'blue', NOW);
    setSetting(db, 'recycle.retentionDays', -3, NOW);
    db.prepare("UPDATE settings SET value = 'not json' WHERE key = 'ui.theme'").run();
    const first = readSettings(deps);
    expect(first.general.theme).toEqual({
      value: 'system',
      default: 'system',
      source: { kind: 'default' },
    });
    expect(first.recycle.retentionDays.source).toEqual({ kind: 'default' });
    readSettings(deps);
    expect(warnings.filter((w) => JSON.stringify(w).includes('ui.theme'))).toHaveLength(1);
  });

  it('a corrupt test-encode retention row ("abc", 100, 1.5) reads as the default', () => {
    for (const bad of ['abc', 100, 1.5]) {
      setSetting(db, 'engine.testEncodeKeepHours', bad, NOW);
      expect(readSettings(deps).queue.testEncodeKeepHours, String(bad)).toEqual({
        value: 2,
        default: 2,
        source: { kind: 'default' },
      });
    }
  });

  it('a stored plugin timeout above its bound reads as the default, like loadLimits', () => {
    setSetting(db, 'plugins.limits.callTimeoutMs', 3_600_001, NOW);
    expect(readSettings(deps).plugins.callTimeoutMs.source).toEqual({ kind: 'default' });
  });

  it('env values: set when the variable was present at start, with its name', () => {
    const unset = readSettings(deps);
    expect(unset.queue.stallHours).toEqual({
      value: deps.config.healthStallHours,
      variable: 'TRANSCODA_HEALTH_STALL_HOURS',
      set: false,
    });
    expect(unset.general.publicUrl).toEqual({
      value: null,
      variable: 'TRANSCODA_PUBLIC_URL',
      set: false,
    });
    const set = readSettings(
      make({
        config: { healthStallHours: 2, publicUrl: 'https://t.example.net' },
        envSet: ['TRANSCODA_HEALTH_STALL_HOURS', 'TRANSCODA_PUBLIC_URL'],
      }),
    );
    expect(set.queue.stallHours).toEqual({
      value: 2,
      variable: 'TRANSCODA_HEALTH_STALL_HOURS',
      set: true,
    });
    expect(set.queue.minFreeGib).toMatchObject({
      variable: 'TRANSCODA_HEALTH_MIN_FREE_GIB',
      set: false,
    });
    expect(set.general.publicUrl).toMatchObject({ value: 'https://t.example.net', set: true });
  });

  it('allowed hosts list each host once, the first source winning', () => {
    setSetting(db, 'allowed_hosts', ['nas.lan', 'localhost'], NOW);
    const s = readSettings(make({ config: { allowedHosts: ['nas.lan', 'media.example'] } }));
    expect(s.general.allowedHosts).toEqual([
      { host: 'localhost', source: { kind: 'built-in' } },
      { host: '127.0.0.1', source: { kind: 'built-in' } },
      { host: '::1', source: { kind: 'built-in' } },
      { host: 'nas.lan', source: { kind: 'setup' } },
      { host: 'media.example', source: { kind: 'env', variable: 'TRANSCODA_ALLOWED_HOSTS' } },
    ]);
  });

  it('isolation mode follows the config', () => {
    const iso = { uid: 1, gid: 1, runDir: '/run/p', setprivPath: '/usr/bin/setpriv' };
    const mode = (c: Partial<Config>) => readSettings(make({ config: c })).plugins.isolation.mode;
    expect(mode({ pluginIsolation: iso, pluginIsolationOff: false })).toBe('separate-user');
    expect(mode({ pluginIsolation: null, pluginIsolationOff: true })).toBe('same-user');
    expect(mode({ pluginIsolation: null, pluginIsolationOff: false })).toBe('not-required');
  });

  it('recycle usage sums the recycled rows', () => {
    for (const [path, sizeBytes] of [
      ['/m/a.mkv', 1000],
      ['/m/b.mkv', 2500],
    ] as const) {
      insertRecycled(db, {
        path,
        libraryId: 'lib',
        jobId: 'job',
        sizeBytes,
        recycledAt: NOW.toISOString(),
      });
    }
    expect(readSettings(deps).recycle.usage).toEqual({ files: 2, bytes: 3500 });
  });

  it('never carries the secret key or the catalog token', () => {
    const json = JSON.stringify(readSettings(deps));
    expect(json).not.toContain(SECRET_HEX);
    expect(json).not.toContain(CATALOG_TOKEN);
  });
});

describe('updateSettings', () => {
  it('writes the row and answers the new value from the database', () => {
    const s = updateSettings(deps, { recycleRetentionDays: 14 });
    expect(s.recycle.retentionDays).toEqual({
      value: 14,
      default: 7,
      source: { kind: 'database' },
    });
    expect(readSettings(deps).recycle.retentionDays.value).toBe(14);
  });

  it('writes the test-encode retention and logs the field name', () => {
    const lines: unknown[] = [];
    const d = { ...deps, log: { info: (e: unknown) => void lines.push(e), warn() {}, error() {} } };
    const s = updateSettings(d as SettingsDeps, { testEncodeKeepHours: 6 });
    expect(s.queue.testEncodeKeepHours).toEqual({
      value: 6,
      default: 2,
      source: { kind: 'database' },
    });
    expect(lines).toEqual([{ msg: 'settings changed', fields: ['testEncodeKeepHours'] }]);
  });

  it('maps every field to its row key', () => {
    updateSettings(deps, {
      serverName: 'Basement',
      theme: 'dark',
      recycleRetentionDays: 3,
      recycleMaxFreePercent: 40,
      pluginCallTimeoutMs: 5000,
      testEncodeKeepHours: 0,
    });
    const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
    expect(rows).toEqual([
      { key: 'engine.testEncodeKeepHours', value: '0' },
      { key: 'plugins.limits.callTimeoutMs', value: '5000' },
      { key: 'recycle.maxFreePercent', value: '40' },
      { key: 'recycle.retentionDays', value: '3' },
      { key: 'server.name', value: '"Basement"' },
      { key: 'ui.theme', value: '"dark"' },
    ]);
  });

  it('an empty or null server name removes the row', () => {
    updateSettings(deps, { serverName: 'Basement' });
    updateSettings(deps, { serverName: '' });
    expect(db.prepare("SELECT 1 FROM settings WHERE key = 'server.name'").get()).toBeUndefined();
    updateSettings(deps, { serverName: 'Attic' });
    const s = updateSettings(deps, { serverName: null });
    expect(db.prepare("SELECT 1 FROM settings WHERE key = 'server.name'").get()).toBeUndefined();
    expect(s.general.serverName).toEqual({
      value: null,
      default: null,
      source: { kind: 'default' },
    });
  });

  it('applies the plugin call timeout live, once, and only when it is in the change', () => {
    updateSettings(deps, { theme: 'light', recycleMaxFreePercent: 10 });
    expect(applyLimits).not.toHaveBeenCalled();
    updateSettings(deps, { pluginCallTimeoutMs: 5000 });
    expect(applyLimits).toHaveBeenCalledTimes(1);
    expect(applyLimits).toHaveBeenCalledWith({ callTimeoutMs: 5000 });
  });

  it('logs the changed field names, never the values', () => {
    const lines: unknown[] = [];
    const d = { ...deps, log: { info: (e: unknown) => void lines.push(e), warn() {}, error() {} } };
    updateSettings(d as SettingsDeps, { serverName: 'Secret basement', theme: 'dark' });
    expect(lines).toEqual([{ msg: 'settings changed', fields: ['serverName', 'theme'] }]);
  });

  it('writes nothing when one write fails (one transaction)', () => {
    db.exec(
      "CREATE TRIGGER no_theme BEFORE INSERT ON settings WHEN NEW.key = 'ui.theme' BEGIN SELECT RAISE(ABORT, 'nope'); END",
    );
    expect(() => updateSettings(deps, { recycleRetentionDays: 9, theme: 'dark' })).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM settings').get()).toEqual({ n: 0 });
    expect(applyLimits).not.toHaveBeenCalled();
  });
});

describe('readAppearance', () => {
  it('theme and server name from the rows, defaults otherwise', () => {
    expect(readAppearance(db)).toEqual({ theme: 'system', serverName: null });
    setSetting(db, 'ui.theme', 'light', NOW);
    setSetting(db, 'server.name', 'Basement', NOW);
    expect(readAppearance(db)).toEqual({ theme: 'light', serverName: 'Basement' });
    setSetting(db, 'ui.theme', 'blue', NOW);
    expect(readAppearance(db).theme).toBe('system');
  });
});
