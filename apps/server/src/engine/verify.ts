// Output verification: re-probe the encoded file and check it against the build model before any
// replace. Every check runs and failures accumulate (except an unreadable output: probe only).
import type { BuildModel, ProbeResult, StreamPlan } from '@transcoda/sdk';
import { DEVICE_PROFILES, type ProbeStream, sameLanguage } from '@transcoda/shared';
import { type Exec, makeExec } from '../capabilities/ffmpeg.ts';
import { extraInputOf, isExtraStream, isMkvCover, outputOrder } from './build-model.ts';
import { READ_FAILURE } from './decoder-names.ts';
import { probeFile } from './probe.ts';
import { type ProgressSample, progressReader, type VerifyProgress } from './progress.ts';
import { containerPlaysOn, streamPlaysOn, type TargetIssue } from './targets.ts';

export type { VerifyProgress } from './progress.ts';

export type VerifyFailure = {
  check:
    | 'probe'
    | 'duration'
    | 'stream-count'
    | 'stream-match'
    | 'sidecars'
    | 'defaults'
    | 'decode-start'
    | 'decode-end'
    | 'decode-sample'
    | 'decode-full'
    | 'targets';
  message: string;
};

export interface VerifyInput {
  outputPath: string;
  /** The original; output decode failures are re-checked on it (`source-damaged`). */
  sourcePath: string;
  model: BuildModel;
  sourceProbe: ProbeResult;
  ffmpegPath: string;
  ffprobePath: string;
  exec?: Exec;
  /** One-second spots decoded across the output besides its start and end (default 10). */
  sampleSpots?: number;
  /** Decode the whole output too (the library's `verifyFullDecode`). */
  fullDecode?: boolean;
  /** Aborts every ffprobe/ffmpeg run (cancel, shutdown); the result is then meaningless. */
  signal?: AbortSignal;
  /**
   * Called as each check is done (the output probe, each stream end, each spot decode: `checks`),
   * as the whole-file decode moves (`full-decode`, from its `-progress`), and when the source is
   * re-decoded after a decode failure (`source`).
   */
  onProgress?: (p: VerifyProgress) => void;
}

/**
 * `warnings`: kept non-default audio/subtitle tracks some target cannot play (allowed, controller
 * ruling R1), as `<type> #<output index> won't direct-play on <target>`, and a source header that
 * claims a longer duration than its streams have.
 *
 * `kind` on a failure: `source-damaged` only when every failure is a decode failure of an output
 * stream and its source stream fails the same decode check (`sourceFailures` says how): re-encoding
 * cannot fix it, the pipeline keeps the original without a retry. Otherwise `output-invalid`
 * (duration mismatches always are).
 */
export type VerifyResult =
  | { ok: true; probe: ProbeResult; warnings: string[] }
  | {
      ok: false;
      kind: 'output-invalid' | 'source-damaged';
      failures: VerifyFailure[];
      sourceFailures: VerifyFailure[];
      probe: ProbeResult | null;
      warnings: string[];
    };

/** A stream end may differ by this much plus the duration of its last frame/packet. */
const END_TOLERANCE = 0.25;
/** A tail read starts this many seconds before the expected stream end… */
const TAIL_BEFORE = 2;
/** …and stops this many seconds after it, so it never scans the whole file. */
const TAIL_AFTER = 3;
/** Packets ending this close to a read's end mean the stream may run on: read further. */
const EDGE = 1;
/** An end search never goes further than this from where the stream was expected to end. */
const MAX_SEARCH = 600;
/** decode-end starts at the last keyframe at least this far before the end. */
const DECODE_END_SECONDS = 3;
/** A keyframe search looks back this far before giving up. */
const MAX_KEYFRAME_SEARCH = 120;
/** A source header this much longer than every kept stream is stale (a warning). */
const STALE_GAP = 2;
/** Seeking `ffmpeg -ss` lands on a time far beyond any file: the demuxer's last seek point. */
const BEYOND_END = 1e7;
/**
 * Formats whose time seek does not land on a keyframe (it lands mid-GOP and the decoder reports
 * missing references); decode-end opens them at the keyframe's byte offset instead.
 */
const BYTE_SEEK_FORMATS = new Set(['mpegts', 'mpeg']);

/** Decoding a second of a large file on a busy CPU can take a while; never hang forever. */
const verifyExec: Exec = makeExec({ timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });

/** A whole-file decode of a long film on a busy CPU takes a while; still never forever. */
const fullDecodeExec: Exec = makeExec({ timeout: 6 * 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });

/** Every call of `exec` carries `signal` (a cancel or shutdown kills the running tool). */
function withSignal(exec: Exec, signal: AbortSignal | undefined): Exec {
  return signal ? (file, args, opts) => exec(file, args, { ...opts, signal }) : exec;
}

/** Default number of sampled one-second spots (Jan's verify-depth decision). */
export const SAMPLE_SPOTS = 10;

type RunResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; detail: string; exited: boolean; stderr: string };

/**
 * Runs a tool; a non-zero exit, a timeout or a spawn error is `ok: false` with its first line.
 * `exited`: the tool ran and exited with a code of its own (not killed by the time or output
 * limit, a signal, or never started).
 */
async function run(exec: Exec, file: string, args: string[]): Promise<RunResult> {
  try {
    return { ok: true, ...(await exec(file, args)) };
  } catch (err) {
    const e = (err ?? {}) as {
      stderr?: unknown;
      message?: unknown;
      code?: unknown;
      killed?: unknown;
    };
    const stderr = typeof e.stderr === 'string' ? e.stderr : '';
    const detail = firstLine(stderr) ?? firstLine(String(e.message ?? err));
    const exited = typeof e.code === 'number' && e.killed !== true;
    return { ok: false, detail: detail ?? 'failed', exited, stderr };
  }
}

