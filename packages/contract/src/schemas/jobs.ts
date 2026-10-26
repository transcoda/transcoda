import {
  JobPlanSchema,
  JobStateSchema,
  LaneSchema,
  ProbeStreamSchema,
  ProbeSummarySchema,
  TraceEntrySchema,
  WorkflowGraphSchema,
} from '@transcoda/shared';
import { z } from 'zod';
import { PathStringSchema } from './libraries.ts';

/**
 * Where a verify stands. `checks`: the output probe, each stream end and each spot decode, `done`
 * of `total`; `full-decode`: the whole-file decode, measured by its time (the progress's percent,
 * speed and eta); `source`: re-decoding the source where the output failed (no measure).
 */
export const VerifyProgressSchema = z.object({
  stage: z.enum(['checks', 'full-decode', 'source']),
  done: z.number().int().nullable(),
  total: z.number().int().nullable(),
});

export const JobProgressSchema = z.object({
  percent: z.number().nullable(),
  outTimeSeconds: z.number(),
  speed: z.number().nullable(),
  fps: z.number().nullable(),
  sizeBytes: z.number().nullable(),
  etaSeconds: z.number().nullable(),
  /** Verifying only (absent while encoding). */
  verify: VerifyProgressSchema.optional(),
});

/**
 * Where the original went after a replace. Jobs always recycle in M1 (`recycle`). `deleted` only
 * appears for a replace that took the `.orig` path (no recycle folder: the `.orig` copy is removed
 * at the end) and was finished by the startup sweep from its journal.
 */
export const ReplacedToSchema = z.enum(['recycle', 'deleted']);

/** One job as the list shows it. */
export const JobSchema = z.object({
  id: z.string(),
  runId: z.string(),
  state: JobStateSchema,
  /**
   * User-paused (a secondary chip); the state stays what it was. A running ffmpeg is stopped and
   * its lane freed; outside ffmpeg the job waits before verify and before the finish actions
   * (keeping its lane). Always false in a final state.
   */
  paused: z.boolean(),
  /**
   * The lane the job runs in. A prepared job still waiting for it (state `building`, lane set)
   * is planned and waiting for that lane; it holds it from `encoding` on.
   */
  lane: LaneSchema.nullable(),
  attempt: z.number().int(),
  priority: z.number().int(),
  dryRun: z.boolean(),
  /** Dry runs only: encode, verify and measure for real, then stop before the first write. */
  testEncode: z.boolean(),
  fileName: z.string(),
  filePath: z.string(),
  libraryId: z.string(),
  libraryName: z.string(),
  workflowId: z.string(),
  /**
   * A waiting real job's value is provisional: it runs on the version active when it starts
   * (re-pinned then). Dry-run jobs keep theirs.
   */
  workflowVersion: z.number().int(),
  workflowName: z.string(),
  progress: JobProgressSchema.nullable(),
  queuedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  /** The one-line human reason (kept, failed, skipped, nothing to do, cancelled). */
  reason: z.string().nullable(),
  result: z
    .object({
      outcome: JobStateSchema,
      beforeBytes: z.number().int().nullable(),
      afterBytes: z.number().int().nullable(),
      replacedTo: ReplacedToSchema.nullable(),
    })
    .nullable(),
  /**
   * What went wrong after the write (a required plugin finish step failed, the server stopped
   * before the remaining steps): the job is still `done`. Empty when none.
   */
  problems: z.array(z.string()),
  /**
   * Dry runs only: the engine's estimate of the output size (from past results of the workflow);
   * null for a real run and when there is no estimate.
   */
  estimatedBytes: z.number().int().nullable(),
  /** Dry runs only: one line of what the plan would do; null for a real run or no plan. */
  planSummary: z.string().nullable(),
  /**
   * A plan-only dry run that ended `dry_run` with a size gate between the encode and the write:
   * it would replace only if the result saves at least `minSavingPercent`, decided after encoding
   * (a test-encode dry run measures it). Null otherwise.
   */
  dependsOnSize: z.object({ minSavingPercent: z.number() }).nullable(),
  /**
   * An automatic job waiting (queued, or prepared and waiting for its lane) because its library's
   * run hours are closed: it starts at `opensAt` (null: no hours are chosen, it never starts on
   * its own), shown in the server's `timeZone`. Null when nothing holds it back.
   */
  heldByRunHours: z
    .object({ opensAt: z.iso.datetime().nullable(), timeZone: z.string() })
    .nullable(),
});

