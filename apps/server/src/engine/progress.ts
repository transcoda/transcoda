// Parsing of ffmpeg's `-progress pipe:1` output into job progress.
import type { JobProgress } from '../db/repos/jobs.ts';

export interface ProgressSample {
  /**
   * How far the output is, or null when ffmpeg reports no out time (`N/A`). ffmpeg 8 reports the
   * earliest stream's time and N/A while any stream has no timestamp yet: a copied image track
   * (one packet, no dts in Matroska) keeps it N/A for the whole encode. ffmpeg 9 reports the
   * furthest stream's time.
   */
  outTimeSeconds: number | null;
  speed: number | null;
  fps: number | null;
  sizeBytes: number | null;
  /** Video frames written so far (`frame=`), when the block has a count. */
  frames?: number;
}

/** A finite number from a progress value (`N/A` and garbage are null); `1.5x` reads as 1.5. */
function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** `hh:mm:ss.micro` (possibly negative) in seconds, or null. */
function clock(value: string | undefined): number | null {
  const m = value?.match(/^(-?)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!m) return null;
  const s = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  return m[1] ? -s : s;
}

/**
 * One `-progress` block: key=value lines ending with `progress=continue|end`, or null when it is
 * incomplete. A block without an out time (`N/A`) is still a sample: ffmpeg is writing output
 * (its size and frame count say how much). `out_time_ms` is in microseconds too (an ffmpeg quirk).
 */
export function parseProgressBlock(lines: string[]): ProgressSample | null {
  const kv = new Map<string, string>();
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq > 0) kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const state = kv.get('progress');
  if (state !== 'continue' && state !== 'end') return null;
  const us = num(kv.get('out_time_us')) ?? num(kv.get('out_time_ms'));
  const seconds = us !== null ? us / 1_000_000 : clock(kv.get('out_time'));
  const size = num(kv.get('total_size'));
  const frames = num(kv.get('frame'));
  return {
    outTimeSeconds: seconds === null ? null : Math.max(0, seconds),
    speed: num(kv.get('speed')),
    fps: num(kv.get('fps')),
    sizeBytes: size !== null && size >= 0 ? Math.round(size) : null,
    ...(frames !== null && frames >= 0 ? { frames: Math.round(frames) } : {}),
  };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * The sample with its out time at least as far as its video frames reach at `frameRate` (the first
 * video stream's, which `frame=` counts): ffmpeg 8 reports the earliest stream's time, so a copied
 * image track holds it at its one packet (or N/A) while the film is encoded. For display only.
 */
export function withFrameTime(sample: ProgressSample, frameRate: number | null): ProgressSample {
  const frames = sample.frames ?? 0;
  if (frameRate === null || !(frameRate > 0) || frames <= 0) return sample;
  const byFrames = frames / frameRate;
  const out = sample.outTimeSeconds;
  return out !== null && out >= byFrames ? sample : { ...sample, outTimeSeconds: byFrames };
}

/**
 * Job progress from a sample: percent = min(100, out/duration × 100) to one decimal (null without
 * a positive duration or an out time); eta = (duration − out) / speed to one decimal, never
 * negative (null without a positive speed, a duration or an out time).
 */
export function toJobProgress(sample: ProgressSample, durationSeconds: number): JobProgress {
  const hasDuration =
    Number.isFinite(durationSeconds) && durationSeconds > 0 && sample.outTimeSeconds !== null;
  const outTimeSeconds = sample.outTimeSeconds ?? 0;
  const { speed } = sample;
  return {
    percent: hasDuration ? Math.min(100, round1((outTimeSeconds / durationSeconds) * 100)) : null,
    outTimeSeconds,
    speed,
    fps: sample.fps,
    sizeBytes: sample.sizeBytes,
    etaSeconds:
      hasDuration && speed !== null && speed > 0
        ? round1(Math.max(0, durationSeconds - outTimeSeconds) / speed)
        : null,
  };
}

/**
 * A reader for `-progress pipe:1` arriving in chunks (split anywhere): calls `onSample` once per
 * complete block.
 */
export function progressReader(onSample: (s: ProgressSample) => void): (chunk: string) => void {
  let rest = '';
  let block: string[] = [];
  return (chunk) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      block.push(line);
      if (!line.startsWith('progress=')) continue;
      const sample = parseProgressBlock(block);
      block = [];
      if (sample) onSample(sample);
    }
  };
}

/** Where a verify stands, as `verifyOutput` reports it (see `JobProgress.verify`). */
export type VerifyProgress =
  | { stage: 'checks'; done: number; total: number }
  | { stage: 'full-decode'; sample: ProgressSample; durationSeconds: number | null }
  | { stage: 'source' };

/**
 * Job progress while verifying: the checks fill by how many are done; the whole-file decode by its
 * time against the output's duration (as an encode); re-checking the source has no measure.
 */
export function toVerifyProgress(p: VerifyProgress): JobProgress {
  if (p.stage === 'full-decode') {
    return {
      ...toJobProgress(p.sample, p.durationSeconds ?? 0),
      verify: { stage: p.stage, done: null, total: null },
    };
  }
  const idle = {
    outTimeSeconds: 0,
    speed: null,
    fps: null,
    sizeBytes: null,
    etaSeconds: null,
  };
  if (p.stage === 'source') {
    return { percent: null, ...idle, verify: { stage: p.stage, done: null, total: null } };
  }
  return {
    percent: p.total > 0 ? round1((p.done / p.total) * 100) : null,
    ...idle,
    verify: { stage: p.stage, done: p.done, total: p.total },
  };
}