function firstLine(text: string): string | null {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? null
  );
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Matroska's per-stream `DURATION` tag, `HH:MM:SS.fffffffff`, in seconds. */
function tagDuration(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

type RawStream = Record<string, unknown>;

/** The ffprobe JSON behind a probe: its `format` and `streams` (empty when absent). */
function rawOf(probe: ProbeResult): { format: Record<string, unknown>; streams: RawStream[] } {
  const raw = (probe.raw ?? {}) as { format?: unknown; streams?: unknown };
  const format =
    raw.format !== null && typeof raw.format === 'object'
      ? (raw.format as Record<string, unknown>)
      : {};
  const streams = Array.isArray(raw.streams) ? (raw.streams as RawStream[]) : [];
  return { format, streams };
}

/** A stream's own duration: ffprobe `duration`, else the mkv `DURATION` tag. */
function streamDuration(s: RawStream | undefined): number | null {
  if (!s) return null;
  const tags = (s.tags ?? {}) as Record<string, unknown>;
  const d = num(s.duration) ?? tagDuration(tags.DURATION ?? tags.duration);
  return d !== null && d > 0 ? d : null;
}

/**
 * The source's duration as its header states it: the container duration, else its longest stream
 * duration (ffprobe `duration` or the mkv `DURATION` tag); null when neither is known.
 */
export function referenceDuration(probe: ProbeResult): number | null {
  if (probe.durationSeconds > 0) return probe.durationSeconds;
  let longest: number | null = null;
  for (const s of rawOf(probe).streams) {
    const d = streamDuration(s);
    if (d !== null && (longest === null || d > longest)) longest = d;
  }
  return longest;
}

/** A file under verification: times in it are measured from `start` (its first timestamp). */
interface MediaFile {
  path: string;
  probe: ProbeResult;
  start: number;
  /** Open at a byte offset for decode-end (see BYTE_SEEK_FORMATS). */
  byteSeek: boolean;
  /** Stream ends (file time) found so far, by stream index. */
  ends: Map<number, number>;
}

/**
 * Where a file's timeline starts: the container start_time, else the earliest stream start_time,
 * else the first packet's pts. mpegts typically starts at 1.4 s, a remux of it at 0.
 */
async function mediaFile(
  exec: Exec,
  ffprobePath: string,
  path: string,
  probe: ProbeResult,
): Promise<MediaFile> {
  const { format, streams } = rawOf(probe);
  const byteSeek = probe.formatName.split(',').some((f) => BYTE_SEEK_FORMATS.has(f));
  const own = num(format.start_time);
  const ends = new Map<number, number>();
  if (own !== null) return { path, probe, start: own, byteSeek, ends };
  const starts = streams.map((s) => num(s.start_time)).filter((t): t is number => t !== null);
  if (starts.length > 0) return { path, probe, start: Math.min(...starts), byteSeek, ends };
  const r = await run(exec, ffprobePath, [
    '-v',
    'error',
    '-read_intervals',
    '%+#1',
    '-show_entries',
    'packet=pts_time',
    '-of',
    'csv=p=0',
    path,
  ]);
  const first = r.ok ? num(firstLine(r.stdout)?.split(',')[0]) : null;
  return { path, probe, start: first ?? 0, byteSeek, ends };
}

/** ffprobe `-read_intervals` for [from, to] in file time (open start when at the file start). */
function interval(file: MediaFile, from: number, to: number): string {
  const t = (x: number) => String(Math.round((file.start + x) * 1000) / 1000);
  return from <= 0 ? `%${t(to)}` : `${t(from)}%${t(to)}`;
}

/** Packet rows `entries` of stream `index` in [from, to] (file time); null when ffprobe fails. */
async function packets(
  exec: Exec,
  ffprobePath: string,
  file: MediaFile,
  index: number,
  range: string,
  entries: string,
): Promise<string[][] | { error: string }> {
  const r = await run(exec, ffprobePath, [
    '-v',
    'error',
    '-select_streams',
    String(index),
    '-read_intervals',
    range,
    '-show_entries',
    `packet=${entries}`,
    '-of',
    'csv=p=0',
    file.path,
  ]);
  if (!r.ok) return { error: r.detail };
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => l.split(','));
}

/** Where a stream's packets end (`pts + duration` of its last packet, file time) and that duration. */
type StreamEnd = { end: number; last: number };

type EndSearch =
  | ({ kind: 'end' } & StreamEnd)
  | { kind: 'none'; searched: number }
  | { kind: 'beyond'; at: number }
  | { kind: 'unreadable'; detail: string };

/**
 * Finds where stream `index` ends, starting with the window [expected − TAIL_BEFORE, expected +
 * TAIL_AFTER]. No packets there: look further back (×4 each time, at most MAX_SEARCH, `none`
 * after that). Packets up to the window's end: the stream runs on, read further ahead (likewise
 * bounded, `beyond` after that). A truncated file keeps its header duration but has no packets
 * there, which this catches; a seek past the end lands on the last seek point, so a stale header
 * costs one read.
 */
