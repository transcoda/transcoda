import type { Job, JobDetail } from '@transcoda/contract';
import { ACTIVE_JOB_STATES } from '@transcoda/shared';
import { hasScope } from '../../auth/tokens.ts';
import { findJob, type JobListRow, jobsInStates } from '../../db/repos/jobs.ts';
import type { RunHoursHold } from '../../engine/run-hours.ts';
import { os, requireAnyScope, requireHumanSessionWith, requireScope } from '../middleware.ts';
import { redactGraph } from '../redact.ts';

// Reads need `read`; queueing needs `jobs:create` (or `plan` for a dry run); pause, resume and
// cancel (one or all) need `jobs:manage`.

/** The list row as the API shows it (no replace journal, file id, walk path or requeue count). */
function toJob(r: JobListRow & { heldByRunHours: RunHoursHold | null }): Job {
  return {
    id: r.id,
    runId: r.runId,
    state: r.state,
    paused: r.paused,
    lane: r.lane,
    attempt: r.attempt,
    encodedOn: r.encodedOn,
    failedGpus: r.failedGpus,
    priority: r.priority,
    dryRun: r.dryRun,
    testEncode: r.testEncode,
    fileName: r.fileName,
    filePath: r.path,
    libraryId: r.libraryId,
    libraryName: r.libraryName,
    workflowId: r.workflowId,
    workflowVersion: r.workflowVersion,
    workflowName: r.workflowName,
    progress: r.progress,
    queuedAt: r.queuedAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    reason: r.reason,
    result: r.result,
    problems: r.problems,
    estimatedBytes: r.estimatedBytes,
    planSummary: r.planSummary,
    dependsOnSize: r.dependsOnSize,
    heldByRunHours: r.heldByRunHours,
  };
}

export const queue = os.jobs.queue
  .use(requireAnyScope('jobs:create', 'plan'))
  .handler(async ({ context, input, errors }) => {
    const { auth } = context;
    if (auth.kind === 'token' && !input.dryRun && !hasScope(auth.scopes, 'jobs:create')) {
      throw errors.FORBIDDEN({ message: 'A plan token can only queue dry runs' });
    }
    const result = await context.deps.engine.queue.queue({
      path: input.path,
      ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
      dryRun: input.dryRun,
      ...(input.workflowVersion !== undefined ? { workflowVersion: input.workflowVersion } : {}),
      force: input.force,
      fileOnly: input.fileOnly,
      priority: input.priority,
      // A dry run test-encodes one file unless asked otherwise; a real run never does.
      testEncode: input.dryRun ? (input.testEncode ?? 'if-single-file') : false,
      createdBy: auth.user.id,
    });
    switch (result.kind) {
      case 'queued':
        return {
          runId: result.run.id,
          jobIds: result.jobs.map((j) => j.id),
          dryRun: result.run.dryRun,
          note: result.run.note,
          workflowVersion: result.run.workflowVersion,
          testEncode: result.run.testEncode,
        };
      case 'path-rejected':
        throw errors.PATH_REJECTED({ data: { path: input.path, reason: result.reason } });
      case 'workflow-missing':
        throw errors.NOT_FOUND({ message: 'Workflow not found' });
      case 'version-missing':
        throw errors.NOT_FOUND({ message: 'Workflow version not found' });
      case 'workflow-invalid':
        throw errors.WORKFLOW_INVALID({ data: { issues: result.issues } });
      case 'no-feeding-workflow':
        throw errors.NO_FEEDING_WORKFLOW();
    }
  });

export const list = os.jobs.list.use(requireScope('read')).handler(({ context, input }) => {
  const { jobs, counts, problemCount, dependsOnSizeCount } = context.deps.engine.listJobs({
    limit: input.limit,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.libraryId !== undefined ? { libraryId: input.libraryId } : {}),
    ...(input.state !== undefined ? { states: [input.state].flat() } : {}),
    ...(input.before !== undefined ? { before: input.before } : {}),
    ...(input.problems === true ? { problems: true as const } : {}),
    ...(input.dependsOnSize === true ? { dependsOnSize: true as const } : {}),
  });
  return { jobs: jobs.map(toJob), counts, problemCount, dependsOnSizeCount };
});

export const stats = os.jobs.stats
  .use(requireScope('read'))
  .handler(({ context, input }) => context.deps.engine.jobStats(input.since));

export const history = os.jobs.history
  .use(requireScope('read'))
  .handler(({ context }) => context.deps.engine.jobHistory());

