import { RunHoursSchema } from '@transcoda/shared';
import { z } from 'zod';

/** A filesystem path as the API takes it: never containing NUL (400 before any disk access). */
export const PathStringSchema = z
  .string()
  .refine((p) => !p.includes('\0'), { message: 'A path must not contain NUL' });

/** A library named by id and name (error data, read fields). */
export const LibraryRefSchema = z.object({ id: z.string(), name: z.string() });
/** A workflow version that takes (or would take) files from a library. */
const LibraryWorkflowVersionSchema = z.object({
  workflowId: z.string(),
  name: z.string(),
  version: z.number().int(),
});
/** The active workflow that takes files from this library; null: none. */
export const LibraryFeedsSchema = LibraryWorkflowVersionSchema.nullable();
/**
 * With no feeder: the live workflows whose newest version's Library input names this library but
 * is not active (activating it would make it the feeder), most recently edited first. Empty when
 * a workflow feeds the library.
 */
export const LibraryNamedByInactiveSchema = z.array(LibraryWorkflowVersionSchema);

export const LibrarySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The root's realpath. */
  path: z.string(),
  /**
   * Absolute; null means the default `<root>/.transcoda-recycle`. Every replace recycles the
   * original (recycling cannot be switched off in M1).
   */
  recycleFolder: z.string().nullable(),
  processHardlinked: z.boolean(),
  /** Verify decodes the whole output (not only its start and end) before replacing. */
  verifyFullDecode: z.boolean(),
  /**
   * When the library's automatic jobs ("Scan now", automatic scans: real runs its feeder chose)
   * may start, in the server's time zone; null: never set (no restriction). Manual runs always
   * start at once; a job already running when the window closes finishes.
   */
  runHours: RunHoursSchema.nullable(),
  feeds: LibraryFeedsSchema,
  namedByInactive: LibraryNamedByInactiveSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const LibrariesListOutputSchema = z.object({
  libraries: z.array(LibrarySchema),
  /** What the upgrade to library triggers changed (migration 0008), until dismissed. */
  notices: z.array(z.string()),
  /** The server's clock when the list was read: run hours are in its time zone. */
  clock: z.object({ now: z.iso.datetime(), timeZone: z.string() }),
});
/** The issue message for a `defaultWorkflowId` sent to create or update (a 400). */
export const REMOVED_DEFAULT_WORKFLOW =
  "defaultWorkflowId was removed: a workflow's Library input chooses its library";
/** Refuses the removed field with a message that says what replaced it. */
const RemovedDefaultWorkflowSchema = z.never({ error: REMOVED_DEFAULT_WORKFLOW }).optional();

export const LibraryIdInputSchema = z.object({ id: z.string() });
export const LibraryCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** An existing directory; stored as its realpath. */
  path: PathStringSchema.min(1),
  /**
   * Relative paths are under the root; null or absent: the default `<root>/.transcoda-recycle`.
   * Must be a folder strictly inside the root (else 400 LIBRARY_PATH_INVALID).
   */
  recycleFolder: PathStringSchema.min(1).nullable().optional(),
  processHardlinked: z.boolean().optional(),
  verifyFullDecode: z.boolean().optional(),
  runHours: RunHoursSchema.nullable().optional(),
  defaultWorkflowId: RemovedDefaultWorkflowSchema,
});
/** The root path cannot change; create another library instead. */
export const LibraryUpdateInputSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(120).optional(),
  /** null: back to the default `<root>/.transcoda-recycle`. Strictly inside the root (else 400). */
  recycleFolder: PathStringSchema.min(1).nullable().optional(),
  processHardlinked: z.boolean().optional(),
  verifyFullDecode: z.boolean().optional(),
  /** null: no restriction. */
  runHours: RunHoursSchema.nullable().optional(),
  defaultWorkflowId: RemovedDefaultWorkflowSchema,
});
export const LibraryBrowseInputSchema = z.object({
  id: z.string(),
  /** Relative to the library root; '' is the root. */
  path: PathStringSchema.default(''),
});
/** One folder for the file picker: sub-folder names and media files (names sorted). */
export const LibraryBrowseOutputSchema = z.object({
  dirs: z.array(z.string()),
  files: z.array(
    z.object({ name: z.string(), sizeBytes: z.number().int(), mtime: z.iso.datetime() }),
  ),
});

export type LibraryRef = z.infer<typeof LibraryRefSchema>;
export type LibraryFeeds = z.infer<typeof LibraryFeedsSchema>;
export type Library = z.infer<typeof LibrarySchema>;
export type LibrariesListOutput = z.infer<typeof LibrariesListOutputSchema>;
export type LibraryCreateInput = z.infer<typeof LibraryCreateInputSchema>;
export type LibraryUpdateInput = z.infer<typeof LibraryUpdateInputSchema>;
export type LibraryBrowseOutput = z.infer<typeof LibraryBrowseOutputSchema>;