async function findEnd(
  exec: Exec,
  ffprobePath: string,
  file: MediaFile,
  index: number,
  expected: number,
): Promise<EndSearch> {
  let at = expected;
  let before = TAIL_BEFORE;
  let after = TAIL_AFTER;
  for (;;) {
    const from = at - before;
    const to = at + after;
    const rows = await packets(
      exec,
      ffprobePath,
      file,
      index,
      interval(file, from, to),
      'pts_time,duration_time',
    );
    if (!Array.isArray(rows)) return { kind: 'unreadable', detail: rows.error };
    let best: StreamEnd | null = null;
    for (const [pts, duration] of rows) {
      const t = num(pts);
      if (t === null) continue;
      const last = num(duration) ?? 0;
      const end = t + last - file.start;
      if (!best || end > best.end) best = { end, last };
    }
    if (best) {
      if (best.end < to - EDGE) return { kind: 'end', ...best };
      if (to - expected >= MAX_SEARCH) return { kind: 'beyond', at: best.end };
      at = best.end;
      before = TAIL_BEFORE;
      after = Math.min(after * 4, MAX_SEARCH);
      continue;
    }
    if (from <= 0 || expected - from >= MAX_SEARCH) {
      return { kind: 'none', searched: Math.min(expected, expected - from) };
    }
    before = Math.min(before * 4, expected - at + MAX_SEARCH);
  }
}

/**
 * The file's measured end (latest packet end of any stream, file time) read from the demuxer's
 * last seek point; null when nothing can be read.
 */
async function measuredEnd(
  exec: Exec,
  ffprobePath: string,
  file: MediaFile,
): Promise<number | null> {
  const r = await run(exec, ffprobePath, [
    '-v',
    'error',
    '-read_intervals',
    `${BEYOND_END}%`,
    '-show_entries',
    'packet=pts_time,duration_time',
    '-of',
    'csv=p=0',
    file.path,
  ]);
  if (!r.ok) return null;
  let end: number | null = null;
  for (const line of r.stdout.split('\n')) {
    const [pts, duration] = line.trim().split(',');
    const t = num(pts);
    if (t === null) continue;
    const e = t + (num(duration) ?? 0) - file.start;
    if (end === null || e > end) end = e;
  }
  return end;
}

/** Output media streams (video other than covers, audio) with the plan entry they came from. */
function mediaPairs(
  model: BuildModel,
  probe: ProbeResult,
): { out: ProbeStream; plan: StreamPlan }[] {
  const plans = outputOrder(model);
  return [...probe.streams]
    .sort((a, b) => a.index - b.index)
    .flatMap((out, i) => {
      const plan = plans[i];
      const media = (out.type === 'video' && !out.attachedPic) || out.type === 'audio';
      return media && plan ? [{ out, plan }] : [];
    });
}

function secs(n: number): string {
  return `${n.toFixed(2)}s`;
}

/**
 * Each output media stream must end where its source stream ends, both measured from their own
 * file's start, within END_TOLERANCE plus the longer of the two last packet durations. Each source
 * stream's end is searched for around its own expected end (its stream duration, else the file's),
 * and the output stream around that end. Every stream is compared; whatever cannot be is a
 * failure. Returns the source stream ends too (for the stale-header warning).
 */
async function durationCheck(
  exec: Exec,
  ffprobePath: string,
  model: BuildModel,
  source: MediaFile,
  output: MediaFile,
  tick: () => void,
): Promise<{ failures: VerifyFailure[]; sourceEnds: number[] }> {
  const fail = (message: string): VerifyFailure => ({ check: 'duration', message });
  const failures: VerifyFailure[] = [];
  const sourceEnds: number[] = [];
  const pairs = mediaPairs(model, output.probe);
  if (pairs.length === 0) return { failures, sourceEnds };
  const { streams } = rawOf(source.probe);
  let fileEnd = referenceDuration(source.probe);
  if (fileEnd === null) fileEnd = await measuredEnd(exec, ffprobePath, source);
  const compare = async ({ out, plan }: (typeof pairs)[number]): Promise<void> => {
    const name = `output #${out.index} (${plan.type} #${plan.sourceIndex})`;
    const raw = streams.find((s) => num(s.index) === plan.sourceIndex);
    const own = streamDuration(raw);
    const rawStart = num(raw?.start_time);
    const expected = own !== null ? (rawStart ?? source.start) + own - source.start : fileEnd;
    if (expected === null) {
      failures.push(fail(`the source's end cannot be read, so ${name} cannot be compared`));
      return;
    }
    const src = await findEnd(exec, ffprobePath, source, plan.sourceIndex, expected);
    if (src.kind === 'unreadable') {
      failures.push(
        fail(`the end of source stream #${plan.sourceIndex} cannot be read: ${src.detail}`),
      );
      return;
    }
    if (src.kind === 'none') {
      failures.push(
        fail(
          `source stream #${plan.sourceIndex} has no packets in the ${secs(src.searched)} before its expected end at ${secs(expected)}, so ${name} cannot be compared`,
        ),
      );
      return;
    }
    if (src.kind === 'beyond') {
      failures.push(
        fail(
          `source stream #${plan.sourceIndex} runs on past ${secs(src.at)}, far beyond its expected end at ${secs(expected)}, so ${name} cannot be compared`,
        ),
      );
      return;
    }
    sourceEnds.push(src.end);
    source.ends.set(plan.sourceIndex, src.end);
    const o = await findEnd(exec, ffprobePath, output, out.index, src.end);
    if (o.kind === 'unreadable') {
      failures.push(fail(`the end of ${name} cannot be read: ${o.detail}`));
    } else if (o.kind === 'none') {
      failures.push(
        fail(
          `${name} ends early: no packets in the ${secs(o.searched)} before the source stream ends at ${secs(src.end)}`,
        ),
      );
    } else if (o.kind === 'beyond') {
      failures.push(
        fail(`${name} runs on past ${secs(o.at)}, the source stream ends at ${secs(src.end)}`),
      );
    } else {
      output.ends.set(out.index, o.end);
      if (Math.abs(o.end - src.end) > END_TOLERANCE + Math.max(o.last, src.last)) {
        failures.push(
          fail(`${name} ends at ${secs(o.end)}, the source stream at ${secs(src.end)}`),
        );
      }
    }
  };
  for (const pair of pairs) {
    await compare(pair);
    tick();
  }
  return { failures, sourceEnds };
}

