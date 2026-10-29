import { DeviceProfileIdSchema } from '@transcoda/shared';
import { z } from 'zod';

/** `?deep=1` (or `true`) runs the deep check; absent is the plain liveness answer. */
export const HealthInputSchema = z.object({ deep: z.enum(['1', 'true']).optional() }).optional();
export type HealthInput = z.infer<typeof HealthInputSchema>;

const CheckSchema = z.enum(['ok', 'fail']);
/** Names and ok/fail only: the answer is public, so it never carries a path or a message. */
export const HealthChecksSchema = z.object({
  database: CheckSchema,
  ffmpeg: CheckSchema,
  scratchSpace: CheckSchema,
  queue: CheckSchema,
});
export type HealthChecksOutput = z.infer<typeof HealthChecksSchema>;

export const HealthOutputSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  checks: HealthChecksSchema.optional(),
});
export type HealthOutput = z.infer<typeof HealthOutputSchema>;

/**
 * A GPU found at startup; `id` is how the encoding-device setting names it (`nvidia:<index>`,
 * `intel:<pci address>`).
 */
export const GpuSchema = z.object({
  id: z.string(),
  vendor: z.enum(['nvidia', 'intel']),
  /**
   * NVIDIA: nvidia-smi's index; ffmpeg runs with CUDA_DEVICE_ORDER=PCI_BUS_ID, so CUDA uses the
   * same. Intel: the ordinal among Intel GPUs, display only (never an id).
   */
  index: z.number().int().nonnegative(),
  name: z.string(),
  /** Intel only, e.g. `/dev/dri/renderD128`. */
  renderNode: z.string().optional(),
  /** Intel only, e.g. `0000:07:00.0`. */
  pci: z.string().optional(),
});
export type Gpu = z.infer<typeof GpuSchema>;

/** One reading of a GPU's video engines, in percent. */
export const GpuLoadSampleSchema = z.object({
  at: z.iso.datetime(),
  encoder: z.number(),
  decoder: z.number(),
});
/** The last hour of video engine load per GPU (kept in memory; empty after a restart). */
export const GpuLoadOutputSchema = z.object({
  /** Time between samples. */
  intervalMs: z.number().int(),
  /**
   * GPUs with at least one sample: NVIDIA ones through nvidia-smi, Intel ones from the i915 fdinfo
   * of Transcoda's own encodes (none before the first). Empty without either.
   */
  gpus: z.array(
    z.object({
      /** The GPU's setting id (`nvidia:0`, `intel:<pci>`). */
      id: z.string(),
      /** Kept for older clients. */
      index: z.number().int(),
      name: z.string(),
      samples: z.array(GpuLoadSampleSchema),
    }),
  ),
});
export type GpuLoadOutput = z.infer<typeof GpuLoadOutputSchema>;

const ffmpegAvailable = z.object({
  available: z.literal(true),
  path: z.string(),
  version: z.string(),
  encoders: z.array(z.string()),
  hwaccels: z.array(z.string()),
  filters: z.array(z.string()),
  /** Absent from probes made before GPU detection (and in tests): none detected. */
  gpus: z.array(GpuSchema).optional(),
});
const ffmpegUnavailable = z.object({
  available: z.literal(false),
  path: z.string(),
  error: z.string(),
});

/** The startup ffmpeg probe, as the server keeps it. */
export const FfmpegCapabilitiesSchema = z.discriminatedUnion('available', [
  ffmpegAvailable,
  ffmpegUnavailable,
]);
/** The ffmpeg probe result (server side); the API answer adds `deviceProfiles`. */
export type Capabilities = z.infer<typeof FfmpegCapabilitiesSchema>;

export const DeviceProfileInfoSchema = z.object({ id: DeviceProfileIdSchema, name: z.string() });
export type DeviceProfileInfo = z.infer<typeof DeviceProfileInfoSchema>;

/** `system.capabilities`: the ffmpeg probe plus the device profiles (labels for `targets`). */
export const CapabilitiesSchema = z.discriminatedUnion('available', [
  ffmpegAvailable.extend({ deviceProfiles: z.array(DeviceProfileInfoSchema) }),
  ffmpegUnavailable.extend({ deviceProfiles: z.array(DeviceProfileInfoSchema) }),
]);
export type CapabilitiesOutput = z.infer<typeof CapabilitiesSchema>;

/** Why a backup was taken: before migrations, on a new build, or by "Back up now". */
export const BackupReasonSchema = z.enum(['migration', 'build', 'manual']);
export type BackupReason = z.infer<typeof BackupReasonSchema>;

/** One database backup: the file name only, never a server path. */
export const BackupSchema = z.object({
  name: z.string(),
  size: z.number().int().nonnegative(),
  createdAt: z.string(),
  reason: BackupReasonSchema,
});
export type Backup = z.infer<typeof BackupSchema>;

/** `system.backups.list`: newest first; `keep` is how many the server keeps. */
export const BackupsListOutputSchema = z.object({
  backups: z.array(BackupSchema),
  keep: z.number().int().positive(),
});
export type BackupsListOutput = z.infer<typeof BackupsListOutputSchema>;

/** One release's notes, as `pnpm release` writes them to `apps/server/src/changelog.json`. */
export const ReleaseNotesSchema = z.object({
  version: z.string(),
  /** `YYYY-MM-DD`. */
  date: z.string(),
  entries: z.array(
    z.object({ type: z.enum(['new', 'improved', 'fixed', 'breaking']), text: z.string() }),
  ),
});
export type ReleaseNotes = z.infer<typeof ReleaseNotesSchema>;

/** Whether a newer Transcoda release exists (notice only: the person updates their container). */
export const AppUpdateOutputSchema = z.object({
  /** The running version. */
  current: z.string(),
  /** False with TRANSCODA_UPDATE_CHECK=false or a build from source: GitHub is never asked. */
  checking: z.boolean(),
  /** The last successful check; null before the first (a minute after start). */
  checkedAt: z.iso.datetime().nullable(),
  update: z
    .object({
      version: z.string(),
      /** The release on GitHub. */
      url: z.string(),
      /** The full changelog. */
      changelogUrl: z.string(),
      /** The notes of the newest versions after the running one, newest first (empty when unread). */
      releases: z.array(ReleaseNotesSchema),
      /** Further missed versions, older than the ones in `releases`. */
      olderReleases: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type AppUpdateOutput = z.infer<typeof AppUpdateOutputSchema>;
