// Check source: one read-only ffmpeg pass over the whole file before anything is encoded.
import type { ProbeResult } from '@transcoda/sdk';
import { isPicture } from '@transcoda/shared';
import type { Exec } from '../capabilities/ffmpeg.ts';
import { classifyErrorLine, READ_FAILURE, sourceDecoderNames } from './decoder-names.ts';
import { progressReader } from './progress.ts';
import type { VerifyFailure } from './verify.ts';

/**
 * What the pass found. `damaged`: a source decoder reported an error the source reproduces, or the
 * file is cut off (see {@link CUT_OFF_SECONDS}); `stream` names the stream when the error says
 * which. `error`: the pass could not tell (a read error on a disk or network share, a timeout, a
 * demuxer error without a decoder error, ffmpeg failed without a source error): never damage.
 */
export type CheckSourceResult =
  | { kind: 'ok'; warnings: string[] }
  | { kind: 'damaged'; reason: string; stream?: string }
  | { kind: 'error'; message: string };

/** A stream counts as cut off only when it ends more than this short of the declared end… */
export const CUT_OFF_SECONDS = 30;
/** …and more than this share of it… */
export const CUT_OFF_SHARE = 0.02;
/**
 * …and the demuxer reported truncation (see {@link TRUNCATION}) no more than this before where the
 * read stopped (progress comes in coarse steps on a fast pass). Without it the header is stale: a
 * warning, as verify says of a source header longer than its streams.
 */
const TAIL_SECONDS = 60;
/** The demuxer saying the file stops short. */
const TRUNCATION = /file ended prematurely|truncat|end of file|premature end|unexpected end/i;

/** A confirming read covers the stretch where the error was seen plus this much… */
const CONFIRM_SECONDS = 7;
/** …and never more than this. */
const CONFIRM_MAX_SECONDS = 120;

/** The encoders of the pass itself (the null muxer's defaults): their lines are never the source's. */
const NULL_ENCODERS: ReadonlySet<string> = new Set(['pcm_s16le', 'wrapped_avframe']);

/** 10 min plus 5 min per started GiB (a 2 GB file read in about a minute on the test box). */
export function checkSourceTimeoutMs(sizeBytes: number): number {
  return 600_000 + 300_000 * Math.ceil(Math.max(0, sizeBytes) / 2 ** 30);
}

/**
 * The pass: every audio stream decoded, video copied (decoded with `decodeVideo`, or when the file
 * has no audio: an empty pass would prove nothing), output discarded.
 */
export function checkSourceArgs(path: string, probe: ProbeResult, decodeVideo: boolean): string[] {
  const hasAudio = probe.streams.some((s) => s.type === 'audio');
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'level+error',
    '-progress',
    'pipe:1',
    '-i',
    path,
    '-map',
    '0:a?',
    '-map',
    '0:V?',
    ...(decodeVideo || !hasAudio ? [] : ['-c:v', 'copy']),
    '-f',
    'null',
    '-',
  ];
}

/** `m:ss`, or `h:mm:ss` from an hour. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * The stream a decoder error line names: `audio #1 (DTS)` from an input-stream context
 * (`[aist#0:1/dts @ …]`) or from a decoder context (`[dca @ …]`, `[dec:dca @ …]`) matched against
 * the probe's codecs; undefined when it names none or several.
 */
function streamOf(line: string, probe: ProbeResult): string | undefined {
  const name = (s: ProbeResult['streams'][number]) =>
    `${s.type} #${s.index} (${s.codec.toUpperCase()})`;
  const ctx = contextOf(line);
  const ist = /^[a-z]?ist#0:(\d+)/.exec(ctx);
  if (ist) {
    const s = probe.streams.find((x) => x.index === Number(ist[1]));
    return s && name(s);
  }
  const decoder = ctx.startsWith('dec:') ? ctx.slice(4) : ctx;
  const mapped = probe.streams.filter(
    (s) =>
      (s.type === 'audio' || (s.type === 'video' && !isPicture(s, probe.streams))) &&
      sourceDecoderNames([s.codec]).has(decoder),
  );
  return mapped.length === 1 ? name(mapped[0] as (typeof mapped)[number]) : undefined;
}