/** Plan and output stream are a source cover and the mkv attachment it was written as. */
function coverMatches(out: ProbeStream, plan: StreamPlan): boolean {
  return (
    (out.type === 'attachment' || (out.type === 'video' && out.attachedPic)) &&
    out.codec === plan.codec
  );
}

function lang(l: string | null): string {
  return l ?? 'und';
}

/** Differences between a kept stream and the output stream at its position. */
function streamMismatches(model: BuildModel, plan: StreamPlan, out: ProbeStream): string[] {
  const file = extraInputOf(model, plan)?.label.file;
  const name = `output #${out.index} (${
    file === undefined ? `${plan.type} #${plan.sourceIndex}` : `${plan.type} from ${file}`
  })`;
  if (isMkvCover(model, plan)) {
    return coverMatches(out, plan)
      ? []
      : [`${name}: expected cover ${plan.codec}, got ${out.type} ${out.codec}`];
  }
  if (out.type !== plan.type) return [`${name}: expected ${plan.type}, got ${out.type}`];
  if (plan.type === 'data') return [];
  const problems: string[] = [];
  if (out.codec !== plan.codec) problems.push(`codec ${out.codec}, expected ${plan.codec}`);
  const sameLang =
    (plan.language === null && out.language === null) || sameLanguage(plan.language, out.language);
  if (!sameLang) problems.push(`language ${lang(out.language)}, expected ${lang(plan.language)}`);
  const flag = (what: string, want: boolean, got: boolean) => {
    if (want !== got)
      problems.push(want ? `not ${what}, expected ${what}` : `${what}, expected not ${what}`);
  };
  flag('default', plan.default, out.default);
  flag('forced', plan.forced, out.forced);
  flag('attached_pic', plan.attachedPic, out.attachedPic);
  return problems.map((p) => `${name}: ${p}`);
}

/**
 * An mp4 muxer writes the chapters as a QuickTime chapter track of its own (a `bin_data` data
 * stream), whether or not the source had one, so on an mp4 those tracks are left out of the
 * comparison on both sides. An mkv keeps its chapters in the container and counts every stream.
 */
function chapterTrack(model: BuildModel, s: { type: string; codec: string }): boolean {
  return model.container === 'mp4' && s.type === 'data' && s.codec === 'bin_data';
}

/** The kept streams against the output's, in order: count, then type, codec, language and flags. */
export function streamFailures(model: BuildModel, probe: ProbeResult): VerifyFailure[] {
  const plans = outputOrder(model).filter((s) => !chapterTrack(model, s));
  const outs = [...probe.streams]
    .sort((a, b) => a.index - b.index)
    .filter((s) => !chapterTrack(model, s));
  const failures: VerifyFailure[] = [];
  if (plans.length !== outs.length) {
    failures.push({
      check: 'stream-count',
      message: `output has ${outs.length} streams, the plan keeps ${plans.length}`,
    });
  }
  plans.forEach((plan, i) => {
    const out = outs[i];
    if (!out) return;
    for (const message of streamMismatches(model, plan, out)) {
      failures.push({ check: 'stream-match', message });
    }
  });
  return failures;
}

/**
 * Every sidecar stream the plan keeps must be in the output as a subtitle with its language tag
 * at its position. That only confirms the track and its tag survived: ffprobe cannot tell
 * whether the subtitle's text is really in that language (the tag comes from the file name).
 * Counted apart from stream-match so a lost sidecar reads as what it is.
 */
export function sidecarFailures(model: BuildModel, probe: ProbeResult): VerifyFailure[] {
  const plans = outputOrder(model);
  const outs = [...probe.streams].sort((a, b) => a.index - b.index);
  const sidecars = plans.filter(isExtraStream);
  if (sidecars.length === 0) return [];
  const present = plans.filter((plan, i) => {
    const out = outs[i];
    return (
      isExtraStream(plan) &&
      out?.type === 'subtitle' &&
      ((plan.language === null && out.language === null) ||
        sameLanguage(plan.language, out.language))
    );
  });
  return present.length === sidecars.length
    ? []
    : [
        {
          check: 'sidecars',
          message: `embedded ${present.length} of ${sidecars.length} subtitle files`,
        },
      ];
}

/** Exactly one default audio when the output has audio; at most one default subtitle. */
function defaultFailures(probe: ProbeResult): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  const audio = probe.streams.filter((s) => s.type === 'audio');
  const audioDefaults = audio.filter((s) => s.default).length;
  if (audio.length > 0 && audioDefaults !== 1) {
    failures.push({
      check: 'defaults',
      message: `${audioDefaults} default audio tracks, expected exactly one`,
    });
  }
  const subDefaults = probe.streams.filter((s) => s.type === 'subtitle' && s.default).length;
  if (subDefaults > 1) {
    failures.push({
      check: 'defaults',
      message: `${subDefaults} default subtitle tracks, expected at most one`,
    });
  }
  return failures;
}

type DecodeCheck = 'decode-start' | 'decode-end' | 'decode-sample' | 'decode-full';

/**
 * Where decode-end starts in `file`: the last keyframe of `anchor` (its first video stream other
 * than covers, else its first audio stream) at least DECODE_END_SECONDS before that stream's end.
 * Returns ffmpeg input options plus the input URL; null when no keyframe was found.
 */
async function endSeek(
  exec: Exec,
  ffprobePath: string,
  file: MediaFile,
  anchor: number,
  anchorEnd: number,
): Promise<{ args: string[]; from: number } | null> {
  const target = Math.max(0, anchorEnd - DECODE_END_SECONDS);
  let back = 10;
  for (;;) {
    const from = target - back;
    const rows = await packets(
      exec,
      ffprobePath,
      file,
      anchor,
      interval(file, from, target + TAIL_AFTER),
      'pts_time,pos,flags',
    );
    if (!Array.isArray(rows)) return null;
    let best: { pts: number; pos: number | null } | null = null;
    let first: { pts: number; pos: number | null } | null = null;
    // ffprobe prints packet fields in its own order: pts_time, pos, flags.
    for (const [pts, pos, flags] of rows) {
      const t = num(pts);
      if (t === null || !flags?.includes('K')) continue;
      const k = { pts: t - file.start, pos: num(pos) };
      if (!first || k.pts < first.pts) first = k;
      if (k.pts <= target && (!best || k.pts > best.pts)) best = k;
    }
    // A file shorter than the window: its first keyframe.
    const pick = best ?? (from <= 0 ? first : null);
    if (pick) {
      if (file.byteSeek) {
        if (pick.pos === null) return null;
        return {
          args: ['-i', `subfile,,start,${pick.pos},end,0,,:file:${file.path}`],
          from: pick.pts,
        };
      }
      return { args: ['-ss', Math.max(0, pick.pts).toFixed(6), '-i', file.path], from: pick.pts };
    }
    if (from <= 0 || back >= MAX_KEYFRAME_SEARCH) return null;
    back = Math.min(back * 4, MAX_KEYFRAME_SEARCH);
  }
}

/** A decode run's input options, stream maps, and how it is named in messages. */
interface DecodeRun {
  input: string[];
  maps: string[];
  where: string;
  /** Output options before the null muxer (the whole-file decode's `-progress`). */
  output?: string[];
}

/**
 * A failed decode. `decodeError`: ffmpeg ran to its own exit and reported what it read; false when
 * the run says nothing about the file's content (ffmpeg could not start, was killed by the time or
 * output limit, or could not read the file: a disk or network share problem). Only a decode error
 * can confirm source damage.
 */
type Decoded = { failure: VerifyFailure; decodeError: boolean };

/**
 * Decodes the run and reports a failure for a non-zero exit or any error-level message: ffmpeg
 * exits 0 on a truncated file and only reports `File ended prematurely`. `-copyts` keeps the null
 * muxer quiet about timestamps after a seek.
 */
async function decode(
  exec: Exec,
  ffmpegPath: string,
  check: DecodeCheck,
  r: DecodeRun,
  prefix: string,
): Promise<Decoded | null> {
  const res = await run(exec, ffmpegPath, [
    '-nostdin',
    '-hide_banner',
    '-v',
    'error',
    '-xerror',
    ...r.input,
    ...r.maps.flatMap((m) => ['-map', m]),
    '-copyts',
    ...(r.output ?? []),
    '-f',
    'null',
    '-',
  ]);
  if (!res.ok) {
    return {
      failure: { check, message: `${prefix}decoding ${r.where} failed: ${res.detail}` },
      decodeError: res.exited && !READ_FAILURE.test(res.stderr),
    };
  }
  const error = firstLine(res.stderr);
  return error === null
    ? null
    : {
        failure: { check, message: `${prefix}decoding ${r.where} reported: ${error}` },
        decodeError: !READ_FAILURE.test(res.stderr),
      };
}

/** How decode-start and decode-end open `file` (stream maps are added per run). */
async function decodeInputs(
  exec: Exec,
  ffprobePath: string,
  file: MediaFile,
  isOutput: boolean,
): Promise<Record<'decode-start' | 'decode-end', { input: string[]; where: string } | null>> {
  const start = { input: ['-t', '1', '-i', file.path], where: 'the first second' };
  const streams = [...file.probe.streams].sort((a, b) => a.index - b.index);
  const anchor =
    streams.find((s) => s.type === 'video' && !s.attachedPic) ??
    streams.find((s) => s.type === 'audio');
  if (!anchor) return { 'decode-start': start, 'decode-end': null };
  let end = file.ends.get(anchor.index) ?? null;
  if (end === null) {
    const reference = referenceDuration(file.probe) ?? (await measuredEnd(exec, ffprobePath, file));
    const found =
      reference === null ? null : await findEnd(exec, ffprobePath, file, anchor.index, reference);
    end = found?.kind === 'end' ? found.end : null;
  }
  const seek = end === null ? null : await endSeek(exec, ffprobePath, file, anchor.index, end);
  if (seek) {
    return {
      'decode-start': start,
      'decode-end': { input: seek.args, where: `the end from ${secs(seek.from)}` },
    };
  }
  // No keyframe found: the output still has its end decoded (its own index seek; an error fails
  // it, the safe direction); a byte-seek source would only report missing references.
  const fallback = {
    input: ['-sseof', `-${DECODE_END_SECONDS}`, '-i', file.path],
    where: 'the end',
  };
  return { 'decode-start': start, 'decode-end': isOutput || !file.byteSeek ? fallback : null };
}

/** One decode of the output and how the same part of the source is opened (null: it cannot be). */
interface Spot {
  check: DecodeCheck;
  out: { input: string[]; where: string };
  src: { input: string[]; where: string } | null;
  exec: Exec;
}

/** When the `n` sampled spots of the output start (file time); none in an output under 4 s. */
function spotTimes(probe: ProbeResult, n: number): Set<number> {
  const length = referenceDuration(probe);
  const times = new Set<number>();
  if (length === null || n <= 0 || length < 4) return times;
  for (let i = 0; i < n; i += 1) {
    const t = Math.round(((i + 0.5) / n) * length * 10) / 10;
    if (t >= 1 && t <= length - 2) times.add(t);
  }
  return times;
}

/**
 * `n` one-second spots spread evenly across the output (file time), each at least a second from
 * the start and two from the end (decode-start and decode-end cover those), each opened at a
 * keyframe: input `-ss` on mkv/mp4 seeks to the keyframe before the spot; a byte-seek format
 * (mpegts), whose time seek lands mid-GOP, is opened at the byte offset of the anchor stream's last
 * keyframe at or before the spot (as decode-end does). The source is opened the same way at the
 * same time from its own start; a spot without a keyframe found is decoded on neither side.
 */
async function sampleSpots(
  exec: Exec,
  ffprobePath: string,
  output: MediaFile,
  source: MediaFile,
  n: number,
  skip: () => void,
): Promise<Spot[]> {
  const times = spotTimes(output.probe, n);
  const anchorOf = (file: MediaFile) => {
    const streams = [...file.probe.streams].sort((a, b) => a.index - b.index);
    return (
      streams.find((s) => s.type === 'video' && !s.attachedPic) ??
      streams.find((s) => s.type === 'audio')
    );
  };
  const open = async (file: MediaFile, t: number) => {
    const where = `1 s at ${secs(t)}`;
    if (!file.byteSeek) {
      return { input: ['-ss', t.toFixed(3), '-t', '1', '-i', file.path], where };
    }
    const anchor = anchorOf(file);
    if (!anchor) return null;
    // endSeek picks the last keyframe at least DECODE_END_SECONDS before the given end.
    const seek = await endSeek(exec, ffprobePath, file, anchor.index, t + DECODE_END_SECONDS);
    if (!seek) return null;
    const i = seek.args.indexOf('-i');
    return {
      input: [...seek.args.slice(0, i), '-t', '1', ...seek.args.slice(i)],
      where: `1 s at ${secs(seek.from)}`,
    };
  };
  const spots: Spot[] = [];
  for (const t of times) {
    const out = await open(output, t);
    if (!out) {
      skip();
      continue;
    }
    spots.push({ check: 'decode-sample', out, src: await open(source, t), exec });
  }
  return spots;
}

/**
 * Decodes every non-cover video and every audio stream of the output: its start, from a keyframe
 * near its end, ~10 one-second spots across it (`sampleSpots`), and the whole file when
 * `fullDecode`. When the output fails a decode, each media stream is decoded alone to find the
 * broken ones, and their source streams are decoded the same way: `explained` is true only when
 * every broken output stream's source stream fails that decode too.
 */
async function decodeChecks(
  exec: Exec,
  input: VerifyInput,
  source: MediaFile,
  output: MediaFile,
  tick: () => void,
): Promise<{
  failures: VerifyFailure[];
  attribute: () => Promise<{ explained: boolean; sourceFailures: VerifyFailure[] }>;
}> {
  const outInputs = await decodeInputs(exec, input.ffprobePath, output, true);
  let srcInputs: Awaited<ReturnType<typeof decodeInputs>> | null = null;
  const sourceInputs = async () => {
    srcInputs ??= await decodeInputs(exec, input.ffprobePath, source, false);
    return srcInputs;
  };
  const spots: (Spot | { check: 'decode-start' | 'decode-end' })[] = [];
  for (const check of ['decode-start', 'decode-end'] as const) spots.push({ check });
  spots.push(
    ...(await sampleSpots(
      exec,
      input.ffprobePath,
      output,
      source,
      input.sampleSpots ?? SAMPLE_SPOTS,
      tick,
    )),
  );
  if (input.fullDecode) {
    const whole = (path: string) => ({ input: ['-i', path], where: 'the whole file' });
    spots.push({
      check: 'decode-full',
      out: whole(output.path),
      src: whole(source.path),
      exec: withSignal(input.exec ?? fullDecodeExec, input.signal),
    });
  }
  /** Start/end are opened per file (their seek depends on the file); the rest are fixed. */
  const resolve = async (spot: (typeof spots)[number], side: 'out' | 'src') => {
    if ('out' in spot) return side === 'out' ? spot.out : spot.src;
    return side === 'out' ? outInputs[spot.check] : (await sourceInputs())[spot.check];
  };
  const execOf = (spot: (typeof spots)[number]): Exec => ('exec' in spot ? spot.exec : exec);
  const failed: (typeof spots)[number][] = [];
  const failures: VerifyFailure[] = [];
  const report = input.onProgress;
  const durationSeconds = referenceDuration(output.probe);
  for (const spot of spots) {
    const how = await resolve(spot, 'out');
    let run = execOf(spot);
    let extra: string[] = [];
    // The whole-file decode is measured by its own time; every other spot counts as a check.
    if (report && spot.check === 'decode-full') {
      const at = (sample: ProgressSample) =>
        report({ stage: 'full-decode', sample, durationSeconds });
      at({ outTimeSeconds: 0, speed: null, fps: null, sizeBytes: null });
      const onStdout = progressReader(at);
      const base = run;
      run = (file, args, opts) => base(file, args, { ...opts, onStdout });
      extra = ['-progress', 'pipe:1', '-nostats'];
    }
    const f = how
      ? await decode(
          run,
          input.ffmpegPath,
          spot.check,
          { ...how, maps: ['0:V?', '0:a?'], output: extra },
          '',
        )
      : null;
    if (spot.check !== 'decode-full') tick();
    // Any failure fails the output, a decode error or not (the safe direction).
    if (f) {
      failures.push(f.failure);
      failed.push(spot);
    }
  }
  // Each stream alone, without find_stream_info: it decodes a little of every stream while
  // opening, so another stream's errors would be reported against this one.
  const alone = (how: { input: string[]; where: string }, map: string): DecodeRun => ({
    input: ['-nofind_stream_info', ...how.input],
    where: how.where,
    maps: [map],
  });
  const attribute = async () => {
    input.onProgress?.({ stage: 'source' });
    const pairs = mediaPairs(input.model, output.probe);
    const rawStreams = rawOf(source.probe).streams;
    const sourceFailures: VerifyFailure[] = [];
    let explained = failed.length > 0;
    for (const spot of failed) {
      const outHow = await resolve(spot, 'out');
      const srcHow = await resolve(spot, 'src');
      const run = execOf(spot);
      let broken = 0;
      for (const { out, plan } of pairs) {
        if (!outHow) continue;
        const own = await decode(
          run,
          input.ffmpegPath,
          spot.check,
          alone(outHow, `0:${out.index}`),
          '',
        );
        if (!own) continue;
        broken++;
        // A run that says nothing about the content cannot be matched on the source.
        if (!own.decodeError) {
          explained = false;
          continue;
        }
        // mpegts streams are addressed by their id (PID): stream order is the demuxer's own.
        const id = rawStreams.find((s) => num(s.index) === plan.sourceIndex)?.id;
        const map =
          source.byteSeek && typeof id === 'string' ? `0:i:${id}` : `0:${plan.sourceIndex}`;
        const theirs = srcHow
          ? await decode(
              run,
              input.ffmpegPath,
              spot.check,
              alone(srcHow, map),
              `source: stream #${plan.sourceIndex}: `,
            )
          : null;
        if (theirs?.decodeError) sourceFailures.push(theirs.failure);
        else explained = false;
      }
      if (broken === 0) explained = false;
    }
    return { explained, sourceFailures };
  };
  return { failures, attribute };
}

