import { z } from 'zod';
import { PathStringSchema } from './libraries.ts';

/** The most folders one `fs.browseDirs` answer lists; more sets `truncated`. */
export const BROWSE_DIRS_MAX = 500;

export const FsBrowseDirsInputSchema = z.object({
  /** An absolute folder; '/' when absent. `..` is normalised away, symlinks are resolved. */
  path: PathStringSchema.refine((p) => p.startsWith('/'), {
    message: 'The path must be absolute',
  }).default('/'),
});

export const FsDirEntrySchema = z.object({
  name: z.string(),
  /** The folder's real path (a symlink shows its target), what to pass to browse it. */
  path: z.string(),
  /** False for a folder the app user can read but not write to: not a usable library root. */
  writable: z.boolean(),
});

export const FsBrowseDirsOutputSchema = z.object({
  /** The browsed folder's real path. */
  path: z.string(),
  /** False when the app user cannot write here: not a usable library root. */
  writable: z.boolean(),
  /** Null at '/'. */
  parent: z.string().nullable(),
  /** Readable sub-folders only (no files, no hidden names), sorted by name. */
  entries: z.array(FsDirEntrySchema),
  /** True when more than {@link BROWSE_DIRS_MAX} folders exist; the rest are not listed. */
  truncated: z.boolean(),
});

export type FsBrowseDirsOutput = z.infer<typeof FsBrowseDirsOutputSchema>;
export type FsDirEntry = z.infer<typeof FsDirEntrySchema>;
