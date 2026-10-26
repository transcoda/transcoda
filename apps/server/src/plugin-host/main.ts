// The plugin host: one process per enabled plugin, forked by the server under Node's permission
// model (no fs, child_process, worker, addon, wasi or inspector). argv: [bundlePath]; env: PATH and
// NODE_ENV only. Every message the host sends is redacted of the integration's secrets first.
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type AnyNodeDefinition,
  createCache,
  integrationMetadata,
  type LogLevel,
  nodeMetadata,
  type PluginCache,
  type PluginContext,
  parseSettings,
  pluginManifest,
  secretPaths,
  type TranscodaPlugin,
  triggerMetadata,
} from '@transcoda/sdk';
import {
  type FetchInput,
  type FetchResult,
  type HostMessage,
  type JsonValue,
  type PathMapping,
  PathMappingSchema,
  type PluginLimitsSchema,
  PROTOCOL_VERSION,
  parseServerMessage,
  SECRET_PLACEHOLDER,
  type ServerMessage,
} from '@transcoda/shared';
import { z } from 'zod';
import { createHostContext } from './context.ts';
import {
  capMessage,
  createFetchWaiters,
  errorResult,
  FETCH_TOO_LARGE,
  fetchTooLarge,
  okResult,
} from './messages.ts';
import {
  createRedactor,
  createTokenizer,
  redactJson,
  type SecretEntry,
  tokenizeJson,
} from './redact.ts';

/** `process.permission.drop` is not in @types/node 24.19.2. */
interface PermissionWithDrop {
  drop(scope: string, ref?: string): void;
}

type Limits = z.infer<typeof PluginLimitsSchema>;
type JsonObject = Record<string, JsonValue>;
type Hook = 'decide' | 'build' | 'finish' | 'data' | 'run';

const FATAL_EXIT_CODE = 70;
const MAX_MIGRATED_BYTES = 256 * 1024;
const bundlePath = process.argv[2] ?? '';
const ownEntry = fileURLToPath(import.meta.url);

let plugin: TranscodaPlugin | null = null;
let limits: Limits | null = null;
let settings: JsonObject = {};
let mappings: PathMapping[] = [];
let cache: PluginCache | null = null;
let redact: (text: string) => string = (text) => text;
/** The fetch channel's rewriting: secrets become tokens the server substitutes back. */
let tokenize: (text: string) => string = (text) => text;
let initialised = false;
let dying = false;
const fetches = createFetchWaiters();

function sendRaw(message: HostMessage): void {
  process.send?.(capMessage(message));
}

function send(message: HostMessage): void {
  sendRaw(message);
}

/** Sends `fatal`, then exits 70 once the message is flushed. */
function fatal(reason: string): void {
  if (dying) return;
  dying = true;
  const message: HostMessage = {
    v: PROTOCOL_VERSION,
    id: 'host',
    type: 'fatal',
    reason: redact(reason),
  };
  const exit = () => process.exit(FATAL_EXIT_CODE);
  if (typeof process.send !== 'function' || !process.connected) {
    exit();
    return;
  }
  try {
    process.send(capMessage(message), exit);
  } catch {
    exit();
  }
}

const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function toJson(value: unknown): JsonValue {
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue);
}

function asObject(value: JsonValue): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sendLog(level: LogLevel, message: string, jobId: string | null): void {
  send({ v: PROTOCOL_VERSION, id: 'log', type: 'log', level, message: redact(message), jobId });
}

interface CallState {
  id: string;
  /** Set by a `cancel` for this id: its fetches fail and its answer is dropped. */
  cancelled: boolean;
}

/** The server message being handled; follows unawaited work started by that handler. */
const currentCall = new AsyncLocalStorage<CallState>();
/** Calls whose handler has not finished yet. */
const inflight = new Map<string, CallState>();

let fetchCounter = 0;
async function sendFetch(input: FetchInput): Promise<FetchResult> {
  fetchCounter += 1;
  const id = `fetch-${fetchCounter}`;
  if (currentCall.getStore()?.cancelled === true) {
    return { ok: false, error: { kind: 'failed', message: 'the call was cancelled' } };
  }
  const clean = tokenizeJson(tokenize, toJson(input)) as FetchInput;
  const callId = currentCall.getStore()?.id ?? null;
  const message: HostMessage = { v: PROTOCOL_VERSION, id, type: 'fetch', callId, input: clean };
  if (fetchTooLarge(message)) return FETCH_TOO_LARGE;
  const answer = fetches.wait(id);
  send(message);
  return answer;
}

