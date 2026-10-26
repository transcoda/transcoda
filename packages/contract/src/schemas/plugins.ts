import {
  JsonValueSchema,
  PathMappingSchema,
  PLUGIN_NAME_PATTERN,
  PluginManifestSchema,
  PluginStateSchema,
} from '@transcoda/shared';
import { z } from 'zod';
import { NodeKindSchema } from './nodes.ts';
import { WorkflowRefSchema } from './workflows.ts';

/**
 * How outputs show a stored secret; saving `{ set: true }` for a field keeps the stored value.
 * `endsWith` is the secret's last four characters, only for a secret long enough that they give
 * nothing useful away, so a person can tell which key is stored.
 */
export const SecretMarkerSchema = z.strictObject({
  set: z.boolean(),
  endsWith: z.string().length(4).optional(),
});

const PluginNameSchema = z.string().regex(PLUGIN_NAME_PATTERN);

/** Why the signed blocklist stops a plugin or build; null when it does not. */
export const BlockedSchema = z
  .object({ reason: z.string(), url: z.string().nullable() })
  .nullable();

const PluginTestKindSchema = z.enum([
  'unreachable',
  'unauthorized',
  'wrong-product',
  'too-old',
  'other',
]);

/** Never carries settings or secrets: those only travel through `plugins.settings*`. */
export const PluginSummarySchema = z.object({
  name: PluginNameSchema,
  version: z.string(),
  enabled: z.boolean(),
  state: PluginStateSchema,
  stateReason: z.string().nullable(),
  nextRestartAt: z.iso.datetime().nullable(),
  /** Set when the blocklist names the installed build (it is stopped, or refused when enabled). */
  blocked: BlockedSchema,
  nodes: z.array(z.string()),
  hasIntegration: z.boolean(),
  /** The newest compatible catalog version, when newer than the installed one. */
  updateAvailable: z.string().nullable(),
  catalogUrl: z.string().nullable(),
  installedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** The manifest's SVG icon; show it only as an image, never as markup. Null: none. */
  icon: z.string().nullable(),
  /** Workflows whose current or active version uses its nodes (`active`: the active one does). */
  usedBy: z.array(WorkflowRefSchema.extend({ active: z.boolean() })),
  /**
   * How the last stored connection test went (a save's test, or a test of the saved values);
   * never its message, which only `plugins.settingsGet` carries. Null: never tested.
   */
  lastTest: z
    .object({ at: z.iso.datetime(), ok: z.boolean(), kind: PluginTestKindSchema.nullable() })
    .nullable(),
});
export type PluginSummary = z.infer<typeof PluginSummarySchema>;

export const PluginIntegrationSchema = z.object({
  id: z.string(),
  title: z.string(),
  settingsSchema: JsonValueSchema,
  requires: z.object({ product: z.string(), minVersion: z.string() }).nullable(),
});

export const PluginTriggerSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  icon: z.string(),
});

export const PluginDetailSchema = PluginSummarySchema.extend({
  manifest: PluginManifestSchema,
  integration: PluginIntegrationSchema.nullable(),
  triggers: z.array(PluginTriggerSchema),
  provenance: z.object({
    sha256: z.string(),
    attestation: z.string().nullable(),
    coreTested: z.array(z.string()),
    /** Id of the key that verified the bundle at install; null: installed unsigned. */
    signedBy: z.string().nullable(),
  }),
});
export type PluginDetail = z.infer<typeof PluginDetailSchema>;

export const PluginsListOutputSchema = z.object({
  plugins: z.array(PluginSummarySchema),
  /**
   * Plugins that are not installed but whose nodes workflows use (by the `<plugin>:` prefix of
   * the node types), with those workflows; sorted by name.
   */
  missing: z.array(z.object({ name: PluginNameSchema, workflows: z.array(WorkflowRefSchema) })),
});

export const PluginNameInputSchema = z.object({ name: PluginNameSchema });
export const PluginInstallInputSchema = z.object({
  name: PluginNameSchema,
  version: z.string(),
  catalogUrl: z.url(),
});
export const PluginUpdateInputSchema = PluginNameInputSchema.extend({ version: z.string() });
export const PluginUpdateCheckOutputSchema = z.object({
  /**
   * Workflows whose active version (`version`) would stop running after the update: `dropped`,
   * the plugin no longer serves its node version; `behaviour`, its migration changes behaviour
   * and is held until a person reviews and activates a new version.
   */
  wouldBreak: z.array(
    WorkflowRefSchema.extend({
      active: z.boolean(),
      version: z.number().int(),
      reason: z.enum(['dropped', 'behaviour']),
    }),
  ),
  /** Workflows whose newest version, not the active one, is affected (it is written for review). */
  needsReview: z.array(WorkflowRefSchema),
  /** The release does not list the node versions it serves, so nothing could be checked. */
  unknown: z.boolean(),
});
export type PluginUpdateCheckOutput = z.infer<typeof PluginUpdateCheckOutputSchema>;
export const PluginRemoveInputSchema = PluginNameInputSchema.extend({ confirm: z.literal(true) });

