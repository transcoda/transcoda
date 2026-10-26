// The settings half of the plugin service: what an admin saves, tests and reads for a plugin's
// integration. Secrets are stored only sealed (AES-GCM, see crypto.ts), opened only to hand to the
// plugin process and the fetch proxy, and never logged or returned.
import type { PluginSettingsGetOutput, PluginSummary, PluginTestOutput } from '@transcoda/contract';
import { secretPaths } from '@transcoda/sdk';
import type { FetchPolicy, JsonValue } from '@transcoda/shared';
import type { z } from 'zod';
import { type Database, openDatabase } from '../db/open.ts';
import {
  findPluginSettings,
  type PluginIntegration,
  type PluginLastTest,
  setLastTest,
  upsertPluginSettings,
} from '../db/repos/plugins.ts';
import type { Logger } from '../logger.ts';
import { serverSettingsSchema } from '../nodes/plugin-settings-schema.ts';
import { createRedactor } from '../plugin-host/redact.ts';
import {
  isEncrypted,
  maskSettings,
  openSettings,
  SettingsDecryptError,
  sealSettings,
} from './crypto.ts';
import { PluginServiceError } from './errors.ts';
import { resolveAllowedOrigins } from './fetch-proxy.ts';
import type { PluginSupervisor } from './supervisor.ts';

type JsonObject = Record<string, JsonValue>;

/** What the settings code needs to know about a plugin. */
export interface SettingsTarget {
  name: string;
  integration: PluginIntegration | null;
}

const MAX_TEST_TEXT = 500;

/**
 * Only a token-like secret shows its last four characters (`endsWith`): at least this long and
 * made of token characters. A short one or a passphrase (spaces, punctuation) only reads as set.
 */
const HINT_MIN_LENGTH = 20;
const TOKEN_LIKE = /^[A-Za-z0-9._~+/=-]+$/;