function contextFor(job: { id: string; attempt: number } | null, dryRun: boolean): PluginContext {
  if (limits === null) throw new Error('host is not initialised');
  cache ??= createCache({ entries: limits.cacheEntries, bytes: limits.cacheBytes });
  return createHostContext({
    settings,
    limits,
    mappings,
    sendFetch,
    sendLog,
    dryRun,
    job,
    cache,
  });
}

function jobOf(value: JsonValue | undefined): { id: string; attempt: number } | null {
  const o = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (o === null || typeof o.id !== 'string') return null;
  return { id: o.id, attempt: typeof o.attempt === 'number' ? o.attempt : 1 };
}

function integrationSchema(): JsonValue | null {
  return plugin?.integration ? integrationMetadata(plugin.integration).settingsSchema : null;
}

/** Secrets of candidate settings seen by `test`/`validate`; bounded, oldest dropped first. */
const MAX_EXTRA_SECRETS = 32;
const extraSecrets = new Map<string, string>();

function secretEntries(values: JsonObject): SecretEntry[] {
  const schema = integrationSchema();
  if (schema === null) return [];
  return secretPaths(schema).flatMap((path) => {
    const value = values[path];
    return typeof value === 'string' ? [{ path, value }] : [];
  });
}

function rememberCandidate(values: JsonObject): void {
  for (const { path, value } of secretEntries(values)) {
    extraSecrets.delete(value);
    extraSecrets.set(value, path);
    if (extraSecrets.size > MAX_EXTRA_SECRETS) {
      const oldest = extraSecrets.keys().next();
      if (!oldest.done) extraSecrets.delete(oldest.value);
    }
  }
  refreshRedactor();
}

function refreshRedactor(): void {
  const entries = [
    ...secretEntries(settings),
    ...[...extraSecrets].map(([value, path]) => ({ path, value })),
  ];
  redact = createRedactor(entries.map((e) => e.value));
  tokenize = createTokenizer(entries, redact);
}

function mappingsIn(values: JsonObject): PathMapping[] {
  const schema = integrationSchema() as { properties?: Record<string, JsonObject> } | null;
  return Object.entries(schema?.properties ?? {})
    .filter(([, s]) => s['x-transcoda'] === 'path-mappings')
    .flatMap(([key]) => {
      const r = z.array(PathMappingSchema).safeParse(values[key]);
      return r.success ? r.data : [];
    });
}

/** Applies new integration settings: parsed with the plugin's own zod, secrets and mappings re-read. */
function applySettings(incoming: JsonValue): void {
  // A rotated-out secret may still be in a plugin's memory or a cache: keep redacting it.
  rememberCandidate(settings);
  const parsed = plugin?.integration?.settings.safeParse(asObject(incoming));
  settings = parsed?.success ? (parsed.data as JsonObject) : asObject(incoming);
  mappings = mappingsIn(settings);
  cache = null;
  refreshRedactor();
}

function looksLikePlugin(d: unknown): d is TranscodaPlugin {
  if (d === null || typeof d !== 'object') return false;
  const p = d as Record<string, unknown>;
  return (
    typeof p.name === 'string' &&
    typeof p.version === 'string' &&
    typeof p.sdk === 'string' &&
    Array.isArray(p.nodes)
  );
}

function dropGrants(): void {
  const permission = process.permission as unknown as PermissionWithDrop | undefined;
  try {
    if (permission === undefined) throw new Error('the permission model is not enabled');
    permission.drop('fs.read', bundlePath);
    permission.drop('fs.read', ownEntry);
  } catch (e) {
    throw new Error(`could not drop fs.read: ${text(e)}`);
  }
}

function hardenGlobals(): void {
  (globalThis as { fetch: unknown }).fetch = () => {
    throw new Error('use ctx.fetch');
  };
  // `process.binding` is left alone on purpose: under --permission Node itself answers it with
  // ERR_ACCESS_DENIED (the sandbox suite asserts that); deleting it would turn the denial into a
  // TypeError and add nothing.
}

