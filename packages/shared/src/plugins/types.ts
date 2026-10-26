import { z } from 'zod';

/** Finish actions run in this order: the write is `write`; plugin actions slot around it. */
export const FINISH_PHASES = [
  'gate',
  'write',
  'library-manager',
  'media-server',
  'notify',
] as const;
export type FinishPhase = (typeof FINISH_PHASES)[number];
export const FinishPhaseSchema = z.enum(FINISH_PHASES);

export function finishPhaseRank(p: FinishPhase): number {
  return FINISH_PHASES.indexOf(p);
}

/** restarting = crashed, backoff pending; stopped = gave up or fatal on start. */
export const PLUGIN_STATES = ['starting', 'running', 'restarting', 'stopped', 'disabled'] as const;
export type PluginState = (typeof PLUGIN_STATES)[number];
export const PluginStateSchema = z.enum(PLUGIN_STATES);

/** The catalog `name` and the `<plugin>:` prefix of node types. */
export const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/** Refused as plugin names: they would collide with `/plugins/catalog` and `/plugins/catalogs`. */
export const RESERVED_PLUGIN_NAMES = ['catalog', 'catalogs'] as const;

export const HOOK_EVENT_NAMES = ['onJobDone', 'onJobFailed', 'afterReplace'] as const;
export const HookEventNameSchema = z.enum(HOOK_EVENT_NAMES);
export type HookEventName = z.infer<typeof HookEventNameSchema>;

/** Longest icon accepted, in characters: an icon is a small mark, not a picture. */
export const PLUGIN_ICON_MAX_LENGTH = 16_384;

/**
 * SVG markup (an optional XML declaration, then `<svg`). Shown only as an image
 * (`<img src="data:image/svg+xml,…">`), where SVG cannot run scripts or load anything, never
 * inserted into the page as markup.
 */
export const PluginIconSchema = z
  .string()
  .max(PLUGIN_ICON_MAX_LENGTH)
  .regex(/^\s*(<\?xml[^>]*\?>\s*)?<svg[\s>]/, 'icon must be SVG markup')
  // A lone surrogate cannot be URI-encoded: the page could not turn the icon into an image.
  .refine((s) => s.isWellFormed(), 'icon must be well-formed text');

export const PluginManifestSchema = z.object({
  name: z
    .string()
    .regex(PLUGIN_NAME_PATTERN)
    .refine((n) => !(RESERVED_PLUGIN_NAMES as readonly string[]).includes(n), {
      message: 'plugin name is reserved',
    }),
  /** Semver; checked server-side. */
  version: z.string(),
  sdk: z.string().min(1),
  nodes: z.array(z.string()),
  /** Every node's current version and the migration links it serves; absent from older bundles. */
  nodeVersions: z
    .array(
      z.object({
        type: z.string(),
        version: z.number().int().positive(),
        migrations: z.array(
          z.object({
            from: z.number().int(),
            to: z.number().int(),
            risk: z.enum(['safe', 'behaviour']),
          }),
        ),
      }),
    )
    .optional(),
  /**
   * Every node's kind (a NODE_KINDS word) and title, so the catalog can show what a plugin adds
   * before it is installed; absent from older bundles.
   */
  nodeInfo: z.array(z.object({ type: z.string(), kind: z.string(), title: z.string() })).optional(),
  integration: z.string().nullable(),
  triggers: z.array(z.string()),
  hooks: z.array(HookEventNameSchema),
  /** The plugin's own icon; absent: the UI shows a monogram. */
  icon: PluginIconSchema.optional(),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const PathMappingSchema = z.object({
  remote: z.string().startsWith('/'),
  local: z.string().startsWith('/'),
});
export type PathMapping = z.infer<typeof PathMappingSchema>;

export const SECRET_PLACEHOLDER = '[redacted]';

export interface SupervisorLimits {
  callTimeoutMs: number;
  finishRunTimeoutMs: number;
  testTimeoutMs: number;
  triggerTimeoutMs: number;
  hookTimeoutMs: number;
  startTimeoutMs: number;
  heapMb: number;
  rssMb: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  stableMs: number;
  maxCrashes: number;
  crashWindowMs: number;
  fetchDefaultTimeoutMs: number;
  fetchMaxTimeoutMs: number;
  fetchConcurrency: number;
  fetchPerSecond: number;
  fetchBodyBytes: number;
  cacheEntries: number;
  cacheBytes: number;
  /** Plugin host processes that may run at once; a start past it is refused (the plugin is `stopped`). */
  maxHosts: number;
  /** After a call is cancelled, how long the host gets to finish it before it is killed (never past the call's timeout). */
  cancelGraceMs: number;
}

export const DEFAULT_LIMITS: SupervisorLimits = {
  callTimeoutMs: 30_000,
  finishRunTimeoutMs: 300_000,
  testTimeoutMs: 20_000,
  triggerTimeoutMs: 5_000,
  hookTimeoutMs: 30_000,
  startTimeoutMs: 60_000,
  heapMb: 128,
  rssMb: 256,
  backoffMinMs: 1_000,
  backoffMaxMs: 60_000,
  stableMs: 300_000,
  maxCrashes: 3,
  crashWindowMs: 600_000,
  fetchDefaultTimeoutMs: 15_000,
  fetchMaxTimeoutMs: 300_000,
  fetchConcurrency: 2,
  fetchPerSecond: 10,
  fetchBodyBytes: 16_777_216,
  cacheEntries: 1_000,
  cacheBytes: 8_388_608,
  maxHosts: 16,
  cancelGraceMs: 5_000,
};

export interface FetchPolicy {
  /** Resolved origins. */
  allowedOrigins: string[];
  allowInsecureTls: boolean;
}