const isObject = (v: JsonValue | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isSetMarker = (v: JsonValue | undefined): boolean => isObject(v) && v.set === true;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function issuesText(issues: Array<{ path: string; message: string }>): string {
  return issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
}

/** The masked settings with `endsWith` on each secret whose opened value is long enough. */
function withHints(masked: JsonObject, opened: JsonObject): JsonObject {
  const out: JsonObject = { ...masked };
  for (const [key, value] of Object.entries(masked)) {
    const plain = opened[key];
    if (
      isSetMarker(value) &&
      typeof plain === 'string' &&
      plain.length >= HINT_MIN_LENGTH &&
      TOKEN_LIKE.test(plain)
    ) {
      out[key] = { set: true, endsWith: plain.slice(-4) };
    }
  }
  return out;
}

/** The fetch policy a plugin runs under: its declared origins resolved against its settings. */
export function policyOf(integration: PluginIntegration | null, settings: JsonObject): FetchPolicy {
  if (!integration) return { allowedOrigins: [], allowInsecureTls: false };
  return {
    allowedOrigins: resolveAllowedOrigins(integration.allowedOrigins, settings),
    allowInsecureTls: settings.allowInsecureTls === true,
  };
}

/** The stored settings, decrypted. An unreadable secret leaves the plain values and an error text. */
export function openStoredSettings(
  db: Database,
  secretKey: Buffer,
  name: string,
): { settings: JsonObject; error: string | null } {
  const stored = findPluginSettings(db, name)?.settings;
  if (!isObject(stored)) return { settings: {}, error: null };
  try {
    return { settings: openSettings(secretKey, name, stored), error: null };
  } catch (err) {
    const plain: JsonObject = {};
    for (const [k, v] of Object.entries(stored)) if (!isEncrypted(v)) plain[k] = v;
    return {
      settings: plain,
      error: err instanceof SettingsDecryptError ? err.message : 'stored settings cannot be opened',
    };
  }
}

/**
 * Dev plugins have no `plugins` row (the foreign key of `plugin_settings` needs one), and a dev
 * plugin is never persisted: its settings live in a private in-memory database with the same
 * table, for the life of the process.
 */
function openDevSettingsDb(): Database {
  const db = openDatabase(':memory:');
  db.exec(`CREATE TABLE plugin_settings (
    plugin_name TEXT PRIMARY KEY,
    settings_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_test_json TEXT
  )`);
  return db;
}

export interface PluginSettingsDeps {
  db: Database;
  /** Whether `name` is a dev plugin (settings kept in memory only). */
  isDev(name: string): boolean;
  secretKey: Buffer;
  supervisor: PluginSupervisor;
  now(): Date;
  log: Logger;
  /** Why the plugin's nodes cannot run now, or null. */
  unavailable(name: string): string | null;
}

export class PluginSettings {
  private devDb: Database | null = null;

  constructor(private readonly deps: PluginSettingsDeps) {}

  /** The database holding `name`'s settings. */
  private dbOf(name: string): Database {
    if (!this.deps.isDev(name)) return this.deps.db;
    this.devDb ??= openDevSettingsDb();
    return this.devDb;
  }

  /** Closes the in-memory dev settings database (service stop). */
  close(): void {
    this.devDb?.close();
    this.devDb = null;
  }

  /** The stored settings of a plugin, decrypted (for the service to hand to a starting process). */
  open(name: string): { settings: JsonObject; error: string | null } {
    return openStoredSettings(this.dbOf(name), this.deps.secretKey, name);
  }

  get(rec: SettingsTarget): PluginSettingsGetOutput {
    const name = rec.name;
    const integration = this.integrationOf(rec);
    const row = findPluginSettings(this.dbOf(name), name);
    const stored = row?.settings;
    let settings: JsonObject = isObject(stored) ? maskSettings(stored) : {};
    let needsReview: string | null = null;
    if (row !== null) {
      const { settings: opened, error } = this.open(name);
      needsReview = error ?? this.reviewMessage(integration, opened);
      settings = withHints(settings, opened);
    }
    return {
      settings,
      lastTest: row?.lastTest
        ? { at: row.lastTest.at, result: this.testOutputOf(row.lastTest) }
        : null,
      needsReview,
    };
  }

  /** How the last stored test went, without its message (the plugin list's status); null: none. */
  lastTest(name: string): PluginSummary['lastTest'] {
    const t = findPluginSettings(this.dbOf(name), name)?.lastTest;
    if (!t) return null;
    return { at: t.at, ok: t.ok, kind: t.ok ? null : (t.kind ?? 'other') };
  }

  /** A message when the stored values no longer fit the schema the installed version declares. */
  private reviewMessage(integration: PluginIntegration, opened: JsonObject): string | null {
    const issues = this.parseWith(integration, opened);
    return issues === null || issues.length === 0 ? null : `needs review: ${issuesText(issues)}`;
  }

  /**
   * zod issues of `values` against the persisted schema (paths and messages only); null when
   * unusable. Patterns and formats are the plugin's to check, never run here (ReDoS).
   */
  private parseWith(
    integration: PluginIntegration,
    values: JsonObject,
  ): Array<{ path: string; message: string; missing: boolean }> | null {
    let schema: z.ZodType;
    try {
      schema = serverSettingsSchema(integration.settingsSchema);
    } catch {
      return null;
    }
    const r = schema.safeParse(values);
    if (r.success) return [];
    return r.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
      missing: values[String(i.path[0] ?? '')] === undefined,
    }));
  }

  private testOutputOf(t: PluginLastTest): PluginTestOutput {
    return t.ok
      ? {
          ok: true,
          message: t.message,
          ...(t.version !== undefined ? { version: t.version } : {}),
          ...(t.warnings !== undefined ? { warnings: t.warnings } : {}),
        }
      : { ok: false, kind: t.kind ?? 'other', message: t.message };
  }

  private integrationOf(rec: SettingsTarget): PluginIntegration {
    if (!rec.integration) {
      throw new PluginServiceError('no-integration', `plugin ${rec.name} has no settings`);
    }
    return rec.integration;
  }

  /**
   * The plaintext a save or a test would apply: the form's values, with a secret sent as
   * `{ set: true }` (or left out) taking the stored value. Throws `settings-invalid` for a non-object.
   */
  private candidateOf(
    name: string,
    integration: PluginIntegration,
    input: JsonValue,
  ): { candidate: JsonObject; secretKeys: string[] } {
    if (!isObject(input)) {
      throw new PluginServiceError('settings-invalid', 'the settings are not valid', [
        { path: '', message: 'settings must be an object', missing: false },
      ]);
    }
    const secretKeys = secretPaths(integration.settingsSchema);
    const previous = this.open(name).settings;
    const candidate: JsonObject = { ...input };
    for (const key of secretKeys) {
      const v = input[key];
      if (v === undefined || isSetMarker(v)) {
        const old = previous[key];
        if (old === undefined) delete candidate[key];
        else candidate[key] = old;
      }
    }
    return { candidate, secretKeys };
  }

  async save(rec: SettingsTarget, input: JsonValue): Promise<PluginSettingsGetOutput> {
    const name = rec.name;
    {
      const integration = this.integrationOf(rec);
      const { candidate, secretKeys } = this.candidateOf(name, integration, input);
      const issues = await this.validate(name, integration, candidate);
      if (issues.length > 0) {
        throw new PluginServiceError('settings-invalid', 'the settings are not valid', issues);
      }
      const previous = findPluginSettings(this.dbOf(name), name)?.settings;
      let sealed: JsonObject;
      try {
        sealed = sealSettings(
          this.deps.secretKey,
          name,
          input as JsonObject,
          secretKeys,
          isObject(previous) ? previous : null,
        );
      } catch (err) {
        throw new PluginServiceError('settings-invalid', 'the settings are not valid', [
          { path: '', message: messageOf(err), missing: false },
        ]);
      }
      upsertPluginSettings(this.dbOf(name), name, sealed, this.deps.now());
      let opened: JsonObject;
      try {
        opened = openSettings(this.deps.secretKey, name, sealed);
      } catch (err) {
        // Stored, but unreadable with this key: say so rather than throw a bare error.
        throw new PluginServiceError('settings-invalid', 'the saved settings cannot be opened', [
          { path: '', message: messageOf(err), missing: false },
        ]);
      }
      try {
        await this.deps.supervisor.updateSettings(name, opened, policyOf(integration, opened));
      } catch (err) {
        // Saved; a plugin that is down picks the settings up on its next start.
        this.deps.log.warn({
          msg: 'plugin settings not delivered',
          plugin: name,
          error: messageOf(err),
        });
      }
      return this.get(rec);
    }
  }

  /** The plugin's own zod while it runs, else the persisted JSON Schema. */
  private async validate(
    name: string,
    integration: PluginIntegration,
    candidate: JsonObject,
  ): Promise<Array<{ path: string; message: string; missing: boolean }>> {
    if (this.deps.supervisor.status(name)?.state === 'running') {
      let answer: Awaited<ReturnType<PluginSupervisor['validate']>>;
      try {
        answer = await this.deps.supervisor.validate(name, null, candidate);
      } catch (err) {
        throw new PluginServiceError('not-running', messageOf(err));
      }
      if (!answer.ok) throw new PluginServiceError('not-running', answer.error.message);
      const result = answer.result as {
        ok?: boolean;
        issues?: Array<{ path: string; message: string; missing: boolean }>;
      } | null;
      return result?.ok === false ? (result.issues ?? []) : [];
    }
    return this.parseWith(integration, candidate) ?? [];
  }

  async test(rec: SettingsTarget, input: JsonValue): Promise<PluginTestOutput> {
    const name = rec.name;
    {
      const integration = this.integrationOf(rec);
      const { candidate, secretKeys } = this.candidateOf(name, integration, input);
      if (this.deps.supervisor.status(name)?.state !== 'running') {
        throw new PluginServiceError('not-running', this.deps.unavailable(name) ?? 'not running');
      }
      const secrets = secretKeys.flatMap((k) => {
        const v = candidate[k];
        return typeof v === 'string' && v !== '' ? [v] : [];
      });
      const redact = createRedactor([...secrets, ...this.openedSecrets(name, secretKeys)]);
      const clean = (text: string): string => redact(text).slice(0, MAX_TEST_TEXT);
      const out = await this.runTest(name, integration, candidate, clean);
      // Only the outcome is kept; the form's values never are.
      const lastTest: PluginLastTest = out.ok
        ? {
            ok: true,
            message: out.message,
            at: this.deps.now().toISOString(),
            ...(out.version !== undefined ? { version: out.version } : {}),
            ...(out.warnings !== undefined ? { warnings: out.warnings } : {}),
          }
        : { ok: false, kind: out.kind, message: out.message, at: this.deps.now().toISOString() };
      setLastTest(this.dbOf(name), name, lastTest, this.deps.now());
      return out;
    }
  }

  private openedSecrets(name: string, secretKeys: string[]): string[] {
    const stored = this.open(name).settings;
    return secretKeys.flatMap((k) => {
      const v = stored[k];
      return typeof v === 'string' && v !== '' ? [v] : [];
    });
  }

  private async runTest(
    name: string,
    integration: PluginIntegration,
    candidate: JsonObject,
    clean: (text: string) => string,
  ): Promise<PluginTestOutput> {
    let answer: Awaited<ReturnType<PluginSupervisor['test']>>;
    try {
      answer = await this.deps.supervisor.test(name, candidate, policyOf(integration, candidate));
    } catch (err) {
      return { ok: false, kind: 'other', message: clean(messageOf(err)) };
    }
    if (!answer.ok) return { ok: false, kind: 'other', message: clean(answer.error.message) };
    const r = answer.result as Record<string, JsonValue> | null;
    if (r !== null && r.ok === true && typeof r.message === 'string') {
      return {
        ok: true,
        message: clean(r.message),
        ...(typeof r.version === 'string' ? { version: clean(r.version) } : {}),
        ...(Array.isArray(r.warnings)
          ? { warnings: r.warnings.filter((w): w is string => typeof w === 'string').map(clean) }
          : {}),
      };
    }
    const kinds = ['unreachable', 'unauthorized', 'wrong-product', 'too-old', 'other'] as const;
    if (r !== null && r.ok === false && typeof r.message === 'string') {
      const kind = kinds.find((k) => k === r.kind) ?? 'other';
      return { ok: false, kind, message: clean(r.message) };
    }
    return {
      ok: false,
      kind: 'other',
      message: 'the plugin returned an answer that is not a test result',
    };
  }
}
