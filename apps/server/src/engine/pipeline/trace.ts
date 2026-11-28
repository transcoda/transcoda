// The finish-phase entries the pipeline adds to a job's trace after the walk: a size gate's
// branch, a Render's Damaged, a plugin step's own answer, and the node a stop or failure cut.
import { RENDER_DAMAGED_PORT, type TraceEntry } from '@transcoda/shared';
import { appendTrace, type JobRow, nextTraceSeq } from '../../db/repos/jobs/jobs.ts';
import type { JobControl } from '../queue/scheduler.ts';
import type { DamagedBranch, GateBranch } from '../walk/walk.ts';
import type { PipelineCore } from './core.ts';
import { type Prepared, stepOf } from './types.ts';

/** The longest reason a finish entry added after the walk keeps (a plugin's answer is shown as is). */
const MAX_TRACE_REASON = 2000;

/**
 * The job ended (failed, canceled) while `p.runningNode` was at work: its trace says so with
 * `reason` (`failed: …`, `canceled: …`), so that node reads failed or canceled instead of done,
 * and the steps after it did not run.
 */
export function traceStopped(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  p: Prepared,
  reason: string,
): void {
  const at = p.runningNode;
  if (at === null) return;
  p.runningNode = null;
  traceFinish(core, job, ctl, { ...at, source: 'core', port: null, reason });
}

/** Adds a size-gate entry to the job's trace (the branch it took, or that it depends). */
export function traceGate(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  nodeId: string,
  o: { port: 'pass' | 'else' | null; reason: string; findings: GateFindings },
): void {
  traceFinish(core, job, ctl, { nodeId, workflowPath: [], source: 'core', ...o });
}

/** Traces a gate that passed on the measured size. */
export function traceGatePass(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  gate: GateBranch,
  saving: number,
  minSavingPercent: number,
): void {
  traceGate(core, job, ctl, gate.nodeId, {
    port: 'pass',
    reason: `Size gate: saved ${saving.toFixed(1)}%, at least ${minSavingPercent}% \u2192 yes`,
    findings: gateFindings(minSavingPercent, saving),
  });
}

/**
 * Traces a gate whose result saved too little and that writes the track changes instead (or, in
 * a test encode, would): it continues on Yes.
 */
export function traceTrackChanges(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  gate: GateBranch,
  g: { saving: number; minSavingPercent: number },
): void {
  const what = job.dryRun ? 'would write' : 'wrote';
  traceGate(core, job, ctl, gate.nodeId, {
    port: 'pass',
    reason: `Size gate: saved ${g.saving.toFixed(1)}%, below ${g.minSavingPercent}% \u2192 ${what} track changes without re-encoding \u2192 yes`,
    findings: { ...gateFindings(g.minSavingPercent, g.saving), trackChanges: true },
  });
}

/** Traces a gate after an earlier gate's track changes: nothing was encoded to measure. */
export function traceGateAfterTrackChanges(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  gate: GateBranch,
  minSavingPercent: number,
): void {
  traceGate(core, job, ctl, gate.nodeId, {
    port: 'pass',
    reason: 'Size gate: only the track changes are written, nothing to measure \u2192 yes',
    findings: { ...gateFindings(minSavingPercent), trackChanges: true },
  });
}

/**
 * Adds a finish-phase entry to the job's trace after the walk: a size gate's branch, or a
 * plugin finish step's own answer (after the walk's planned entry for that node).
 */
export function traceFinish(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  o: {
    nodeId: string;
    workflowPath: string[];
    source: 'core' | 'plugin';
    port: string | null;
    reason: string;
    /** Only the size gate's numbers: a finish step's findings may carry secrets. */
    findings?: GateFindings;
    startedAt?: string;
  },
): void {
  if (ctl.stopReason() === 'shutdown') return;
  const now = core.deps.now().toISOString();
  const entry: TraceEntry = {
    seq: nextTraceSeq(core.deps.db, job.id),
    attempt: job.attempt,
    nodeId: o.nodeId,
    workflowPath: [...o.workflowPath],
    phase: 'finish',
    source: o.source,
    port: o.port,
    reason:
      o.reason.length > MAX_TRACE_REASON ? `${o.reason.slice(0, MAX_TRACE_REASON - 1)}…` : o.reason,
    findings: o.findings ?? {},
    startedAt: o.startedAt ?? now,
    endedAt: now,
  };
  appendTrace(core.deps.db, job.id, entry);
  core.events().publish({ type: 'job.trace', jobId: job.id, entry });
}

/**
 * The source is damaged and Render's Damaged is wired: records the branch on the trace and
 * moves the job's walk onto it (Done's steps were never taken). Runs nothing.
 */
export function recordDamagedBranch(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  p: Prepared,
  branch: DamagedBranch,
  damage: { reason: string },
): void {
  traceFinish(core, job, ctl, {
    nodeId: branch.nodeId,
    workflowPath: [],
    source: 'core',
    port: RENDER_DAMAGED_PORT,
    reason: `Render: source is damaged (${damage.reason}) \u2192 Damaged`,
  });
  const at = p.walkPath.findIndex((s) => s.workflowPath.length === 0 && s.nodeId === branch.nodeId);
  if (at >= 0) {
    core.update(job, ctl, {
      walkPath: [
        ...p.walkPath.slice(0, at),
        { workflowPath: [], nodeId: branch.nodeId, port: RENDER_DAMAGED_PORT },
        ...branch.path,
      ].map(stepOf),
    });
  }
}

/**
 * A gate failed: records the `else` branch on the trace and moves the job's walk onto it (the
 * pass steps after the gate were never taken). Runs nothing.
 */
export function recordElseBranch(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  p: Prepared,
  gate: GateBranch | undefined,
  /** `note`: why a gate that writes track changes kept the original after all. */
  g: { saving: number; minSavingPercent: number; note?: string },
): void {
  if (!gate) return;
  traceGate(core, job, ctl, gate.nodeId, {
    port: 'else',
    reason: `Size gate: saved ${g.saving.toFixed(1)}%, below ${g.minSavingPercent}% \u2192 no${g.note ? ` (${g.note})` : ''}`,
    findings: gateFindings(g.minSavingPercent, g.saving),
  });
  const at = p.walkPath.findIndex((s) => s.workflowPath.length === 0 && s.nodeId === gate.nodeId);
  if (at >= 0) {
    core.update(job, ctl, {
      walkPath: [
        ...p.walkPath.slice(0, at),
        { workflowPath: [], nodeId: gate.nodeId, port: 'else' },
        ...gate.elsePath,
      ].map(stepOf),
    });
  }
}

/**
 * A size gate's decision entry's findings: the minimum saving and, once measured, the saving
 * (percent, one decimal), so screens need not read them out of the reason. `trackChanges`: the
 * gate went on with the track changes alone (the video kept as it is).
 */
type GateFindings = { minSavingPercent: number; savedPercent?: number; trackChanges?: true };

export function gateFindings(minSavingPercent: number, saving?: number): GateFindings {
  return saving === undefined
    ? { minSavingPercent }
    : { minSavingPercent, savedPercent: Math.round(saving * 10) / 10 };
}