export const PluginCatalogVersionSchema = z.object({
  version: z.string(),
  sdk: z.string(),
  /** Whether the running core satisfies this version's `sdk` range. */
  compatible: z.boolean(),
  coreTested: z.array(z.string()),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  attestation: z.string().nullable(),
  /** Url of the bundle's detached signature; null when the catalog carries none. */
  signature: z.string().nullable(),
  releasedAt: z.string(),
  /** Set when the blocklist names this build: it cannot be installed. */
  blocked: BlockedSchema,
});
export const PluginCatalogEntrySchema = z.object({
  name: PluginNameSchema,
  title: z.string(),
  description: z.string(),
  /** The newest compatible version, null when none is. */
  latest: z.string().nullable(),
  installed: z.string().nullable(),
  versions: z.array(PluginCatalogVersionSchema),
  /** The `latest` version's manifest icon (SVG; show it only as an image). Null: none or unknown. */
  icon: z.string().nullable(),
  /**
   * The nodes the `latest` version adds, from its manifest. Kind and title are null when the
   * manifest predates them; the list is empty when the manifest could not be read.
   */
  nodes: z.array(
    z.object({
      type: z.string(),
      kind: NodeKindSchema.nullable(),
      title: z.string().nullable(),
    }),
  ),
});
export const PluginCatalogOutputSchema = z.object({
  catalogs: z.array(
    z.object({
      catalogUrl: z.string(),
      official: z.boolean(),
      /** Verified against signing keys (false: an unsigned custom catalog). */
      signed: z.boolean(),
      /** Ids of the keys the catalog is verified with; empty when unsigned. */
      keyIds: z.array(z.string()),
      error: z.string().nullable(),
      fetchedAt: z.iso.datetime().optional(),
      plugins: z.array(PluginCatalogEntrySchema),
    }),
  ),
  /** The signed blocklist: where it comes from and how the last check went (fail-open: an error keeps the old list). */
  blocklist: z.object({
    url: z.string(),
    error: z.string().nullable(),
    fetchedAt: z.iso.datetime().nullable(),
    entries: z.number().int().nonnegative(),
  }),
});
export const PluginCatalogInputSchema = z.object({ refresh: z.boolean().default(false) });
export const PluginCatalogAddInputSchema = z.object({
  url: z.url(),
  /**
   * The keys the catalog is signed with, `<keyId>:<64 hex>` comma-separated (the format of
   * TRANSCODA_PLUGIN_CATALOG_KEY); omitted: an unsigned catalog.
   */
  signingKeys: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}:[0-9a-f]{64}(,[A-Za-z0-9._-]{1,64}:[0-9a-f]{64})*$/)
    .optional(),
});

/**
 * `message` and `warnings` are shown to the admin and stored: they must never contain a secret or
 * a request URL.
 */
export const PluginTestOutputSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    message: z.string(),
    version: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  }),
  z.object({
    ok: z.literal(false),
    kind: PluginTestKindSchema,
    message: z.string(),
  }),
]);
export type PluginTestOutput = z.infer<typeof PluginTestOutputSchema>;

export const PluginSettingsGetOutputSchema = z.object({
  /** Every secret is masked as a `SecretMarkerSchema` (`{ set: true }`), never its value. */
  settings: JsonValueSchema,
  lastTest: z.object({ at: z.iso.datetime(), result: PluginTestOutputSchema }).nullable(),
  /** A validation message when the stored settings no longer fit the plugin's schema. */
  needsReview: z.string().nullable(),
});
export type PluginSettingsGetOutput = z.infer<typeof PluginSettingsGetOutputSchema>;
/** A secret field sent as `{ set: true }` keeps the stored value; a string replaces it. */
export const PluginSettingsSaveInputSchema = PluginNameInputSchema.extend({
  settings: JsonValueSchema,
});
export const PluginSettingsTestInputSchema = PluginSettingsSaveInputSchema;

export const PathMappingTestInputSchema = PluginNameInputSchema.extend({
  mapping: PathMappingSchema,
});
/** `local` must be an existing directory under a library root. */
export const PathMappingTestOutputSchema = z.object({ ok: z.boolean(), message: z.string() });
