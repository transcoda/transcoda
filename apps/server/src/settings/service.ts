import {
  type Capabilities,
  EncodeDeviceSchema,
  GpuIdSchema,
  type SettingSource,
  type Settings,
  type SettingsUpdateInput,
  TEST_ENCODE_KEEP_HOURS_MAX,
  type Theme,
  ThemeSchema,
} from '@transcoda/contract';
import { DEFAULT_LIMITS } from '@transcoda/shared';
import { type ZodType, z } from 'zod';
import {
  devicePlan,
  encodeSlots,
  gpuLabel,
  orderGpus,
  parseEncodeDevice,
} from '../capabilities/devices.ts';
import type { Config } from '../config.ts';
import type { Database } from '../db/open.ts';
import { recycledTotals } from '../db/repos/jobs.ts';
import {
  deleteSetting,
  getSetting,
  SETTING_DEFAULTS,
  SETTING_KEYS,
  type SettingKey,
  setSetting,
} from '../db/repos/settings.ts';
import { findVersion, listWorkflows } from '../db/repos/workflows.ts';
import { ALWAYS_ALLOWED_HOSTS } from '../http/host-check.ts';
import type { Logger } from '../logger.ts';
import { LIMIT_BOUNDS } from '../plugins/limits.ts';

/**
 * Server settings: the rows of the key-value `settings` table a person may change in the UI, plus
 * the read-only values around them (env variables, built-in lanes, setup hosts), each with where it
 * comes from. Never a secret: only the fields of `SettingsSchema` are read here.
 */
export interface SettingsDeps {
  db: Database;
  config: Config;
  /** Names of TRANSCODA_* variables present in the environment at start (names only, never values). */
  envSet: ReadonlySet<string>;
  version: string;
  plugins: { applyLimits(p: { callTimeoutMs: number }): void };
  /** The startup probe (with the detected GPUs), for the encoding-device choices. */
  capabilities(): Capabilities;
  now(): Date;
  log: Logger;
}

/** How a stored row must look; a row that fails reads as the default (as the engine and loadLimits treat it). */
const ROW_SCHEMAS = {
  serverName: z.string().min(1),
  theme: ThemeSchema,
  recycleRetentionDays: z.number().min(0),
  recycleMaxFreePercent: z.number().min(0).max(100),
  pluginCallTimeoutMs: z.number().int().positive().max(LIMIT_BOUNDS.callTimeoutMs),
  testEncodeKeepHours: z.number().int().min(0).max(TEST_ENCODE_KEEP_HOURS_MAX),
  encodeDevice: EncodeDeviceSchema,
  gpuOrder: z.array(GpuIdSchema).max(16),
} satisfies Partial<Record<keyof typeof SETTING_KEYS, ZodType>>;

const FINISH_RUN_KEY = 'plugins.limits.finishRunTimeoutMs';
const ALLOWED_HOSTS_KEY = 'allowed_hosts';

/** Corrupt rows already reported, per database: a broken row is logged once, not on every read. */
const reported = new WeakMap<Database, Set<string>>();

function row<T>(
  db: Database,
  key: string,
  schema: ZodType<T>,
  log: Logger | null,
): { value: T; found: true } | { found: false } {
  try {
    const v = getSetting(db, key, schema);
    return v === null ? { found: false } : { value: v, found: true };
  } catch {
    if (log) {
      const seen = reported.get(db) ?? new Set<string>();
      reported.set(db, seen);
      if (!seen.has(key)) {
        seen.add(key);
        log.warn({ msg: 'settings row is not valid; using the default', key });
      }
    }
    return { found: false };
  }
}

function editable<K extends keyof typeof ROW_SCHEMAS>(
  deps: Pick<SettingsDeps, 'db' | 'log'>,
  field: K,
): {
  value: z.infer<(typeof ROW_SCHEMAS)[K]> | (typeof SETTING_DEFAULTS)[K];
  default: (typeof SETTING_DEFAULTS)[K];
  source: SettingSource;
} {
  const fallback = SETTING_DEFAULTS[field];
  const r = row(deps.db, SETTING_KEYS[field], ROW_SCHEMAS[field] as ZodType, deps.log);
  return r.found
    ? {
        value: r.value as z.infer<(typeof ROW_SCHEMAS)[K]>,
        default: fallback,
        source: { kind: 'database' },
      }
    : { value: fallback, default: fallback, source: { kind: 'default' } };
}

function fromEnv<T>(deps: SettingsDeps, variable: string, value: T) {
  return { value, variable, set: deps.envSet.has(variable) };
}

