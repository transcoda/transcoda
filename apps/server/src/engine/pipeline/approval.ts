// The Approval step (docs/dev/engine.md, "Approval"): the rendered and verified output stays in
// the job's temp dir while a person decides on the job page. Nothing is written meanwhile and
// the job holds no lane. The wait lives in memory: a restart discards the result (the startup
// sweep fails the job), and the original is never touched before an approval.
import { fmtBytes, type JsonValue } from '@transcoda/shared';
import {
  deleteApproval,
  insertApproval,
  type JobRow,
  parkedBytes,
} from '../../db/repos/jobs/jobs.ts';
import type { ApprovalAction } from '../../nodes/core/approval.ts';
import { jobProbeOf } from '../media/probe.ts';
import type { JobControl } from '../queue/scheduler.ts';
import type { GateBranch } from '../walk/walk.ts';
import { takeRejected } from './branches.ts';
import type { PipelineCore } from './core.ts';
import { traceFinish } from './trace.ts';
import { abortPromise, type End, fail, final, type Prepared, Stop } from './types.ts';

/** The job's reason while its result waits for a person. */
export const WAITING_FOR_APPROVAL = 'waiting for approval';

const DAY_MS = 86_400_000;

/** How often the server rejects the parked results past their time. */
export const APPROVAL_EXPIRY_CHECK_MS = 60_000;

export type ApprovalAnswer =
  | { kind: 'approved'; by: string }
  | { kind: 'rejected'; by: string }
  | { kind: 'expired' };

/** The jobs whose results wait for a person now, and the way to answer each (in memory). */
export class ApprovalDesk {
  private readonly waiting = new Map<string, (answer: ApprovalAnswer) => void>();

  /** The answer for `jobId`; throws Stop when the job is canceled or the server stops first. */
  async wait(jobId: string, signal: AbortSignal): Promise<ApprovalAnswer> {
    const stopped = abortPromise(signal);
    const answered = new Promise<ApprovalAnswer>((resolve) => {
      this.waiting.set(jobId, resolve);
    });
    try {
      const first = await Promise.race([answered, stopped.promise]);
      if (first === 'aborted') throw new Stop();
      return first;
    } finally {
      this.waiting.delete(jobId);
      stopped.dispose();
    }
  }

  /** Answers a waiting job; false when it is not waiting (answered already, or never parked). */
  answer(jobId: string, answer: ApprovalAnswer): boolean {
    const resolve = this.waiting.get(jobId);
    if (!resolve) return false;
    this.waiting.delete(jobId);
    resolve(answer);
    return true;
  }
}

const daysText = (n: number): string => `${n} ${n === 1 ? 'day' : 'days'}`;

/**
 * Parks the verified output and waits for the answer. Approved: the finish steps go on. Rejected
 * or expired: the output is discarded, the steps behind Rejected run and the original is kept.
 * A result that would take the parked results past `TRANSCODA_APPROVAL_MAX_GB` is not parked:
 * the job fails and the original stays. Throws Stop on a cancel (the parked row goes; the
 * pipeline removes the temp dir) or a shutdown (nothing is written; the startup sweep settles it).
 */
export async function awaitApproval(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  p: Prepared,
  action: ApprovalAction,
  gate: GateBranch | undefined,
  afterBytes: number,
): Promise<{ kind: 'approved'; job: JobRow } | { kind: 'end'; end: End }> {
  const { db, config } = core.deps;
  const desk = core.deps.approvals;
  if (!desk) throw new Error('an Approval step ran without an approval desk');
  const limit = config.approvalMaxBytes;
  if (parkedBytes(db) + afterBytes > limit) {
    const why = `approval: results waiting for approval would take more than ${fmtBytes(limit)}; this one was discarded`;
    return { kind: 'end', end: fail(final('workflow', why)) };
  }
  const now = core.deps.now();
  insertApproval(db, {
    jobId: job.id,
    nodeId: action.nodeId,
    parkedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + action.expireAfterDays * DAY_MS).toISOString(),
    beforeBytes: p.fp.sizeBytes,
    afterBytes,
    plan: p.plan,
    outputProbe: p.outputProbe && (jobProbeOf(p.outputProbe) as unknown as JsonValue),
  });
  job = core.update(job, ctl, { reason: WAITING_FOR_APPROVAL });
  const at = { nodeId: action.nodeId, workflowPath: action.workflowPath, source: 'core' } as const;
  traceFinish(core, job, ctl, {
    ...at,
    port: null,
    reason: `Approval: waiting for a person, at most ${daysText(action.expireAfterDays)}`,
  });
  // Nothing runs for the job while it waits: the next file takes its lane.
  ctl.releaseLane?.();
  let answer: ApprovalAnswer;
  try {
    answer = await desk.wait(job.id, ctl.signal);
  } catch (err) {
    if (ctl.stopReason() === 'cancel') deleteApproval(db, job.id);
    throw err;
  }
  deleteApproval(db, job.id);
  job = core.update(job, ctl, { reason: null });
  if (answer.kind === 'approved') {
    traceFinish(core, job, ctl, {
      ...at,
      port: 'pass',
      reason: `Approval: approved by ${answer.by}`,
    });
    // A job paused while it waited stays held until it is resumed.
    await core.waitWhilePaused(ctl);
    return { kind: 'approved', job };
  }
  const why =
    answer.kind === 'rejected'
      ? `rejected by ${answer.by}`
      : `not approved within ${daysText(action.expireAfterDays)}`;
  const extra = await takeRejected(core, job, ctl, p, gate, action, why, afterBytes);
  return { kind: 'end', end: await core.keepOriginal(job, ctl, p, why, extra, afterBytes) };
}
