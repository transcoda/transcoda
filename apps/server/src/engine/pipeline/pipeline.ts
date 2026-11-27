// The job executor: probe → decide → build (prepare), then encode → verify → finish actions
// (execute). Every phase change is written to the job row and published; every trace entry too.
// Each phase lives in its own module (pipeline-prepare, -encode, -output, -steps, -branches,
// -trace); the state they share is PipelineCore (pipeline-core.ts).
import { basename, dirname } from 'node:path';
import { finishPhaseRank, type Lane, TRACE_CANCELED } from '@transcoda/shared';
import { type EncodeSlot, slotGpuLabel } from '../../capabilities/devices.ts';
import { findJob, hasReplaceJournal, type JobRow } from '../../db/repos/jobs/jobs.ts';
import { isWithin, MAX_SIDECAR_BYTES } from '../files/paths.ts';
import { encoderUsable, kept } from '../model/model.ts';
import { coverExtractArgs, deviceVendor, renderArgs, renderCommandLine } from '../model/render.ts';
import { retarget } from '../model/retarget.ts';
import type { ExecuteOutcome, JobControl, JobExecutor, SlotFit } from '../queue/scheduler.ts';
import { actionNode } from '../walk/walk.ts';
import { takeElse } from './branches.ts';
import { PipelineCore } from './core.ts';
import { coverFailure, coverTimeoutMs, encode } from './encode.ts';
import { moveCopy, recycleSidecarsAfterReplace, replace } from './output.ts';
import { runPrepare } from './prepare.ts';
import { afterReplace, finishWritten, notify, pluginStep } from './steps.ts';
import { recordElseBranch, traceGatePass, traceStopped } from './trace.ts';
import {
  type End,
  type Failure,
  fail,
  final,
  message,
  NEVER_WRITES,
  PASS_LOG_ARGS,
  type PipelineDeps,
  type Prepared,
  renderInputOf,
  resultOf,
  SETTLED,
  Stop,
  savingPercent,
  stoppedBefore,
  type Written,
} from './types.ts';

export { redactUrl } from './steps.ts';
export { logPathFor, type PipelineDeps } from './types.ts';

import { verifyEncoded } from './output.ts';

export class Pipeline implements JobExecutor {
  private readonly core: PipelineCore;

  constructor(deps: PipelineDeps) {
    this.core = new PipelineCore(deps);
  }

  // ---- prepare ----

  async prepare(
    job: JobRow,
    ctl: JobControl,
  ): Promise<{ lane: Lane; fit: SlotFit } | { final: true } | ExecuteOutcome> {
    // A new attempt (or a requeue) starts without the last one's node problems.
    this.core.nodeProblems.delete(job.id);
    try {
      return await runPrepare(this.core, job, ctl);
    } catch (err) {
      if (err instanceof Stop) return { final: true };
      throw err;
    }
  }

  // ---- execute ----

  async execute(
    job: JobRow,
    _lane: Lane,
    ctl: JobControl,
    slot: EncodeSlot | null = null,
  ): Promise<ExecuteOutcome | null> {
    const p = this.core.prepared.get(job.id);
    if (!p) throw new Error(`job ${job.id} was not prepared`);
    p.slot = slot;
    if (slot !== null) {
      // The slot's GPU is known only now: the argv rendered at Build names none (or the pinned one).
      const { device } = slot;
      const vendor = deviceVendor(device);
      let encodedOn: string | null = null;
      if (device !== null && vendor !== null) {
        // Auto's encoders move to the slot's vendor; a named encoder never does. Null (ffmpeg
        // lacks the target) or a target that cannot render: the job encodes as built (prepare's
        // fit keeps such a job off the other vendor's slots, so this is a last resort).
        const caps = this.core.capabilitiesOf();
        const usable = caps.encoders.filter((e) => encoderUsable(e, caps));
        const target = retarget(p.model, p.autoStreams, vendor, usable) ?? p.model;
        const moved = target === p.model ? null : this.core.renderFor(p, target, device);
        if (moved) {
          p.model = target;
          p.plan = p.replan(target);
          p.args = moved;
        } else {
          if (target !== p.model) {
            this.core.deps.log.warn({
              msg: `could not render for the ${vendor} GPU; encoding as built`,
              job: job.id,
            });
          }
          p.args = [...PASS_LOG_ARGS, ...renderArgs({ ...renderInputOf(p), device })];
        }
        p.command = renderCommandLine(this.core.deps.config.ffmpegPath, p.args);
        // Only a job that encodes on that GPU names it: not a software encode, not the other
        // vendor's encoder.
        const suffix = vendor === 'nvidia' ? '_nvenc' : '_qsv';
        const onGpu = kept(p.model).some(
          (s) => s.type === 'video' && s.mode === 'convert' && s.encoder?.endsWith(suffix),
        );
        if (onGpu) encodedOn = slotGpuLabel(slot, this.core.deps.capabilities());
      }
      // A retry clears what an earlier attempt recorded.
      if (job.encodedOn !== encodedOn) job = this.core.update(job, ctl, { encodedOn });
    }
    try {
      return await this.conclude(job, ctl, p, await this.runExecute(job, ctl, p));
    } catch (err) {
      if (err instanceof Stop) {
        if (ctl.stopReason() === 'cancel') await this.cancelled(job, ctl, p);
        // shutdown: no database write and no cleanup; the startup sweep settles the job.
        return null;
      }
      // Unexpected: fail the job here (temp removed) rather than leaving it to the scheduler —
      // unless something was written already: then it is done, with the error as its problem.
      this.core.deps.log.error({ msg: 'job pipeline failed', job: job.id, error: message(err) });
      if (p.written !== null) {
        p.written.problems.push(`internal error: ${message(err)}`);
        await finishWritten(this.core, job, ctl, p, p.written);
        return null;
      }
      return this.conclude(job, ctl, p, {
        kind: 'fail',
        failure: final('internal', `internal error: ${message(err)}`),
      });
    } finally {
      if (ctl.stopReason() !== 'shutdown') this.core.prepared.delete(job.id);
    }
  }

