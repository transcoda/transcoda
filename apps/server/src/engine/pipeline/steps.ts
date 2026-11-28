// The finish steps after the write: notify, plugin finish steps and the afterReplace hook, and
// recording `done` with what the job left at its final path.
import {
  corePluginContext,
  type FinishAction,
  type FinishRunResult,
  type PluginFinishAction,
} from '@transcoda/sdk';
import { fingerprintKey } from '../../db/repos/files.ts';
import { findJob, type JobRow } from '../../db/repos/jobs/jobs.ts';
import { hookJobOf } from '../../plugins/runtime/hooks.ts';
// Two functions are named replaceOriginal: the finish node (nodes/core/finish.ts) and this one.
import { fingerprintFromStats } from '../files/replace.ts';
import { contentHash } from '../media/content-hash.ts';
import type { JobControl } from '../queue/scheduler.ts';
import { actionNode, finishRunContext, jobUrl } from '../walk/walk.ts';
import type { PipelineCore } from './core.ts';
import { traceFinish } from './trace.ts';
import {
  abortPromise,
  fileStatsOf,
  message,
  type Prepared,
  resultOf,
  type StepExtra,
  type StepFile,
  type Written,
} from './types.ts';

/** A notify request is abandoned after this long (a warning, never a failure). */
export const NOTIFY_TIMEOUT_MS = 10_000;

/** A required plugin finish step that failed with a retryable error is tried once more after this. */
export const PLUGIN_RETRY_MS = 10_000;

/** `https://host/…`: a webhook URL may carry a token in its path or query. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return 'an invalid URL';
  }
}

/** Records `done` for a job that wrote its result, with any later problems as its reason. */
export async function finishWritten(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  p: Prepared,
  w: Written,
): Promise<void> {
  // Temp goes before the final state is written: a retry or the next job may reuse the dir.
  await core.removeTemp(job.id);
  const { outputFingerprint, outputHash } = await outputIdentityOf(core, job, w);
  const trouble =
    w.problems.length > 0
      ? `finished with a problem: ${w.problems.join('; ')}`
      : w.lateCancel
        ? 'canceled too late'
        : null;
  // A size gate's track changes say so first: the result is not the encode.
  const reason = [w.note, trouble].filter((t) => t !== null).join('; ') || null;
  core.finish(
    findJob(core.deps.db, job.id) ?? job,
    ctl,
    'done',
    { reason, warnings: [...p.warnings, ...w.problems] },
    {
      ...resultOf(p),
      afterBytes: w.afterBytes,
      replacedTo: w.replacedTo,
      problems: [...w.problems],
      outputFingerprint,
      outputHash,
    },
  );
}

/**
 * The fingerprint and content hash of the file the job left at its final path (the replaced
 * original, or the last move-copy destination), read after every finish step ran; null when it
 * is gone or unreadable (a plugin step may have moved it). Already processed recognises the file
 * by these. The hash is not cancelled with the job: the write is done, and it reads 12 MiB.
 */
async function outputIdentityOf(
  core: PipelineCore,
  job: JobRow,
  w: Written,
): Promise<{ outputFingerprint: string | null; outputHash: string | null }> {
  if (w.dest === null) return { outputFingerprint: null, outputHash: null };
  try {
    return {
      outputFingerprint: fingerprintKey(fingerprintFromStats(await core.deps.fs.stat(w.dest))),
      outputHash: await contentHash(w.dest),
    };
  } catch (err) {
    core.deps.log.warn({
      msg: 'could not read the written file',
      job: job.id,
      path: w.dest,
      error: message(err),
    });
    return { outputFingerprint: null, outputHash: null };
  }
}

