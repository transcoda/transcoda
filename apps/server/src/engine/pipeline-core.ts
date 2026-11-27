// The job state and helpers the pipeline phases share: see PipelineCore.
import { join } from 'node:path';
import type { BuildModel } from '@transcoda/sdk';
import type { FailureCode, JobState, NodeProblem } from '@transcoda/shared';
import { devicePlan, readEncodeDevice } from '../capabilities/devices.ts';
import { type Exec, makeExec } from '../capabilities/ffmpeg.ts';
import type { Database } from '../db/open.ts';
import { type Fingerprint, fingerprintKey } from '../db/repos/files.ts';
import { insertJobResult, type JobPatch, type JobRow, updateJob } from '../db/repos/jobs.ts';
import { findWorkflow } from '../db/repos/workflows.ts';
import type { CheckSourceResult } from '../nodes/core-tools.ts';
import { errorCode } from '../platform/fs-ops.ts';
import { type HookName, hookJobOf } from '../plugins/hooks.ts';
import { contentHash } from './content-hash.ts';
import type { EngineEvents } from './events.ts';
import { SETTLE_MINUTES } from './paths.ts';
import {
  type End,
  type FinishResult,
  message,
  PASS_LOG_ARGS,
  type PipelineDeps,
  type Prepared,
  type ResultInput,
  renderInputOf,
  resultOf,
  SETTLED,
  type StepFile,
  Stop,
} from './pipeline-types.ts';
import { jobUrl } from './plugin-context.ts';
import { type RenderDevice, RenderError, renderArgs } from './render.ts';
import type { JobControl } from './scheduler.ts';
import type { ActionNode } from './walk.ts';

/** How often a job paused outside ffmpeg checks whether it was resumed. */
const PAUSE_POLL_MS = 100;

/**
 * The state and helpers every phase of a job shares: the dependencies, the per-job maps, the
 * job-row writes, the final-state record, node notes and the stop checks. The phases are free
 * functions that take it as `core`.
 */
export class PipelineCore {
  /** What prepare learned about each job that is ready or running, until it finishes. */
  readonly prepared = new Map<string, Prepared>();
  /** The warnings of a job's failed GPU encodes, kept across its requeues to another GPU. */
  readonly gpuWarnings = new Map<string, string[]>();
  readonly settleMinutes: number;
  /** Check source's results by file and setting, oldest first (see coreTools). */
  readonly checkResults = new Map<string, CheckSourceResult>();
  /** The content hash of each running real job's source, until its result is recorded. */
  readonly sourceHashes = new Map<string, string>();
  /** Per job, the warnings and problems of this attempt that belong to a node (`noteNode`). */
  readonly nodeProblems = new Map<string, NodeProblem[]>();

  constructor(readonly deps: PipelineDeps) {
    this.settleMinutes = deps.settleMinutes ?? SETTLE_MINUTES;
  }

  /**
   * The sampled content hash of `path`, cancelled with the job (a stop throws Stop); null when the
   * file is gone or cannot be read (logged: the job goes on without it).
   */
  async hashOf(job: JobRow, ctl: JobControl, path: string): Promise<string | null> {
    try {
      return await contentHash(path, { signal: ctl.signal });
    } catch (err) {
      this.stopIfAborted(ctl);
      this.deps.log.warn({
        msg: 'could not hash the file',
        job: job.id,
        path,
        error: message(err),
      });
      return null;
    }
  }

  /**
   * Records a warning or problem that belongs to `at`'s node with the job's result, where the job
   * page shows it as that node's badge (it is in the result's warnings or problems too).
   */
  noteNode(
    job: JobRow,
    at: ActionNode | null,
    severity: NodeProblem['severity'],
    text: string,
  ): void {
    if (at === null) return;
    const list = this.nodeProblems.get(job.id) ?? [];
    list.push({ workflowPath: [...at.workflowPath], nodeId: at.nodeId, severity, message: text });
    this.nodeProblems.set(job.id, list);
  }

  /** A job warning that belongs to `at`'s node. */
  warnNode(job: JobRow, p: StepFile, at: ActionNode | null, text: string): void {
    p.warnings.push(text);
    this.noteNode(job, at, 'warning', text);
  }

  /** A warning from the Render's work (encode, verify): told on the node at work, the Render. */
  renderWarn(job: JobRow, p: Prepared, text: string): void {
    this.warnNode(job, p, p.runningNode, text);
  }

