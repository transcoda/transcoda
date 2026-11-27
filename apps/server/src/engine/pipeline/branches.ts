// The side branches where nothing may write: a size gate's else, and the steps behind a
// Render's or a Check source's Damaged when the source turns out damaged.
import type { AnyFinishAction } from '@transcoda/sdk';
import { finishPhaseRank } from '@transcoda/shared';
import type { JobRow } from '../../db/repos/jobs/jobs.ts';
import type { JobControl } from '../queue/scheduler.ts';
import type { VerifyFailure } from '../verify/verify.ts';
import {
  actionNode,
  type DamagedBranch,
  type GateBranch,
  type SourceDamagedAt,
} from '../walk/walk.ts';
import type { PipelineCore } from './core.ts';
import { notify, pluginStep } from './steps.ts';
import { recordDamagedBranch, recordElseBranch } from './trace.ts';
import {
  type End,
  type Prepared,
  SOURCE_DAMAGED,
  type StepExtra,
  type StepFile,
  Stop,
  stoppedBefore,
  type Written,
} from './types.ts';

/**
 * A gate failed before anything was written: records the branch, moves the job's walk onto
 * `else` and runs the notifications and other non-writing steps wired there (the result is
 * discarded, so nothing can write). A step that fails or is cut short by a stop is a warning:
 * the original is kept either way. Returns the warnings for the job.
 */
export async function takeElse(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  p: Prepared,
  gate: GateBranch | undefined,
  g: { saving: number; minSavingPercent: number; afterBytes: number; why: string },
): Promise<string[]> {
  if (!gate) return [];
  recordElseBranch(core, job, ctl, p, gate, g);
  return runNoWriteSteps(core, job, ctl, p, gate.elseActions, g.afterBytes, g.why, {
    gate: { savedPercent: Math.round(g.saving * 10) / 10, minSavingPercent: g.minSavingPercent },
    where: 'the size gate\u2019s No branch',
    owner: p,
  });
}

/**
 * The source turned out damaged before anything was written (Render's Quality check on and its
 * Damaged wired, a real job): records the branch, moves the job's walk onto Damaged and runs
 * the notifications and other non-writing steps there, with nothing rendered or written: a
 * plugin step sees outcome `damaged`, the original's path and size, and `damage`. Returns the
 * warnings for the job.
 */
async function takeDamaged(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  p: Prepared,
  branch: DamagedBranch,
  damage: { reason: string; stream?: string },
): Promise<string[]> {
  recordDamagedBranch(core, job, ctl, p, branch, damage);
  return runNoWriteSteps(core, job, ctl, p, branch.actions, p.fp.sizeBytes, SOURCE_DAMAGED, {
    damage,
    where: 'Render\u2019s Damaged',
    owner: p,
  });
}

/**
 * Runs the steps of a side branch where nothing may write (a gate's `else`, Render's Damaged):
 * notifications (outcome `kept_original` with `why`) and plugin steps, in order. A step that
 * fails or is cut short by a stop is a warning: the original is kept either way. Each step is
 * the current node while it works, and `owner`'s node at work (what a failure is traced on).
 * Returns the warnings for the job.
 */
async function runNoWriteSteps(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  p: StepFile,
  actions: AnyFinishAction[],
  afterBytes: number,
  why: string,
  { owner, ...side }: StepExtra & { where: string; owner?: Prepared },
): Promise<string[]> {
  const out: string[] = [];
  const kept: Written = {
    afterBytes,
    replacedTo: null,
    dest: null,
    mode: 'kept',
    lateCancel: false,
    problems: [],
  };
  let lastRank = -1;
  for (const action of actions) {
    const at = actionNode(action);
    if (owner) owner.runningNode = at;
    if (at !== null && !ctl.signal.aborted) ctl.setCurrentNode(at);
    try {
      if (action.kind === 'notify') {
        await notify(core, job, p, action, afterBytes, null, {
          outcome: 'kept_original',
          reason: why,
        });
      } else if (action.kind === 'plugin' && 'phase' in action) {
        if (finishPhaseRank(action.phase) < lastRank) {
          out.push(
            `${action.description}: skipped, its phase ${action.phase} is earlier than a phase that already ran`,
          );
          continue;
        }
        lastRank = finishPhaseRank(action.phase);
        const done = await pluginStep(core, job, ctl, p, action, kept, side);
        if (!done) {
          out.push(stoppedBefore(ctl));
          break;
        }
      } else {
        out.push(`skipped a ${action.kind} step: nothing can be written behind ${side.where}`);
      }
    } catch (err) {
      if (!(err instanceof Stop)) throw err;
      out.push(stoppedBefore(ctl));
      break;
    }
  }
  if (owner) owner.runningNode = null;
  // A required plugin step's failure is a problem on a written job; here it is a warning.
  return [...out, ...kept.problems];
}

/**
 * The path left a Check source by Damaged (in prepare, nothing encoded): a real job runs the
 * non-writing steps after it with outcome `damaged`; a dry run runs none. Either ends
 * `kept_original` with the result marked source-damaged.
 */
export async function sourceDamagedAtCheck(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  file: Omit<StepFile, 'warnings'>,
  built: { actions: AnyFinishAction[]; sourceDamagedAt: SourceDamagedAt | null },
): Promise<{ final: true }> {
  const damage = built.sourceDamagedAt?.damage ?? { reason: 'damaged' };
  const reason = `source is damaged: ${damage.reason}`;
  const side: StepFile = { ...file, warnings: [] };
  const extra = job.dryRun
    ? []
    : await runNoWriteSteps(core, job, ctl, side, built.actions, file.fp.sizeBytes, reason, {
        damage,
        where: 'Check source\u2019s Damaged',
      });
  core.finish(
    job,
    ctl,
    'kept_original',
    { reason, warnings: [...side.warnings, ...extra] },
    { fp: file.fp, sourceDamaged: true },
  );
  return { final: true };
}

/**
 * Confirmed source damage (the encode's decoder errors the source reproduces, or verify's
 * `source-damaged`): the original is kept and the result says the source is damaged. With
 * Render's Damaged wired, a real job first runs its steps; a dry run only records the branch.
 * `details` are the job's warnings; `confirmed` says what is wrong (the first one is the
 * `damage.reason` a plugin step gets).
 */
export async function sourceDamaged(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  p: Prepared,
  details: string[],
  confirmed: VerifyFailure[],
): Promise<End> {
  const extra: string[] = [];
  if (p.damaged !== null) {
    // Nothing is encoded any more: the slot is free for the next file while the steps run.
    ctl.releaseEncoder?.();
    const damage = { reason: damageReason(confirmed) };
    if (job.dryRun) recordDamagedBranch(core, job, ctl, p, p.damaged, damage);
    else extra.push(...(await takeDamaged(core, job, ctl, p, p.damaged, damage)));
  }
  return core.keepOriginal(job, ctl, p, SOURCE_DAMAGED, [...details, ...extra], null, {
    sourceDamaged: true,
  });
}

/** What is wrong with the source, from the first confirmed failure (without the check's name). */
function damageReason(confirmed: VerifyFailure[]): string {
  const first = confirmed[0];
  return first ? first.message.replace(/^source: /, '') : 'decode errors';
}
