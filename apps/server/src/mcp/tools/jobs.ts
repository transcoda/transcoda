import { type JobDetail, JobsListInputSchema } from '@transcoda/contract';
import { z } from 'zod';
import { type AnyToolDef, defineTool } from '../tool.ts';
import {
  type JobBrief,
  JobBriefShape,
  JobReportShape,
  jobBrief,
  jobLine,
  jobReport,
  jobReportText,
  type Titles,
} from './job-report.ts';

export { JobBriefShape, jobBrief, jobLine };

const JobId = z.string().describe('Job id, from list_jobs or queue results');

const countsShape = z
  .record(z.string(), z.number().int())
  .describe('Jobs per state within the scope (runId, libraryId); state filter and paging ignored');

/** Titles for the top-level nodes of the detail's (redacted) graph; nested nodes show their id. */
function titlesFor(detail: JobDetail, catalogue: Map<string, string>): Titles {
  const top = new Map<string, string>();
  for (const n of detail.graph?.nodes ?? []) {
    top.set(n.id, n.label ?? catalogue.get(n.type) ?? n.type);
  }
  return (nodeId, workflowPath) =>
    (workflowPath.length === 0 ? top.get(nodeId) : undefined) ?? nodeId;
}

const listJobs = defineTool({
  name: 'list_jobs',
  title: 'List jobs',
  description:
    'Newest jobs first, optionally filtered by state, library or run. Pages by `before` (pass nextCursor). counts covers the whole scope.',
  scopes: ['read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: {
    ...JobsListInputSchema.shape,
    state: JobsListInputSchema.shape.state.describe('One state or several, e.g. ["failed"]'),
    runId: JobsListInputSchema.shape.runId.describe('Only the jobs of this run'),
    libraryId: JobsListInputSchema.shape.libraryId.describe('Only the jobs of this library'),
    limit: z.number().int().min(1).max(200).default(20).describe('Page size (default 20, max 200)'),
    before: JobsListInputSchema.shape.before.describe('nextCursor of the previous page'),
  },
  output: {
    jobs: z.array(z.object(JobBriefShape)),
    counts: countsShape,
    nextCursor: z
      .string()
      .nullable()
      .describe('Pass as `before` for the next page; null at the end'),
  },
  async run({ api }, args) {
    const { jobs, counts } = await api.jobs.list({ ...args });
    const briefs: JobBrief[] = jobs.map(jobBrief);
    const last = briefs.at(-1);
    const nextCursor = briefs.length === args.limit && last ? last.id : null;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const lines = [`${briefs.length} of ${total} jobs`, ...briefs.map(jobLine)];
    if (nextCursor) lines.push(`More: call again with before="${nextCursor}"`);
    return { text: lines.join('\n'), data: { jobs: briefs, counts, nextCursor } };
  },
});

const getJob = defineTool({
  name: 'get_job',
  title: 'Diagnose a job',
  description:
    'A diagnosis of one job: state, reason, the node it failed at, the path the file took, per-node decisions, result, plan and a probe summary. Use get_job_log for the ffmpeg log.',
  scopes: ['read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: { id: JobId },
  output: JobReportShape,
  async run({ api }, { id }) {
    const [detail, { nodes }] = await Promise.all([api.jobs.get({ id }), api.nodes.list()]);
    const catalogue = new Map(nodes.map((n) => [n.type, n.title]));
    const report = jobReport(detail, titlesFor(detail, catalogue));
    return { text: jobReportText(report), data: report };
  },
});

const getJobLog = defineTool({
  name: 'get_job_log',
  title: 'Job log',
  description:
    'The tail of the ffmpeg log of a job (empty before it ran). maxBytes keeps only the last characters; truncated says whether anything was cut.',
  scopes: ['read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: {
    id: JobId,
    maxBytes: z
      .number()
      .int()
      .min(256)
      .max(65536)
      .default(16384)
      .describe('How many characters of the end of the log to return (default 16384)'),
  },
  output: {
    log: z.string(),
    bytes: z.number().int().describe('Size of `log` in bytes'),
    truncated: z.boolean().describe('True when the log was longer than maxBytes'),
  },
  async run({ api }, { id, maxBytes }) {
    const { log: full } = await api.jobs.log({ id });
    let log = full.slice(-maxBytes);
    // Do not start on the second half of a surrogate pair.
    const first = log.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) log = log.slice(1);
    return {
      text: log === '' ? 'No log yet.' : log,
      data: { log, bytes: Buffer.byteLength(log), truncated: full.length > maxBytes },
    };
  },
});

const controlOutput = { ok: z.literal(true), id: z.string() };

const pauseJob = defineTool({
  name: 'pause_job',
  title: 'Pause a job',
  description: 'Pause a queued or running job. A running ffmpeg is stopped and its lane freed.',
  scopes: ['jobs:manage'],
  annotations: { idempotentHint: true, openWorldHint: false },
  input: { id: JobId },
  output: controlOutput,
  async run({ api }, { id }) {
    await api.jobs.pause({ id });
    return { text: `Paused job ${id}.`, data: { ok: true as const, id } };
  },
});

const resumeJob = defineTool({
  name: 'resume_job',
  title: 'Resume a job',
  description: 'Resume a paused job.',
  scopes: ['jobs:manage'],
  annotations: { idempotentHint: true, openWorldHint: false },
  input: { id: JobId },
  output: controlOutput,
  async run({ api }, { id }) {
    await api.jobs.resume({ id });
    return { text: `Resumed job ${id}.`, data: { ok: true as const, id } };
  },
});

const cancelJob = defineTool({
  name: 'cancel_job',
  title: 'Cancel a job',
  description: 'Cancel a job that has not finished. This cannot be undone.',
  scopes: ['jobs:manage'],
  annotations: { destructiveHint: true, openWorldHint: false },
  input: { id: JobId },
  output: controlOutput,
  async run({ api }, { id }) {
    await api.jobs.cancel({ id });
    return { text: `Cancelled job ${id}.`, data: { ok: true as const, id } };
  },
});

const jobsWord = (n: number) => `${n} ${n === 1 ? 'job' : 'jobs'}`;

const cancelAllJobs = defineTool({
  name: 'cancel_all_jobs',
  title: 'Cancel all jobs',
  description:
    'Cancel every job that has not finished (queued, running or paused), optionally of one library. Running ffmpeg processes are stopped and their partial output removed. Jobs already replacing their file finish (counted in writing). This cannot be undone.',
  scopes: ['jobs:manage'],
  annotations: { destructiveHint: true, openWorldHint: false },
  input: {
    libraryId: z
      .string()
      .optional()
      .describe('Only the jobs of this library; omit for every library'),
  },
  output: {
    cancelled: z.number().int().describe('How many jobs were cancelled'),
    writing: z
      .number()
      .int()
      .describe('Jobs left to finish: they were already replacing their file'),
    failed: z.number().int().describe('Jobs whose cancel failed; they keep running'),
  },
  async run({ api }, { libraryId }) {
    const out = await api.jobs.cancelAll(libraryId === undefined ? {} : { libraryId });
    const parts = [`Cancelled ${jobsWord(out.cancelled)}.`];
    if (out.writing > 0)
      parts.push(`${jobsWord(out.writing)} already replacing their file will finish.`);
    if (out.failed > 0) parts.push(`${jobsWord(out.failed)} could not be cancelled.`);
    return { text: parts.join(' '), data: out };
  },
});

export const jobTools: AnyToolDef[] = [
  listJobs,
  getJob,
  getJobLog,
  pauseJob,
  resumeJob,
  cancelJob,
  cancelAllJobs,
];