async function init(msg: Extract<ServerMessage, { type: 'init' }>): Promise<void> {
  limits = msg.limits;
  // Before the plugin's own top-level code runs, so it cannot capture the real fetch.
  hardenGlobals();
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(bundlePath).href)) as { default?: unknown };
  } catch (e) {
    return fatal(`could not load the plugin bundle: ${text(e)}`);
  }
  if (!looksLikePlugin(mod.default)) return fatal('bundle has no plugin default export');
  plugin = mod.default;
  try {
    dropGrants();
  } catch (e) {
    return fatal(text(e));
  }
  applySettings(msg.settings);
  let ready: HostMessage;
  try {
    await plugin.setup?.(contextFor(null, false));
    ready = {
      v: PROTOCOL_VERSION,
      id: msg.id,
      type: 'ready',
      manifest: pluginManifest(plugin),
      nodes: plugin.nodes.map((n) => toJson(nodeMetadata(n))),
      integration: plugin.integration
        ? {
            settingsSchema: integrationMetadata(plugin.integration).settingsSchema,
            allowedOrigins: plugin.integration.allowedOrigins,
            id: plugin.integration.id,
            title: plugin.integration.title,
            requires: plugin.integration.requires ?? null,
          }
        : null,
      triggers: (plugin.triggers ?? []).map((t) => {
        const m = triggerMetadata(t);
        return {
          id: m.id,
          title: m.title,
          description: m.description,
          icon: m.icon,
          settingsSchema: m.settingsSchema,
          auth: toJson(m.auth),
        };
      }),
    };
  } catch (e) {
    return fatal(`plugin setup failed: ${text(e)}`);
  }
  initialised = true;
  send(ready);
}

function issuesToText(issues: Array<{ path: string; message: string }>): string {
  return issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
}

function zodIssues(error: z.ZodError): string {
  return issuesToText(error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
}

function findNode(type: string): AnyNodeDefinition {
  const def = plugin?.nodes.find((n) => n.type === type);
  if (!def) throw new Error(`unknown node type ${type}`);
  return def;
}

/** Same chaining as workflows/upgrade.ts `chainBetween`; the host inlines no server code. */
function migrateSettings(def: AnyNodeDefinition, from: number, values: JsonValue): JsonValue {
  const fail = () =>
    new Error(`no migration path from v${from} to v${def.version} for ${def.type}`);
  if (!Number.isInteger(from) || from > def.version) throw fail();
  let current = from;
  let result = values;
  while (current < def.version) {
    const candidates = (def.migrations ?? []).filter((m) => m.from === current);
    const step = candidates[0];
    if (candidates.length !== 1 || !step || step.to <= current || step.to > def.version) {
      throw fail();
    }
    const next: unknown = step.migrate(structuredClone(result));
    if (
      next !== null &&
      typeof next === 'object' &&
      typeof (next as { then?: unknown }).then === 'function'
    ) {
      throw new Error(
        `migration v${step.from} to v${step.to} of ${def.type} returned a promise: migrations must be synchronous`,
      );
    }
    result = next as JsonValue;
    current = step.to;
  }
  return result;
}

function hookContext(raw: JsonValue): Record<string, unknown> {
  const base = asObject(raw);
  const job = jobOf(base.job);
  const pluginCtx = contextFor(job, base.dryRun === true);
  return { ...base, log: (m: string) => sendLog('info', m, job?.id ?? null), plugin: pluginCtx };
}

async function handle(msg: ServerMessage): Promise<JsonValue> {
  if (plugin === null) throw new Error('host is not initialised');
  switch (msg.type) {
    case 'settings':
      applySettings(msg.settings);
      return null;
    case 'validate': {
      if (msg.nodeType === null) {
        if (!plugin.integration) throw new Error('plugin has no integration');
        const candidate = asObject(msg.settings);
        rememberCandidate(candidate);
        const r = plugin.integration.settings.safeParse(candidate);
        if (r.success) {
          const value = asObject(toJson(r.data));
          // The answer never carries a secret value, not even the one the caller just sent.
          for (const { path } of secretEntries(value)) value[path] = SECRET_PLACEHOLDER;
          return { ok: true, value };
        }
        return {
          ok: false,
          issues: r.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
            missing: false,
          })),
        };
      }
      return toJson(parseSettings(findNode(msg.nodeType), msg.settings));
    }
    case 'call': {
      const def = findNode(msg.nodeType);
      const hook: Hook = msg.hook;
      const fn = def[hook];
      if (typeof fn !== 'function') throw new Error(`${def.type} has no ${hook} hook`);
      const incoming =
        msg.nodeVersion === def.version
          ? msg.settings
          : migrateSettings(def, msg.nodeVersion, msg.settings);
      const parsed = parseSettings(def, incoming);
      if (!parsed.ok) throw new Error(`invalid settings: ${issuesToText(parsed.issues)}`);
      const result = await (fn as (ctx: unknown, s: unknown) => Promise<unknown>).call(
        def,
        hookContext(msg.ctx),
        parsed.value,
      );
      return toJson(result);
    }
    case 'migrate': {
      const def = findNode(msg.nodeType);
      const migrated = migrateSettings(def, msg.from, msg.settings);
      const parsed = parseSettings(def, migrated);
      if (!parsed.ok) {
        throw new Error(
          `migrated settings of ${def.type} are not valid for v${def.version}: ${issuesToText(parsed.issues)}`,
        );
      }
      const settings = toJson(parsed.value);
      if (JSON.stringify(settings).length > MAX_MIGRATED_BYTES) {
        throw new Error(`migrated settings of ${def.type} are larger than 256 KB`);
      }
      return { settings };
    }
    case 'test': {
      const integration = plugin.integration;
      if (!integration) throw new Error('plugin has no integration');
      // The candidate settings (maybe unsaved) are used for this call only; their secrets are
      // redacted from now on, the live settings stay as they were.
      const candidate = asObject(msg.settings);
      const parsed = integration.settings.safeParse(candidate);
      if (!parsed.success) throw new Error(`invalid settings: ${zodIssues(parsed.error)}`);
      rememberCandidate(candidate);
      const ctx = { ...contextFor(null, false), settings: parsed.data as JsonObject };
      return toJson(await integration.test(ctx));
    }
    case 'trigger': {
      const trigger = plugin.triggers?.find((t) => t.id === msg.triggerId);
      if (!trigger) throw new Error(`unknown trigger ${msg.triggerId}`);
      const request = asObject(msg.request);
      const parsedSettings = trigger.settings.safeParse(asObject(request.settings ?? {}));
      if (!parsedSettings.success) {
        throw new Error(`invalid settings: ${zodIssues(parsedSettings.error)}`);
      }
      const result = await trigger.handle(
        contextFor(null, false),
        request as never,
        parsedSettings.data,
      );
      return toJson(result);
    }
    case 'hook': {
      const fn = plugin.hooks?.[msg.name];
      if (typeof fn !== 'function') return null;
      const job = asObject(msg.job);
      await fn.call(plugin.hooks, contextFor(jobOf(job), job.dryRun === true), job as never);
      return null;
    }
    case 'cancel':
      return null;
    case 'init':
    case 'fetch-result':
      throw new Error(`unexpected ${msg.type}`);
  }
}

