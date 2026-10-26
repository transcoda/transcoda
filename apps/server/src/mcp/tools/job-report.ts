import type { Job, JobDetail } from '@transcoda/contract';
import { JobResultSchema } from '@transcoda/contract';
import { branchWord, JobStateSchema } from '@transcoda/shared';
import { z } from 'zod';

/** Title of a node: top level `label ?? catalogue title ?? type`; inside a sub-workflow the node id. */
export type Titles = (nodeId: string, workflowPath: string[]) => string;

export const JobBriefShape = {
  id: z.string(),
  runId: z.string(),
  state: JobStateSchema,
  paused: z.boolean(),
  dryRun: z.boolean(),
  testEncode: z
    .boolean()
    .describe('A dry run that encodes, verifies and measures for real (afterBytes is measured)'),
  fileName: z.string(),
  filePath: z.string(),
  libraryId: z.string(),
  libraryName: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  workflowVersion: z.number().int(),
  reason: z.string().nullable(),
  progressPercent: z.number().nullable(),
  queuedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  beforeBytes: z.number().int().nullable(),
  afterBytes: z.number().int().nullable(),
  estimatedBytes: z
    .number()
    .int()
    .nullable()
    .describe('Dry runs only: the estimated output size; null when there is no estimate'),
  planSummary: z
    .string()
    .nullable()
    .describe('Dry runs only: what the plan would do in one line; null without a plan'),
  dependsOnSize: z
    .object({ minSavingPercent: z.number() })
    .nullable()
    .describe(
      'Plan-only dry runs ending dry_run: a size gate before the write decides after encoding; it would replace only if the result saves at least minSavingPercent. null otherwise',
    ),
};
export type JobBrief = z.infer<z.ZodObject<typeof JobBriefShape>>;

export function jobBrief(job: Job): JobBrief {
  return {
    id: job.id,
    runId: job.runId,
    state: job.state,
    paused: job.paused,
    dryRun: job.dryRun,
    testEncode: job.testEncode,
    fileName: job.fileName,
    filePath: job.filePath,
    libraryId: job.libraryId,
    libraryName: job.libraryName,
    workflowId: job.workflowId,
    workflowName: job.workflowName,
    workflowVersion: job.workflowVersion,
    reason: job.reason,
    progressPercent: job.progress?.percent ?? null,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    beforeBytes: job.result?.beforeBytes ?? null,
    afterBytes: job.result?.afterBytes ?? null,
    estimatedBytes: job.estimatedBytes,
    planSummary: job.planSummary,
    dependsOnSize: job.dependsOnSize,
  };
}

/** "would replace if it saves ≥ 25%" for a dry run its size gate decides; null otherwise. */
function dependsText(j: Pick<JobBrief, 'dependsOnSize'>): string | null {
  return j.dependsOnSize
    ? `would replace if it saves ≥ ${j.dependsOnSize.minSavingPercent}%`
    : null;
}

export function jobLine(j: JobBrief): string {
  const size =
    j.testEncode && j.afterBytes !== null
      ? ` — measured ${j.afterBytes} bytes`
      : j.estimatedBytes !== null && !j.dependsOnSize
        ? ` — estimated ${j.estimatedBytes} bytes`
        : '';
  return `${j.state}${j.paused ? ' (paused)' : ''}${j.dryRun ? ' [dry run]' : ''}${j.testEncode ? ' [test encode]' : ''} ${j.id} — ${j.fileName} — ${j.workflowName} v${j.workflowVersion}${j.reason ? ` — ${j.reason}` : ''}${j.planSummary ? ` — plan: ${j.planSummary}` : ''}${dependsText(j) ? ` — ${dependsText(j)} (decided after encoding)` : ''}${size}`;
}

export const JobReportShape = {
  ...JobBriefShape,
  failingNode: z.object({ nodeId: z.string(), title: z.string(), reason: z.string() }).nullable(),
  path: z.array(
    z.object({
      nodeId: z.string(),
      title: z.string(),
      port: z.string().nullable(),
      workflowPath: z.array(z.string()),
    }),
  ),
  decisions: z.array(
    z.object({
      seq: z.number().int(),
      attempt: z.number().int(),
      nodeId: z.string(),
      title: z.string(),
      phase: z.string(),
      port: z.string().nullable(),
      reason: z.string(),
    }),
  ),
  result: JobResultSchema.nullable(),
  plan: z
    .object({
      container: z.object({ from: z.string(), to: z.string() }),
      rewrite: z.boolean(),
      streams: z.array(
        z.object({
          index: z.number().int(),
          type: z.string(),
          codec: z.string(),
          language: z.string().nullable(),
          action: z.string(),
          note: z.string(),
        }),
      ),
    })
    .nullable(),
  probe: z
    .object({
      container: z.string(),
      durationSeconds: z.number(),
      sizeBytes: z.number().int(),
      streams: z.array(
        z.object({
          index: z.number().int(),
          type: z.string(),
          codec: z.string(),
          language: z.string().nullable(),
          default: z.boolean(),
        }),
      ),
    })
    .nullable(),
};
export type JobReport = z.infer<z.ZodObject<typeof JobReportShape>>;

/** A walk failure is traced on the failing node as `failed: <reason>` with no port (walk.ts). */
const FAILED_PREFIX = 'failed: ';

/**
 * The node that failed the walk of a failed job: among the entries of the highest attempt, the one
 * with the highest seq (trace order is not assumed), only when that entry itself records a failure.
 * A failure outside the walk (ffmpeg, probe, verify, replace) leaves no such entry: null, never a
 * node that merely ran last. Null for any other state or an empty trace.
 */
