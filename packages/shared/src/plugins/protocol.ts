import { z } from 'zod';
import { JsonValueSchema } from '../workflow/graph.ts';
import { HookEventNameSchema, PluginManifestSchema } from './types.ts';

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export const HOOK_NAMES = ['decide', 'build', 'finish', 'data', 'run'] as const;
export const HookNameSchema = z.enum(HOOK_NAMES);
export type HookName = z.infer<typeof HookNameSchema>;

const positiveInt = z.number().int().positive();
export const PluginLimitsSchema = z.strictObject({
  callTimeoutMs: positiveInt,
  finishRunTimeoutMs: positiveInt,
  testTimeoutMs: positiveInt,
  triggerTimeoutMs: positiveInt,
  hookTimeoutMs: positiveInt,
  fetchDefaultTimeoutMs: positiveInt,
  fetchMaxTimeoutMs: positiveInt,
  cacheEntries: positiveInt,
  cacheBytes: positiveInt,
});
export type PluginLimits = z.infer<typeof PluginLimitsSchema>;

/**
 * Credentials the server applies after it has put the real secret values back, so a plugin never
 * has to build (and the host never has to tokenize) a Basic header or a prefixed base64 value.
 */
export const FetchAuthSchema = z.union([
  z.strictObject({ basic: z.strictObject({ username: z.string(), password: z.string() }) }),
  z.strictObject({ bearer: z.string() }),
  z.strictObject({ header: z.strictObject({ name: z.string().min(1), value: z.string() }) }),
  z.strictObject({ query: z.strictObject({ name: z.string().min(1), value: z.string() }) }),
]);
export type FetchAuth = z.infer<typeof FetchAuthSchema>;

export const FetchInputSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.union([z.string(), JsonValueSchema]).optional(),
  timeoutMs: positiveInt.optional(),
  accept: z.enum(['json', 'text', 'none']).default('json'),
  auth: FetchAuthSchema.optional(),
});
export type FetchInput = z.infer<typeof FetchInputSchema>;

export const FetchOutputSchema = z.strictObject({
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  /** Parsed JSON, text, or null. */
  body: JsonValueSchema,
});
export type FetchOutput = z.infer<typeof FetchOutputSchema>;

export const FETCH_ERROR_KINDS = ['refused', 'timeout', 'rate-limited', 'failed'] as const;
export const FetchErrorKindSchema = z.enum(FETCH_ERROR_KINDS);
export type FetchErrorKind = z.infer<typeof FetchErrorKindSchema>;

const envelope = <T extends string>(type: T) => ({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string(),
  type: z.literal(type),
});

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...envelope('init'),
    /** Decrypted integration settings, {} when none. */
    settings: JsonValueSchema,
    limits: PluginLimitsSchema,
    dryRunDefaults: z.strictObject({}),
  }),
  z.strictObject({ ...envelope('settings'), settings: JsonValueSchema }),
  z.strictObject({
    ...envelope('validate'),
    /** null = the integration settings. */
    nodeType: z.string().nullable(),
    settings: JsonValueSchema,
  }),
  z.strictObject({
    ...envelope('migrate'),
    nodeType: z.string(),
    from: z.number().int(),
    settings: JsonValueSchema,
  }),
  z.strictObject({
    ...envelope('call'),
    hook: HookNameSchema,
    nodeType: z.string(),
    nodeVersion: z.number().int(),
    ctx: JsonValueSchema,
    settings: JsonValueSchema,
  }),
  z.strictObject({ ...envelope('test'), settings: JsonValueSchema }),
  z.strictObject({ ...envelope('trigger'), triggerId: z.string(), request: JsonValueSchema }),
  z.strictObject({ ...envelope('hook'), name: HookEventNameSchema, job: JsonValueSchema }),
  z.discriminatedUnion('ok', [
    z.strictObject({
      ...envelope('fetch-result'),
      ok: z.literal(true),
      response: FetchOutputSchema,
    }),
    z.strictObject({
      ...envelope('fetch-result'),
      ok: z.literal(false),
      error: z.strictObject({ kind: FetchErrorKindSchema, message: z.string() }),
    }),
  ]),
  /** Best effort: `id` is the id of the call to abandon; its fetches stop and its answer is dropped. */
  z.strictObject({ ...envelope('cancel') }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export const HostMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...envelope('ready'),
    manifest: PluginManifestSchema,
    /** NodeMetadata[] */
    nodes: z.array(JsonValueSchema),
    integration: z
      .object({
        settingsSchema: JsonValueSchema,
        allowedOrigins: z.array(z.string()),
        /** What the Plugins page shows; absent from older hosts. */
        id: z.string().optional(),
        title: z.string().optional(),
        requires: z.object({ product: z.string(), minVersion: z.string() }).nullable().optional(),
      })
      .nullable(),
    triggers: z.array(
      z.strictObject({
        id: z.string(),
        title: z.string(),
        description: z.string(),
        icon: z.string(),
        settingsSchema: JsonValueSchema,
        auth: JsonValueSchema,
      }),
    ),
  }),
  z.strictObject({ ...envelope('fatal'), reason: z.string() }),
  z.discriminatedUnion('ok', [
    z.strictObject({ ...envelope('result'), ok: z.literal(true), result: JsonValueSchema }),
    z.strictObject({
      ...envelope('result'),
      ok: z.literal(false),
      error: z.strictObject({ message: z.string(), retryable: z.boolean() }),
    }),
  ]),
  /**
   * `id` is the host's own request id; the server answers `fetch-result` with it. `callId` is the
   * id of the server message whose handling issued the fetch, or null outside any call (setup).
   * callId is a hint from an untrusted process; it only ever narrows what a fetch may do within
   * what the plugin already holds.
   */
  z.strictObject({
    ...envelope('fetch'),
    callId: z.string().max(128).nullable(),
    input: FetchInputSchema,
  }),
  z.strictObject({
    ...envelope('log'),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
    jobId: z.string().nullable(),
  }),
]);
export type HostMessage = z.infer<typeof HostMessageSchema>;

export type FetchFailure = { ok: false; error: { kind: FetchErrorKind; message: string } };
/** The `fetch-result` body. */
export type FetchResult = { ok: true; response: FetchOutput } | FetchFailure;
export type HostReady = Extract<HostMessage, { type: 'ready' }>;
export type HostResult = Extract<HostMessage, { type: 'result' }>;

export function messageBytes(m: unknown): number {
  return Buffer.byteLength(JSON.stringify(m));
}

export type ParseResult<T> = { ok: true; message: T } | { ok: false; parseError: string };

const MAX_PARSE_ERROR_CHARS = 500;

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
  let bytes: number;
  try {
    bytes = messageBytes(raw);
  } catch (e) {
    return {
      ok: false,
      parseError: `message is not serialisable: ${String(e)}`.slice(0, MAX_PARSE_ERROR_CHARS),
    };
  }
  if (bytes > MAX_MESSAGE_BYTES) {
    return {
      ok: false,
      parseError: `message is ${bytes} bytes, over the ${MAX_MESSAGE_BYTES} byte cap`,
    };
  }
  const r = schema.safeParse(raw);
  return r.success
    ? { ok: true, message: r.data }
    : { ok: false, parseError: r.error.message.slice(0, MAX_PARSE_ERROR_CHARS) };
}

export function parseServerMessage(raw: unknown): ParseResult<ServerMessage> {
  return parseWith(ServerMessageSchema, raw);
}

export function parseHostMessage(raw: unknown): ParseResult<HostMessage> {
  return parseWith(HostMessageSchema, raw);
}