  /** Deletes the temp dir of a job cancelled while ready, and records its result. */
  async discard(job: JobRow): Promise<void> {
    const p = this.core.prepared.get(job.id);
    this.core.prepared.delete(job.id);
    this.core.gpuWarnings.delete(job.id);
    this.core.nodeProblems.delete(job.id);
    await this.core.removeTemp(job.id);
    if (p)
      this.core.recordResult(job, p.fp, { ...resultOf(p), outcome: 'cancelled', logPath: null });
    this.core.sourceHashes.delete(job.id);
  }

  /** Turns how execute ended into the job's outcome; temp goes first (a retry reuses the dir). */
  private async conclude(
    job: JobRow,
    ctl: JobControl,
    p: Prepared,
    end: End,
  ): Promise<ExecuteOutcome | null> {
    if (end.kind === 'settled') return null;
    await this.core.removeTemp(job.id);
    if (end.kind === 'requeue') {
      const { reason, requeues, failedGpus } = end;
      return {
        requeue: {
          reason,
          ...(requeues !== undefined ? { requeues } : {}),
          ...(failedGpus !== undefined ? { failedGpus } : {}),
        },
      };
    }
    const f = end.failure;
    const row = findJob(this.core.deps.db, job.id) ?? job;
    // Retried once when it may help; never while a replace journal exists (the sweep owns it).
    if (f.retry && row.attempt === 1 && !hasReplaceJournal(this.core.deps.db, job.id)) {
      return { requeue: { reason: f.reason, attempt: 2 } };
    }
    traceStopped(this.core, row, ctl, p, `failed: ${f.reason}`);
    this.core.finish(
      row,
      ctl,
      'failed',
      { code: f.code, reason: f.reason, warnings: [...p.warnings, ...(f.warnings ?? [])] },
      resultOf(p),
    );
    return null;
  }