export const JobResultSchema = z.object({
  outcome: JobStateSchema,
  beforeBytes: z.number().int().nullable(),
  afterBytes: z.number().int().nullable(),
  /** Dry runs: the estimated size of the output. */
  estimatedBytes: z.number().int().nullable(),
  /** The ffmpeg command line (null when nothing was encoded). */
  command: z.string().nullable(),
  replacedTo: ReplacedToSchema.nullable(),
  warnings: z.array(z.string()),
  /** Problems after the write, separate from `warnings`. */
  problems: z.array(z.string()),
});

/**
 * A probe as the job page shows it. Each stream carries its Matroska statistics bitrate
 * (`tagBitrateKbps`, kb/s: the `BPS` tag, else `NUMBER_OF_BYTES` over `DURATION`; null without
 * them). It is unchecked: a muxer that copies stream tags (ffmpeg does) keeps an older file's
 * statistics, so a screen trusts it only when it fits the file.
 */
export const JobProbeSchema = ProbeSummarySchema.extend({
  streams: z.array(ProbeStreamSchema.extend({ tagBitrateKbps: z.number().nullable() })),
});

/** One node of the file's path through the workflow and the file output it left by. */
export const WalkStepSchema = z.object({
  workflowPath: z.array(z.string()),
  nodeId: z.string(),
  port: z.string().nullable(),
});

export const JobDetailSchema = JobSchema.extend({
  trace: z.array(TraceEntrySchema),
  result: JobResultSchema.nullable(),
  probe: JobProbeSchema.nullable(),
  /**
   * The probe of the output verify read (a test-encode, a real run, a size gate that kept the
   * original after encoding); null when nothing was verified, when the job then failed or was
   * cancelled (that output was thrown away), and for results from before it was stored.
   */
  outputProbe: JobProbeSchema.nullable(),
  /**
   * The pinned workflow version's graph, for the trace view (webhook URLs shown as scheme and host
   * only); null when that version cannot be read. Redaction is conservative: a notify node's `url`,
   * any Run-node override of a `url` setting, and any Run-node override string that parses as an
   * http(s) URL (a media-server base URL too) are shown as `scheme://host/…`.
   */
  graph: WorkflowGraphSchema.nullable(),
  /** The build model per stream (dry-run plan table); null before Build. */
  plan: JobPlanSchema.nullable(),
  /** The path the walk took, in order (partial on a walk failure); [] before the walk. */
  path: z.array(WalkStepSchema),
  /** The kept output of a test-encode dry run until `keptUntil`; null when there is none. */
  testOutput: z
    .object({
      keptUntil: z.iso.datetime(),
      sizeBytes: z.number().int(),
      container: z.enum(['mkv', 'mp4']),
    })
    .nullable(),
  /**
   * Why the test output was not kept or went before its time (`not kept: scratch space low`,
   * `expired`, `deleted`, …); null when there is nothing to say.
   */
  testOutputNote: z.string().nullable(),
});

export const JobIdInputSchema = z.object({ id: z.string() });

export const JobsQueueInputSchema = z
  .object({
    /** A media file or a folder inside a library. */
    path: PathStringSchema.min(1),
    /** Default: the workflow that feeds the library (its active version's Library input). */
    workflowId: z.string().optional(),
    dryRun: z.boolean().default(false),
    /** Dry runs only: the version to plan with (default: the newest). A real run uses the active version. */
    workflowVersion: z.number().int().min(1).optional(),
    /** Queue files this workflow version already finished. */
    force: z.boolean().default(false),
    /**
     * One file only ("Run on a file"): a folder is refused (PATH_REJECTED "not a file"), so a real
     * run on a whole folder only comes from a scan.
     */
    fileOnly: z.boolean().default(false),
    priority: z.number().int().min(-10).max(10).default(0),
    /**
     * Dry runs only: encode, verify and measure for real, then stop before the first write.
     * Default: true when the path is one file, false for a folder.
     */
    testEncode: z.boolean().optional(),
  })
  .refine((i) => i.workflowVersion === undefined || i.dryRun, {
    message: 'a real run always uses the active version',
    path: ['workflowVersion'],
  })
  .refine((i) => i.testEncode !== true || i.dryRun, {
    message: 'only a dry run can test-encode',
    path: ['testEncode'],
  });
export const JobsQueueOutputSchema = z.object({
  runId: z.string(),
  jobIds: z.array(z.string()),
  /** What was queued (a real request becomes a dry run when no version is active). */
  dryRun: z.boolean(),
  /** 'no active version' when the request was turned into a dry run; otherwise null. */
  note: z.string().nullable(),
  /** The version the run was pinned to. */
  workflowVersion: z.number().int(),
  /** Whether the run test-encodes (always false for a real run). */
  testEncode: z.boolean(),
});

