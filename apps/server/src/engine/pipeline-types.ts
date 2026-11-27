// What every phase of the job pipeline shares: its dependencies, what prepare learned about a
// job (Prepared), how execute ends (End, Failure), the result fields, and small pure helpers.
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import type { Capabilities } from '@transcoda/contract';
import type {
  AnyFinishAction,
  BuildModel,
  FileStats,
  FinishRunContext,
  ProbeResult,
} from '@transcoda/sdk';
import type { FailureCode, JobPlan, JobState, JsonValue, NodeProblem } from '@transcoda/shared';
import type { EncodeSlot } from '../capabilities/devices.ts';
import type { Exec } from '../capabilities/ffmpeg.ts';
import type { Database } from '../db/open.ts';
import type { Fingerprint } from '../db/repos/files.ts';
import type { WalkStep } from '../db/repos/jobs.ts';
import type { LibraryRow } from '../db/repos/libraries.ts';
import type { NodeRegistry } from '../nodes/registry.ts';
import type { Config } from '../platform/config.ts';
import type { FsOps } from '../platform/fs-ops.ts';
import type { Logger } from '../platform/logger.ts';
import type { PluginHooksRunner } from '../plugins/hooks.ts';
import type { PluginRestartGate } from '../plugins/restart-gate.ts';
import type { WorkflowService } from '../workflows/service.ts';
import type { CurrentNode, EngineEvents } from './events.ts';
import { jobProbeOf } from './probe.ts';
import type { ProcessSpawner } from './process.ts';
import type { RenderInput } from './render.ts';
import type { ReplaceDeps } from './replace.ts';
import type { JobControl, SlotFit } from './scheduler.ts';
import type { SpaceWaits } from './space-waits.ts';
import type { TestOutputStore } from './test-outputs.ts';
import type { ActionNode, DamagedBranch, GateBranch } from './walk.ts';

/** Job progress is written at most this often. */
export const PROGRESS_INTERVAL_MS = 1000;
/**
 * ffmpeg's log level for a job (warnings and errors, each line tagged with its level) and a
 * progress report every 0.1 s: the in-pass check tells decoder errors before the first output
 * frame from later ones by whether a report with frames written arrived first.
 */
export const PASS_LOG_ARGS = ['-loglevel', 'level+warning', '-stats_period', '0.1'] as const;
/** The end of a GPU failure's requeue reason (and warning). */
export const TRYING_ANOTHER_GPU = '; trying another GPU';

export interface PipelineDeps {
  db: Database;
  config: Config;
  workflows: WorkflowService;
  registry: NodeRegistry;
  capabilities(): Capabilities;
  events: EngineEvents;
  spawner: ProcessSpawner;
  fs: FsOps;
  /** ffprobe/ffmpeg runner for probe, cover extraction and verify; each defaults to its own. */
  exec?: Exec;
  now(): Date;
  log: Logger;
  /** Default {@link SETTLE_MINUTES}. */
  settleMinutes?: number;
  /** Default `pollForSpace` (re-check every 30 s). */
  waitForSpace?: ReplaceDeps['waitForSpace'];
  /** The replaces waiting for free space now (the deep health reads them); absent: not kept. */
  spaceWaits?: SpaceWaits;
  /** Plugin job hooks (absent: none run). */
  hooks?: PluginHooksRunner;
  /** Waits for plugins in restart backoff before a job fails on them (absent: never waits). */
  restartGate?: PluginRestartGate;
  /** Keeps test-encode outputs and makes room for real jobs (absent: nothing kept). */
  testOutputs?: TestOutputStore;
  /**
   * Is there a slot for a job with `fit` on a GPU not in `failed`? (absent: never; a failed GPU
   * encode then goes to software at once.)
   */
  otherGpuFor?(fit: SlotFit, failed: string[]): boolean;
}