export const get = os.jobs.get
  .use(requireScope('read'))
  .handler(({ context, input, errors }): JobDetail => {
    const detail = context.deps.engine.jobDetail(input.id);
    if (!detail) throw errors.NOT_FOUND();
    const { result } = detail;
    return {
      ...toJob(detail.job),
      trace: detail.trace,
      result: result && {
        outcome: result.outcome,
        beforeBytes: result.beforeBytes,
        afterBytes: result.afterBytes,
        estimatedBytes: result.estimatedBytes,
        command: result.command,
        replacedTo: result.replacedTo,
        warnings: result.warnings,
        problems: result.problems,
        sourceDamaged: result.sourceDamaged,
      },
      probe: detail.probe,
      outputProbe: detail.outputProbe,
      graph: detail.graph && redactGraph(detail.graph),
      plan: detail.plan,
      path: detail.path,
      testOutput: detail.testOutput && {
        keptUntil: detail.testOutput.keptUntil,
        sizeBytes: detail.testOutput.sizeBytes,
        container: detail.testOutput.container,
      },
      testOutputNote: detail.testOutputNote,
    };
  });

export const log = os.jobs.log
  .use(requireScope('read'))
  .handler(async ({ context, input, errors }) => {
    const text = await context.deps.engine.jobLog(input.id);
    if (text === null) throw errors.NOT_FOUND();
    return { log: text };
  });

export const pause = os.jobs.pause
  .use(requireScope('jobs:manage'))
  .handler(({ context, input, errors }) => {
    if (!findJob(context.deps.db, input.id)) throw errors.NOT_FOUND();
    if (context.deps.engine.scheduler.pauseJob(input.id) !== 'ok') throw errors.JOB_NOT_ACTIVE();
    return { ok: true as const };
  });

export const resume = os.jobs.resume
  .use(requireScope('jobs:manage'))
  .handler(({ context, input, errors }) => {
    if (!findJob(context.deps.db, input.id)) throw errors.NOT_FOUND();
    if (context.deps.engine.scheduler.resumeJob(input.id) !== 'ok') {
      throw errors.JOB_NOT_ACTIVE({ message: 'The job is not paused' });
    }
    return { ok: true as const };
  });

export const retryFailed = os.jobs.retryFailed
  .use(requireScope('jobs:manage'))
  .handler(({ context }) => context.deps.engine.queue.retryFailed());

export const cancel = os.jobs.cancel
  .use(requireScope('jobs:manage'))
  .handler(({ context, input, errors }) => {
    if (!findJob(context.deps.db, input.id)) throw errors.NOT_FOUND();
    // `already`: a cancel under way answers ok, as it always has.
    if (context.deps.engine.scheduler.cancelJob(input.id) === 'not-active') {
      throw errors.JOB_NOT_ACTIVE();
    }
    return { ok: true as const };
  });

/**
 * Every job that has not finished (queued, running, paused), optionally of one library, through
 * the same scheduler cancel as `cancel`: a running ffmpeg is killed and its temp output removed.
 * A job replacing its file, or past its first write, is left to finish (`writing`): its cancel
 * could not undo the write. Queued jobs go first, so freeing a lane never starts one of them. A
 * job that finished meanwhile, or whose cancel was already under way, is not counted. One cancel
 * that throws is logged and counted in `failed`; the others still run.
 */
export const cancelAll = os.jobs.cancelAll
  .use(requireScope('jobs:manage'))
  .handler(({ context, input, errors }) => {
    const { db, engine, log } = context.deps;
    const { scheduler } = engine;
    if (scheduler.isStopping) {
      throw errors.JOB_NOT_ACTIVE({ message: 'The server is stopping; nothing was cancelled' });
    }
    const jobs = jobsInStates(db, [...ACTIVE_JOB_STATES]).filter(
      (j) => input.libraryId === undefined || j.libraryId === input.libraryId,
    );
    const queuedFirst = [
      ...jobs.filter((j) => j.state === 'queued'),
      ...jobs.filter((j) => j.state !== 'queued'),
    ];
    const out = { cancelled: 0, writing: 0, failed: 0 };
    for (const job of queuedFirst) {
      try {
        const r = scheduler.cancelJob(job.id, { beforeWrite: true });
        if (r === 'ok') out.cancelled++;
        else if (r === 'writing') out.writing++;
      } catch (err) {
        out.failed++;
        log.error({
          msg: 'cancel all: a job could not be cancelled',
          job: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  });

// Session-only: any API token is refused; no MCP tool wraps it. Playing and downloading are the
// plain route in http/test-output.ts.
export const deleteTestOutput = os.jobs.deleteTestOutput
  .use(requireHumanSessionWith('Test outputs are handled in the UI'))
  .handler(async ({ context, input, errors }) => {
    if (!(await context.deps.engine.testOutputs.remove(input.id, 'deleted'))) {
      throw errors.NOT_FOUND();
    }
    return { ok: true as const };
  });
