import { JobStateSchema, RUN_OUTCOME_KEYS } from '@transcoda/shared';
import { z } from 'zod';
import { ReplacedToSchema } from './jobs.ts';

export const RunSchema = z.object({
  id: z.string(),
  libraryId: z.string(),
  workflowId: z.string(),
  workflowVersion: z.number().int(),
  requestedPath: z.string(),
  dryRun: z.boolean(),
  /** Dry runs only: every job encodes, verifies and measures for real, then stops before the first write. */
  testEncode: z.boolean(),
  force: z.boolean(),
  /** Why the run is a dry run the request did not ask for; otherwise null. */
  note: z.string().nullable(),
  /** User id. */
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
});

const int = z.number().int();
/**
 * Per outcome (plus `queued` and `in_progress`); `total` is their sum. `dependsOnSize` is the part of `dry_run`
 * whose size gate decides after encoding (plan-only dry runs), not an outcome of its own.
 */
export const RunCountsSchema = z.object({
  ...Object.fromEntries(RUN_OUTCOME_KEYS.map((k) => [k, int])),
  total: int,
  beforeBytes: int,
  afterBytes: int,
  dependsOnSize: int,
} as Record<
  (typeof RUN_OUTCOME_KEYS)[number] | 'total' | 'beforeBytes' | 'afterBytes' | 'dependsOnSize',
  typeof int
>);

export const RunSummarySchema = z.object({
  run: RunSchema,
  workflowName: z.string(),
  libraryName: z.string(),
  counts: RunCountsSchema,
});
export const RunDetailSchema = RunSummarySchema.extend({
  /** Every job of the run, in queue order. */
  files: z.array(
    z.object({
      jobId: z.string(),
      /** This job's own version; differs from the run's after a re-pin. */
      workflowVersion: int,
      fileName: z.string(),
      filePath: z.string(),
      state: JobStateSchema,
      reason: z.string().nullable(),
      beforeBytes: int.nullable(),
      afterBytes: int.nullable(),
      replacedTo: ReplacedToSchema.nullable(),
      /**
       * Dry runs only: the engine's estimate of the output size (from past results of the
       * workflow); null for a real run and when there is no estimate.
       */
      estimatedBytes: int.nullable(),
      /** Dry runs only: one line of what the plan would do; null for a real run or no plan. */
      planSummary: z.string().nullable(),
      /** A plan-only dry run decided by its size gate after encoding; null otherwise. */
      dependsOnSize: z.object({ minSavingPercent: z.number() }).nullable(),
    }),
  ),
});
export const RunsListInputSchema = z.object({ limit: int.min(1).max(200).default(50) });
export const RunsListOutputSchema = z.object({ runs: z.array(RunSummarySchema) });
export const RunIdInputSchema = z.object({ id: z.string() });

export type Run = z.infer<typeof RunSchema>;
export type RunCounts = z.infer<typeof RunCountsSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type RunDetail = z.infer<typeof RunDetailSchema>;