function allowedHosts(deps: SettingsDeps): Settings['general']['allowedHosts'] {
  const stored = row(deps.db, ALLOWED_HOSTS_KEY, z.array(z.string()), deps.log);
  const out: Settings['general']['allowedHosts'] = [];
  const seen = new Set<string>();
  const add = (host: string, source: SettingSource) => {
    if (seen.has(host)) return;
    seen.add(host);
    out.push({ host, source });
  };
  for (const h of ALWAYS_ALLOWED_HOSTS) add(h, { kind: 'built-in' });
  for (const h of stored.found ? stored.value : []) add(h.toLowerCase(), { kind: 'setup' });
  // config.ts already lowercases TRANSCODA_ALLOWED_HOSTS.
  for (const h of deps.config.allowedHosts)
    add(h, { kind: 'env', variable: 'TRANSCODA_ALLOWED_HOSTS' });
  return out;
}

/**
 * The "Encoding device" choices: auto, CPU only and each GPU detected (GPU 0 unnamed when ffmpeg
 * has NVENC but nvidia-smi listed none). A stored GPU that is gone is kept as a choice so the page
 * can show it, marked missing.
 */
function encodeDevices(caps: Capabilities, stored: string): Settings['queue']['encodeDevices'] {
  const out = [
    { id: 'auto', label: 'Auto', missing: false },
    { id: 'cpu', label: 'CPU only', missing: false },
  ];
  const all = caps.available ? (caps.gpus ?? []) : [];
  const nvidia = all.filter((g) => g.vendor === 'nvidia');
  for (const g of nvidia)
    out.push({ id: g.id, label: `GPU ${g.index} · ${g.name}`, missing: false });
  const zero = parseEncodeDevice('nvidia:0');
  if (nvidia.length === 0 && !devicePlan(caps, zero).missing) {
    out.push({ id: 'nvidia:0', label: 'GPU 0', missing: false });
  }
  for (const g of all.filter((x) => x.vendor === 'intel')) {
    out.push({ id: g.id, label: g.name, missing: false });
  }
  const setting = parseEncodeDevice(stored);
  if (
    (setting.kind === 'nvidia' || setting.kind === 'intel') &&
    !out.some((d) => d.id === stored)
  ) {
    const name = setting.kind === 'nvidia' ? `GPU ${setting.index}` : `Intel GPU ${setting.pci}`;
    out.push({ id: stored, label: `${name} (not found: encodes on the CPU)`, missing: true });
  }
  return out;
}

/**
 * Every GPU the order can name, in the effective order: the detected ones, then ids that are only
 * in the stored order (gone), marked missing.
 */
function queueGpus(caps: Capabilities, order: string[]): Settings['queue']['gpus'] {
  const detected = orderGpus(caps.available ? (caps.gpus ?? []) : [], order);
  const out: Settings['queue']['gpus'] = detected.map((g) => ({
    id: g.id,
    label: gpuLabel(g),
    vendor: g.vendor,
    missing: false,
  }));
  for (const id of order) {
    if (out.some((g) => g.id === id)) continue;
    out.push({
      id,
      label: `${id} (not found)`,
      vendor: id.startsWith('intel:') ? 'intel' : 'nvidia',
      missing: true,
    });
  }
  return out;
}

const VENDOR_ENCODER = /_(nvenc|qsv)$/;

/**
 * Workflows whose active version has a live Encode video node pinned to a vendor's encoder. Only
 * worth a hint when auto can use GPUs of two vendors; otherwise empty.
 */
function pinnedVendorWorkflows(
  db: Database,
  caps: Capabilities,
  order: string[],
): Settings['queue']['pinnedVendorWorkflows'] {
  const vendors = new Set(
    encodeSlots(caps, { kind: 'auto' }, order).map((s) => s.gpuId?.split(':')[0]),
  );
  if (vendors.size < 2) return [];
  const out: Settings['queue']['pinnedVendorWorkflows'] = [];
  for (const w of listWorkflows(db)) {
    if (w.kind !== 'workflow' || w.activeVersion === null) continue;
    const v = findVersion(db, w.id, w.activeVersion);
    if (!v?.ok) continue;
    for (const n of v.row.graph.nodes) {
      const encoder = (n.settings as { encoder?: unknown } | null)?.encoder;
      if (n.type !== 'core:encode-video' || n.bypassed) continue;
      if (typeof encoder === 'string' && VENDOR_ENCODER.test(encoder)) {
        out.push({ id: w.id, name: w.name, encoder });
        break;
      }
    }
  }
  return out;
}

/** The encode lane: one job, or one per GPU when the scheduler gives each GPU its own slot. */
function encodeLaneLabel(caps: Capabilities, stored: string, order: string[]): string {
  const n = encodeSlots(caps, parseEncodeDevice(stored), order).length;
  return n > 1 ? `Encode ×${n} (one per GPU)` : 'Encode';
}

function isolationMode(config: Config): Settings['plugins']['isolation']['mode'] {
  if (config.pluginIsolation !== null) return 'separate-user';
  if (config.pluginIsolationOff) return 'same-user';
  return 'not-required';
}

