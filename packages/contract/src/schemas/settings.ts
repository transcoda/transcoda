import { LaneSchema } from '@transcoda/shared';
import { z } from 'zod';

export const ThemeSchema = z.enum(['system', 'dark', 'light']);
export type Theme = z.infer<typeof ThemeSchema>;

/** Where a value comes from; the UI words it (sourceText). */
export const SettingSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('default') }), // no DB row
  z.object({ kind: z.literal('database') }), // a settings row
  z.object({ kind: z.literal('env'), variable: z.string() }), // read-only
  z.object({ kind: z.literal('setup') }), // allowed host recorded at setup
  z.object({ kind: z.literal('built-in') }), // localhost etc., fixed lanes
]);
export type SettingSource = z.infer<typeof SettingSourceSchema>;

/** The longest "Test encodes kept for" may keep a test-encode output, in hours. */
export const TEST_ENCODE_KEEP_HOURS_MAX = 72;

/** An "Encoding device" value: `auto`, `cpu` or an NVIDIA GPU by its nvidia-smi index. */
export const EncodeDeviceSchema = z.string().regex(/^(auto|cpu|nvidia:\d{1,3})$/);

/** An editable value: what is used now, the default, and why. */
const editable = <T extends z.ZodType>(v: T) =>
  z.object({ value: v, default: v, source: SettingSourceSchema });
/** An env-only value: effective value (the default when unset), the variable, whether it is set. */
const fromEnv = <T extends z.ZodType>(v: T) =>
  z.object({ value: v, variable: z.string(), set: z.boolean() });

export const SettingsSchema = z.object({
  general: z.object({
    /** null: no name (the top bar shows none). */
    serverName: editable(z.string().nullable()),
    theme: editable(ThemeSchema),
    /** TRANSCODA_PUBLIC_URL */
    publicUrl: fromEnv(z.string().nullable()),
    allowedHosts: z.array(z.object({ host: z.string(), source: SettingSourceSchema })),
  }),
  queue: z.object({
    /** Changed through queue.pause / queue.resume, not settings.update. */
    paused: z.boolean(),
    /** Built in: encode, quick. */
    lanes: z.array(z.object({ id: LaneSchema, label: z.string() })),
    /** TRANSCODA_HEALTH_STALL_HOURS */
    stallHours: fromEnv(z.number()),
    /** TRANSCODA_HEALTH_MIN_FREE_GIB */
    minFreeGib: fromEnv(z.number()),
    /** "Test encodes kept for", hours; 0 deletes a test output right after measuring. */
    testEncodeKeepHours: editable(z.number()),
    /** "Encoding device": `auto`, `cpu` or `nvidia:<index>`; decoding follows it. */
    encodeDevice: editable(z.string()),
    /** Its choices: auto, CPU only, each detected GPU, and a stored GPU that is gone (`missing`). */
    encodeDevices: z.array(z.object({ id: z.string(), label: z.string(), missing: z.boolean() })),
  }),
  recycle: z.object({
    retentionDays: editable(z.number()),
    maxFreePercent: editable(z.number()),
    usage: z.object({ files: z.number().int(), bytes: z.number().int() }),
  }),
  plugins: z.object({
    callTimeoutMs: editable(z.number().int()),
    /** Read-only here. */
    finishRunTimeoutMs: z.object({ value: z.number().int(), source: SettingSourceSchema }),
    isolation: z.object({
      mode: z.enum(['separate-user', 'same-user', 'not-required']),
      variable: z.literal('TRANSCODA_PLUGIN_ISOLATION'),
    }),
  }),
  about: z.object({ version: z.string(), node: z.string() }),
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * The allow-list: only these fields, each validated; at least one. The server maps each field to
 * its settings row key; '' for serverName is stored as null.
 */
export const SettingsUpdateInputSchema = z
  .object({
    serverName: z
      .string()
      .trim()
      .max(64)
      .regex(/^[^\p{C}]*$/u)
      .nullable(),
    theme: ThemeSchema,
    recycleRetentionDays: z.number().int().min(0).max(3650),
    recycleMaxFreePercent: z.number().int().min(0).max(100),
    pluginCallTimeoutMs: z.number().int().min(1_000).max(3_600_000),
    testEncodeKeepHours: z.number().int().min(0).max(TEST_ENCODE_KEEP_HOURS_MAX),
    encodeDevice: EncodeDeviceSchema,
  })
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Nothing to change' });
export type SettingsUpdateInput = z.infer<typeof SettingsUpdateInputSchema>;
