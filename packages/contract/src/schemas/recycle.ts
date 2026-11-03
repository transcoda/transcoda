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
