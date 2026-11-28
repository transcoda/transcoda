import type { BuildModel, ProbeResult, StreamPlan } from '@transcoda/sdk';
import { isPicture } from '@transcoda/shared';
import type { Exec } from '../../capabilities/ffmpeg.ts';
import { type ProgressSample, progressReader } from '../encode/progress.ts';
import { NULL_TIMESTAMPS, READ_FAILURE } from '../media/decoder-names.ts';
import { isExtraStream, outputOrder } from '../model/model.ts';
import { findEnd, measuredEnd, TAIL_AFTER } from './durations.ts';
import {
  firstLine,
  fullDecodeExec,
  interval,
  type MediaFile,
  mediaPairs,
  num,
  packets,
  rawOf,
  referenceDuration,
  run,
  secs,
  withSignal,
} from './media.ts';
import type { VerifyFailure, VerifyInput } from './types.ts';

// The decode checks: decoding the start, the end, sampled spots and (optionally) the whole output,
// and the source again where the output fails.

/** decode-end starts at the last keyframe at least this far before the end. */
export const DECODE_END_SECONDS = 3;

/** A keyframe search looks back this far before giving up. */
const MAX_KEYFRAME_SEARCH = 120;

/** Default number of sampled one-second spots (Jan's verify-depth decision). */
export const SAMPLE_SPOTS = 10;

type DecodeCheck = 'decode-start' | 'decode-end' | 'decode-sample' | 'decode-full';

/**
 * Where decode-end starts in `file`: the last keyframe of `anchor` (its first video stream other
 * than covers, else its first audio stream) at least DECODE_END_SECONDS before that stream's end.
 * Returns ffmpeg input options plus the input URL; null when no keyframe was found.
 */
