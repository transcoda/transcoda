import type { BuildModel } from '@transcoda/sdk';
import type { Exec } from '../../capabilities/ffmpeg.ts';
import {
  interval,
  type MediaFile,
  mediaPairs,
  num,
  packets,
  rawOf,
  referenceDuration,
  run,
  secs,
  streamDuration,
} from './media.ts';
import type { VerifyFailure } from './types.ts';

// The duration check: where each output stream really ends, against the source.

/** A stream end may differ by this much plus the duration of its last frame/packet. */
const END_TOLERANCE = 0.25;

/** A tail read starts this many seconds before the expected stream end… */
const TAIL_BEFORE = 2;

/** …and stops this many seconds after it, so it never scans the whole file. */
export const TAIL_AFTER = 3;

/** Packets ending this close to a read's end mean the stream may run on: read further. */
const EDGE = 1;

/** An end search never goes further than this from where the stream was expected to end. */
const MAX_SEARCH = 600;

/** Seeking `ffmpeg -ss` lands on a time far beyond any file: the demuxer's last seek point. */
const BEYOND_END = 1e7;

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
export async function findEnd(
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
export async function measuredEnd(
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

/**
 * Each output media stream must end where its source stream ends, both measured from their own
 * file's start, within END_TOLERANCE plus the longer of the two last packet durations. Each source
 * stream's end is searched for around its own expected end (its stream duration, else the file's),
 * and the output stream around that end. Every stream is compared; whatever cannot be is a
 * failure. Returns the source stream ends too (for the stale-header warning).
 */
export async function durationCheck(
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
