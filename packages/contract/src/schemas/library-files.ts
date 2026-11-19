import { z } from 'zod';
import { JOBS_LIST_MAX, JobMediaSchema, JobProbeSchema, JobSchema } from './jobs.ts';
import { SeasonParamSchema } from './libraries.ts';

/** The most shows and movies one titles page returns. */
export const LIBRARY_TITLES_MAX = 120;
/** The most files one files page returns (the server's own cap, repeated like JOBS_LIST_MAX). */
export const LIBRARY_FILES_MAX = 200;

/** The job whose poster a card shows: `id` is that job's id, so `GET /jobs/{id}/poster` serves it. */
export const PosterRefSchema = z.object({ id: z.string(), media: JobMediaSchema });
export type PosterRef = z.infer<typeof PosterRefSchema>;

/** A restored replace counts as `other`. */
export const OutcomeCountsSchema = z.object({
  replaced: z.number().int(),
  kept: z.number().int(),
  failed: z.number().int(),
  other: z.number().int(),
});
export type OutcomeCounts = z.infer<typeof OutcomeCountsSchema>;

export const FileSortSchema = z.enum(['title', 'size', 'lastRun', 'result']);
export type FileSort = z.infer<typeof FileSortSchema>;

export const LibraryTitlesInputSchema = z.object({
  id: z.string(),
  search: z.string().max(200).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(LIBRARY_TITLES_MAX).default(60),
});
export const LibraryTitleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('show'),
    key: z.string(),
    title: z.string(),
    year: z.number().int().nullable(),
    poster: PosterRefSchema.nullable(),
    episodes: z.number().int(),
    seasons: z.number().int(),
    outcomes: OutcomeCountsSchema,
    savedBytes: z.number().int(),
  }),
  z.object({
    type: z.literal('movie'),
    fileId: z.string(),
    poster: PosterRefSchema.nullable(),
    latest: JobSchema,
  }),
]);
export const LibraryTitlesOutputSchema = z.object({
  items: z.array(LibraryTitleSchema),
  total: z.number().int(),
});
export type LibraryTitle = z.infer<typeof LibraryTitleSchema>;
export type LibraryTitlesOutput = z.infer<typeof LibraryTitlesOutputSchema>;

export const LibrarySeasonsInputSchema = z.object({ id: z.string(), show: z.string() });
export const LibrarySeasonsOutputSchema = z.object({
  title: z.string(),
  year: z.number().int().nullable(),
  seasons: z.array(
    z.object({
      season: z.union([z.number().int(), z.literal('none')]),
      episodes: z.number().int(),
      poster: PosterRefSchema.nullable(),
      outcomes: OutcomeCountsSchema,
      savedBytes: z.number().int(),
    }),
  ),
});
export type LibrarySeasonsOutput = z.infer<typeof LibrarySeasonsOutputSchema>;

export const LibraryFilesInputSchema = z
  .object({
    id: z.string(),
    show: z.string().optional(),
    season: SeasonParamSchema.optional(),
    search: z.string().max(200).optional(),
    sort: FileSortSchema.default('title'),
    desc: z.boolean().default(false),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(LIBRARY_FILES_MAX).default(100),
  })
  // A season alone would also match movies (no season), so it only means something within a show.
  .refine((v) => v.season === undefined || v.show !== undefined, {
    message: 'season needs show',
    path: ['season'],
  });
export type LibraryFilesInput = z.infer<typeof LibraryFilesInputSchema>;

export const LibraryFileSchema = z.object({
  id: z.string(),
  path: z.string(),
  fileName: z.string(),
  /** What is there now. */
  sizeBytes: z.number().int(),
  /** The original's size when the latest job replaced the file (restore not in effect). */
  originalBytes: z.number().int().nullable(),
  mtime: z.iso.datetime(),
  gone: z.boolean(),
  poster: PosterRefSchema.nullable(),
  latest: JobSchema,
});
export const LibraryFilesOutputSchema = z.object({
  files: z.array(LibraryFileSchema),
  total: z.number().int(),
});
export type LibraryFile = z.infer<typeof LibraryFileSchema>;
export type LibraryFilesOutput = z.infer<typeof LibraryFilesOutputSchema>;

export const LibraryFileInputSchema = z.object({
  id: z.string(),
  fileId: z.string(),
  jobsOffset: z.number().int().min(0).default(0),
  jobsLimit: z.number().int().min(1).max(JOBS_LIST_MAX).default(50),
});
export const LibraryFileDetailSchema = z.object({
  file: LibraryFileSchema,
  /**
   * The show page this file's episode belongs to, as the titles list keys it; null unless the
   * file's stored media says episode (a movie, or no job has media).
   */
  showKey: z.string().nullable(),
  /** The file's season in the season routes' form; null exactly when `showKey` is. */
  season: z.union([z.number().int(), z.literal('none')]).nullable(),
  /** The file as it is now. */
  now: JobProbeSchema.nullable(),
  /** The original, when the latest job replaced the file (restore not in effect). */
  before: JobProbeSchema.nullable(),
  /** Newest first. */
  jobs: z.array(JobSchema),
  jobsTotal: z.number().int(),
});
export type LibraryFileDetail = z.infer<typeof LibraryFileDetailSchema>;