export function readSettings(deps: SettingsDeps): Settings {
  const { db, config } = deps;
  const encodeDevice = editable(deps, 'encodeDevice');
  const gpuOrder = editable(deps, 'gpuOrder');
  const paused = row(db, SETTING_KEYS.queuePaused, z.boolean(), deps.log);
  const finishRun = row(
    db,
    FINISH_RUN_KEY,
    z.number().int().positive().max(LIMIT_BOUNDS.finishRunTimeoutMs),
    deps.log,
  );
  return {
    general: {
      serverName: editable(deps, 'serverName'),
      theme: editable(deps, 'theme'),
      publicUrl: fromEnv(deps, 'TRANSCODA_PUBLIC_URL', config.publicUrl),
      allowedHosts: allowedHosts(deps),
    },
    queue: {
      paused: paused.found ? paused.value : SETTING_DEFAULTS.queuePaused,
      lanes: [
        {
          id: 'encode',
          label: encodeLaneLabel(deps.capabilities(), encodeDevice.value, gpuOrder.value),
        },
        { id: 'quick', label: 'Quick' },
      ],
      stallHours: fromEnv(deps, 'TRANSCODA_HEALTH_STALL_HOURS', config.healthStallHours),
      minFreeGib: fromEnv(deps, 'TRANSCODA_HEALTH_MIN_FREE_GIB', config.healthMinFreeGiB),
      testEncodeKeepHours: editable(deps, 'testEncodeKeepHours'),
      encodeDevice,
      encodeDevices: encodeDevices(deps.capabilities(), encodeDevice.value),
      gpuOrder,
      gpus: queueGpus(deps.capabilities(), gpuOrder.value),
      pinnedVendorWorkflows: pinnedVendorWorkflows(db, deps.capabilities(), gpuOrder.value),
    },
    recycle: {
      retentionDays: editable(deps, 'recycleRetentionDays'),
      maxFreePercent: editable(deps, 'recycleMaxFreePercent'),
      usage: recycledTotals(db),
    },
    plugins: {
      callTimeoutMs: editable(deps, 'pluginCallTimeoutMs'),
      finishRunTimeoutMs: finishRun.found
        ? { value: finishRun.value, source: { kind: 'database' } }
        : { value: DEFAULT_LIMITS.finishRunTimeoutMs, source: { kind: 'default' } },
      isolation: { mode: isolationMode(config), variable: 'TRANSCODA_PLUGIN_ISOLATION' },
    },
    about: { version: deps.version, node: process.versions.node },
  };
}

/** Field of the update input → its row key. Only these fields can ever be written. */
const FIELD_KEYS = {
  serverName: SETTING_KEYS.serverName,
  theme: SETTING_KEYS.theme,
  recycleRetentionDays: SETTING_KEYS.recycleRetentionDays,
  recycleMaxFreePercent: SETTING_KEYS.recycleMaxFreePercent,
  pluginCallTimeoutMs: SETTING_KEYS.pluginCallTimeoutMs,
  testEncodeKeepHours: SETTING_KEYS.testEncodeKeepHours,
  encodeDevice: SETTING_KEYS.encodeDevice,
  gpuOrder: SETTING_KEYS.gpuOrder,
} as const satisfies Record<keyof SettingsUpdateInput, SettingKey>;

/**
 * Writes the validated input (the contract schema) in one transaction, then applies the live
 * effects (the plugin call timeout) and logs the changed field names (never the values).
 */
export function updateSettings(deps: SettingsDeps, input: SettingsUpdateInput): Settings {
  const { db } = deps;
  const now = deps.now();
  const fields = (Object.keys(FIELD_KEYS) as (keyof SettingsUpdateInput)[]).filter(
    (f) => input[f] !== undefined,
  );
  db.transaction(() => {
    for (const field of fields) {
      const value = input[field];
      const key = FIELD_KEYS[field];
      if (field === 'serverName' && (value === null || value === '')) deleteSetting(db, key);
      else if (value !== undefined) setSetting(db, key, value, now);
    }
  })();
  if (input.pluginCallTimeoutMs !== undefined) {
    deps.plugins.applyLimits({ callTimeoutMs: input.pluginCallTimeoutMs });
  }
  deps.log.info({ msg: 'settings changed', fields });
  return readSettings(deps);
}

/** What every page needs before sign-in: the theme and the server name (defaults when unset or corrupt). */
export function readAppearance(db: Database): { theme: Theme; serverName: string | null } {
  const theme = row(db, SETTING_KEYS.theme, ThemeSchema, null);
  const name = row(db, SETTING_KEYS.serverName, ROW_SCHEMAS.serverName, null);
  return {
    theme: theme.found ? theme.value : SETTING_DEFAULTS.theme,
    serverName: name.found ? name.value : SETTING_DEFAULTS.serverName,
  };
}