/** The first context of a log line (`matroska,webm` of `[matroska,webm @ 0x…] …`); '' when none. */
function contextOf(line: string): string {
  return /^\[([^\]@]+?)(?: @ 0x[0-9a-f]+)?\]/i.exec(line.trim())?.[1]?.trim() ?? '';
}

/** The message of an error line, without its contexts and level tag. */
function messageOf(line: string): string {
  return line.replace(/^(\s*\[[^\]]*\]\s*)+/, '').trim() || line.trim();
}

/** A stderr line and where the pass was when it came: `at` the last out time (null before any). */
interface Seen {
  line: string;
  at: number | null;
  /** The out time of the next progress block (null: none came after it). */
  until: number | null;
}

/**
 * Reads the whole file once (see {@link checkSourceArgs}) and says whether the source is damaged.
 * Decoder errors before the first output frame (a stream cut mid-GOP, audio starting mid-frame)
 * are ignored, as the encode does; the first later one is damage only when `confirm` (a decode of
 * the source from `at`, for `seconds`) reproduces it. An abort rethrows (the job was cancelled or
 * the server stops); every other failure of the pass is `error`, never `damaged`.
 */
export async function checkSource(input: {
  path: string;
  probe: ProbeResult;
  ffmpegPath: string;
  decodeVideo: boolean;
  sizeBytes: number;
  exec: Exec;
  confirm: (spot: { at: number; seconds: number }) => Promise<VerifyFailure[]>;
  signal?: AbortSignal;
}): Promise<CheckSourceResult> {
  const { probe, signal } = input;
  const timeoutMs = checkSourceTimeoutMs(input.sizeBytes);
  let readTo: number | null = null;
  const seen: Seen[] = [];
  let waiting: Seen[] = [];
  const onStdout = progressReader((s) => {
    readTo = s.outTimeSeconds;
    for (const l of waiting) l.until = s.outTimeSeconds;
    waiting = [];
  });
  let rest = '';
  const take = (line: string) => {
    if (line.trim() === '') return;
    const l: Seen = { line, at: readTo, until: null };
    seen.push(l);
    waiting.push(l);
  };
  const onStderr = (chunk: string) => {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop() ?? '';
    for (const p of parts) take(p.replace(/\r$/, ''));
  };
  let stderr: string;
  let exitFailure: string | null = null;
  try {
    const r = await input.exec(
      input.ffmpegPath,
      checkSourceArgs(input.path, probe, input.decodeVideo),
      { onStdout, onStderr, timeoutMs, ...(signal ? { signal } : {}) },
    );
    stderr = r.stderr;
  } catch (err) {
    if (signal?.aborted || (err as { name?: unknown } | null)?.name === 'AbortError') throw err;
    const e = (err ?? {}) as { killed?: boolean; stderr?: unknown; message?: unknown };
    if (e.killed === true) {
      return {
        kind: 'error',
        message: `reading the file took longer than ${Math.round(timeoutMs / 60_000)} min and was stopped`,
      };
    }
    if (typeof e.stderr !== 'string') {
      return { kind: 'error', message: `ffmpeg could not run: ${String(e.message ?? err)}` };
    }
    stderr = e.stderr;
    exitFailure = String(e.message ?? 'ffmpeg failed').split('\n')[0] ?? 'ffmpeg failed';
  }
  take(rest);
  // Lines the exec did not hand over as they came have no known time: never after the first frame.
  if (seen.length === 0) {
    for (const line of stderr.split('\n')) {
      if (line.trim() !== '') seen.push({ line, at: null, until: null });
    }
  }
  const lines = seen.map((l) => l.line);
  const errors = seen.filter((l) => classifyErrorLine(l.line, new Set(), NULL_ENCODERS) !== null);
  // A read that failed (any line, any context) may have left decoder errors behind it: the file
  // is not proven damaged.
  const unreadable = seen.find((l) => READ_FAILURE.test(l.line));
  if (unreadable) return { kind: 'error', message: messageOf(unreadable.line) };
  const codecs = sourceDecoderNames(probe.streams.map((s) => s.codec));
  const side = (l: Seen) => classifyErrorLine(l.line, codecs, NULL_ENCODERS);
  const afterStart = (l: Seen) => l.at !== null && l.at > 0;
  const leading = errors.filter((l) => side(l) !== 'output' && !afterStart(l)).length;
  const warnings =
    leading > 0 ? [`ignored ${leading} decoder error(s) before the first output frame`] : [];
  // Only a source decoder proves damage: the demuxer also speaks for a disk or a network share.
  const first = errors.find((l) => side(l) === 'source' && afterStart(l));
  if (first && first.at !== null) {
    const stream = streamOf(first.line, probe);
    const reason = `${stream ?? 'source'}: ${messageOf(first.line)}`;
    const until = first.until ?? (readTo as number | null) ?? first.at;
    const seconds = Math.min(CONFIRM_MAX_SECONDS, Math.max(0, until - first.at) + CONFIRM_SECONDS);
    const confirmed = await input.confirm({ at: first.at, seconds });
    if (confirmed.length === 0) {
      return {
        kind: 'error',
        message: `${reason} at ${clock(first.at)}, which the source does not reproduce`,
      };
    }
    return { kind: 'damaged', reason, ...(stream ? { stream } : {}) };
  }
  // The demuxer's own lines: `in#0/…`, or libavformat's under the source's format name.
  const formats = new Set(probe.formatName.split(','));
  const fromDemuxer = (l: Seen) =>
    side(l) === 'demuxer' || formats.has(contextOf(l.line).split(',')[0] ?? '');
  const end = readTo as number | null;
  const atTail = (l: Seen) =>
    end !== null && l.at !== null && l.at >= end - TAIL_SECONDS && TRUNCATION.test(l.line);
  const tailTruncated = errors.some((l) => fromDemuxer(l) && atTail(l));
  // Truncation at the tail is the cut-off check's to judge; any other demuxer error: can't tell.
  const demuxer = errors.find((l) => side(l) === 'demuxer' && afterStart(l) && !atTail(l));
  if (demuxer) return { kind: 'error', message: messageOf(demuxer.line) };
  if (exitFailure !== null) {
    const last = errors.at(-1)?.line ?? lines.at(-1);
    return { kind: 'error', message: last ? messageOf(last) : exitFailure };
  }
  const declared = probe.durationSeconds;
  const read = readTo as number | null;
  if (read === null || !Number.isFinite(declared) || declared <= 0) {
    return { kind: 'ok', warnings };
  }
  const gap = declared - read;
  if (gap > CUT_OFF_SECONDS && gap > declared * CUT_OFF_SHARE) {
    if (tailTruncated) {
      return {
        kind: 'damaged',
        reason: `cut off: readable to ${clock(read)} of ${clock(declared)}`,
      };
    }
    warnings.push(`the header says ${clock(declared)}, but the file reads to ${clock(read)}`);
    return { kind: 'ok', warnings };
  }
  if (gap >= 1) {
    warnings.push(`ends ${Math.round(gap)} s short of the declared ${clock(declared)}`);
  }
  return { kind: 'ok', warnings };
}

/**
 * Engine tools a core node may use from its hook context (`ctx.core`, server-side only: never sent
 * to a plugin). The pipeline binds them to the job's file, probe and cancel signal.
 */
export interface CoreTools {
  checkSource(opts: { decodeVideo: boolean }): Promise<CheckSourceResult>;
}
