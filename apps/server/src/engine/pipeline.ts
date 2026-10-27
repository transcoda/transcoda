// The job executor: probe → decide → build (prepare), then encode → verify → finish actions
// (execute). Every phase change is written to the job row and published; every trace entry too.
import type { Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Capabilities } from '@transcoda/contract';
import {
  type AnyFinishAction,
  type BuildModel,
  corePluginContext,
  type FileStats,
  type FinishAction,
  type FinishRunContext,
  type FinishRunResult,
  type PluginFinishAction,
  type ProbeResult,
  type StreamPlan,
} from '@transcoda/sdk';
import {
  finishPhaseRank,
  type Issue,
  isPicture,
  type JobPlan,
  type JobState,
  type JsonValue,
  type Lane,
  normalizeLanguage,
  sameLanguage,
  type TraceEntry,
} from '@transcoda/shared';
import {
  devicePlan,
  type EncodeSlot,
  readEncodeDevice,
  slotGpuLabel,
} from '../capabilities/devices.ts';
import { type Exec, makeExec } from '../capabilities/ffmpeg.ts';
import type { Config } from '../config.ts';
import type { Database } from '../db/open.ts';
import { durably } from '../db/open.ts';
import {
  alreadyProcessedReason,
  appendTrace,
  findFinalRealResult,
  findJob,
  hasReplaceJournal,
  insertJobResult,
  type JobPatch,
  type JobRow,
  nextTraceSeq,
  recentRatios,
  setJobProbe,
  updateJob,
  upsertFile,
  type WalkStep,
} from '../db/repos/jobs.ts';
import type { LibraryRow } from '../db/repos/libraries.ts';
import { findRun } from '../db/repos/runs.ts';
import { findWorkflow } from '../db/repos/workflows.ts';
import type { Logger } from '../logger.ts';
import type { NodeRegistry } from '../nodes/registry.ts';
import { type HookName, hookJobOf, type PluginHooksRunner } from '../plugins/hooks.ts';
import type { PluginRestartGate } from '../plugins/restart-gate.ts';
import type { WorkflowService } from '../workflows/service.ts';
import {
  containerCanHold,
  coverFile,
  diffFromProbe,
  encoderUsable,
  extraInputOf,
  isExtraStream,
  isIdentity,
  isMkvCover,
  kept,
  normalizeDefaults,
  outputOrder,
} from './build-model.ts';
import { sourceDecoderNames } from './decoder-names.ts';
import type { CurrentNode, EngineEvents } from './events.ts';
import { ffmpegFailure, looksLikeGpuFailure, softwareFallback } from './fallback.ts';
import { type Fingerprint, fingerprintKey } from './fingerprint.ts';
import { ClobberRefused, errorCode, type FsOps, renameNoClobber } from './fs-ops.ts';
import { loadWorkflowForJob } from './load-workflow.ts';
import { checkPath, isWithin, MAX_SIDECAR_BYTES, SETTLE_MINUTES, skipReasonFor } from './paths.ts';
import { finishRunContext, jobUrl } from './plugin-context.ts';
import { jobProbeOf, probeFailure, probeFile } from './probe.ts';
import type { ProcessSpawner } from './process.ts';
import type { ProgressSample } from './progress.ts';
import { toJobProgress, toVerifyProgress, type VerifyProgress } from './progress.ts';
import { defaultRecycleFolder } from './recycle.ts';
import {
  coverExtractArgs,
  deviceVendor,
  outputExtension,
  type RenderDevice,
  RenderError,
  type RenderInput,
  renderArgs,
  renderCommandLine,
  renderEncoders,
  yuv420Depth,
} from './render.ts';
// Two functions are named replaceOriginal: the finish node (nodes/core/finish.ts) and this one.
import {
  durableReplaceWrites,
  fingerprintFromStats,
  pollForSpace,
  type ReplaceDeps,
  replaceOriginal as replaceOriginalFile,
  spaceWaitText,
} from './replace.ts';
import { autoStreams, retarget } from './retarget.ts';
import type { ExecuteOutcome, JobControl, JobExecutor, SlotFit } from './scheduler.ts';
import { recycleSidecars } from './sidecar-recycle.ts';
import type { SpaceWaits } from './space-waits.ts';
import { removeOrigCopy, settleReplaceNow } from './sweep.ts';
import type { TestOutputStore } from './test-outputs.ts';
import { confirmSourceDamage, verifyOutput } from './verify.ts';
import {
  type DecidedPath,
  type GateBranch,
  type WalkDeps,
  type WalkInput,
  walkBuild,
  walkDecide,
} from './walk.ts';

/** Job progress is written at most this often. */
export const PROGRESS_INTERVAL_MS = 1000;
/** A notify request is abandoned after this long (a warning, never a failure). */
export const NOTIFY_TIMEOUT_MS = 10_000;
/** Results whose after/before ratio feeds a dry run's estimate. */
export const ESTIMATE_HISTORY = 20;
/**
 * ffmpeg's log level for a job (warnings and errors, each line tagged with its level) and a
 * progress report every 0.1 s: the in-pass check tells decoder errors before the first output
 * frame from later ones by whether a report with frames written arrived first.
 */
export const PASS_LOG_ARGS = ['-loglevel', 'level+warning', '-stats_period', '0.1'] as const;
/** The longest reason a finish entry added after the walk keeps (a plugin's answer is shown as is). */
const MAX_TRACE_REASON = 2000;

