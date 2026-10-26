import { DEFAULT_LIMITS, type JsonValue } from '@transcoda/shared';
import type { ZodType } from 'zod';
import type { Database } from '../open.ts';

export function getSetting<T>(db: Database, key: string, schema: ZodType<T>): T | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? schema.parse(JSON.parse(row.value)) : null;
}

export function setSetting(db: Database, key: string, value: JsonValue, now: Date): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), now.toISOString());
}

/** Keys of the server's settings rows (engine, appearance, the editable plugin limit). */
export const SETTING_KEYS = {
  queuePaused: 'queue.paused',
  recycleRetentionDays: 'recycle.retentionDays',
  recycleMaxFreePercent: 'recycle.maxFreePercent',
  serverName: 'server.name',
  theme: 'ui.theme',
  pluginCallTimeoutMs: 'plugins.limits.callTimeoutMs',
  testEncodeKeepHours: 'engine.testEncodeKeepHours',
  encodeDevice: 'engine.encodeDevice',
} as const;
export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

/** Values used when a key has no row. */
export const SETTING_DEFAULTS = {
  queuePaused: false,
  recycleRetentionDays: 7,
  recycleMaxFreePercent: 25,
  serverName: null,
  theme: 'system',
  pluginCallTimeoutMs: DEFAULT_LIMITS.callTimeoutMs,
  /** Hours a test-encode output is kept (0: deleted right after measuring). */
  testEncodeKeepHours: 2,
  /** Where video is decoded and encoded: `auto`, `cpu` or `nvidia:<index>`. */
  encodeDevice: 'auto',
} as const satisfies Record<keyof typeof SETTING_KEYS, JsonValue>;

/** A typed setting, or `fallback` when the row is missing. */
export function getSettingOr<T>(db: Database, key: SettingKey, schema: ZodType<T>, fallback: T): T {
  return getSetting(db, key, schema) ?? fallback;
}

/** Removes a row: the key reads as its default again. */
export function deleteSetting(db: Database, key: SettingKey): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}
