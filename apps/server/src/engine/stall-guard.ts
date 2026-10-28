// The output stall guard: an encode whose ffmpeg writes no more output for a long time is stopped.
import type { RunnerProcess } from './process.ts';
import type { ProgressSample } from './progress.ts';

/** The guard checks this often (or every quarter of the limit, when that is shorter). */
export const STALL_CHECK_MS = 30_000;

/**
 * The reason a job fails with when its encode stalled: ffmpeg was stopped after `minutes` of
 * running without writing more output.
 */
export function stallReason(minutes: number): string {
  return (
    `ffmpeg wrote no output for ${formatMinutes(minutes)} and was stopped. ` +
    'It was still reading the source but holding everything back in memory, which usually means ' +
    'one stream could not get started (for example a cover image stored as a video track). ' +
    'Check the plan for a stream that should not be encoded.'
  );
}

function formatMinutes(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? '1 hour' : `${h} hours`;
  }
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * Tracks whether ffmpeg's output still grows. Output advances when a progress sample's out time or
 * total size is beyond the best seen so far; the clock starts at `start` (the spawn). Time spent
 * paused (the process stopped by the user or a queue pause) does not count.
 */
export class OutputStallGuard {
  private lastAdvance: number;
  private bestTime = 0;
  private bestSize = 0;
  private pausedAt: number | null = null;

  constructor(
    private readonly limitMs: number,
    private readonly now: () => number,
  ) {
    this.lastAdvance = now();
  }

  sample(s: ProgressSample): void {
    const size = s.sizeBytes ?? 0;
    if (s.outTimeSeconds > this.bestTime || size > this.bestSize) {
      this.bestTime = Math.max(this.bestTime, s.outTimeSeconds);
      this.bestSize = Math.max(this.bestSize, size);
      this.lastAdvance = this.now();
    }
  }

  pause(): void {
    if (this.pausedAt === null) this.pausedAt = this.now();
  }

  resume(): void {
    if (this.pausedAt === null) return;
    this.lastAdvance += this.now() - this.pausedAt;
    this.pausedAt = null;
  }

  /** True once the process has run `limitMs` (paused time excluded) without more output. */
  stalled(): boolean {
    return this.pausedAt === null && this.now() - this.lastAdvance >= this.limitMs;
  }
}

/**
 * Watches `proc` with a guard: `onStall` runs once (and the process is killed) when the guard says
 * stalled. Returns the process to attach (its pause and resume also pause the guard's clock) and
 * a `stop` to call when the process ended.
 */
export function watchForStall(
  proc: RunnerProcess,
  guard: OutputStallGuard,
  limitMs: number,
  onStall: () => void,
): { proc: RunnerProcess; stop(): void } {
  let fired = false;
  const timer = setInterval(
    () => {
      if (fired || !guard.stalled()) return;
      fired = true;
      clearInterval(timer);
      onStall();
      proc.kill();
    },
    Math.max(1, Math.min(STALL_CHECK_MS, limitMs / 4)),
  );
  timer.unref?.();
  return {
    proc: {
      pid: proc.pid,
      pause: () => {
        guard.pause();
        proc.pause();
      },
      resume: () => {
        guard.resume();
        proc.resume();
      },
      kill: () => proc.kill(),
      done: proc.done,
    },
    stop: () => clearInterval(timer),
  };
}