  /** Runs the job to its end. Throws Stop on an abort before anything was written. */
  private async runExecute(job: JobRow, ctl: JobControl, p: Prepared): Promise<End> {
    if (job.dryRun && !job.testEncode) throw new Error('a plan-only dry run reached execute');
    const { fs, config } = this.core.deps;
    this.core.stopIfAborted(ctl);
    await fs.mkdir(p.tempDir);
    await fs.mkdir(dirname(p.logPath));
    // Each attempt has its own log, truncated at the start (a requeue reuses the attempt's).
    await fs.truncate(p.logPath);
    this.core.stopIfAborted(ctl);
    // Copying sidecars, extracting covers, encoding and verifying are the Render's work: it is the
    // node reported as current (the page lights it) and the one a failure or cancel is traced on.
    // A walk without a Render (a workflow from before it) has its encoding node in that role.
    p.runningNode =
      p.renderNodeId === null ? p.lastBuildNode : { nodeId: p.renderNodeId, workflowPath: [] };
    ctl.setCurrentNode(p.runningNode);
    job = this.core.update(job, ctl, { state: 'encoding', progress: null });

    // Sidecars are copied (open handle checked, no symlink, size capped) before anything reads them.
    for (const [n, copy] of p.extraInputFiles) {
      const original = p.model.extraInputs?.[n - 1]?.path ?? '';
      try {
        // Only a realpath inside the library: a symlinked parent directory would lead elsewhere
        // (O_NOFOLLOW only guards the last component).
        if (!isWithin(original, p.library.path) || (await fs.realpath(original)) !== original) {
          throw new Error('its path is not a real path in the library');
        }
        await fs.copyRegular(original, copy, MAX_SIDECAR_BYTES);
      } catch (err) {
        return fail(
          final(
            'encode',
            `render: subtitle file ${basename(original)} cannot be used: ${message(err)}`,
          ),
        );
      }
    }

    // Covers for an mkv output are extracted into the temp dir first (ffmpeg attaches files).
    for (const [index, path] of p.coverFiles) {
      try {
        await this.core.exec(
          config.ffmpegPath,
          coverExtractArgs(p.realPath, index, path),
          ctl.signal,
          coverTimeoutMs(p.probe.sizeBytes),
        );
      } catch (err) {
        this.core.stopIfAborted(ctl);
        return fail(final('encode', coverFailure(err, index, coverTimeoutMs(p.probe.sizeBytes))));
      }
      this.core.stopIfAborted(ctl);
      if (!(await fs.exists(path))) {
        return fail(
          final('encode', `render: cover video #${index} needs its extracted image file`),
        );
      }
    }

    // Kept test outputs never hold up a real job: the oldest go while scratch space is low.
    if (!job.dryRun) await this.core.deps.testOutputs?.makeRoom();
    const encoded = await encode(this.core, job, ctl, p);
    if (encoded !== null) return encoded;
    // Encoded: the GPU is free for the next file while this one is verified and finishes. A retry
    // after a failed verify is queued again and waits for a slot like any job.
    ctl.releaseEncoder?.();

    // Verify. A pause outside ffmpeg (no process to stop) holds the job before verify and before
    // the finish actions until it is resumed.
    job = this.core.update(job, ctl, { state: 'verifying', progress: null });
    await this.core.waitWhilePaused(ctl);
    const unverified = await verifyEncoded(this.core, job, ctl, p);
    if (unverified !== null) return unverified;
    // Finish actions, in order. Once something was written, nothing is retried any more: a later
    // failure (or a stop) ends the job `done` with that problem as its reason and a warning.
    const afterBytes = (await fs.stat(p.outputPath)).size;
    // A test-encode stops here: the gates decide on the measured size, nothing is written.
    if (job.dryRun) return this.endTestEncode(job, ctl, p, afterBytes);
    // Rendered only for its Damaged side: a good file is kept, and Done's steps (none write)
    // do not run, as when prepare ends such a path.
    if (!p.writes) return this.core.keepOriginal(job, ctl, p, NEVER_WRITES, [], afterBytes);
    await this.core.waitWhilePaused(ctl);
    this.core.stopIfAborted(ctl);
    const state: Written = {
      afterBytes,
      replacedTo: null,
      dest: null,
      mode: 'replaced',
      lateCancel: false,
      problems: [],
    };
    const { problems } = state;
    const markWritten = () => {
      p.written = state;
      ctl.markWritten?.();
    };
    const wrote = () => p.written !== null;
    /** The highest finish phase a plugin step already ran in (-1: none). */
    let lastPluginRank = -1;
    for (const [actionIndex, action] of p.actions.entries()) {
      if (wrote() && ctl.signal.aborted && ctl.stopReason() === 'shutdown') {
        problems.push(stoppedBefore(ctl));
        break;
      }
      const at = actionNode(action);
      p.runningNode = at;
      // Each finish step is current while it works, as the node its failure is traced on.
      if (at !== null && !ctl.signal.aborted) ctl.setCurrentNode(at);
      /** A problem after the write, told on this step's node too. */
      const problem = (text: string): void => {
        problems.push(text);
        this.core.noteNode(job, at, 'problem', text);
      };
      let failure: Failure | null = null;
      try {
        if (action.kind === 'size-gate') {
          const saving = savingPercent(p.fp.sizeBytes, afterBytes);
          const gate = p.gates.find((g) => g.actionIndex === actionIndex);
          if (saving < action.minSavingPercent) {
            const why = `saved only ${saving.toFixed(1)}%, below ${action.minSavingPercent}%`;
            if (!wrote()) {
              const extra = await takeElse(this.core, job, ctl, p, gate, {
                saving,
                minSavingPercent: action.minSavingPercent,
                afterBytes,
                why,
              });
              return this.core.keepOriginal(job, ctl, p, why, extra, afterBytes);
            }
            problem(`size gate after a write: ${why}`);
          } else if (gate) {
            traceGatePass(this.core, job, ctl, gate, saving, action.minSavingPercent);
          }
        } else if (action.kind === 'replace') {
          const r = await replace(this.core, job, ctl, p, action.recycleFolder);
          if (r.kind === 'requeue') {
            if (!wrote()) return r;
            failure = final('source_changed', 'file changed during processing');
          } else if (r.kind === 'failure') {
            failure = r.failure;
          } else {
            job = r.job;
            state.replacedTo = r.replacedTo;
            state.dest = p.realPath;
            state.mode = 'replaced';
            state.lateCancel ||= r.lateCancel;
            if (r.problem) problem(r.problem);
            markWritten();
            for (const text of await recycleSidecarsAfterReplace(this.core, job, p, r))
              problem(text);
            await afterReplace(this.core, job, ctl, p, state);
          }
        } else if (action.kind === 'move-copy') {
          failure = await moveCopy(this.core, job, ctl, p, action, state);
          if (failure === null) {
            markWritten();
            await afterReplace(this.core, job, ctl, p, state);
          }
        } else if (action.kind === 'notify') {
          await notify(this.core, job, p, action, afterBytes, state.replacedTo);
        } else if (action.kind === 'plugin') {
          if (!('phase' in action)) {
            problems.push('a finish node that is not a plugin returned a plugin action');
          } else if (finishPhaseRank(action.phase) < lastPluginRank) {
            // Validation (FINISH_ORDER) forbids this; checked again so it is never silent.
            problem(
              `${action.description}: skipped, its phase ${action.phase} is earlier than a phase that already ran`,
            );
          } else if (!wrote()) {
            // Unreachable: prepare ends such jobs kept_original, and validation orders them after
            // the write.
            return fail(final('internal', 'plugin finish step before a write'));
          } else {
            lastPluginRank = finishPhaseRank(action.phase);
            if (!(await pluginStep(this.core, job, ctl, p, action, state))) {
              problems.push(stoppedBefore(ctl));
              break;
            }
          }
        }
      } catch (err) {
        if (!(err instanceof Stop) || !wrote()) throw err;
        problems.push(stoppedBefore(ctl));
        break;
      }
      if (failure !== null) {
        if (!wrote()) return fail(failure);
        problem(failure.reason);
      }
    }
    p.runningNode = null;
    if (p.written === null) {
      // Unreachable: a path without replace or move-copy ends before the finish actions.
      return this.core.keepOriginal(job, ctl, p, NEVER_WRITES, [], afterBytes);
    }
    await finishWritten(this.core, job, ctl, p, p.written);
    return SETTLED;
  }

