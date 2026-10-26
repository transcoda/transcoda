import type { DeviceProfileId, FinishPhase, JsonValue, ProbeSummary } from '@transcoda/shared';
import type { PluginContext } from './context.ts';

export interface FileStats {
  path: string;
  sizeBytes: number;
  mtime: string;
  nlink: number;
}

export interface ProbeResult extends ProbeSummary {
  formatName: string;
  chapters: number;
  raw: JsonValue;
}

/** Data-port values: a missing/unknown source resolves to 'unknown'. */
export type DataValue = JsonValue | 'unknown';

export interface HookContextBase {
  probe: ProbeResult;
  file: FileStats;
  /** By input port id. */
  data: Record<string, DataValue>;
  capabilities: { encoders: string[]; filters: string[]; hwaccels: string[] };
  log(message: string): void;
  /** Core nodes get `corePluginContext()`; plugin nodes get their own plugin's context. */
  plugin: PluginContext;
}

export interface DecideContext extends HookContextBase {
  /** The walk's clock (epoch ms), so a decide hook stays pure. */
  now: number;
}
export interface DecideResult {
  port: string;
  reason: string;
  findings?: Record<string, JsonValue>;
}

export interface BuildContext extends HookContextBase {
  model: BuildModel;
}
export interface BuildResult {
  model: BuildModel;
  reason: string;
  findings?: Record<string, JsonValue>;
}

export interface FinishContext extends HookContextBase {
  model: BuildModel;
}
export type FinishAction =
  | { kind: 'size-gate'; minSavingPercent: number }
  | { kind: 'replace'; recycleFolder: string | null }
  | { kind: 'move-copy'; mode: 'move' | 'copy'; outputRoot: string }
  | { kind: 'notify'; url: string; method: 'POST' | 'PUT' }
  /** What a plugin finish hook returns; `run` does the work after the write. */
  | { kind: 'plugin'; description: string; required: boolean };
export interface FinishResult {
  actions: FinishAction[];
  reason: string;
}

/** What the walker stores for a plugin action: the hook's action plus where it came from. */
export interface PluginFinishAction {
  kind: 'plugin';
  description: string;
  required: boolean;
  phase: FinishPhase;
  nodeType: string;
  nodeVersion: number;
  nodeId: string;
  workflowPath: string[];
  settings: Record<string, JsonValue>;
}
/** What the walker returns and the pipeline loops over. */
export type AnyFinishAction = FinishAction | PluginFinishAction;

/** The context of a plugin finish `run`, called after the write. */
export interface FinishRunContext extends HookContextBase {
  originalPath: string;
  newPath: string;
  replacedTo: 'recycle' | 'deleted' | null;
  beforeBytes: number;
  afterBytes: number;
  /**
   * `kept`: the step sits behind a size gate's `else`. The original was kept, `newPath` is
   * `originalPath`, `replacedTo` is null and `afterBytes` is the size of the discarded result.
   */
  outcome: 'replaced' | 'moved' | 'copied' | 'kept';
  containerChanged: boolean;
  problemsSoFar: string[];
  /**
   * Set (only) behind a size gate's `else`: how much the result saved and the gate's minimum
   * (both %). Core always sends `null` elsewhere; optional so existing test contexts still compile.
   */
  gate?: { savedPercent: number; minSavingPercent: number } | null | undefined;
  /** The job's page in the UI (`TRANSCODA_PUBLIC_URL` + `/jobs/<id>`); null when no public URL is configured. */
  jobUrl: string | null;
  /** The job's workflow name, as the job page shows it. */
  workflowName: string;
}
export type FinishRunResult =
  | { ok: true; message: string }
  | { ok: false; message: string; retryable?: boolean | undefined };

export interface DataContext extends HookContextBase {}
/**
 * A data node with one `data:*` output returns that port's value as `value`. With several
 * outputs `value` must be an object keyed by output id (`{ language, title, ids }`): each port
 * gets its own key; anything else makes every port `'unknown'`.
 */
export interface DataResult {
  value: DataValue;
  reason: string;
}

export const STREAM_PLAN_TYPES = ['video', 'audio', 'subtitle', 'attachment', 'data'] as const;

/**
 * `data` streams (mp4 tmcd timecode, mkv metadata tracks) are always kept in copy mode, never
 * converted, and are ignored by identity comparison, target checks and verify's per-stream match
 * (counted only).
 */
export interface StreamPlan {
  /**
   * The probe index of the source stream. A stream from an extra input has `sourceIndex = -input`
   * (never a probe index) and is read as stream 0 of that input.
   */
  sourceIndex: number;
  /**
   * 1-based index into `BuildModel.extraInputs` for a stream that comes from an extra input file;
   * absent or 0 means the source. Plugin build hooks may read it but never change it.
   */
  input?: number | undefined;
  type: (typeof STREAM_PLAN_TYPES)[number];
  keep: boolean;
  mode: 'copy' | 'convert';
  codec: string;
  encoder: string | null;
  quality: number | null;
  preset: string | null;
  /**
   * Audio: the target bitrate. Video: alone, a target bitrate; with `quality`, capped quality (the
   * encoder keeps the quality but never spends more than this bitrate).
   */
  bitrateKbps: number | null;
  channels: number | null;
  profile: string | null;
  pixelFormat: string | null;
  language: string | null;
  title: string | null;
  default: boolean;
  forced: boolean;
  /** Cover art (`attached_pic`); exempt from target checks, never encoded. */
  attachedPic: boolean;
  /** Other ffprobe disposition flags carried through verbatim (comment, hearing_impaired, …). */
  dispositions: string[];
  order: number;
  /**
   * Why a node dropped the stream, when its language alone does not say (`same as audio #1 (AAC
   * 2.0 English)`): the plan's note for the dropped stream. Read only while `keep` is false.
   */
  dropReason?: string | undefined;
}

/** A file read next to the source: a subtitle sidecar. Streams from it carry `StreamPlan.input`. */
export interface ExtraInput {
  /** Absolute realpath of a file beside the source (a subtitle sidecar). */
  path: string;
  kind: 'subtitle';
  /** After a successful replace: leave the file, or move it to the recycle folder. */
  afterReplace: 'keep' | 'recycle';
  /**
   * The file's own subtitle codec: picks the ffmpeg demuxer (`-f`) and lets the diff say
   * `convert subrip→mov_text` after `fitToContainer` rewrites the stream's codec.
   */
  codec: string;
  /** For plan/diff text: language (639-2/T or null), forced, sdh, the file's base name. */
  label: { file: string; language: string | null; forced: boolean; sdh: boolean };
}

export interface BuildModel {
  container: 'mkv' | 'mp4';
  streams: StreamPlan[];
  /**
   * Extra input files, in input order (`-i` 1, 2, …). Only core nodes may add or change them: the
   * walker fails a plugin build hook that does.
   */
  extraInputs?: ExtraInput[] | undefined;
  targets: DeviceProfileId[];
  inputArgs: string[];
  globalArgs: string[];
}
