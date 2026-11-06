import { z } from 'zod';

/** A `recycled` entry's path: an original restores, a restore's set-aside output undoes it. */
export const RecycleRestoreInputSchema = z.object({ path: z.string().min(1) });

export const RecycleRestoreOutputSchema = z.object({
  jobId: z.string(),
  direction: z.enum(['restored', 'undone']),
  /** Subtitle files that stayed where they were, each as `<name> (<why>)`. */
  notRestored: z.array(z.string()),
});

export type RecycleRestoreInput = z.infer<typeof RecycleRestoreInputSchema>;
export type RecycleRestoreOutput = z.infer<typeof RecycleRestoreOutputSchema>;

/** One entry of a library's recycle folder. */
export const RecycledEntrySchema = z.object({
  path: z.string(),
  /** Where the file came from, relative to the library root. */
  relativePath: z.string(),
  kind: z.enum(['original', 'sidecar', 'restored-output']),
  sizeBytes: z.number().int(),
  jobId: z.string(),
  recycledAt: z.iso.datetime(),
  /** When retention removes it (recycledAt + retention days). */
  deletesAt: z.iso.datetime(),
});

export const RecycleListInputSchema = z.object({ libraryId: z.string().optional() });

export const RecycleListOutputSchema = z.object({
  /** Every library, in list order, with what its recycle folder holds. */
  libraries: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      files: z.number().int(),
      bytes: z.number().int(),
    }),
  ),
  /** The asked library; without one, the first with files (else the first); null when there are none. */
  library: z
    .object({
      id: z.string(),
      name: z.string(),
      folder: z.string(),
      totalBytes: z.number().int(),
      /** Free space on the folder's filesystem; null when it can't be read. */
      freeBytes: z.number().int().nullable(),
      retentionDays: z.number().int(),
      entries: z.array(RecycledEntrySchema),
    })
    .nullable(),
});

export const RecycleDeleteInputSchema = z.object({ path: z.string().min(1) });
export const RecycleDeleteOutputSchema = z.object({ bytes: z.number().int() });

export const RecycleEmptyInputSchema = z.object({
  libraryId: z.string(),
  /** The newest entry the person saw when confirming: anything recycled after it stays. */
  throughRecycledAt: z.iso.datetime(),
});
export const RecycleEmptyOutputSchema = z.object({
  removed: z.number().int(),
  bytes: z.number().int(),
  /** Entries left because a replace or restore of their job was under way. */
  skipped: z.number().int(),
});

export type RecycledEntry = z.infer<typeof RecycledEntrySchema>;
export type RecycleListOutput = z.infer<typeof RecycleListOutputSchema>;
export type RecycleEmptyOutput = z.infer<typeof RecycleEmptyOutputSchema>;