/** Sends the summary; a failure is a warning (with the URL redacted), never a job failure. */
export async function notify(
  core: PipelineCore,
  job: JobRow,
  p: StepFile,
  action: Extract<FinishAction, { kind: 'notify' }>,
  afterBytes: number,
  replacedTo: 'recycle' | 'deleted' | null,
  kept?: { outcome: 'kept_original'; reason: string },
): Promise<void> {
  if (job.dryRun) throw new Error('a notify step reached a dry run');
  const where = redactUrl(action.url);
  const body = JSON.stringify({
    jobId: job.id,
    runId: job.runId,
    path: p.realPath,
    workflowId: job.workflowId,
    workflowVersion: job.workflowVersion,
    outcome: kept?.outcome ?? 'done',
    ...(kept ? { reason: kept.reason } : {}),
    beforeBytes: p.fp.sizeBytes,
    afterBytes,
    replacedTo,
  });
  try {
    const res = await fetch(action.url, {
      method: action.method,
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok)
      core.warnNode(job, p, actionNode(action), `notify ${where} answered ${res.status}`);
  } catch (err) {
    const why = message(err).split(action.url).join(where);
    core.warnNode(job, p, actionNode(action), `notify ${where} failed: ${why}`);
  }
}

/**
 * `afterReplace`: right after the write, before the next action (a plugin step may rely on the
 * plugin having seen it). Bounded by the runner's timeout and by a cancel or shutdown.
 */
export async function afterReplace(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  p: Prepared,
  w: Written,
): Promise<void> {
  if (job.dryRun) throw new Error('an afterReplace hook reached a dry run');
  const { hooks } = core.deps;
  if (!hooks) return;
  const row = findJob(core.deps.db, job.id) ?? job;
  const payload = hookJobOf(
    row,
    {
      outcome: w.mode,
      reason: null,
      beforeBytes: p.fp.sizeBytes,
      afterBytes: w.afterBytes,
      replacedTo: w.replacedTo,
      problems: [],
    },
    core.workflowName(row.workflowId),
    jobUrl(core.deps.config.publicUrl, row.id),
  );
  const gone = abortPromise(ctl.signal);
  try {
    await Promise.race([hooks.run('afterReplace', payload), gone.promise]);
  } catch (err) {
    core.deps.log.warn({
      msg: 'plugin hook failed',
      hook: 'afterReplace',
      jobId: job.id,
      error: message(err),
    });
  } finally {
    gone.dispose();
  }
}

/**
 * Runs one plugin finish action after the write. Returns false when the job was stopped (cancel
 * or shutdown) meanwhile: the caller records that and ends the job `done`. A failure, a throw
 * (timeout, crash, bad answer) or a refusal is never an exception here: a required step records
 * a problem, a best-effort step a warning. Never called for a dry run.
 */
export async function pluginStep(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  p: StepFile,
  action: PluginFinishAction,
  w: Written,
  extra: StepExtra = {},
): Promise<boolean> {
  if (job.dryRun) throw new Error('a plugin finish step reached a dry run');
  const { registry } = core.deps;
  const ctx = finishRunContext(
    {
      probe: p.probe,
      file: fileStatsOf(p.fp, p.realPath),
      data: {},
      capabilities: core.capabilitiesOf(),
      log: (m) =>
        core.deps.log.info({ msg: 'node log', job: job.id, node: action.nodeId, message: m }),
      plugin: corePluginContext({ dryRun: false, job: { id: job.id, attempt: job.attempt } }),
    },
    {
      originalPath: p.realPath,
      newPath: w.dest ?? p.realPath,
      replacedTo: w.replacedTo,
      beforeBytes: p.fp.sizeBytes,
      afterBytes: w.afterBytes,
      outcome: extra.damage ? 'damaged' : w.mode,
      containerChanged: w.mode !== 'kept' && p.model.container !== p.probe.container,
      problemsSoFar: [...w.problems],
      gate: extra.gate ?? null,
      damage: extra.damage ?? null,
      jobUrl: jobUrl(core.deps.config.publicUrl, job.id),
      workflowName: core.workflowName(job.workflowId),
    },
  );
  const attempt = async (): Promise<FinishRunResult | 'aborted'> => {
    const entry = registry.get(action.nodeType);
    const down = entry?.unavailable?.() ?? null;
    if (down !== null) return { ok: false, message: `${down}`, retryable: true };
    const run = entry?.def.run;
    if (!run) {
      return { ok: false, message: `${action.nodeType} has no run step any more` };
    }
    const stopped = abortPromise(ctl.signal);
    // The call keeps running in the plugin when abandoned (a stop); its late answer is dropped.
    // `signal` is server-side only (wireContext strips it): a stop cancels the plugin's call.
    const call = run
      .call(
        entry.def,
        { ...ctx, signal: ctl.signal, nodeVersion: action.nodeVersion } as typeof ctx,
        action.settings,
      )
      .then(
        (r): FinishRunResult => r,
        (err: unknown): FinishRunResult => ({
          ok: false,
          message: message(err),
          retryable: (err as { retryable?: unknown } | null)?.retryable === true,
        }),
      );
    try {
      return await Promise.race([call, stopped.promise]);
    } finally {
      stopped.dispose();
    }
  };
  const startedAt = core.deps.now().toISOString();
  let result = await attempt();
  if (result === 'aborted') return false;
  if (!result.ok && result.retryable === true && action.required) {
    const wait = abortPromise(ctl.signal);
    let timer: NodeJS.Timeout | undefined;
    try {
      const slept = await Promise.race([
        new Promise<'slept'>((resolve) => {
          timer = setTimeout(() => resolve('slept'), PLUGIN_RETRY_MS);
        }),
        wait.promise,
      ]);
      if (slept === 'aborted') return false;
    } finally {
      clearTimeout(timer);
      wait.dispose();
    }
    result = await attempt();
    if (result === 'aborted') return false;
  }
  if (result.ok) {
    core.deps.log.info({
      msg: 'plugin finish step',
      jobId: job.id,
      nodeId: action.nodeId,
      message: result.message,
    });
  } else if (action.required) {
    w.problems.push(result.message);
    // On a side branch (nothing written) the caller reports it as a warning.
    core.noteNode(job, action, w.mode === 'kept' ? 'warning' : 'problem', result.message);
  } else {
    core.warnNode(job, p, action, `${action.description}: ${result.message}`);
  }
  // The step's own answer on the job (C2), as the job page and get_job show it. The plugin
  // process has already redacted it with the plugin's secrets (`redactResult`), like the log line.
  traceFinish(core, job, ctl, {
    nodeId: action.nodeId,
    workflowPath: action.workflowPath,
    source: 'plugin',
    port: null,
    reason: result.ok ? result.message : `failed: ${result.message}`,
    startedAt,
  });
  return true;
}