  /**
   * Ends a test-encode dry run after verify and measuring: the size gates before the first write
   * decide on the measured size (the first failing one keeps the original, with its own numbers);
   * the first replace or move-copy (or the end of the list) means it would replace. No step that
   * writes, notifies or calls a plugin runs.
   */
  private async endTestEncode(
    job: JobRow,
    ctl: JobControl,
    p: Prepared,
    afterBytes: number,
  ): Promise<End> {
    for (const [actionIndex, action] of p.actions.entries()) {
      if (action.kind === 'replace' || action.kind === 'move-copy') break;
      if (action.kind !== 'size-gate') continue;
      const saving = savingPercent(p.fp.sizeBytes, afterBytes);
      const min = action.minSavingPercent;
      const gate = p.gates.find((g) => g.actionIndex === actionIndex);
      if (saving < min) {
        recordElseBranch(this.core, job, ctl, p, gate, { saving, minSavingPercent: min });
        const why = `saved only ${saving.toFixed(1)}%, below ${min}%`;
        return this.concludeTestEncode(job, ctl, p, 'kept_original', why, afterBytes);
      }
      if (gate) traceGatePass(this.core, job, ctl, gate, saving, min);
    }
    if (!p.writes) {
      return this.concludeTestEncode(job, ctl, p, 'kept_original', NEVER_WRITES, afterBytes);
    }
    return this.concludeTestEncode(job, ctl, p, 'dry_run', null, afterBytes);
  }

  /**
   * Records a test-encode's outcome with the measured size. The verified output is kept first
   * (moved out of the temp dir), then the temp dir goes.
   */
  private async concludeTestEncode(
    job: JobRow,
    ctl: JobControl,
    p: Prepared,
    state: 'dry_run' | 'kept_original',
    reason: string | null,
    afterBytes: number,
  ): Promise<End> {
    await this.core.deps.testOutputs?.keep(job.id, p.outputPath, p.model.container);
    await this.core.removeTemp(job.id);
    this.core.finish(
      job,
      ctl,
      state,
      { reason, warnings: p.warnings },
      { ...resultOf(p), afterBytes },
    );
    return SETTLED;
  }

  private async cancelled(job: JobRow, ctl: JobControl, p: Prepared): Promise<void> {
    traceStopped(this.core, job, ctl, p, `${TRACE_CANCELED} the job was canceled during this step`);
    await this.core.removeTemp(job.id);
    this.core.finish(job, ctl, 'cancelled', { warnings: p.warnings }, resultOf(p));
  }
}