/** A required plugin finish step that failed with a retryable error is tried once more after this. */
export const PLUGIN_RETRY_MS = 10_000;
/** How often a job paused outside ffmpeg checks whether it was resumed. */
const PAUSE_POLL_MS = 100;
/** The end of a GPU failure's requeue reason (and warning). */
const TRYING_ANOTHER_GPU = '; trying another GPU';
/** Error lines kept for a reason or a warning. */
const MAX_ERROR_LINES = 3;
/** Bytes read from the end of a job log for a failure reason. */
const REASON_TAIL_BYTES = 8 * 1024;
/** A source frame count may differ from the output's by this many frames… */
const FRAME_SLACK = 2;
/** …or this fraction of the count, whichever is larger. */
const FRAME_TOLERANCE = 0.005;

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
interface Prepared {
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
  args: string[];
  command: string;
  /** The encode slot execute got (null: the quick lane, or before execute). */
  slot: EncodeSlot | null;
  /** Set once a failed GPU encode was rerun on the software encoder (only once per attempt). */
  softwareFallback?: boolean;
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
interface Written {
  afterBytes: number;
  replacedTo: 'recycle' | 'deleted' | null;
  /** Where the result now is: the original's path after a replace, the destination of a move-copy. */
  dest: string | null;
  mode: 'replaced' | 'moved' | 'copied' | 'kept';
  lateCancel: boolean;
  problems: string[];
}

type Failure = {
  reason: string;
  /** A second attempt could change the outcome (I/O, encode, verify, finish actions). */
  retry: boolean;
  warnings?: string[];
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `encode` iff any kept video stream (not a picture) is converted; everything else is quick. */
export function laneFor(model: BuildModel, probe: ProbeResult): Lane {
  return kept(model).some((s) => s.type === 'video' && s.mode === 'convert' && !pictureOf(s, probe))
    ? 'encode'
    : 'quick';
}

/**
 * The encode slots a job fits, from its kept video streams in convert mode: a named NVENC
 * encoder needs an NVIDIA slot, a named QSV encoder an Intel one; else auto hardware encoders go
 * on any GPU, and software encodes on any slot.
 */
export function slotFitOf(model: BuildModel, auto: ReadonlySet<number>): SlotFit {
  const video = [...model.streams.entries()].filter(
    ([, s]) => s.keep && s.type === 'video' && s.mode === 'convert',
  );
  const named = video.filter(([i]) => !auto.has(i)).map(([, s]) => s.encoder ?? '');
  if (named.some((e) => e.endsWith('_nvenc'))) return 'nvidia';
  if (named.some((e) => e.endsWith('_qsv'))) return 'intel';
  const hardware = ([i, s]: [number, StreamPlan]) =>
    auto.has(i) && /_(nvenc|qsv)$/.test(s.encoder ?? '');
  return video.some(hardware) ? 'gpu' : 'software';
}

/** A planned stream is a picture when its source is one (isPicture); an added one when flagged. */
function pictureOf(s: StreamPlan, probe: ProbeResult): boolean {
  const src = probe.streams.find((p) => p.index === s.sourceIndex);
  return src ? isPicture(src, probe.streams) : s.attachedPic;
}

/** Median after/before ratio of the workflow's recent `done` results × `beforeBytes`; null without. */
export function estimateBytes(
  db: Database,
  workflowId: string,
  beforeBytes: number,
): number | null {
  const ratios = recentRatios(db, workflowId, ESTIMATE_HISTORY).sort((a, b) => a - b);
  if (ratios.length === 0) return null;
  const mid = Math.floor(ratios.length / 2);
  const median =
    ratios.length % 2 === 1
      ? (ratios[mid] as number)
      : ((ratios[mid - 1] as number) + (ratios[mid] as number)) / 2;
  return Math.round(median * beforeBytes);
}

function actionOf(s: StreamPlan): 'keep' | 'drop' | 'convert' {
  if (!s.keep) return 'drop';
  return s.mode === 'convert' && s.type !== 'data' ? 'convert' : 'keep';
}

/**
 * The model per stream for the job screens: one entry per probe stream (dropped ones `drop`), then
 * one per stream the model adds (a second plan for the same source, e.g. an added audio track).
 * Notes come from diffFromProbe's per-stream lines.
 */
export function planOf(
  model: BuildModel,
  probe: ProbeResult,
  originalLanguage: string | null,
  /** Extra notes per stream (normalizeDefaults), appended to the diff's. */
  extraNotes: ReadonlyMap<StreamPlan, string> = new Map(),
): JobPlan {
  const lines = diffFromProbe(model, probe);
  const notesFor = (type: string, index: number): string[] => {
    const prefix = `${type} #${index}: `;
    return lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
  };
  const dropNote = (type: string, index: number): string => {
    const line = lines.find(
      (l) => l === `drop ${type} #${index}` || l.startsWith(`drop ${type} #${index} (`),
    );
    const m = line ? /\((.*)\)$/.exec(line) : null;
    return m?.[1] ?? '';
  };
  const isOriginal = (language: string | null): boolean =>
    originalLanguage !== null && sameLanguage(language, originalLanguage);
  const streams: JobPlan['streams'] = [];
  const keptOrder = kept(model);
  for (const p of probe.streams) {
    const plans = model.streams.filter((s) => s.sourceIndex === p.index);
    const [first, ...added] = plans;
    const notes = notesFor(p.type, p.index);
    const keptPlans = keptOrder.filter((s) => s.sourceIndex === p.index);
    const diffNoteOf = (s: StreamPlan): string => {
      if (!s.keep) return dropNote(p.type, p.index);
      if (notes.length === keptPlans.length) return notes[keptPlans.indexOf(s)] ?? '';
      return s === keptPlans[0] ? (notes[0] ?? '') : '';
    };
    const noteOf = (s: StreamPlan): string =>
      [diffNoteOf(s), extraNotes.get(s) ?? ''].filter((n) => n !== '').join('; ');
    if (!first) {
      streams.push({
        index: p.index,
        type: p.type,
        codec: p.codec,
        language: p.language,
        title: p.title,
        isOriginalLanguage: isOriginal(p.language),
        default: { before: p.default, after: false },
        forced: p.forced,
        action: 'drop',
        note: dropNote(p.type, p.index),
      });
      continue;
    }
    for (const [n, s] of [first, ...added].entries()) {
      const language = s.keep ? s.language : p.language;
      const note = noteOf(s);
      streams.push({
        index: p.index,
        type: p.type,
        codec: s.keep ? s.codec : p.codec,
        language,
        title: s.keep ? s.title : p.title,
        isOriginalLanguage: isOriginal(language),
        default: { before: n === 0 ? p.default : false, after: s.keep ? s.default : false },
        forced: s.keep ? s.forced : p.forced,
        action: actionOf(s),
        note: n === 0 ? note : note === '' ? 'added' : `added: ${note}`,
      });
    }
  }
  const sidecars = sidecarsOf(model);
  return {
    container: { from: probe.container, to: model.container },
    streams,
    ...(sidecars.length > 0 ? { sidecars } : {}),
    rewrite: !isIdentity(model, probe),
    output: outputOrder(model)
      .filter((s) => !isMkvCover(model, s))
      .map((s) => outputTrack(s, probe)),
  };
}

/**
 * A kept stream as the plan's output track, with its source stream's probe index (null for a
 * track from an extra input file). A video track's bit depth comes from the pixel format
 * it is encoded to, else the source's (a copy, or an encode that keeps the source's format); an
 * audio track's channels from the encode, else the source's. Left out when unknown.
 */
function outputTrack(s: StreamPlan, probe: ProbeResult): NonNullable<JobPlan['output']>[number] {
  const source = s.input ? undefined : probe.streams.find((p) => p.index === s.sourceIndex);
  const track = { type: s.type, codec: s.codec, sourceIndex: s.input ? null : s.sourceIndex };
  if (s.type === 'video') {
    const bitDepth =
      s.pixelFormat !== null ? yuv420Depth(s.pixelFormat) : (source?.bitDepth ?? null);
    return bitDepth === null ? track : { ...track, bitDepth };
  }
  if (s.type === 'audio') {
    const channels = s.channels ?? source?.channels ?? null;
    return channels === null ? track : { ...track, channels };
  }
  return track;
}

/** One entry per extra input file (input order): embedded, or dropped with the reason. */
function sidecarsOf(model: BuildModel): NonNullable<JobPlan['sidecars']> {
  return model.streams
    .filter(isExtraStream)
    .sort((a, b) => (a.input ?? 0) - (b.input ?? 0) || a.order - b.order)
    .flatMap((s) => {
      const input = extraInputOf(model, s);
      if (!input) return [];
      const { file, language, forced, sdh } = input.label;
      const held = containerCanHold(model.container, {
        type: s.type,
        codec: input.codec,
      });
      return [
        {
          file,
          language,
          forced,
          sdh,
          codec: s.codec,
          action: s.keep ? ('embed' as const) : ('drop' as const),
          note: s.keep || held ? '' : "container can't hold it",
        },
      ];
    });
}

/** The first `language` value a data node produced (its findings), normalised; null when unknown. */
function originalLanguageOf(decided: DecidedPath): string | null {
  for (const values of decided.data.values()) {
    const v = values.language;
    if (typeof v === 'string' && v !== 'unknown') {
      const lang = normalizeLanguage(v);
      if (lang !== null) return lang;
    }
  }
  return null;
}

/** `https://host/…`: a webhook URL may carry a token in its path or query. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return 'an invalid URL';
  }
}

/** The last `bytes` of a file as text (from the next full line); '' when it does not exist. */
export async function readTail(path: string, bytes: number): Promise<string> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, 'r');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return '';
    throw err;
  }
  try {
    const size = (await fh.stat()).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    if (start === 0) return text;
    const nl = text.indexOf('\n');
    return nl < 0 ? text : text.slice(nl + 1);
  } finally {
    await fh.close();
  }
}

/**
 * Which side an ffmpeg error-level line (`[error]`/`[fatal]`/`[panic]`, ffmpeg's `level+` tag) came
 * from; null for any other line. `source`: its first context is the source input (`in#0…`), one
 * of its streams (`…ist#0:…`), or a decoder context (`dec:<name>`, or a bare `[<name> @ 0x…]`:
 * libavcodec's own messages) naming a source decoder that is not also an encoder of the job. Everything
 * else (encoders, the muxer, `out#`, extra inputs such as sidecars, unknown or no context) is the
 * output's: a source error leads to replacing the file, so a doubtful line never counts.
 */
