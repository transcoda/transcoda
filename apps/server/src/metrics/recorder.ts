// What the database does not keep: how long finished jobs took and how long each encode slot was
// busy, counted in memory from engine events since the server started (Prometheus treats the
// restart as a counter reset).
import { isFinalState, type JobState, type Lane } from '@transcoda/shared';
import type { EngineEvent } from '../engine/events.ts';
import type { EncodeSlotStatus } from '../engine/scheduler.ts';
import type { HistogramFamily } from './exposition.ts';

/** Upper bounds in seconds: 10 s to 8 h. */
export const JOB_DURATION_BUCKETS = [10, 30, 60, 300, 900, 1800, 3600, 7200, 14400, 28800] as const;

export interface RecorderDeps {
  now: () => Date;
  /** The job's start and finish (ISO), or null for an unknown job. */
  jobTimes: (jobId: string) => { startedAt: string | null; finishedAt: string | null } | null;
  /** The encode slots now, read once at construction. */
  slots: () => EncodeSlotStatus[];
}

type Histogram = HistogramFamily['samples'][number];

export class MetricsRecorder {
  /** Jobs seen unfinished, with the last lane they held. */
  private readonly running = new Map<string, Lane | null>();
  private readonly durations = new Map<string, Histogram>();
  /** Per slot id: seconds busy before `since`, and since when it is busy (null: idle). */
  private readonly slots = new Map<string, { seconds: number; since: number | null }>();

  constructor(private readonly deps: RecorderDeps) {
    this.updateSlots(deps.slots());
  }

  handle(e: EngineEvent): void {
    if (e.type === 'job.changed') this.jobChanged(e.jobId, e.state, e.lane);
    else if (e.type === 'queue.changed') this.updateSlots(e.encodeSlots);
  }

  private jobChanged(jobId: string, state: JobState, lane: Lane | null): void {
    if (!isFinalState(state)) {
      this.running.set(jobId, lane ?? this.running.get(jobId) ?? null);
      return;
    }
    if (!this.running.has(jobId)) return;
    const lastLane = this.running.get(jobId) ?? null;
    this.running.delete(jobId);
    const times = this.deps.jobTimes(jobId);
    if (!times?.startedAt || !times.finishedAt) return;
    const seconds = (Date.parse(times.finishedAt) - Date.parse(times.startedAt)) / 1000;
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.observe(lane ?? lastLane ?? 'none', state, seconds);
  }

  private observe(lane: string, outcome: string, seconds: number): void {
    const key = `${lane}\u0000${outcome}`;
    let h = this.durations.get(key);
    if (!h) {
      h = {
        labels: { lane, outcome },
        counts: JOB_DURATION_BUCKETS.map(() => 0),
        count: 0,
        sum: 0,
      };
      this.durations.set(key, h);
    }
    const i = JOB_DURATION_BUCKETS.findIndex((le) => seconds <= le);
    const counts = h.counts as number[];
    if (i >= 0) counts[i] = (counts[i] ?? 0) + 1;
    h.count += 1;
    h.sum += seconds;
  }

  private updateSlots(list: readonly EncodeSlotStatus[]): void {
    const now = this.deps.now().getTime();
    for (const s of list) {
      const slot = this.slots.get(s.id) ?? { seconds: 0, since: null };
      const busy = s.jobId !== null;
      if (busy && slot.since === null) slot.since = now;
      if (!busy && slot.since !== null) {
        slot.seconds += (now - slot.since) / 1000;
        slot.since = null;
      }
      this.slots.set(s.id, slot);
    }
  }

  jobDurations(): Histogram[] {
    return [...this.durations.values()].map((h) => ({ ...h, counts: [...h.counts] }));
  }

  encoderBusy(): { encoder: string; busy: boolean; seconds: number }[] {
    const now = this.deps.now().getTime();
    return [...this.slots.entries()].map(([encoder, s]) => ({
      encoder,
      busy: s.since !== null,
      seconds: s.seconds + (s.since === null ? 0 : (now - s.since) / 1000),
    }));
  }
}