export function failingNodeOf(
  detail: Pick<JobDetail, 'state' | 'trace'>,
  titles: Titles,
): { nodeId: string; title: string; reason: string } | null {
  if (detail.state !== 'failed') return null;
  let best: JobDetail['trace'][number] | undefined;
  for (const e of detail.trace) {
    if (!best || e.attempt > best.attempt || (e.attempt === best.attempt && e.seq > best.seq)) {
      best = e;
    }
  }
  if (!best || best.port !== null || !best.reason.startsWith(FAILED_PREFIX)) return null;
  return {
    nodeId: best.nodeId,
    title: titles(best.nodeId, best.workflowPath),
    reason: best.reason.slice(FAILED_PREFIX.length),
  };
}

export function jobReport(detail: JobDetail, titles: Titles): JobReport {
  return {
    ...jobBrief(detail),
    failingNode: failingNodeOf(detail, titles),
    path: detail.path.map((s) => ({
      nodeId: s.nodeId,
      title: titles(s.nodeId, s.workflowPath),
      port: s.port,
      workflowPath: s.workflowPath,
    })),
    decisions: detail.trace.map((e) => ({
      seq: e.seq,
      attempt: e.attempt,
      nodeId: e.nodeId,
      title: titles(e.nodeId, e.workflowPath),
      phase: e.phase,
      port: e.port,
      reason: e.reason,
    })),
    result: detail.result,
    plan: detail.plan && {
      container: detail.plan.container,
      rewrite: detail.plan.rewrite,
      streams: detail.plan.streams.map((s) => ({
        index: s.index,
        type: s.type,
        codec: s.codec,
        language: s.language,
        action: s.action,
        note: s.note,
      })),
    },
    probe: detail.probe && {
      container: detail.probe.container,
      durationSeconds: detail.probe.durationSeconds,
      sizeBytes: detail.probe.sizeBytes,
      streams: detail.probe.streams.map((s) => ({
        index: s.index,
        type: s.type,
        codec: s.codec,
        language: s.language,
        default: s.default,
      })),
    },
  };
}

export function jobReportText(r: JobReport): string {
  const lines = [
    `Job ${r.id}: ${r.state}${r.paused ? ', paused' : ''}${r.dryRun ? ', dry run' : ''}${r.testEncode ? ', test encode' : ''} — ${r.reason ?? 'no reason yet'}`,
    `File: ${r.filePath} (${r.libraryName})`,
    `Workflow: ${r.workflowName} v${r.workflowVersion} (${r.workflowId})`,
  ];
  const depends = dependsText(r);
  if (depends) {
    lines.push(`Depends on size: ${depends}, decided after encoding (test-encode it to know)`);
  }
  if (r.failingNode) {
    lines.push(
      `Failing node: ${r.failingNode.title} (${r.failingNode.nodeId}) — ${r.failingNode.reason}`,
    );
  }
  if (r.state === 'failed' && !r.failingNode && r.reason) {
    lines.push(
      /^ffmpeg /.test(r.reason)
        ? `Failed during the ffmpeg encode, not at a workflow node: ${r.reason}`
        : `Failed outside the workflow nodes (no node recorded the failure): ${r.reason}`,
    );
  }
  const steps = r.path.filter((s) => s.workflowPath.length === 0);
  if (steps.length > 0) {
    lines.push(
      `Path: ${steps.map((s) => `${s.title}${s.port ? `[${branchWord(s.port) ?? s.port}]` : ''}`).join(' → ')}`,
    );
  }
  // Each finish step's last entry of the last attempt: a plugin step's own answer ("Radarr lists
  // …") follows its planned entry, a size gate's branch its build entry. Keyed by node id alone:
  // finish nodes live only in the top-level graph (a sub-workflow may not hold one,
  // workflows/validate.ts `notAllowed(n, 'a sub-workflow')`), though walk.ts carries a
  // `workflowPath` on every plugin action.
  const lastAttempt = Math.max(0, ...r.decisions.map((d) => d.attempt));
  const finish = new Map<string, { title: string; nodeId: string; reason: string; seq: number }>();
  for (const d of r.decisions) {
    if (d.phase !== 'finish' || d.attempt !== lastAttempt) continue;
    const prev = finish.get(d.nodeId);
    if (!prev || d.seq > prev.seq) finish.set(d.nodeId, d);
  }
  if (finish.size > 0) {
    const list = [...finish.values()].sort((a, b) => a.seq - b.seq);
    lines.push(`Finish steps: ${list.map((d) => `${d.title} — ${d.reason}`).join('; ')}`);
  }
  if (r.result) {
    const bytes = (n: number | null) => (n === null ? '?' : String(n));
    lines.push(
      `Result: ${r.result.outcome}, ${bytes(r.result.beforeBytes)} → ${bytes(r.result.afterBytes)} bytes, ${r.result.replacedTo ?? 'nothing replaced'}`,
    );
  }
  if (r.plan) {
    const count = (a: string) => r.plan?.streams.filter((s) => s.action === a).length ?? 0;
    lines.push(
      `Plan: ${r.plan.container.from} → ${r.plan.container.to}, ${r.plan.streams.length} streams (${count('convert')} convert, ${count('drop')} drop)`,
    );
  }
  if (r.result && r.result.warnings.length > 0) {
    lines.push(`Warnings: ${r.result.warnings.join('; ')}`);
  }
  if (r.result && r.result.problems.length > 0) {
    lines.push(`Problems: ${r.result.problems.join('; ')}`);
  }
  lines.push(
    `Next: get_job_log for the ffmpeg log; get_workflow ${r.workflowId} version ${r.workflowVersion} for the graph.`,
  );
  return lines.join('\n');
}