/** What prepare learned about a job, kept in memory until it finishes. */
export interface Prepared {
  realPath: string;
  /** The library with its root (and recycle folder) as realpaths. */
  library: LibraryRow;
  fp: Fingerprint;
  stat: Stats;
  probe: ProbeResult;
  model: BuildModel;
  /** Indexes into `model.streams` that Encode video put on an encoder by itself (`auto`). */
  autoStreams: Set<number>;
  /** The encode slots the job fits, as computed at prepare. */
  fit: SlotFit;
  actions: AnyFinishAction[];
  /** Per size gate, the non-writing steps behind its `else` (run when the gate fails). */
  gates: GateBranch[];
  /** The steps behind the path's Render's Damaged (Quality check on and wired); else null. */
  damaged: DamagedBranch | null;
  /** The Render on the main path (top level, not bypassed); null for a graph without one. */
  renderNodeId: string | null;
  /** The main path writes the result (a replace or move-copy); else it only renders. */
  writes: boolean;
  /** The walk through `pass` as the build left it; a failing gate swaps the tail for its else. */
  walkPath: WalkStep[];
  plan: JobPlan;
  /** The plan of another model for the same streams (a retarget or the software fallback). */
  replan: (model: BuildModel) => JobPlan;
  tempDir: string;
  outputPath: string;
  logPath: string;
  /** Source index → where its cover image is extracted (mkv outputs). */
  coverFiles: Map<number, string>;
  /** Extra input number → its private copy in the temp dir (what ffmpeg reads). */
  extraInputFiles: Map<number, string>;
  /** The last action node of the build: the job's node while it encodes and verifies. */
  lastBuildNode: CurrentNode | null;
  /**
   * The node whose work is under way in execute: the Render while the job encodes and verifies,
   * then each finish step in turn; null between them. A failure or cancel is told on it.
   */
  runningNode: ActionNode | null;
  args: string[];
  command: string;
  /** The encode slot execute got (null: the quick lane, or before execute). */
  slot: EncodeSlot | null;
  /** Set once a failed GPU encode was rerun on the software encoder (only once per attempt). */
  softwareFallback?: boolean;
  /** Set once a failed Intel GPU encode was rerun with the source decoded on the CPU (once per attempt). */
  cpuDecode?: boolean;
  estimatedBytes: number | null;
  warnings: string[];
  /** What verify read of the output once it passed; null before (kept with the result). */
  outputProbe: ProbeResult | null;
  /**
   * Set once a finish action wrote (a replace installed, a move-copy done): from then on the job
   * ends `done`, whatever happens later (the catch-all in execute reads it too).
   */
  written: Written | null;
}

/** What the finish actions have written so far, and the problems met after the first write. */
export interface Written {
  afterBytes: number;
  replacedTo: 'recycle' | 'deleted' | null;
  /** Where the result now is: the original's path after a replace, the destination of a move-copy. */
  dest: string | null;
  mode: 'replaced' | 'moved' | 'copied' | 'kept';
  lateCancel: boolean;
  problems: string[];
}

export type Failure = {
  /** The job's machine-readable failure code (`jobs.failure_code`). */
  code: FailureCode;
  reason: string;
  /** A second attempt could change the outcome (I/O, encode, verify, finish actions). */
  retry: boolean;
  warnings?: string[];
};

export const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The kind of a failure the job ends with right away, never retried. */
export const final = (code: FailureCode, reason: string, warnings?: string[]): Failure => ({
  code,
  reason,
  retry: false,
  ...(warnings ? { warnings } : {}),
});
export const retryable = (code: FailureCode, reason: string, warnings?: string[]): Failure => ({
  code,
  reason,
  retry: true,
  ...(warnings ? { warnings } : {}),
});

/** Thrown when the job was canceled or the server is stopping (see `stopIfAborted`). */
export class Stop extends Error {}

/** How execute ended: settled (recorded), a requeue for the scheduler, or a failure. */
export type End =
  | { kind: 'settled' }
  | { kind: 'requeue'; reason: string; requeues?: number; failedGpus?: string[] }
  | { kind: 'fail'; failure: Failure };
export const SETTLED: End = { kind: 'settled' };
/** What `finish` records as the job's result besides its outcome. */
export type FinishResult = Partial<Omit<ResultInput, 'outcome'>> & { fp?: Fingerprint };
export const fail = (failure: Failure): End => ({ kind: 'fail', failure });