export const JOBS_LIST_MAX = 200;
export const JobsListInputSchema = z.object({
  runId: z.string().optional(),
  libraryId: z.string().optional(),
  /** One state, or several (repeat the query parameter). */
  state: z.union([JobStateSchema, z.array(JobStateSchema)]).optional(),
  limit: z.number().int().min(1).max(JOBS_LIST_MAX).default(50),
  /** Keyset cursor: the id of the last job of the previous page. */
  before: z.string().optional(),
  /** true: only jobs whose result has problems. */
  problems: z.boolean().optional(),
  /** true: only plan-only dry runs whose outcome depends on the size gate. */
  dependsOnSize: z.boolean().optional(),
});
export const JobsListOutputSchema = z.object({
  jobs: z.array(JobSchema),
  /**
   * Jobs per state (every state, zero when none) within the list's scope (`runId`, `libraryId`);
   * the `state` filter and paging do not apply.
   */
  counts: z.record(JobStateSchema, z.number().int()),
  /** Jobs with problems within the list's scope; the `state` filter and paging do not apply. */
  problemCount: z.number().int(),
  /** Dry runs that depend on size within the list's scope; the `state` filter and paging do not apply. */
  dependsOnSizeCount: z.number().int(),
});

/** `since` omitted: the start of today in the server's time zone. */
export const JobStatsInputSchema = z.object({ since: z.iso.datetime().optional() });
export const JobStatsOutputSchema = z.object({
  /** Replaced files since `since`. */
  files: z.number().int(),
  savedBytes: z.number().int(),
  /** Jobs that ended `failed` since `since` (counted from the jobs, not their results). */
  failed: z.number().int(),
  /** Now. */
  queued: z.number().int(),
  running: z.number().int(),
  /** Jobs whose result has problems, among results created since `since`. */
  problems: z.number().int(),
});

/** One of the last 7 days, a calendar day in the server's time zone. */
export const JobHistoryDaySchema = z.object({
  /** `YYYY-MM-DD` in the server's time zone. */
  date: z.string(),
  /** Before − after of the files replaced that day, never below 0. */
  savedBytes: z.number().int(),
  /** Files replaced (`done`). */
  replaced: z.number().int(),
  /** Files encoded but kept as the original (`kept_original`). */
  kept: z.number().int(),
  /** Seconds of source video encoded (replaced and kept). */
  seconds: z.number(),
});
export const JobHistoryOutputSchema = z.object({
  /** The server's time zone, which the days and "today" follow. */
  timeZone: z.string(),
  /** Oldest first; the last is today. */
  days: z.array(JobHistoryDaySchema).length(7),
  /** Every replaced file ever; `since` is the first result's time (null: none yet). */
  allTime: z.object({
    savedBytes: z.number().int(),
    files: z.number().int(),
    since: z.iso.datetime().nullable(),
  }),
});
export type JobHistoryOutput = z.infer<typeof JobHistoryOutputSchema>;

/**
 * The tail of the job's ffmpeg log. A line repeated in a row comes once as
 * `<line> [transcoda: <n> times]`, and every `set_mempolicy: Operation not permitted` line (libx265
 * in a container, harmless) is counted into the first one that way. Only the log's last 8 MB are
 * read for it: when that is not the whole log, the flood's count reads `at least <n> times`.
 */
export const JobLogOutputSchema = z.object({ log: z.string() });

export type JobProgress = z.infer<typeof JobProgressSchema>;
export type Job = z.infer<typeof JobSchema>;
export type JobResult = z.infer<typeof JobResultSchema>;
export type JobDetail = z.infer<typeof JobDetailSchema>;
export type JobProbe = z.infer<typeof JobProbeSchema>;
export type WalkStep = z.infer<typeof WalkStepSchema>;
export type JobsQueueInput = z.infer<typeof JobsQueueInputSchema>;
export type JobsQueueOutput = z.infer<typeof JobsQueueOutputSchema>;
export type JobsListInput = z.infer<typeof JobsListInputSchema>;
export type JobsListOutput = z.infer<typeof JobsListOutputSchema>;
export type JobStatsOutput = z.infer<typeof JobStatsOutputSchema>;

/** `jobs.retryFailed`: how many failed jobs went back to the queue. */
export const JobsRetryFailedOutputSchema = z.object({ retried: z.number().int() });
