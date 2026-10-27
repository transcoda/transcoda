// Check source: one read-only ffmpeg pass over the whole file before anything is encoded.
import type { ProbeResult } from '@transcoda/sdk';
import { isPicture } from '@transcoda/shared';
import type { Exec } from '../capabilities/ffmpeg.ts';
import { classifyErrorLine, READ_FAILURE, sourceDecoderNames } from './decoder-names.ts';
import { progressReader } from './progress.ts';

/**
 * What the pass found. `damaged`: ffmpeg reported a source decode error, or the file is cut off
 * (see {@link CUT_OFF_SECONDS}); `stream` names the stream when the error says which. `error`: the
 * pass could not tell (an I/O error, a timeout, ffmpeg failed without a source error): never damage.
 */
export type CheckSourceResult =
  | { kind: 'ok'; warnings: string[] }
  | { kind: 'damaged'; reason: string; stream?: string }
  | { kind: 'error'; message: string };

/** A stream counts as cut off only when it ends more than this short of the declared end… */
export const CUT_OFF_SECONDS = 30;
/** …and more than this share of it. */
export const CUT_OFF_SHARE = 0.02;

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
  const ctx = /^\[([^\]@]+?)(?: @ 0x[0-9a-f]+)?\]/i.exec(line.trim())?.[1]?.trim() ?? '';
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

/** The message of an error line, without its contexts and level tag. */
function messageOf(line: string): string {
  return line.replace(/^(\s*\[[^\]]*\]\s*)+/, '').trim() || line.trim();
}

/**
 * Reads the whole file once (see {@link checkSourceArgs}) and says whether the source is damaged.
 * An abort rethrows (the job was cancelled or the server stops); every other failure of the pass
 * is `error`, never `damaged`.
 */
export async function checkSource(input: {
  path: string;
  probe: ProbeResult;
  ffmpegPath: string;
  decodeVideo: boolean;
  sizeBytes: number;
  exec: Exec;
  signal?: AbortSignal;
}): Promise<CheckSourceResult> {
  const { probe, signal } = input;
  const timeoutMs = checkSourceTimeoutMs(input.sizeBytes);
  let readTo: number | null = null;
  const onStdout = progressReader((s) => {
    readTo = s.outTimeSeconds;
  });
  let stderr: string;
  let exitFailure: string | null = null;
  try {
    const r = await input.exec(
      input.ffmpegPath,
      checkSourceArgs(input.path, probe, input.decodeVideo),
      { onStdout, timeoutMs, ...(signal ? { signal } : {}) },
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
  const lines = stderr.split('\n').filter((l) => l.trim() !== '');
  const errors = lines.filter((l) => classifyErrorLine(l, new Set(), NULL_ENCODERS) !== null);
  // A read that failed may have left decoder errors behind it: the file is not proven damaged.
  const unreadable = errors.find((l) => READ_FAILURE.test(l));
  if (unreadable) return { kind: 'error', message: messageOf(unreadable) };
  const codecs = sourceDecoderNames(probe.streams.map((s) => s.codec));
  const first = errors.find((l) => classifyErrorLine(l, codecs, NULL_ENCODERS) !== 'output');
  if (first) {
    const stream = streamOf(first, probe);
    return {
      kind: 'damaged',
      reason: `${stream ?? 'source'}: ${messageOf(first)}`,
      ...(stream ? { stream } : {}),
    };
  }
  if (exitFailure !== null) {
    const last = errors.at(-1) ?? lines.at(-1);
    return { kind: 'error', message: last ? messageOf(last) : exitFailure };
  }
  const declared = probe.durationSeconds;
  const read = readTo as number | null;
  if (read === null || !Number.isFinite(declared) || declared <= 0) {
    return { kind: 'ok', warnings: [] };
  }
  const gap = declared - read;
  if (gap > CUT_OFF_SECONDS && gap > declared * CUT_OFF_SHARE) {
    return { kind: 'damaged', reason: `cut off: readable to ${clock(read)} of ${clock(declared)}` };
  }
  if (gap >= 1) {
    return {
      kind: 'ok',
      warnings: [`ends ${Math.round(gap)} s short of the declared ${clock(declared)}`],
    };
  }
  return { kind: 'ok', warnings: [] };
}

/**
 * Engine tools a core node may use from its hook context (`ctx.core`, server-side only: never sent
 * to a plugin). The pipeline binds them to the job's file, probe and cancel signal.
 */
export interface CoreTools {
  checkSource(opts: { decodeVideo: boolean }): Promise<CheckSourceResult>;
}