/**
 * Container, every video stream, and the default audio (the first flagged, else the first audio)
 * and default subtitle (the first flagged) must play on every target; other tracks only warn.
 * Covers, attachments and data streams are exempt (streamPlaysOn). Levels are checked here only.
 */
function targetResults(
  model: BuildModel,
  probe: ProbeResult,
): { failures: VerifyFailure[]; warnings: string[] } {
  if (model.targets.length === 0) return { failures: [], warnings: [] };
  const audio = probe.streams.filter((s) => s.type === 'audio');
  const defaultAudio = audio.find((s) => s.default) ?? audio[0];
  const defaultSub = probe.streams.find((s) => s.type === 'subtitle' && s.default);
  const blocking = (s: ProbeStream) => s.type === 'video' || s === defaultAudio || s === defaultSub;
  const failures: VerifyFailure[] = containerPlaysOn(model.container, model.targets).map((i) => ({
    check: 'targets',
    message: i.message,
  }));
  const warnings: string[] = [];
  for (const s of probe.streams) {
    const issues: TargetIssue[] = streamPlaysOn(s, model.targets);
    if (blocking(s)) {
      failures.push(...issues.map((i) => ({ check: 'targets' as const, message: i.message })));
      continue;
    }
    for (const target of new Set(issues.map((i) => i.target))) {
      warnings.push(`${s.type} #${s.index} won't direct-play on ${DEVICE_PROFILES[target].name}`);
    }
  }
  return { failures, warnings };
}