export function classifyErrorLine(
  line: string,
  sourceCodecs: ReadonlySet<string>,
  encoders: ReadonlySet<string>,
): 'source' | 'output' | null {
  if (!/\[(error|fatal|panic)\]/.test(line)) return null;
  const m = /^\[([^\]@]+?)(?: @ 0x[0-9a-f]+)?\]/i.exec(line.trim());
  const ctx = m?.[1]?.trim();
  if (!ctx || /^(error|fatal|panic)$/.test(ctx)) return 'output';
  if (/^(in#0\/|[a-z]?ist#0:)/.test(ctx)) return 'source';
  // A decoder may also read an extra input: it counts only when it is one of the source's.
  const decoder = ctx.startsWith('dec:') ? ctx.slice(4) : ctx;
  return sourceCodecs.has(decoder) && !encoders.has(decoder) ? 'source' : 'output';
}

/** A stream's exact frame count (`nb_frames`) and mkvmerge's NUMBER_OF_FRAMES tag (only advisory). */
function sourceFrameCounts(
  probe: ProbeResult,
  index: number,
): { exact: number | null; tag: number | null } {
  const raw = (probe.raw ?? {}) as { streams?: unknown };
  const streams = Array.isArray(raw.streams) ? (raw.streams as Record<string, unknown>[]) : [];
  const s = streams.find((x) => Number(x.index) === index);
  const count = (v: unknown): number | null => {
    const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null;
    return n !== null && n > 0 ? n : null;
  };
  if (!s) return { exact: null, tag: null };
  const tags = (s.tags ?? {}) as Record<string, unknown>;
  return {
    exact: count(s.nb_frames),
    tag: count(tags.NUMBER_OF_FRAMES) ?? count(tags['NUMBER_OF_FRAMES-eng']),
  };
}

/** The kind of a failure the job ends with right away, never retried. */
const final = (reason: string, warnings?: string[]): Failure => ({
  reason,
  retry: false,
  ...(warnings ? { warnings } : {}),
});
const retryable = (reason: string, warnings?: string[]): Failure => ({
  reason,
  retry: true,
  ...(warnings ? { warnings } : {}),
});

class Stop extends Error {}

export class Pipeline implements JobExecutor {
  private readonly prepared = new Map<string, Prepared>();
  /** The warnings of a job's failed GPU encodes, kept across its requeues to another GPU. */
  private readonly gpuWarnings = new Map<string, string[]>();
  private readonly settleMinutes: number;

  constructor(private readonly deps: PipelineDeps) {
    this.settleMinutes = deps.settleMinutes ?? SETTLE_MINUTES;
  }

  // ---- prepare ----

  async prepare(
    job: JobRow,
    ctl: JobControl,
  ): Promise<{ lane: Lane; fit: SlotFit } | { final: true } | ExecuteOutcome> {
    try {
      return await this.runPrepare(job, ctl);
    } catch (err) {
      if (err instanceof Stop) return { final: true };
      throw err;
    }
  }

  private async runPrepare(
    job: JobRow,
    ctl: JobControl,
  ): Promise<{ lane: Lane; fit: SlotFit } | { final: true } | ExecuteOutcome> {
    const { db, config, fs } = this.deps;
    let loaded = loadWorkflowForJob(this.deps.workflows, job);
    const pluginDown = (l: typeof loaded): boolean =>
      l.kind === 'invalid' &&
      l.issues.some((i: Issue) => i.severity === 'error' && i.code === 'PLUGIN_UNAVAILABLE');
    if (pluginDown(loaded) && this.deps.restartGate) {
      // A plugin that is restarting (crashed, in backoff) is waited for, up to its next restart plus
      // the start timeout; one that stopped, is disabled or removed is not, the job fails below.
      const waited = await this.deps.restartGate.waitForRestarts(ctl.signal);
      this.stopIfAborted(ctl);
      if (waited) {
        loaded = loadWorkflowForJob(this.deps.workflows, job);
        if (pluginDown(loaded) && job.attempt === 1) {
          return { requeue: { reason: 'a plugin was still restarting', attempt: 2 } };
        }
      }
    }
    if (loaded.kind === 'not-active') {
      this.finish(job, ctl, 'skipped', { reason: 'workflow is not active' });
      return { final: true };
    }
    if (loaded.kind === 'missing') {
      this.finish(job, ctl, 'failed', { reason: 'workflow missing' });
      return { final: true };
    }
    if (loaded.kind === 'invalid') {
      const errors = loaded.issues.filter((i: Issue) => i.severity === 'error');
      // A plugin that cannot run is named in the reason (the active version cannot start).
      const down = errors.filter((i) => i.code === 'PLUGIN_UNAVAILABLE');
      this.finish(job, ctl, 'failed', {
        reason: `workflow invalid: ${
          down.length > 0 ? down.map((i) => i.message).join('; ') : `${errors.length} error(s)`
        }`,
        warnings: errors.map((i) => `${i.nodeId ? `${i.nodeId}: ` : ''}${i.message}`),
      });
      return { final: true };
    }

    // A real job runs the version active when it starts: re-pin it (its row, events and results
    // then say which version ran).
    const repinned = loaded.version !== job.workflowVersion;
    if (repinned) job = this.update(job, ctl, { workflowVersion: loaded.version });

    // Where the file is now: the path, its library and the identity are checked again, and only
    // realpaths go further (a folder swapped for a symlink since queueing is caught here).
    const check = await checkPath(db, job.path, fs);
    this.stopIfAborted(ctl);
    if (!check.ok) return this.skip(job, ctl, check.reason);
    if (check.library.id !== job.libraryId) return this.skip(job, ctl, 'library changed');
    if (check.realPath !== job.path) return this.skip(job, ctl, 'path now leads to another file');
    const realPath = check.realPath;
    const library = check.library;

    let stat: Stats;
    try {
      stat = await fs.stat(realPath);
    } catch (err) {
      this.stopIfAborted(ctl);
      this.finish(job, ctl, 'failed', { reason: `cannot read the file: ${message(err)}` });
      return { final: true };
    }
    this.stopIfAborted(ctl);
    const fp = fingerprintFromStats(stat);
    const skip = skipReasonFor(fp, stat, library, this.deps.now(), this.settleMinutes);
    // `still growing` too: skipped, never requeued at once (it would be taken again right away).
    if (skip !== null) return this.skip(job, ctl, skip, fp);

    // The version it now runs may have finished this file already (a forced run ignores that).
    if (repinned && !findRun(db, job.runId)?.force) {
      const prior = findFinalRealResult(
        db,
        fingerprintKey(fp),
        job.workflowId,
        job.workflowVersion,
      );
      if (prior) {
        this.finish(
          job,
          ctl,
          'already_processed',
          { reason: alreadyProcessedReason(prior) },
          { fp },
        );
        return { final: true };
      }
    }

    let probe: ProbeResult;
    try {
      probe = await probeFile(realPath, {
        ffprobePath: config.ffprobePath,
        signal: ctl.signal,
        ...(this.deps.exec ? { exec: this.deps.exec } : {}),
      });
    } catch (err) {
      this.stopIfAborted(ctl);
      // The job keeps ffprobe's own reason; the whole error (command and stderr) goes to the log.
      this.deps.log.warn({ msg: 'probe failed', job: job.id, error: message(err) });
      this.finish(
        job,
        ctl,
        'failed',
        { reason: `probe failed: ${probeFailure(err, realPath)}` },
        { fp },
      );
      return { final: true };
    }
    this.stopIfAborted(ctl);
    upsertFile(
      db,
      {
        libraryId: library.id,
        path: realPath,
        fingerprint: fp,
        lastProbe: probe as unknown as JsonValue,
      },
      this.deps.now(),
    );
    setJobProbe(db, job.id, probe as unknown as JsonValue);

    // Decide.
    this.update(job, ctl, { state: 'deciding' });
    const file = fileStatsOf(fp, realPath);
    let lastBuildNode: CurrentNode | null = null;
    const walkDeps = this.walkDeps(job, ctl, (e) => {
      lastBuildNode = { workflowPath: [...e.workflowPath], nodeId: e.nodeId };
    });
    const walkInput: WalkInput = {
      graph: loaded.graph,
      probe,
      file,
      attempt: job.attempt,
      firstSeq: nextTraceSeq(db, job.id),
      dryRun: job.dryRun,
      jobId: job.id,
    };
    const decided = await walkDecide(walkDeps, walkInput);
    this.stopIfAborted(ctl);
    if (decided.kind === 'failed') return this.walkFailed(job, ctl, decided, fp);
    this.update(job, ctl, { walkPath: decided.nodes.map(stepOf) });

    // Build.
    this.update(job, ctl, { state: 'building' });
    const built = await walkBuild(walkDeps, walkInput, decided);
    this.stopIfAborted(ctl);
    if (built.kind === 'failed') return this.walkFailed(job, ctl, built, fp);
    this.update(job, ctl, { walkPath: built.path });
    const { model, actions, gates } = built;
    // Default flags as the output will have them (verify compares them strictly); a model that
    // writes nothing is left as it is.
    const defaultNotes = isIdentity(model, probe) ? new Map() : normalizeDefaults(model);
    const originalLanguage = originalLanguageOf(decided);
    const plan = planOf(model, probe, originalLanguage, defaultNotes);
    const estimatedBytes = estimateBytes(db, job.workflowId, fp.sizeBytes);
    const base = { fp, plan, estimatedBytes };

    if (!plan.rewrite) {
      this.finish(job, ctl, 'nothing_to_do', { reason: 'already as planned' }, base);
      return { final: true };
    }
    if (!actions.some((a) => a.kind === 'replace' || a.kind === 'move-copy')) {
      this.finish(job, ctl, 'kept_original', { reason: 'path never writes the result' }, base);
      return { final: true };
    }

    const tempDir = join(config.transcodeDir, job.id);
    const outputPath = join(tempDir, `out${outputExtension(model.container)}`);
    const coverFiles = new Map<number, string>();
    for (const s of kept(model)) {
      if (isMkvCover(model, s)) {
        coverFiles.set(
          s.sourceIndex,
          join(tempDir, `cover-${s.sourceIndex}.${coverFile(s.codec).ext}`),
        );
      }
    }
    // ffmpeg never opens a sidecar in the library: each is copied into the temp dir first.
    const extraInputFiles = new Map<number, string>();
    for (const [n, e] of (model.extraInputs ?? []).entries()) {
      const ext = /^\.[A-Za-z0-9]{1,8}$/.test(extname(e.path)) ? extname(e.path) : '';
      extraInputFiles.set(n + 1, join(tempDir, `sidecar-${n + 1}${ext}`));
    }
    let args: string[];
    try {
      args = [
        ...PASS_LOG_ARGS,
        ...renderArgs({
          model,
          input: realPath,
          output: outputPath,
          coverFiles,
          extraInputFiles,
          ...this.renderDevice(),
        }),
      ];
    } catch (err) {
      if (!(err instanceof RenderError)) throw err;
      this.finish(job, ctl, 'failed', { reason: `render: ${err.message}` }, base);
      return { final: true };
    }
    const command = renderCommandLine(config.ffmpegPath, args);
    // A job back from a failed GPU keeps saying so; a retry (no failed GPUs) starts clean. After a
    // restart the map is empty: the row's reason still says why it moved.
    if (job.failedGpus.length === 0) this.gpuWarnings.delete(job.id);
    else if (!this.gpuWarnings.has(job.id) && job.reason?.endsWith(TRYING_ANOTHER_GPU)) {
      this.gpuWarnings.set(job.id, [job.reason]);
    }
    const warnings: string[] = [...(this.gpuWarnings.get(job.id) ?? [])];
    if (config.puid !== null && config.puid !== stat.uid) {
      warnings.push(`owner would change from ${stat.uid} to ${config.puid}`);
    }

    if (job.dryRun && !job.testEncode) {
      // The plan cannot know what a gate will decide: the walk lists both branches and the gate
      // says so (the web shows both as possible). A gate before the write makes the outcome
      // "depends on size" (#41), recorded in the plan.
      const decides = sizeGateDecides(actions);
      const dryBase = decides ? { ...base, plan: { ...plan, dependsOnSize: decides } } : base;
      if (gates.some((g) => g.elsePath.length > 0)) {
        // A gate's own step leaves by no port: the result decides, both branches are possible.
        const gateIds = new Set(gates.map((g) => g.nodeId));
        const pass = built.path.map((s) =>
          s.workflowPath.length === 0 && gateIds.has(s.nodeId) ? { ...s, port: null } : s,
        );
        this.update(job, ctl, {
          walkPath: [...pass, ...gates.flatMap((g) => g.elsePath)].map(stepOf),
        });
      }
      for (const g of gates) {
        const min = gateMinimum(actions[g.actionIndex]);
        this.traceGate(job, ctl, g.nodeId, {
          port: null,
          reason: `Size gate: decides after encoding: keep if it saves less than ${min}%`,
          findings: gateFindings(min),
        });
      }
      this.finish(job, ctl, 'dry_run', { reason: null, warnings }, { ...dryBase, command });
      return { final: true };
    }

    const auto = autoStreams(model, built.autoPicks);
    const fit = slotFitOf(model, auto);
    this.prepared.set(job.id, {
      realPath,
      library,
      fp,
      stat,
      probe,
      model,
      autoStreams: auto,
      fit,
      actions,
      gates,
      walkPath: built.path.map(stepOf),
      plan,
      // Retarget and the software fallback keep the streams in order, so each note stays with
      // the stream at its index.
      replan: (other) => {
        const notes = new Map<StreamPlan, string>();
        for (const [i, s] of other.streams.entries()) {
          const note = defaultNotes.get(model.streams[i] as StreamPlan);
          if (note !== undefined) notes.set(s, note);
        }
        return planOf(other, probe, originalLanguage, notes);
      },
      tempDir,
      outputPath,
      logPath: logPathFor(config, job),
      coverFiles,
      extraInputFiles,
      lastBuildNode,
      args,
      command,
      slot: null,
      estimatedBytes,
      warnings,
      outputProbe: null,
      written: null,
    });
    return { lane: laneFor(model, probe), fit };
  }

  // ---- execute ----

  async execute(
    job: JobRow,
    _lane: Lane,
    ctl: JobControl,
    slot: EncodeSlot | null = null,
  ): Promise<ExecuteOutcome | null> {
    const p = this.prepared.get(job.id);
    if (!p) throw new Error(`job ${job.id} was not prepared`);
    p.slot = slot;
    if (slot !== null) {
      // The slot's GPU is known only now: the argv rendered at Build names none (or the pinned one).
      const { device } = slot;
      const vendor = deviceVendor(device);
      let encodedOn: string | null = null;
      if (device !== null && vendor !== null) {
        // Auto's encoders move to the slot's vendor; a named encoder never does. Null (ffmpeg
        // lacks the target, which the slot rules prevent) or a target that cannot render: the
        // job encodes as built.
        const caps = this.capabilitiesOf();
        const usable = caps.encoders.filter((e) => encoderUsable(e, caps));
        const target = retarget(p.model, p.autoStreams, vendor, usable) ?? p.model;
        const moved = target === p.model ? null : this.renderFor(p, target, device);
        if (moved) {
          p.model = target;
          p.plan = p.replan(target);
          p.args = moved;
        } else {
          if (target !== p.model) {
            this.deps.log.warn({
              msg: `could not render for the ${vendor} GPU; encoding as built`,
              job: job.id,
            });
          }
          p.args = [...PASS_LOG_ARGS, ...renderArgs({ ...renderInputOf(p), device })];
        }
        p.command = renderCommandLine(this.deps.config.ffmpegPath, p.args);
        // Only a job that encodes on that GPU names it: not a software encode, not the other
        // vendor's encoder.
        const suffix = vendor === 'nvidia' ? '_nvenc' : '_qsv';
        const onGpu = kept(p.model).some(
          (s) => s.type === 'video' && s.mode === 'convert' && s.encoder?.endsWith(suffix),
        );
        if (onGpu) encodedOn = slotGpuLabel(slot, this.deps.capabilities());
      }
      // A retry clears what an earlier attempt recorded.
      if (job.encodedOn !== encodedOn) job = this.update(job, ctl, { encodedOn });
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
      this.deps.log.error({ msg: 'job pipeline failed', job: job.id, error: message(err) });
      if (p.written !== null) {
        p.written.problems.push(`internal error: ${message(err)}`);
        await this.finishWritten(job, ctl, p, p.written);
        return null;
      }
      return this.conclude(job, ctl, p, {
        kind: 'fail',
        failure: final(`internal error: ${message(err)}`),
      });
    } finally {
      if (ctl.stopReason() !== 'shutdown') this.prepared.delete(job.id);
    }
  }

  /** Deletes the temp dir of a job cancelled while ready, and records its result. */
  async discard(job: JobRow): Promise<void> {
    const p = this.prepared.get(job.id);
    this.prepared.delete(job.id);
    this.gpuWarnings.delete(job.id);
    await this.removeTemp(job.id);
    if (p) this.recordResult(job, p.fp, { ...resultOf(p), outcome: 'cancelled', logPath: null });
  }

  /** Turns how execute ended into the job's outcome; temp goes first (a retry reuses the dir). */
  private async conclude(
    job: JobRow,
    ctl: JobControl,
    p: Prepared,
    end: End,
  ): Promise<ExecuteOutcome | null> {
    if (end.kind === 'settled') return null;
    await this.removeTemp(job.id);
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
    const row = findJob(this.deps.db, job.id) ?? job;
    // Retried once when it may help; never while a replace journal exists (the sweep owns it).
    if (f.retry && row.attempt === 1 && !hasReplaceJournal(this.deps.db, job.id)) {
      return { requeue: { reason: f.reason, attempt: 2 } };
    }
    this.finish(
      row,
      ctl,
      'failed',
      { reason: f.reason, warnings: [...p.warnings, ...(f.warnings ?? [])] },
      resultOf(p),
    );
    return null;
  }

  /** Runs the job to its end. Throws Stop on an abort before anything was written. */
  private async runExecute(job: JobRow, ctl: JobControl, p: Prepared): Promise<End> {
    if (job.dryRun && !job.testEncode) throw new Error('a plan-only dry run reached execute');
    const { fs, config } = this.deps;
    this.stopIfAborted(ctl);
    await fs.mkdir(p.tempDir);
    await fs.mkdir(dirname(p.logPath));
    // Each attempt has its own log, truncated at the start (a requeue reuses the attempt's).
    await fs.truncate(p.logPath);
    this.stopIfAborted(ctl);
    ctl.setCurrentNode(p.lastBuildNode);
    job = this.update(job, ctl, { state: 'encoding', progress: null });

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
          final(`render: subtitle file ${basename(original)} cannot be used: ${message(err)}`),
        );
      }
    }

    // Covers for an mkv output are extracted into the temp dir first (ffmpeg attaches files).
    for (const [index, path] of p.coverFiles) {
      try {
        await this.exec(
          config.ffmpegPath,
          coverExtractArgs(p.realPath, index, path),
          ctl.signal,
          coverTimeoutMs(p.probe.sizeBytes),
        );
      } catch (err) {
        this.stopIfAborted(ctl);
        return fail(final(coverFailure(err, index, coverTimeoutMs(p.probe.sizeBytes))));
      }
      this.stopIfAborted(ctl);
      if (!(await fs.exists(path))) {
        return fail(final(`render: cover video #${index} needs its extracted image file`));
      }
    }

    // Kept test outputs never hold up a real job: the oldest go while scratch space is low.
    if (!job.dryRun) await this.deps.testOutputs?.makeRoom();
    const encoded = await this.encode(job, ctl, p);
    if (encoded !== null) return encoded;
    // Encoded: the GPU is free for the next file while this one is verified and finishes. A retry
    // after a failed verify is queued again and waits for a slot like any job.
    ctl.releaseEncoder?.();

    // Verify. A pause outside ffmpeg (no process to stop) holds the job before verify and before
    // the finish actions until it is resumed.
    job = this.update(job, ctl, { state: 'verifying', progress: null });
    await this.waitWhilePaused(ctl);
    // Each check is written as it is done; the whole-file decode is throttled like an encode.
    let lastVerifyWrite = Number.NEGATIVE_INFINITY;
    const onVerifyProgress = (v: VerifyProgress): void => {
      if (ctl.signal.aborted) return;
      const t = this.deps.now().getTime();
      if (v.stage === 'full-decode' && v.sample.outTimeSeconds > 0) {
        if (t - lastVerifyWrite < PROGRESS_INTERVAL_MS) return;
      }
      lastVerifyWrite = t;
      this.update(job, ctl, { progress: toVerifyProgress(v) });
    };
    const verified = await verifyOutput({
      outputPath: p.outputPath,
      sourcePath: p.realPath,
      model: p.model,
      sourceProbe: p.probe,
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      fullDecode: p.library.verifyFullDecode,
      signal: ctl.signal,
      onProgress: onVerifyProgress,
      ...(this.deps.exec ? { exec: this.deps.exec } : {}),
    });
    this.stopIfAborted(ctl);
    p.warnings.push(...verified.warnings);
    if (verified.ok) p.outputProbe = verified.probe;
    if (!verified.ok) {
      if (verified.kind === 'source-damaged') {
        return this.keepOriginal(
          job,
          ctl,
          p,
          'source has decode errors; nothing was replaced',
          verified.sourceFailures.map((f) => `${f.check}: ${f.message}`),
        );
      }
      return fail(
        retryable(`verify: ${verified.failures.map((f) => `${f.check}: ${f.message}`).join('; ')}`),
      );
    }
    // Finish actions, in order. Once something was written, nothing is retried any more: a later
    // failure (or a stop) ends the job `done` with that problem as its reason and a warning.
    const afterBytes = (await fs.stat(p.outputPath)).size;
    // A test-encode stops here: the gates decide on the measured size, nothing is written.
    if (job.dryRun) return this.endTestEncode(job, ctl, p, afterBytes);
    await this.waitWhilePaused(ctl);
    this.stopIfAborted(ctl);
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
    };
    const wrote = () => p.written !== null;
    /** The highest finish phase a plugin step already ran in (-1: none). */
    let lastPluginRank = -1;
    for (const [actionIndex, action] of p.actions.entries()) {
      if (wrote() && ctl.signal.aborted && ctl.stopReason() === 'shutdown') {
        problems.push(stoppedBefore(ctl));
        break;
      }
      let failure: Failure | null = null;
      try {
        if (action.kind === 'size-gate') {
          const saving = savingPercent(p.fp.sizeBytes, afterBytes);
          const gate = p.gates.find((g) => g.actionIndex === actionIndex);
          if (saving < action.minSavingPercent) {
            const why = `saved only ${saving.toFixed(1)}%, below ${action.minSavingPercent}%`;
            if (!wrote()) {
              const extra = await this.takeElse(job, ctl, p, gate, {
                saving,
                minSavingPercent: action.minSavingPercent,
                afterBytes,
                why,
              });
              return this.keepOriginal(job, ctl, p, why, extra, afterBytes);
            }
            problems.push(`size gate after a write: ${why}`);
          } else if (gate) {
            this.traceGatePass(job, ctl, gate, saving, action.minSavingPercent);
          }
        } else if (action.kind === 'replace') {
          const r = await this.replace(job, ctl, p, action.recycleFolder);
          if (r.kind === 'requeue') {
            if (!wrote()) return r;
            failure = final('file changed during processing');
          } else if (r.kind === 'failure') {
            failure = r.failure;
          } else {
            job = r.job;
            state.replacedTo = r.replacedTo;
            state.dest = p.realPath;
            state.mode = 'replaced';
            state.lateCancel ||= r.lateCancel;
            if (r.problem) problems.push(r.problem);
            markWritten();
            problems.push(...(await this.recycleSidecarsAfterReplace(job, p, r)));
            await this.afterReplace(job, ctl, p, state);
          }
        } else if (action.kind === 'move-copy') {
          failure = await this.moveCopy(job, ctl, p, action, state);
          if (failure === null) {
            markWritten();
            await this.afterReplace(job, ctl, p, state);
          }
        } else if (action.kind === 'notify') {
          await this.notify(job, p, action, afterBytes, state.replacedTo);
        } else if (action.kind === 'plugin') {
          if (!('phase' in action)) {
            problems.push('a finish node that is not a plugin returned a plugin action');
          } else if (finishPhaseRank(action.phase) < lastPluginRank) {
            // Validation (FINISH_ORDER) forbids this; checked again so it is never silent.
            problems.push(
              `${action.description}: skipped, its phase ${action.phase} is earlier than a phase that already ran`,
            );
          } else if (!wrote()) {
            // Unreachable: prepare ends such jobs kept_original, and validation orders them after
            // the write.
            return fail(final('plugin finish step before a write'));
          } else {
            lastPluginRank = finishPhaseRank(action.phase);
            if (!(await this.pluginStep(job, ctl, p, action, state))) {
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
        problems.push(failure.reason);
      }
    }
    if (p.written === null) {
      // Unreachable: prepare only lets a job with replace or move-copy through.
      return fail(final('path never writes the result'));
    }
    await this.finishWritten(job, ctl, p, p.written);
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
        this.recordElseBranch(job, ctl, p, gate, { saving, minSavingPercent: min });
        const why = `saved only ${saving.toFixed(1)}%, below ${min}%`;
        return this.concludeTestEncode(job, ctl, p, 'kept_original', why, afterBytes);
      }
      if (gate) this.traceGatePass(job, ctl, gate, saving, min);
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
    await this.deps.testOutputs?.keep(job.id, p.outputPath, p.model.container);
    await this.removeTemp(job.id);
    this.finish(job, ctl, state, { reason, warnings: p.warnings }, { ...resultOf(p), afterBytes });
    return SETTLED;
  }

  /** Records `done` for a job that wrote its result, with any later problems as its reason. */
  private async finishWritten(
    job: JobRow,
    ctl: JobControl,
    p: Prepared,
    w: Written,
  ): Promise<void> {
    // Temp goes before the final state is written: a retry or the next job may reuse the dir.
    await this.removeTemp(job.id);
    const reason =
      w.problems.length > 0
        ? `finished with a problem: ${w.problems.join('; ')}`
        : w.lateCancel
          ? 'cancelled too late'
          : null;
    this.finish(
      findJob(this.deps.db, job.id) ?? job,
      ctl,
      'done',
      { reason, warnings: [...p.warnings, ...w.problems] },
      {
        ...resultOf(p),
        afterBytes: w.afterBytes,
        replacedTo: w.replacedTo,
        problems: [...w.problems],
      },
    );
  }

  /**
   * Runs ffmpeg and the in-pass checks; null when the output may be verified. Decoder errors
   * before the first output frame (a stream cut mid-GOP) are ignored; a later source-side error
   * keeps the original only when the source reproduces it at that spot.
   */
  private async encode(job: JobRow, ctl: JobControl, p: Prepared): Promise<End | null> {
    const { config } = this.deps;
    const encoders = renderEncoders(p.model);
    const sourceCodecs = sourceDecoderNames(p.probe.streams.map((s) => s.codec));
    let last: ProgressSample | null = null;
    let lastWrite = Number.NEGATIVE_INFINITY;
    let framesOut = false;
    let leading = 0;
    const sourceErrors: { line: string; at: number }[] = [];
    const outputErrors: string[] = [];
    const proc = this.deps.spawner.spawn(config.ffmpegPath, p.args, {
      logPath: p.logPath,
      pidFile: join(p.tempDir, 'ffmpeg.pid'),
      log: this.deps.log,
      onProgress: (s) => {
        last = s;
        if ((s.frames ?? 0) > 0 || s.outTimeSeconds > 0) framesOut = true;
        if (ctl.signal.aborted) return;
        const t = this.deps.now().getTime();
        if (t - lastWrite < PROGRESS_INTERVAL_MS) return;
        lastWrite = t;
        this.update(job, ctl, { progress: toJobProgress(s, p.probe.durationSeconds) });
      },
      onStderrLine: (line) => {
        const side = classifyErrorLine(line, sourceCodecs, encoders);
        if (side === 'output') outputErrors.push(line.trim());
        else if (side === 'source' && !framesOut) leading += 1;
        else if (side === 'source') {
          sourceErrors.push({ line: line.trim(), at: last?.outTimeSeconds ?? 0 });
        }
      },
    });
    ctl.attach(proc);
    let result: Awaited<typeof proc.done>;
    try {
      result = await proc.done;
    } catch (err) {
      ctl.attach(null);
      this.stopIfAborted(ctl);
      return fail(retryable(`ffmpeg could not start: ${message(err)}`));
    }
    ctl.attach(null);
    this.stopIfAborted(ctl);
    if (result.code !== 0) {
      const why =
        result.code === null
          ? `ffmpeg killed by ${result.signal ?? 'a signal'}`
          : `ffmpeg exited ${result.code}`;
      const tail = await readTail(p.logPath, REASON_TAIL_BYTES);
      const cause = ffmpegFailure(tail);
      // The GPU gave up: back to the queue for a GPU it has not failed on, when there is one
      // (never for a software job); else the same plan once more on the software encoder, in
      // this attempt.
      if (!p.softwareFallback && looksLikeGpuFailure(tail)) {
        const { slot } = p;
        const failed = slot?.gpuId ? [...job.failedGpus, slot.gpuId] : null;
        if (slot && failed && p.fit !== 'software' && this.deps.otherGpuFor?.(p.fit, failed)) {
          const reason = `${slot.label} failed (${cause ?? why})${TRYING_ANOTHER_GPU}`;
          this.gpuWarnings.set(job.id, [...(this.gpuWarnings.get(job.id) ?? []), reason]);
          this.deps.log.warn({ msg: 'GPU encode failed, trying another GPU', job: job.id });
          if (job.encodedOn !== null) this.update(job, ctl, { encodedOn: null });
          return { kind: 'requeue', reason, failedGpus: failed };
        }
        const soft = softwareFallback(p.model, this.capabilitiesOf().encoders);
        const args = soft && this.renderFor(p, soft);
        if (soft && args) {
          p.model = soft;
          p.plan = p.replan(soft);
          p.args = args;
          p.command = renderCommandLine(config.ffmpegPath, args);
          p.softwareFallback = true;
          p.warnings.push(`the GPU encode failed (${cause ?? why}); encoded in software instead`);
          this.deps.log.warn({ msg: 'GPU encode failed, retrying in software', job: job.id });
          const row = job.encodedOn === null ? job : this.update(job, ctl, { encodedOn: null });
          return this.encode(row, ctl, p);
        }
      }
      return fail(retryable(cause ? `${why}: ${cause}` : why));
    }
    if (leading > 0) {
      p.warnings.push(`ignored ${leading} decoder error(s) before the first output frame`);
    }
    if (outputErrors.length > 0) {
      const lines = outputErrors.slice(0, MAX_ERROR_LINES);
      return fail(retryable(`encode reported errors: ${lines[0] ?? ''}`, lines));
    }
    if (sourceErrors.length > 0) {
      const lines = sourceErrors.slice(0, MAX_ERROR_LINES).map((e) => e.line);
      const confirmed = await confirmSourceDamage({
        sourcePath: p.realPath,
        sourceProbe: p.probe,
        ffmpegPath: config.ffmpegPath,
        ffprobePath: config.ffprobePath,
        times: sourceErrors.map((e) => e.at),
        signal: ctl.signal,
        ...(this.deps.exec ? { exec: this.deps.exec } : {}),
      });
      this.stopIfAborted(ctl);
      if (confirmed.length > 0) {
        return this.keepOriginal(job, ctl, p, 'source has decode errors; nothing was replaced', [
          ...lines,
          ...confirmed.map((f) => `${f.check}: ${f.message}`),
        ]);
      }
      return fail(
        retryable(
          `encode reported source decode errors the source does not reproduce: ${lines[0] ?? ''}`,
          lines,
        ),
      );
    }
    const videos = kept(p.model).filter((s) => s.type === 'video' && !pictureOf(s, p.probe));
    const sample = last as ProgressSample | null;
    const frames = sample?.frames;
    if (videos.length === 1 && frames !== undefined) {
      const { exact, tag } = sourceFrameCounts(p.probe, (videos[0] as StreamPlan).sourceIndex);
      const off = (n: number) => Math.abs(frames - n) > Math.max(FRAME_SLACK, n * FRAME_TOLERANCE);
      if (exact !== null && off(exact)) {
        return fail(retryable(`encode wrote ${frames} video frames, the source has ${exact}`));
      }
      if (exact === null && tag !== null && off(tag)) {
        p.warnings.push(
          `encode wrote ${frames} video frames; the source tag NUMBER_OF_FRAMES says ${tag}`,
        );
      }
    }
    return null;
  }

  /**
   * After a replace: the embedded sidecars marked `recycle` follow the original into the recycle
   * folder (never on a move-copy or a gate's else). Returns problems, never throws.
   */
  private async recycleSidecarsAfterReplace(
    job: JobRow,
    p: Prepared,
    r: { replacedTo: 'recycle' | 'deleted'; recycleFolder: string; libraryRoot: string },
  ): Promise<string[]> {
    if (job.dryRun) throw new Error('a sidecar recycle step reached a dry run');
    const wanted = p.model.streams.some(
      (s) => s.keep && extraInputOf(p.model, s)?.afterReplace === 'recycle',
    );
    if (!wanted) return [];
    if (r.replacedTo !== 'recycle')
      return ['subtitle files were kept: the library does not recycle'];
    const { db, fs, log, now } = this.deps;
    return recycleSidecars(
      {
        model: p.model,
        jobId: job.id,
        libraryId: p.library.id,
        libraryRoot: r.libraryRoot,
        recycleFolder: r.recycleFolder,
      },
      { fs, recordRecycled: durableReplaceWrites(db, job.id, now, log).recordRecycled, now, log },
    );
  }

  private async replace(
    job: JobRow,
    ctl: JobControl,
    p: Prepared,
    actionFolder: string | null,
  ): Promise<
    | {
        kind: 'done';
        job: JobRow;
        replacedTo: 'recycle' | 'deleted';
        /** The recycle folder the replace used (sidecars follow the original there). */
        recycleFolder: string;
        libraryRoot: string;
        lateCancel: boolean;
        problem: string | null;
      }
    | { kind: 'requeue'; reason: string; requeues: number }
    | { kind: 'failure'; failure: Failure }
  > {
    if (job.dryRun) throw new Error('a replace step reached a dry run');
    const { db, fs, config } = this.deps;
    const failure = (reason: string) => ({ kind: 'failure' as const, failure: final(reason) });
    // Only realpaths reach the replace: the file and its root are resolved again right before it.
    const check = await checkPath(db, p.realPath, fs);
    this.stopIfAborted(ctl);
    if (!check.ok || check.library.id !== p.library.id || check.realPath !== p.realPath) {
      return failure(
        `file moved before the replace: ${check.ok ? 'path now leads elsewhere' : check.reason}`,
      );
    }
    const root = check.library.path;
    if ((await fs.realpath(root)) !== root || (await fs.realpath(p.realPath)) !== p.realPath) {
      return failure('replace needs realpaths of the file and its library root');
    }
    let recycleFolder: string;
    if (actionFolder !== null) {
      // A node's folder stays inside the library root (the library's own setting is the admin's).
      recycleFolder = resolve(root, actionFolder);
      if (!isWithin(recycleFolder, root)) {
        return failure(
          `replace: recycle folder ${actionFolder} is outside the library root ${root}`,
        );
      }
    } else {
      const folder = check.library.recycleFolder ?? defaultRecycleFolder(root);
      recycleFolder = isAbsolute(folder) ? folder : resolve(root, folder);
    }
    ctl.setCurrentNode(null);
    job = this.update(job, ctl, { state: 'replacing', progress: null });
    const result = await replaceOriginalFile(
      {
        jobId: job.id,
        originalPath: p.realPath,
        outputPath: p.outputPath,
        expected: p.fp,
        recycleFolder,
        owner:
          config.puid !== null && config.pgid !== null
            ? { uid: config.puid, gid: config.pgid }
            : null,
        libraryId: check.library.id,
        libraryRoot: root,
      },
      {
        fs,
        // Each write commits on its own with synchronous = FULL (never inside a transaction).
        ...durableReplaceWrites(db, job.id, this.deps.now, this.deps.log),
        waitForSpace: this.deps.waitForSpace ?? pollForSpace,
        // C4: the job says what it waits for ("waiting for 5.4 GB free on /media (5.1 GB free)"),
        // refreshed on every check, and the reason is cleared when the wait is over.
        // Telling must never change how the replace ends: a failed write is a log line.
        onSpaceWait: (wait) => {
          try {
            if (wait === null) this.deps.spaceWaits?.clear(job.id);
            else this.deps.spaceWaits?.set(job.id, wait, this.deps.now());
            const reason = wait === null ? null : spaceWaitText(wait);
            if (reason !== job.reason) job = this.update(job, ctl, { reason });
          } catch (err) {
            this.deps.log.warn({
              msg: 'could not record the wait for free space',
              job: job.id,
              error: message(err),
            });
          }
        },
        now: this.deps.now,
        log: this.deps.log,
        signal: ctl.signal,
      },
    );
    if (result.kind === 'cancelled') {
      // Nothing on disk changed; a cancel ends the job, a shutdown leaves it to the sweep.
      throw new Stop();
    }
    if (result.kind === 'fingerprint-changed') {
      if (ctl.stopReason() === 'shutdown') throw new Stop();
      const fresh = findJob(db, job.id) ?? job;
      if (fresh.requeues < 1) {
        return {
          kind: 'requeue',
          reason: 'file changed during processing',
          requeues: fresh.requeues + 1,
        };
      }
      return failure('file changed during processing');
    }
    if (result.kind === 'failed') {
      const what = `replace: ${result.step}: ${result.message}`;
      // Nothing moved yet: final (the check that refused will refuse again).
      if (result.step === 'checking') return failure(what);
      // Past the check: settled now from what is on disk, with the sweep's rules.
      const row = findJob(db, job.id) ?? job;
      const settled = await settleReplaceNow(db, { fs, log: this.deps.log }, row, this.deps.now());
      if (settled === 'completed') {
        // The file was replaced: done either way (a `.orig` that cannot be removed keeps the
        // journal, and the next start's sweep finishes the cleaning).
        const now = findJob(db, job.id);
        const j = now?.replaceJournal ?? null;
        const recovered = `${what}; recovered: the replacement is installed`;
        const done = (problem: string) => ({
          kind: 'done' as const,
          job: now ?? job,
          replacedTo: j?.recycling === false ? ('deleted' as const) : ('recycle' as const),
          recycleFolder,
          libraryRoot: root,
          lateCancel: false,
          problem,
        });
        if (j === null || (await removeOrigCopy({ fs, log: this.deps.log }, job.id, j))) {
          if (j !== null) {
            durably(db, () => updateJob(db, job.id, { replaceJournal: null }, this.deps.now()));
          }
          return done(recovered);
        }
        return done(
          `${recovered}; the original copy ${j.copyPath} could not be removed, the next start retries`,
        );
      }
      if (settled === 'rolledBack') return failure(`${what}; original restored`);
      if (settled === 'cleared') return failure(`${what}; nothing was replaced`);
      // conflicts: the sweep's reason says what is left (the journal may stay for the next start).
      return failure(findJob(db, job.id)?.reason ?? what);
    }
    // Replaced: recorded even during a shutdown (the sweep would otherwise requeue a replaced file).
    return {
      kind: 'done',
      job,
      replacedTo: result.recyclePath !== null ? 'recycle' : 'deleted',
      recycleFolder,
      libraryRoot: root,
      lateCancel: ctl.stopReason() === 'cancel',
      problem: null,
    };
  }

  /**
   * Copies (or moves) the output to `outputRoot/<path relative to the library root>` through a
   * tmp beside the destination and a no-clobber rename. Abort-aware: a cancel or shutdown while
   * it writes removes the tmp and throws Stop.
   */
  private async moveCopy(
    job: JobRow,
    ctl: JobControl,
    p: Prepared,
    action: Extract<FinishAction, { kind: 'move-copy' }>,
    state: Written,
  ): Promise<Failure | null> {
    if (job.dryRun) throw new Error('a move-copy step reached a dry run');
    const { fs, config } = this.deps;
    const root = resolve(action.outputRoot);
    const allowed = config.outputRoots.map((r) => resolve(r));
    if (!allowed.some((r) => isWithin(root, r))) {
      return final(`move-copy: ${action.outputRoot} is not a configured output root`);
    }
    const rel = relative(p.library.path, p.realPath);
    const stem = rel.slice(0, rel.length - extname(rel).length);
    const dest = join(root, `${stem}${extname(p.outputPath)}`);
    if (!isWithin(dest, root)) return final(`move-copy: ${dest} is outside ${root}`);
    const tmp = join(dirname(dest), `.transcoda-${job.id}.tmp`);
    /** Removes the tmp; returns the error text when it could not. */
    const dropTmp = async (): Promise<string> => {
      try {
        await fs.unlink(tmp);
        return '';
      } catch (err) {
        return errorCode(err) === 'ENOENT' ? '' : `; could not remove ${tmp}: ${message(err)}`;
      }
    };
    this.stopIfAborted(ctl);
    try {
      await fs.mkdir(dirname(dest));
      if (await fs.exists(dest)) return final(`move-copy: ${dest} already exists`);
      await fs.copyFile(p.outputPath, tmp);
      if (ctl.signal.aborted) {
        const left = await dropTmp();
        if (left) p.warnings.push(`move-copy${left}`);
        throw new Stop();
      }
      if (config.puid !== null && config.pgid !== null) {
        try {
          await fs.chown(tmp, config.puid, config.pgid);
        } catch (err) {
          if (errorCode(err) !== 'EPERM') throw err;
        }
      }
      await renameNoClobber(fs, tmp, dest);
    } catch (err) {
      if (err instanceof Stop) throw err;
      const left = await dropTmp();
      if (err instanceof ClobberRefused) return final(`move-copy: ${dest} already exists${left}`);
      return retryable(`move-copy: ${message(err)}${left}`);
    }
    state.dest = dest;
    state.mode = action.mode === 'move' ? 'moved' : 'copied';
    if (action.mode === 'move') {
      try {
        await fs.unlink(p.outputPath);
      } catch (err) {
        p.warnings.push(
          `move-copy: could not remove the moved output ${p.outputPath}: ${message(err)}`,
        );
      }
    }
    return null;
  }

  /** Sends the summary; a failure is a warning (with the URL redacted), never a job failure. */
  private async notify(
    job: JobRow,
    p: Prepared,
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
      if (!res.ok) p.warnings.push(`notify ${where} answered ${res.status}`);
    } catch (err) {
      const why = message(err).split(action.url).join(where);
      p.warnings.push(`notify ${where} failed: ${why}`);
    }
  }

  /** Adds a size-gate entry to the job's trace (the branch it took, or that it depends). */
  private traceGate(
    job: JobRow,
    ctl: JobControl,
    nodeId: string,
    o: { port: 'pass' | 'else' | null; reason: string; findings: GateFindings },
  ): void {
    this.traceFinish(job, ctl, { nodeId, workflowPath: [], source: 'core', ...o });
  }

  /** Traces a gate that passed on the measured size. */
  private traceGatePass(
    job: JobRow,
    ctl: JobControl,
    gate: GateBranch,
    saving: number,
    minSavingPercent: number,
  ): void {
    this.traceGate(job, ctl, gate.nodeId, {
      port: 'pass',
      reason: `Size gate: saved ${saving.toFixed(1)}%, at least ${minSavingPercent}% \u2192 yes`,
      findings: gateFindings(minSavingPercent, saving),
    });
  }

  /**
   * Adds a finish-phase entry to the job's trace after the walk: a size gate's branch, or a
   * plugin finish step's own answer (after the walk's planned entry for that node).
   */
  private traceFinish(
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
    const now = this.deps.now().toISOString();
    const entry: TraceEntry = {
      seq: nextTraceSeq(this.deps.db, job.id),
      attempt: job.attempt,
      nodeId: o.nodeId,
      workflowPath: [...o.workflowPath],
      phase: 'finish',
      source: o.source,
      port: o.port,
      reason:
        o.reason.length > MAX_TRACE_REASON
          ? `${o.reason.slice(0, MAX_TRACE_REASON - 1)}…`
          : o.reason,
      findings: o.findings ?? {},
      startedAt: o.startedAt ?? now,
      endedAt: now,
    };
    appendTrace(this.deps.db, job.id, entry);
    this.events().publish({ type: 'job.trace', jobId: job.id, entry });
  }

  /**
   * A gate failed before anything was written: records the branch, moves the job's walk onto
   * `else` and runs the notifications and other non-writing steps wired there (the result is
   * discarded, so nothing can write). A step that fails or is cut short by a stop is a warning:
   * the original is kept either way. Returns the warnings for the job.
   */
  private async takeElse(
    job: JobRow,
    ctl: JobControl,
    p: Prepared,
    gate: GateBranch | undefined,
    g: { saving: number; minSavingPercent: number; afterBytes: number; why: string },
  ): Promise<string[]> {
    const out: string[] = [];
    if (!gate) return out;
    this.recordElseBranch(job, ctl, p, gate, g);
    const kept: Written = {
      afterBytes: g.afterBytes,
      replacedTo: null,
      dest: null,
      mode: 'kept',
      lateCancel: false,
      problems: [],
    };
    let lastRank = -1;
    for (const action of gate.elseActions) {
      try {
        if (action.kind === 'notify') {
          await this.notify(job, p, action, g.afterBytes, null, {
            outcome: 'kept_original',
            reason: g.why,
          });
        } else if (action.kind === 'plugin' && 'phase' in action) {
          if (finishPhaseRank(action.phase) < lastRank) {
            out.push(
              `${action.description}: skipped, its phase ${action.phase} is earlier than a phase that already ran`,
            );
            continue;
          }
          lastRank = finishPhaseRank(action.phase);
          const done = await this.pluginStep(job, ctl, p, action, kept, {
            savedPercent: Math.round(g.saving * 10) / 10,
            minSavingPercent: g.minSavingPercent,
          });
          if (!done) {
            out.push(stoppedBefore(ctl));
            break;
          }
        } else {
          out.push(
            `skipped a ${action.kind} step: nothing can be written behind the size gate\u2019s No branch`,
          );
        }
      } catch (err) {
        if (!(err instanceof Stop)) throw err;
        out.push(stoppedBefore(ctl));
        break;
      }
    }
    // A required plugin step's failure is a problem on a written job; here it is a warning.
    return [...out, ...kept.problems];
  }

  /**
   * A gate failed: records the `else` branch on the trace and moves the job's walk onto it (the
   * pass steps after the gate were never taken). Runs nothing.
   */
  private recordElseBranch(
    job: JobRow,
    ctl: JobControl,
    p: Prepared,
    gate: GateBranch | undefined,
    g: { saving: number; minSavingPercent: number },
  ): void {
    if (!gate) return;
    this.traceGate(job, ctl, gate.nodeId, {
      port: 'else',
      reason: `Size gate: saved ${g.saving.toFixed(1)}%, below ${g.minSavingPercent}% \u2192 no`,
      findings: gateFindings(g.minSavingPercent, g.saving),
    });
    const at = p.walkPath.findIndex((s) => s.workflowPath.length === 0 && s.nodeId === gate.nodeId);
    if (at >= 0) {
      this.update(job, ctl, {
        walkPath: [
          ...p.walkPath.slice(0, at),
          { workflowPath: [], nodeId: gate.nodeId, port: 'else' },
          ...gate.elsePath,
        ].map(stepOf),
      });
    }
  }

  // ---- outcomes ----

  private async keepOriginal(
    job: JobRow,
    ctl: JobControl,
    p: Prepared,
    reason: string,
    extra: string[],
    afterBytes: number | null = null,
  ): Promise<End> {
    await this.removeTemp(job.id);
    this.finish(
      job,
      ctl,
      'kept_original',
      { reason, warnings: [...p.warnings, ...extra] },
      { ...resultOf(p), afterBytes },
    );
    return SETTLED;
  }

  private async cancelled(job: JobRow, ctl: JobControl, p: Prepared): Promise<void> {
    await this.removeTemp(job.id);
    this.finish(job, ctl, 'cancelled', { warnings: p.warnings }, resultOf(p));
  }

  private skip(job: JobRow, ctl: JobControl, reason: string, fp?: Fingerprint): { final: true } {
    this.finish(job, ctl, 'skipped', { reason }, fp ? { fp } : {});
    return { final: true };
  }

  private walkFailed(
    job: JobRow,
    ctl: JobControl,
    f: { nodeId: string; reason: string; path: WalkStep[]; retryable: boolean },
    fp: Fingerprint,
  ): { final: true } | ExecuteOutcome {
    const last = f.path.at(-1);
    if (last) ctl.setCurrentNode({ workflowPath: last.workflowPath, nodeId: last.nodeId });
    const reason = f.nodeId ? `${f.nodeId}: ${f.reason}` : f.reason;
    // A plugin hook that failed in a way a second attempt may fix: the same retry-once rule as
    // the encode (nothing has been written yet).
    if (f.retryable && job.attempt === 1) return { requeue: { reason, attempt: 2 } };
    this.update(job, ctl, { walkPath: f.path });
    this.finish(job, ctl, 'failed', { reason }, { fp });
    return { final: true };
  }

  /**
   * Records a final state: the row (no lane, no progress) and, when the file was fingerprinted, a
   * result; then `run.changed`.
   */
  private finish(
    job: JobRow,
    ctl: JobControl,
    state: JobState,
    o: { reason?: string | null; warnings?: string[] },
    r: Partial<Omit<ResultInput, 'outcome'>> & { fp?: Fingerprint } = {},
  ): void {
    const { db } = this.deps;
    this.gpuWarnings.delete(job.id);
    const row = db.transaction(() => {
      const updated = this.write(job.id, {
        state,
        reason: o.reason ?? null,
        lane: null,
        progress: null,
      });
      if (r.fp)
        this.recordResult(updated, r.fp, { ...r, outcome: state, warnings: o.warnings ?? [] });
      return updated;
    })();
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

  private workflowName(id: string): string {
    return findWorkflow(this.deps.db, id, { includeDeleted: true })?.name ?? '';
  }

  /**
   * Tells the plugins about a finished job without holding the job (its lane) while they answer:
   * every failure is a log line inside the runner. Skipped for a dry run and during a shutdown
   * (the plugins are going away).
   */
  private fireHook(hook: HookName, ctl: JobControl, job: ReturnType<typeof hookJobOf>): void {
    const { hooks } = this.deps;
    if (!hooks || job.dryRun || ctl.stopReason() === 'shutdown') return;
    hooks.run(hook, job).catch((err: unknown) => {
      this.deps.log.warn({ msg: 'plugin hook failed', hook, jobId: job.id, error: message(err) });
    });
  }

  /**
   * `afterReplace`: right after the write, before the next action (a plugin step may rely on the
   * plugin having seen it). Bounded by the runner's timeout and by a cancel or shutdown.
   */
  private async afterReplace(job: JobRow, ctl: JobControl, p: Prepared, w: Written): Promise<void> {
    if (job.dryRun) throw new Error('an afterReplace hook reached a dry run');
    const { hooks } = this.deps;
    if (!hooks) return;
    const row = findJob(this.deps.db, job.id) ?? job;
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
      this.workflowName(row.workflowId),
      jobUrl(this.deps.config.publicUrl, row.id),
    );
    const gone = abortPromise(ctl.signal);
    try {
      await Promise.race([hooks.run('afterReplace', payload), gone.promise]);
    } catch (err) {
      this.deps.log.warn({
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
  private async pluginStep(
    job: JobRow,
    ctl: JobControl,
    p: Prepared,
    action: PluginFinishAction,
    w: Written,
    gate: NonNullable<FinishRunContext['gate']> | null = null,
  ): Promise<boolean> {
    if (job.dryRun) throw new Error('a plugin finish step reached a dry run');
    const { registry } = this.deps;
    const ctx = finishRunContext(
      {
        probe: p.probe,
        file: fileStatsOf(p.fp, p.realPath),
        data: {},
        capabilities: this.capabilitiesOf(),
        log: (m) =>
          this.deps.log.info({ msg: 'node log', job: job.id, node: action.nodeId, message: m }),
        plugin: corePluginContext({ dryRun: false, job: { id: job.id, attempt: job.attempt } }),
      },
      {
        originalPath: p.realPath,
        newPath: w.dest ?? p.realPath,
        replacedTo: w.replacedTo,
        beforeBytes: p.fp.sizeBytes,
        afterBytes: w.afterBytes,
        outcome: w.mode,
        containerChanged: w.mode !== 'kept' && p.model.container !== p.probe.container,
        problemsSoFar: [...w.problems],
        gate,
        jobUrl: jobUrl(this.deps.config.publicUrl, job.id),
        workflowName: this.workflowName(job.workflowId),
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
    const startedAt = this.deps.now().toISOString();
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
      this.deps.log.info({
        msg: 'plugin finish step',
        jobId: job.id,
        nodeId: action.nodeId,
        message: result.message,
      });
    } else if (action.required) {
      w.problems.push(result.message);
    } else {
      p.warnings.push(`${action.description}: ${result.message}`);
    }
    // The step's own answer on the job (C2), as the job page and get_job show it. The plugin
    // process has already redacted it with the plugin's secrets (`redactResult`), like the log line.
    this.traceFinish(job, ctl, {
      nodeId: action.nodeId,
      workflowPath: action.workflowPath,
      source: 'plugin',
      port: null,
      reason: result.ok ? result.message : `failed: ${result.message}`,
      startedAt,
    });
    return true;
  }

  /** Replaces the job's result row (delete + insert in one transaction). */
  private recordResult(
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
        // Only an outcome that stands on the verified output keeps its probe: a failed or
        // cancelled job threw that output away.
        outputProbe: OUTPUT_OUTCOMES.has(r.outcome) ? (r.outputProbe ?? null) : null,
        createdAt: this.deps.now().toISOString(),
      });
    })();
  }

  // ---- helpers ----

  private walkDeps(
    job: JobRow,
    ctl: JobControl,
    onBuildEntry: (entry: TraceEntry) => void,
  ): WalkDeps {
    return {
      registry: this.deps.registry,
      resolveChild: (id, version, overrides) =>
        this.deps.workflows.resolvePinnedChild(id, version, overrides),
      now: this.deps.now,
      onTrace: (entry: TraceEntry) => {
        if (ctl.stopReason() === 'shutdown') return;
        if (entry.phase === 'build') onBuildEntry(entry);
        appendTrace(this.deps.db, job.id, entry);
        this.events().publish({ type: 'job.trace', jobId: job.id, entry });
      },
      onNodeStart: (node) => {
        if (!ctl.signal.aborted) ctl.setCurrentNode(node);
      },
      capabilities: this.capabilitiesOf(),
      log: (m) => this.deps.log.info({ msg: 'node log', job: job.id, message: m }),
    };
  }

  /** The GPU the "Encoding device" setting names, when it is detected; nothing for auto and CPU. */
  private renderDevice(): { device?: RenderDevice } {
    const { device } = devicePlan(this.deps.capabilities(), readEncodeDevice(this.deps.db));
    return device ? { device } : {};
  }

  /** What hook contexts report: the probed ffmpeg's encoders, filters and hwaccels (none when unprobed). */
  private capabilitiesOf(): { encoders: string[]; filters: string[]; hwaccels: string[] } {
    const caps = this.deps.capabilities();
    return caps.available
      ? { encoders: caps.encoders, filters: caps.filters, hwaccels: caps.hwaccels }
      : { encoders: [], filters: [], hwaccels: [] };
  }

  /** The ffmpeg arguments for another plan of the same prepared job; null when it cannot render. */
  private renderFor(p: Prepared, model: BuildModel, device?: RenderDevice): string[] | null {
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

  private exec(
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

  private events(): EngineEvents {
    return this.deps.events;
  }

  /** Waits while the user has the job paused; throws Stop on a cancel or shutdown meanwhile. */
  private async waitWhilePaused(ctl: JobControl): Promise<void> {
    while (ctl.paused()) {
      this.stopIfAborted(ctl);
      await new Promise((r) => setTimeout(r, PAUSE_POLL_MS));
    }
    this.stopIfAborted(ctl);
  }

  /** Throws Stop when the job was cancelled or the server is stopping. */
  private stopIfAborted(ctl: JobControl): void {
    if (ctl.signal.aborted) throw new Stop();
  }

  private write(id: string, patch: JobPatch): JobRow {
    const row = updateJobOrThrow(this.deps.db, id, patch, this.deps.now());
    return row;
  }

  private update(job: JobRow, ctl: JobControl, patch: JobPatch): JobRow {
    const row = this.write(job.id, patch);
    ctl.changed(row);
    return row;
  }

  private async removeTemp(jobId: string): Promise<void> {
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

/** How execute ended: settled (recorded), a requeue for the scheduler, or a failure. */
type End =
  | { kind: 'settled' }
  | { kind: 'requeue'; reason: string; requeues?: number; failedGpus?: string[] }
  | { kind: 'fail'; failure: Failure };
const SETTLED: End = { kind: 'settled' };
const fail = (failure: Failure): End => ({ kind: 'fail', failure });

type ResultInput = {
  outcome: JobState;
  afterBytes: number | null;
  estimatedBytes: number | null;
  command: string | null;
  plan: JobPlan | null;
  replacedTo: 'recycle' | 'deleted' | null;
  logPath: string | null;
  warnings: string[];
  problems: string[];
  /** The verified output's probe as the job page reads it (a JobProbe: no raw JSON). */
  outputProbe: JsonValue | null;
};

/** Outcomes whose result keeps the verified output's probe (written, measured, or measured and kept). */
const OUTPUT_OUTCOMES: ReadonlySet<JobState> = new Set(['done', 'kept_original', 'dry_run']);

/** The problem recorded when a stop cuts the finish actions after a write. */
function stoppedBefore(ctl: JobControl): string {
  const why = ctl.stopReason();
  return `${why === 'shutdown' ? 'the server stopped' : (why ?? 'stopped')} before the remaining finish actions`;
}

/** Resolves `'aborted'` once the signal aborts (with that reason when `only` is given). */
function abortPromise(
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
function fileStatsOf(fp: Fingerprint, path: string): FileStats {
  return {
    path,
    sizeBytes: fp.sizeBytes,
    mtime: new Date(fp.mtimeMs).toISOString(),
    nlink: fp.nlink,
  };
}

/** How much smaller the output is than the original, in percent (0 for an empty original). */
function savingPercent(before: number, after: number): number {
  return before > 0 ? ((before - after) / before) * 100 : 0;
}

/** What Build rendered the argv from, to render it again on the slot's device. */
function renderInputOf(p: Prepared): RenderInput {
  return {
    model: p.model,
    input: p.realPath,
    output: p.outputPath,
    coverFiles: p.coverFiles,
    extraInputFiles: p.extraInputFiles,
  };
}

/** The result fields every outcome of a prepared job carries. */
function resultOf(p: Prepared): { fp: Fingerprint } & Partial<ResultInput> {
  return {
    fp: p.fp,
    plan: p.plan,
    estimatedBytes: p.estimatedBytes,
    command: p.command,
    logPath: p.logPath,
    outputProbe: p.outputProbe && (jobProbeOf(p.outputProbe) as unknown as JsonValue),
  };
}

/**
 * A size gate's decision entry's findings: the minimum saving and, once measured, the saving
 * (percent, one decimal), so screens need not read them out of the reason.
 */
type GateFindings = { minSavingPercent: number; savedPercent?: number };

function gateFindings(minSavingPercent: number, saving?: number): GateFindings {
  return saving === undefined
    ? { minSavingPercent }
    : { minSavingPercent, savedPercent: Math.round(saving * 10) / 10 };
}

/** `<configDir>/logs/jobs/<jobId>.attempt-<n>.log`: one log per attempt. */
export function logPathFor(
  config: Pick<Config, 'configDir'>,
  job: { id: string; attempt: number },
): string {
  return join(config.configDir, 'logs', 'jobs', `${job.id}.attempt-${job.attempt}.log`);
}

/**
 * Whether a size gate decides the outcome: the strictest minimum saving of the size gates before
 * the first replace or move-copy in the walked actions; null without a write or without such a
 * gate. A gate on a branch not taken or a bypassed gate adds no action, so it never counts.
 */
export function sizeGateDecides(
  actions: readonly AnyFinishAction[],
): { minSavingPercent: number } | null {
  let min: number | null = null;
  for (const a of actions) {
    if (a.kind === 'replace' || a.kind === 'move-copy') {
      return min === null ? null : { minSavingPercent: min };
    }
    if (a.kind === 'size-gate') min = Math.max(min ?? a.minSavingPercent, a.minSavingPercent);
  }
  return null;
}

/** The minimum saving of a size-gate action (0 if the action is something else). */
function gateMinimum(action: AnyFinishAction | undefined): number {
  return action?.kind === 'size-gate' ? action.minSavingPercent : 0;
}

function stepOf(n: WalkStep): WalkStep {
  return { workflowPath: [...n.workflowPath], nodeId: n.nodeId, port: n.port };
}

/** Cover extraction copies one image; a minute is plenty even on a slow share. */
const coverExec: Exec = makeExec({ timeout: 60_000, maxBuffer: 1024 * 1024 });

/**
 * Copying a cover out reads the whole file (ffmpeg reaches the picture's packet only after the
 * rest: about 3 min for a 30 GB remux on a hard disk), so the limit grows with the file: 60 s plus
 * 1 s per 100 MB.
 */
export function coverTimeoutMs(sizeBytes: number): number {
  return 60_000 + Math.ceil(Math.max(0, sizeBytes) / 100_000_000) * 1000;
}

/** Why a cover could not be copied out, in one line: a timeout in words, else ffmpeg's last error. */
export function coverFailure(err: unknown, index: number, timeoutMs: number): string {
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    killed?: unknown;
    stderr?: unknown;
  };
  if (e.killed === true) {
    const minutes = Math.round(timeoutMs / 60_000);
    return `render: copying the cover (video #${index}) out of the file took longer than ${minutes} min and was stopped`;
  }
  const lines = (typeof e.stderr === 'string' ? e.stderr : '').trim().split('\n').filter(Boolean);
  const last = lines
    .at(-1)
    ?.replace(/^\[[^\]]* @ 0x[0-9a-f]+\]\s*/i, '')
    .trim();
  return `render: the cover (video #${index}) could not be copied out of the file${last ? `: ${last}` : ''}`;
}

function updateJobOrThrow(db: Database, id: string, patch: JobPatch, now: Date): JobRow {
  const row = updateJob(db, id, patch, now);
  if (row === null) throw new Error(`job ${id} vanished`);
  return row;
}