export async function endSeek(
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
      const ss = Math.max(0, pick.pts + file.skipped);
      return { args: ['-ss', ss.toFixed(6), '-i', file.path], from: pick.pts };
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
 * muxer quiet about timestamps after a seek, and {@link NULL_TIMESTAMPS} about rounded ones.
 */
export async function decode(
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
    ...NULL_TIMESTAMPS,
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

/**
 * The `-map`s of a decode of a file's content: every video stream that is not a picture (see
 * isPicture) and every audio stream, by index. Never `0:V?`: it leaves out only streams flagged
 * attached_pic, so a cover an earlier encode turned into an ordinary video track would be decoded
 * too, and the null muxer then queues every decoded frame of the film waiting for the cover's next
 * frame until memory runs out. Outputs need this as much as sources: a cover is copied as it is.
 * A file with neither keeps ffmpeg's own choice (a lone picture cannot hold anything back).
 *
 * `byId` is for a byte-seek source (see BYTE_SEEK_FORMATS) opened mid-way: the demuxer numbers
 * streams in the order it meets them there, so a stream is named by its id (PID) instead. A stream
 * whose id is missing or shared with another keeps its index.
 */
export function mediaMaps(probe: ProbeResult, byId = false): string[] {
  const streams = [...probe.streams].sort((a, b) => a.index - b.index);
  const media = streams.filter(
    (s) => (s.type === 'video' && !isPicture(s, streams)) || s.type === 'audio',
  );
  if (media.length === 0) return ['0:V?', '0:a?'];
  const raw = byId ? rawOf(probe).streams : [];
  const idOf = (index: number): string | null => {
    const id = raw.find((r) => num(r.index) === index)?.id;
    if (typeof id !== 'string' || id === '') return null;
    return raw.filter((r) => r.id === id).length === 1 ? id : null;
  };
  return [
    ...media.filter((s) => s.type === 'video'),
    ...media.filter((s) => s.type === 'audio'),
  ].map((s) => {
    const id = idOf(s.index);
    return id === null ? `0:${s.index}` : `0:i:${id}`;
  });
}

/** The stream a file's seeks are made by: its first video stream other than covers, else audio. */
function anchorOf(file: MediaFile) {
  const streams = [...file.probe.streams].sort((a, b) => a.index - b.index);
  return (
    streams.find((s) => s.type === 'video' && !isPicture(s, streams)) ??
    streams.find((s) => s.type === 'audio')
  );
}

/**
 * The input options and URL that open `file` at its start (`file.start`). A source whose first
 * packets cannot be decoded (see decodableStart) is opened at its first keyframe, where the output
 * starts: by time (`-ss`), or for a byte-seek format at the keyframe's byte offset. Null when that
 * keyframe is not found.
 */
async function openAtStart(
  exec: Exec,
  ffprobePath: string,
  file: MediaFile,
): Promise<string[] | null> {
  if (file.skipped <= 0) return ['-i', file.path];
  if (!file.byteSeek) return ['-ss', file.skipped.toFixed(6), '-i', file.path];
  const anchor = anchorOf(file);
  if (!anchor) return null;
  // endSeek picks the last keyframe at least DECODE_END_SECONDS before the given end: here the
  // first one, at file time 0.
  const seek = await endSeek(exec, ffprobePath, file, anchor.index, DECODE_END_SECONDS);
  return seek?.args ?? null;
}

/** How decode-start and decode-end open `file` (stream maps are added per run). */
async function decodeInputs(
  exec: Exec,
  ffprobePath: string,
  file: MediaFile,
  isOutput: boolean,
): Promise<Record<'decode-start' | 'decode-end', { input: string[]; where: string } | null>> {
  const opened = await openAtStart(exec, ffprobePath, file);
  const start = opened && { input: ['-t', '1', ...opened], where: 'the first second' };
  const anchor = anchorOf(file);
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
export function spotTimes(probe: ProbeResult, n: number): Set<number> {
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
 * same content: the same time from its start, past any undecodable packets the output left out
 * (see decodableStart); a spot without a keyframe found is decoded on neither side.
 */
export async function sampleSpots(
  exec: Exec,
  ffprobePath: string,
  output: MediaFile,
  source: MediaFile,
  n: number,
  skip: () => void,
): Promise<Spot[]> {
  const times = spotTimes(output.probe, n);
  const open = async (file: MediaFile, t: number) => {
    const where = `1 s at ${secs(t)}`;
    if (!file.byteSeek) {
      // ffmpeg's `-ss` counts from where the file's own timeline starts, before any skipped part.
      const ss = (t + file.skipped).toFixed(3);
      return { input: ['-ss', ss, '-t', '1', '-i', file.path], where };
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
 * every failed decode was a decode error (not a read error or a timeout) and every broken output
 * stream's source stream fails that decode too.
 */
export async function decodeChecks(
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
    const whole = (opened: string[] | null) => opened && { input: opened, where: 'the whole file' };
    spots.push({
      check: 'decode-full',
      out: { input: ['-i', output.path], where: 'the whole file' },
      src: whole(await openAtStart(exec, input.ffprobePath, source)),
      exec: withSignal(input.exec ?? fullDecodeExec, input.signal),
    });
  }
  /** Start/end are opened per file (their seek depends on the file); the rest are fixed. */
  const resolve = async (spot: (typeof spots)[number], side: 'out' | 'src') => {
    if ('out' in spot) return side === 'out' ? spot.out : spot.src;
    return side === 'out' ? outInputs[spot.check] : (await sourceInputs())[spot.check];
  };
  const execOf = (spot: (typeof spots)[number]): Exec => ('exec' in spot ? spot.exec : exec);
  /** The failed spots, and whether each failed decoding (not reading or running out of time). */
  const failed: { spot: (typeof spots)[number]; decodeError: boolean }[] = [];
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
          { ...how, maps: mediaMaps(output.probe), output: extra },
          '',
        )
      : null;
    if (spot.check !== 'decode-full') tick();
    // Any failure fails the output, a decode error or not (the safe direction).
    if (f) {
      failures.push(f.failure);
      failed.push({ spot, decodeError: f.decodeError });
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
    for (const { spot, decodeError } of failed) {
      // A failure that says nothing about the content (a read error, a timeout) cannot be the
      // source's, whatever a later decode of it reports.
      if (!decodeError) {
        explained = false;
        continue;
      }
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

/** How far a source's first video keyframe is searched for. */
const FIRST_KEYFRAME_WINDOW = 30;

/**
 * Where the output's timeline starts in the source: a source whose kept media is video only and
 * whose first video packets cannot be decoded (a stream cut mid-GOP) is written from its first
 * keyframe on, and ffmpeg starts the output there; with audio kept the output keeps the source's
 * start. Returns the later start, or `file.start` when nothing is to be moved.
 */
export async function decodableStart(
  exec: Exec,
  ffprobePath: string,
  model: BuildModel,
  file: MediaFile,
): Promise<number> {
  const picture = (s: StreamPlan) => {
    const src = file.probe.streams.find((p) => p.index === s.sourceIndex);
    return src && !isExtraStream(s) ? isPicture(src, file.probe.streams) : s.attachedPic;
  };
  const keptMedia = outputOrder(model).filter(
    (s) => (s.type === 'video' && !picture(s)) || s.type === 'audio',
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