async function onMessage(raw: unknown): Promise<void> {
  const idOf = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined;
  const parsed = parseServerMessage(raw);
  if (!parsed.ok) {
    if (typeof idOf === 'string') {
      send(errorResult(idOf, redact(`invalid message: ${parsed.parseError}`)));
    }
    return;
  }
  const msg = parsed.message;
  if (msg.type === 'fetch-result') {
    fetches.settle(
      msg.id,
      msg.ok ? { ok: true, response: msg.response } : { ok: false, error: msg.error },
    );
    return;
  }
  if (msg.type === 'init') {
    if (initialised || plugin !== null) {
      send(errorResult(msg.id, 'host is already initialised'));
      return;
    }
    await init(msg);
    return;
  }
  if (!initialised) {
    send(errorResult(msg.id, 'host is not initialised: waiting for init'));
    return;
  }
  if (msg.type === 'cancel') {
    // `id` names the call to abandon; a cancel that names none still gets an answer (a ping).
    const target = inflight.get(msg.id);
    if (target) target.cancelled = true;
    else send(okResult(msg.id, null));
    return;
  }
  const state: CallState = { id: msg.id, cancelled: false };
  inflight.set(msg.id, state);
  try {
    const result = await currentCall.run(state, () => handle(msg));
    if (!state.cancelled) send(okResult(msg.id, redactJson(redact, result)));
  } catch (e) {
    if (!state.cancelled) send(errorResult(msg.id, redact(text(e))));
  } finally {
    inflight.delete(msg.id);
  }
}

process.on('uncaughtException', (e) => fatal(text(e)));
process.on('unhandledRejection', (e) => fatal(text(e)));
process.on('disconnect', () => process.exit(0));
process.on('message', (raw) => {
  onMessage(raw).catch((e: unknown) => fatal(text(e)));
});