/** How far a source's first video keyframe is searched for. */
const FIRST_KEYFRAME_WINDOW = 30;

/**
 * Where the output's timeline starts in the source: a source whose kept media is video only and
 * whose first video packets cannot be decoded (a stream cut mid-GOP) is written from its first
 * keyframe on, and ffmpeg starts the output there; with audio kept the output keeps the source's
 * start. Returns the later start, or `file.start` when nothing is to be moved.
 */
async function decodableStart(
  exec: Exec,
  ffprobePath: string,
  model: BuildModel,
  file: MediaFile,
): Promise<number> {
  const keptMedia = outputOrder(model).filter(
    (s) => (s.type === 'video' && !s.attachedPic) || s.type === 'audio',
  );
  const video = keptMedia[0];
  if (!video || keptMedia.some((s) => s.type === 'audio') || video.type !== 'video') {
    return file.start;
  }
  const rows = await packets(
    exec,
    ffprobePath,
    file,
    video.sourceIndex,
    interval(file, 0, FIRST_KEYFRAME_WINDOW),
    'pts_time,flags',
  );
  if (!Array.isArray(rows)) return file.start;
  let first: number | null = null;
  for (const [pts, flags] of rows) {
    const t = num(pts);
    if (t !== null && flags?.includes('K') && (first === null || t < first)) first = t;
  }
  return first !== null && first > file.start ? first : file.start;
}