export type ResultInput = {
  outcome: JobState;
  afterBytes: number | null;
  estimatedBytes: number | null;
  command: string | null;
  plan: JobPlan | null;
  replacedTo: 'recycle' | 'deleted' | null;
  logPath: string | null;
  warnings: string[];
  problems: string[];
  /** The warnings and problems that belong to one node (filled in by `finish`). */
  nodeProblems: NodeProblem[];
  /** The verified output's probe as the job page reads it (a JobProbe: no raw JSON). */
  outputProbe: JsonValue | null;
  /** The original was kept because the source is damaged ("Damaged source"). */
  sourceDamaged: boolean;
  /** `fingerprintKey` of the written file at its final path (done jobs only). */
  outputFingerprint: string | null;
  /** Content hash of the written file at its final path (done jobs only). */
  outputHash: string | null;
};

/** What a step needs of the job's file (a prepared job, or one that ends in prepare). */
export type StepFile = Pick<Prepared, 'fp' | 'realPath' | 'probe' | 'model' | 'warnings'>;

/** What a plugin step on a side branch learns: a gate's numbers, or what is wrong with the source. */
export type StepExtra = {
  gate?: NonNullable<FinishRunContext['gate']>;
  damage?: { reason: string; stream?: string };
};

/** The reason of a job whose source turned out damaged. */
export const SOURCE_DAMAGED = 'source has decode errors; nothing was replaced';
/** The reason of a job whose path renders but never writes the result. */
export const NEVER_WRITES = 'path never writes the result';

/** The problem recorded when a stop cuts the finish actions after a write. */
export function stoppedBefore(ctl: JobControl): string {
  const why = ctl.stopReason();
  return `${why === 'shutdown' ? 'the server stopped' : (why ?? 'stopped')} before the remaining finish actions`;
}

/** Resolves `'aborted'` once the signal aborts (with that reason when `only` is given). */
export function abortPromise(
  signal: AbortSignal,
  only?: string,
): { promise: Promise<'aborted'>; dispose(): void } {
  let onAbort: (() => void) | null = null;
  const promise = new Promise<'aborted'>((resolve) => {
    const check = (): boolean => {
      if (!signal.aborted || (only !== undefined && signal.reason !== only)) return false;
      resolve('aborted');
      return true;
    };
    if (check()) return;
    onAbort = () => {
      if (check()) dispose();
    };
    signal.addEventListener('abort', onAbort);
  });
  const dispose = (): void => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    onAbort = null;
  };
  return { promise, dispose };
}

/** The file stats a hook context carries: the original's stats before the write. */
export function fileStatsOf(fp: Fingerprint, path: string): FileStats {
  return {
    path,
    sizeBytes: fp.sizeBytes,
    mtime: new Date(fp.mtimeMs).toISOString(),
    nlink: fp.nlink,
  };
}

/** How much smaller the output is than the original, in percent (0 for an empty original). */
export function savingPercent(before: number, after: number): number {
  return before > 0 ? ((before - after) / before) * 100 : 0;
}

/** What Build rendered the argv from, to render it again on the slot's device. */
export function renderInputOf(p: Prepared): RenderInput {
  return {
    model: p.model,
    input: p.realPath,
    output: p.outputPath,
    coverFiles: p.coverFiles,
    extraInputFiles: p.extraInputFiles,
    ...(p.cpuDecode ? { gpuDecode: false } : {}),
  };
}

/** The result fields every outcome of a prepared job carries. */
export function resultOf(p: Prepared): { fp: Fingerprint } & Partial<ResultInput> {
  return {
    fp: p.fp,
    plan: p.plan,
    estimatedBytes: p.estimatedBytes,
    command: p.command,
    logPath: p.logPath,
    outputProbe: p.outputProbe && (jobProbeOf(p.outputProbe) as unknown as JsonValue),
  };
}

/** `<configDir>/logs/jobs/<jobId>.attempt-<n>.log`: one log per attempt. */
export function logPathFor(
  config: Pick<Config, 'configDir'>,
  job: { id: string; attempt: number },
): string {
  return join(config.configDir, 'logs', 'jobs', `${job.id}.attempt-${job.attempt}.log`);
}

export function stepOf(n: WalkStep): WalkStep {
  return { workflowPath: [...n.workflowPath], nodeId: n.nodeId, port: n.port };
}