  async keepOriginal(
    job: JobRow,
    ctl: JobControl,
    p: Prepared,
    reason: string,
    extra: string[],
    afterBytes: number | null = null,
    o: { sourceDamaged?: boolean } = {},
  ): Promise<End> {
    await this.removeTemp(job.id);
    this.finish(
      job,
      ctl,
      'kept_original',
      { reason, warnings: [...p.warnings, ...extra] },
      { ...resultOf(p), afterBytes, sourceDamaged: o.sourceDamaged === true },
    );
    return SETTLED;
  }

  skip(job: JobRow, ctl: JobControl, reason: string, fp?: Fingerprint): { final: true } {
    this.finish(job, ctl, 'skipped', { reason }, fp ? { fp } : {});
    return { final: true };
  }

  /**
   * Records a final state: the row (no lane, no progress) and, when the file was fingerprinted, a
   * result; then `run.changed`.
   */
  finish(
    job: JobRow,
    ctl: JobControl,
    state: 'failed',
    o: { code: FailureCode; reason: string; warnings?: string[] },
    r?: FinishResult,
  ): void;
  finish(
    job: JobRow,
    ctl: JobControl,
    state: Exclude<JobState, 'failed'>,
    o: { reason?: string | null; warnings?: string[] },
    r?: FinishResult,
  ): void;
  finish(
    job: JobRow,
    ctl: JobControl,
    state: JobState,
    o: { code?: FailureCode; reason?: string | null; warnings?: string[] },
    r: FinishResult = {},
  ): void {
    const { db } = this.deps;
    this.gpuWarnings.delete(job.id);
    const row = db.transaction(() => {
      const updated = this.write(job.id, {
        state,
        reason: o.reason ?? null,
        // Only a failure has a code; any other final state clears one an earlier attempt left.
        failureCode: state === 'failed' ? (o.code ?? 'internal') : null,
        lane: null,
        progress: null,
      });
      if (r.fp) {
        this.recordResult(updated, r.fp, {
          ...r,
          outcome: state,
          warnings: o.warnings ?? [],
          nodeProblems: this.nodeProblems.get(job.id) ?? [],
        });
      }
      return updated;
    })();
    this.sourceHashes.delete(job.id);
    this.nodeProblems.delete(job.id);
    ctl.changed(row);
    this.events().publish({ type: 'run.changed', runId: job.runId });
    // Hooks after the row is written; never for a dry run, a cancel or a skip.
    if (state === 'done' || state === 'failed') {
      this.fireHook(
        state === 'done' ? 'onJobDone' : 'onJobFailed',
        ctl,
        hookJobOf(
          row,
          {
            outcome: state,
            reason: row.reason,
            beforeBytes: r.fp?.sizeBytes ?? null,
            afterBytes: r.afterBytes ?? null,
            replacedTo: r.replacedTo ?? null,
            problems: r.problems ?? [],
          },
          this.workflowName(row.workflowId),
          jobUrl(this.deps.config.publicUrl, row.id),
        ),
      );
    }
  }

  workflowName(id: string): string {
    return findWorkflow(this.deps.db, id, { includeDeleted: true })?.name ?? '';
  }

  /**
   * Tells the plugins about a finished job without holding the job (its lane) while they answer:
   * every failure is a log line inside the runner. Skipped for a dry run and during a shutdown
   * (the plugins are going away).
   */
  fireHook(hook: HookName, ctl: JobControl, job: ReturnType<typeof hookJobOf>): void {
    const { hooks } = this.deps;
    if (!hooks || job.dryRun || ctl.stopReason() === 'shutdown') return;
    hooks.run(hook, job).catch((err: unknown) => {
      this.deps.log.warn({ msg: 'plugin hook failed', hook, jobId: job.id, error: message(err) });
    });
  }