/** Checks the written output against the plan; see the module comment and docs/decisions.md. */
export async function verifyOutput(input: VerifyInput): Promise<VerifyResult> {
  const exec = withSignal(input.exec ?? verifyExec, input.signal);
  let probe: ProbeResult;
  try {
    probe = await probeFile(input.outputPath, { ffprobePath: input.ffprobePath, exec });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const e = err as { stderr?: unknown };
    const detail = firstLine(String(e.stderr ?? '')) ?? message;
    return {
      ok: false,
      kind: 'output-invalid',
      failures: [{ check: 'probe', message: `the output cannot be read: ${detail}` }],
      sourceFailures: [],
      probe: null,
      warnings: [],
    };
  }
  // The checks: this probe, each output media stream's end, decode start and end, and each spot.
  const total =
    1 +
    mediaPairs(input.model, probe).length +
    2 +
    spotTimes(probe, input.sampleSpots ?? SAMPLE_SPOTS).size;
  let done = 0;
  const tick = () => {
    done = Math.min(total, done + 1);
    input.onProgress?.({ stage: 'checks', done, total });
  };
  tick();
  const targets = targetResults(input.model, probe);
  const warnings = [...targets.warnings];
  const output = await mediaFile(exec, input.ffprobePath, input.outputPath, probe);
  const source = await mediaFile(exec, input.ffprobePath, input.sourcePath, input.sourceProbe);
  source.start = await decodableStart(exec, input.ffprobePath, input.model, source);
  const duration = await durationCheck(exec, input.ffprobePath, input.model, source, output, tick);
  const stated = input.sourceProbe.durationSeconds;
  if (stated > 0 && duration.sourceEnds.length > 0) {
    const longest = Math.max(...duration.sourceEnds);
    if (stated - longest > STALE_GAP) {
      warnings.push(
        `the source header says ${secs(stated)}, but its streams end at ${secs(longest)}`,
      );
    }
  }
  const decoding = await decodeChecks(exec, input, source, output, tick);
  const others = [
    ...duration.failures,
    ...streamFailures(input.model, probe),
    ...sidecarFailures(input.model, probe),
    ...defaultFailures(probe),
  ];
  const failures = [...others, ...decoding.failures, ...targets.failures];
  if (failures.length === 0) return { ok: true, probe, warnings };
  // Only decode failures can be the source's fault, and only when each is matched on the source.
  const onlyDecode = failures.length === decoding.failures.length;
  const { explained, sourceFailures } = onlyDecode
    ? await decoding.attribute()
    : { explained: false, sourceFailures: [] };
  return {
    ok: false,
    kind: explained ? 'source-damaged' : 'output-invalid',
    failures,
    sourceFailures: explained ? sourceFailures : [],
    probe,
    warnings,
  };
}

