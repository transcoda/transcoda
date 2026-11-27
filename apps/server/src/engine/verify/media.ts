import type { BuildModel, ProbeResult, StreamPlan } from '@transcoda/sdk';
import { isPicture, type ProbeStream } from '@transcoda/shared';
import { type Exec, makeExec } from '../../capabilities/ffmpeg.ts';
import { isMemoryLimitError, memoryLimitMessage } from '../../platform/memory-guard.ts';
import { outputOrder } from '../model/model.ts';

// Reading the output and the source: running ffprobe and ffmpeg, stream durations, packets.

/**
 * Formats whose time seek does not land on a keyframe (it lands mid-GOP and the decoder reports
 * missing references); decode-end opens them at the keyframe's byte offset instead.
 */
export const BYTE_SEEK_FORMATS = new Set(['mpegts', 'mpeg']);

/** Decoding a second of a large file on a busy CPU can take a while; never hang forever. */
export const verifyExec: Exec = makeExec({ timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });

/** A whole-file decode of a long film on a busy CPU takes a while; still never forever. */
export const fullDecodeExec: Exec = makeExec({
  timeout: 6 * 60 * 60 * 1000,
  maxBuffer: 64 * 1024 * 1024,
});

/** Every call of `exec` carries `signal` (a cancel or shutdown kills the running tool). */
export function withSignal(exec: Exec, signal: AbortSignal | undefined): Exec {
  return signal ? (file, args, opts) => exec(file, args, { ...opts, signal }) : exec;
}

type RunResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; detail: string; exited: boolean; stderr: string };

/**
 * Runs a tool; a non-zero exit, a timeout or a spawn error is `ok: false` with its first line.
 * `exited`: the tool ran and exited with a code of its own (not killed by the time or output
 * limit, a signal, or never started).
 */
export async function run(exec: Exec, file: string, args: string[]): Promise<RunResult> {
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
    // Stopped by the memory guard: that is the reason, whatever ffmpeg had logged before.
    const detail = isMemoryLimitError(err)
      ? memoryLimitMessage(err.memoryLimitBytes)
      : (firstLine(stderr) ?? firstLine(String(e.message ?? err)));
    const exited = typeof e.code === 'number' && e.killed !== true;
    return { ok: false, detail: detail ?? 'failed', exited, stderr };
  }
}

export function firstLine(text: string): string | null {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? null
  );
}

export function num(v: unknown): number | null {
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
export function rawOf(probe: ProbeResult): {
  format: Record<string, unknown>;
  streams: RawStream[];
} {
  const raw = (probe.raw ?? {}) as { format?: unknown; streams?: unknown };
  const format =
    raw.format !== null && typeof raw.format === 'object'
      ? (raw.format as Record<string, unknown>)
      : {};
  const streams = Array.isArray(raw.streams) ? (raw.streams as RawStream[]) : [];
  return { format, streams };
}

/** A stream's own duration: ffprobe `duration`, else the mkv `DURATION` tag. */
export function streamDuration(s: RawStream | undefined): number | null {
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
export interface MediaFile {
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
export async function mediaFile(
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
export function interval(file: MediaFile, from: number, to: number): string {
  const t = (x: number) => String(Math.round((file.start + x) * 1000) / 1000);
  return from <= 0 ? `%${t(to)}` : `${t(from)}%${t(to)}`;
}

/**
 * Packet rows `entries` of stream `index` in [from, to] (file time); null when ffprobe fails.
 *
 * Reads every stream and keeps `index`'s rows: with `-select_streams` ffprobe seeks by the selected
 * stream, and a Matroska file indexes (Cues) only its video, so a seek by an audio stream reads the
 * whole file from its start (minutes for a 40 GB remux, past the verify timeout).
 */
export async function packets(
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
    '-read_intervals',
    range,
    '-show_entries',
    `packet=stream_index,${entries}`,
    '-of',
    'csv=p=0',
    file.path,
  ]);
  if (!r.ok) return { error: r.detail };
  // ffprobe prints stream_index before the other packet fields.
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => l.split(','))
    .filter(([stream]) => stream === String(index))
    .map((row) => row.slice(1));
}

/**
 * Output media streams (video other than pictures, see isPicture; audio) with the plan entry they
 * came from. A picture (a cover, a poster, an image stored as a video track) is not compared or
 * decoded as media.
 */
export function mediaPairs(
  model: BuildModel,
  probe: ProbeResult,
): { out: ProbeStream; plan: StreamPlan }[] {
  const plans = outputOrder(model);
  return [...probe.streams]
    .sort((a, b) => a.index - b.index)
    .flatMap((out, i) => {
      const plan = plans[i];
      const media =
        (out.type === 'video' && !plan?.attachedPic && !isPicture(out, probe.streams)) ||
        out.type === 'audio';
      return media && plan ? [{ out, plan }] : [];
    });
}

export function secs(n: number): string {
  return `${n.toFixed(2)}s`;
}