  /** Replaces the job's result row (delete + insert in one transaction). */
  recordResult(
    job: JobRow,
    fp: Fingerprint,
    r: Partial<ResultInput> & { outcome: JobState },
  ): void {
    const { db } = this.deps;
    db.transaction(() => {
      db.prepare('DELETE FROM job_results WHERE job_id = ?').run(job.id);
      insertJobResult(db, {
        jobId: job.id,
        fingerprint: fingerprintKey(fp),
        workflowId: job.workflowId,
        workflowVersion: job.workflowVersion,
        outcome: r.outcome,
        beforeBytes: fp.sizeBytes,
        afterBytes: r.afterBytes ?? null,
        estimatedBytes: r.estimatedBytes ?? null,
        command: r.command ?? null,
        plan: r.plan ?? null,
        replacedTo: r.replacedTo ?? null,
        logPath: r.logPath ?? null,
        warnings: r.warnings ?? [],
        problems: r.problems ?? [],
        nodeProblems: r.nodeProblems ?? [],
        // Only an outcome that stands on the verified output keeps its probe: a failed or
        // cancelled job threw that output away.
        outputProbe: OUTPUT_OUTCOMES.has(r.outcome) ? (r.outputProbe ?? null) : null,
        sourceDamaged: r.sourceDamaged ?? false,
        outputFingerprint: r.outcome === 'done' ? (r.outputFingerprint ?? null) : null,
        sourceHash: this.sourceHashes.get(job.id) ?? null,
        outputHash: r.outcome === 'done' ? (r.outputHash ?? null) : null,
        createdAt: this.deps.now().toISOString(),
      });
    })();
  }

  /** The GPU the "Encoding device" setting names, when it is detected; nothing for auto and CPU. */
  renderDevice(): { device?: RenderDevice } {
    const { device } = devicePlan(this.deps.capabilities(), readEncodeDevice(this.deps.db));
    return device ? { device } : {};
  }

  /** What hook contexts report: the probed ffmpeg's encoders, filters and hwaccels (none when unprobed). */
  capabilitiesOf(): { encoders: string[]; filters: string[]; hwaccels: string[] } {
    const caps = this.deps.capabilities();
    return caps.available
      ? { encoders: caps.encoders, filters: caps.filters, hwaccels: caps.hwaccels }
      : { encoders: [], filters: [], hwaccels: [] };
  }

  /** The ffmpeg arguments for another plan of the same prepared job; null when it cannot render. */
  renderFor(p: Prepared, model: BuildModel, device?: RenderDevice): string[] | null {
    try {
      return [
        ...PASS_LOG_ARGS,
        ...renderArgs({ ...renderInputOf(p), model, ...(device ? { device } : {}) }),
      ];
    } catch (err) {
      if (err instanceof RenderError) return null;
      throw err;
    }
  }

  exec(
    file: string,
    args: string[],
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string }> {
    return (this.deps.exec ?? coverExec)(file, args, {
      signal,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  events(): EngineEvents {
    return this.deps.events;
  }

  /** Waits while the user has the job paused; throws Stop on a cancel or shutdown meanwhile. */
  async waitWhilePaused(ctl: JobControl): Promise<void> {
    while (ctl.paused()) {
      this.stopIfAborted(ctl);
      await new Promise((r) => setTimeout(r, PAUSE_POLL_MS));
    }
    this.stopIfAborted(ctl);
  }

  /** Throws Stop when the job was canceled or the server is stopping. */
  stopIfAborted(ctl: JobControl): void {
    if (ctl.signal.aborted) throw new Stop();
  }

  write(id: string, patch: JobPatch): JobRow {
    const row = updateJobOrThrow(this.deps.db, id, patch, this.deps.now());
    return row;
  }

  update(job: JobRow, ctl: JobControl, patch: JobPatch): JobRow {
    const row = this.write(job.id, patch);
    ctl.changed(row);
    return row;
  }

  async removeTemp(jobId: string): Promise<void> {
    try {
      await this.deps.fs.rm(join(this.deps.config.transcodeDir, jobId), { recursive: true });
    } catch (err) {
      this.deps.log.warn({
        msg: 'could not remove a job temp dir',
        job: jobId,
        code: errorCode(err),
      });
    }
  }
}

/** Outcomes whose result keeps the verified output's probe (written, measured, or measured and kept). */
const OUTPUT_OUTCOMES: ReadonlySet<JobState> = new Set(['done', 'kept_original', 'dry_run']);

/** Cover extraction copies one image; a minute is plenty even on a slow share. */
const coverExec: Exec = makeExec({ timeout: 60_000, maxBuffer: 1024 * 1024 });

function updateJobOrThrow(db: Database, id: string, patch: JobPatch, now: Date): JobRow {
  const row = updateJob(db, id, patch, now);
  if (row === null) throw new Error(`job ${id} vanished`);
  return row;
}