/** A confirmation decode of the source starts this long before the spot… */
const CONFIRM_BEFORE = 1;
/** …and runs this long: the encoder's lookahead puts the output time seconds behind the decoder. */
const CONFIRM_SECONDS = 7;

/**
 * Decodes the source around each spot (output seconds where the encode reported a source-side
 * decoder error) and returns the failures: an error the source reproduces there confirms damage;
 * a run that could not start, was killed (the time or output limit) or could not read the file
 * confirms nothing.
 * mkv/mp4 sources are opened with input `-ss` (keyframe before the spot); byte-seek formats at the
 * anchor stream's last keyframe at or before it (`subfile`); a spot without one is not confirmed.
 */
export async function confirmSourceDamage(input: {
  sourcePath: string;
  sourceProbe: ProbeResult;
  ffmpegPath: string;
  ffprobePath: string;
  times: number[];
  /** How long each decode runs (default CONFIRM_SECONDS). */
  seconds?: number;
  exec?: Exec;
  signal?: AbortSignal;
}): Promise<VerifyFailure[]> {
  const seconds = input.seconds ?? CONFIRM_SECONDS;
  const exec = withSignal(input.exec ?? verifyExec, input.signal);
  const file = await mediaFile(exec, input.ffprobePath, input.sourcePath, input.sourceProbe);
  const streams = [...file.probe.streams].sort((a, b) => a.index - b.index);
  const anchor =
    streams.find((s) => s.type === 'video' && !s.attachedPic) ??
    streams.find((s) => s.type === 'audio');
  const failures: VerifyFailure[] = [];
  const spots = [
    ...new Set(input.times.map((t) => Math.max(0, Math.round((t - CONFIRM_BEFORE) * 10) / 10))),
  ];
  for (const from of spots) {
    let open: string[] | null;
    let where = `${seconds} s from ${secs(from)}`;
    if (!file.byteSeek) {
      open = ['-ss', from.toFixed(3), '-t', String(seconds), '-i', file.path];
    } else if (anchor) {
      const seek = await endSeek(
        exec,
        input.ffprobePath,
        file,
        anchor.index,
        from + DECODE_END_SECONDS,
      );
      if (seek) {
        const i = seek.args.indexOf('-i');
        open = [...seek.args.slice(0, i), '-t', String(seconds), ...seek.args.slice(i)];
        where = `${seconds} s from ${secs(seek.from)}`;
      } else open = null;
    } else open = null;
    if (!open) continue;
    const f = await decode(
      exec,
      input.ffmpegPath,
      'decode-sample',
      { input: open, maps: ['0:V?', '0:a?'], where },
      'source: ',
    );
    // Only a decode error confirms: a timeout or a read error says nothing about the file.
    if (f?.decodeError) failures.push(f.failure);
  }
  return failures;
}
