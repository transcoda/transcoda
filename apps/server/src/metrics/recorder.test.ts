import type { JobState, Lane } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../engine/events.ts';
import { JOB_DURATION_BUCKETS, MetricsRecorder } from './recorder.ts';

const t0 = Date.parse('2026-01-01T00:00:00.000Z');

function changed(jobId: string, state: JobState, lane: Lane | null = null): EngineEvent {
  return {
    type: 'job.changed',
    jobId,
    runId: 'r',
    libraryId: 'l',
    workflowId: 'w',
    state,
    paused: false,
    progress: null,
    lane,
    currentNode: null,
    problems: [],
    reason: null,
  };
}

function slots(busy: Record<string, string | null>): EngineEvent {
  return {
    type: 'queue.changed',
    paused: false,
    lanes: { encode: null, quick: null },
    encodeSlots: Object.entries(busy).map(([id, jobId]) => ({ id, label: id, jobId })),
  };
}

function setup(
  times: Record<string, { startedAt: string | null; finishedAt: string | null }> = {},
) {
  let now = t0;
  const rec = new MetricsRecorder({
    now: () => new Date(now),
    jobTimes: (id) => times[id] ?? null,
    slots: () => [],
  });
  return { rec, advance: (s: number) => (now += s * 1000) };
}

describe('MetricsRecorder job durations', () => {
  it('observes a job seen running once, when it reaches a final state, by its lane and outcome', () => {
    const { rec } = setup({
      a: { startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:02:00.000Z' },
    });
    rec.handle(changed('a', 'probing'));
    rec.handle(changed('a', 'encoding', 'encode'));
    rec.handle(changed('a', 'done', null));
    rec.handle(changed('a', 'done', null)); // a later update of the same finished job
    const samples = rec.jobDurations();
    expect(samples).toHaveLength(1);
    expect(samples[0]?.labels).toEqual({ lane: 'encode', outcome: 'done' });
    expect(samples[0]?.count).toBe(1);
    expect(samples[0]?.sum).toBe(120);
    const idx = JOB_DURATION_BUCKETS.findIndex((le) => 120 <= le);
    expect(samples[0]?.counts[idx]).toBe(1);
    expect(samples[0]?.counts.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('skips a job never seen unfinished (finished before start) or without a start time', () => {
    const { rec } = setup({ b: { startedAt: null, finishedAt: '2026-01-01T00:00:01.000Z' } });
    rec.handle(changed('a', 'done'));
    rec.handle(changed('b', 'queued'));
    rec.handle(changed('b', 'cancelled'));
    expect(rec.jobDurations()).toEqual([]);
  });

  it('puts a duration beyond the last bucket only in +Inf (count, not a bucket)', () => {
    const { rec } = setup({
      a: { startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-03T00:00:00.000Z' },
    });
    rec.handle(changed('a', 'encoding', 'quick'));
    rec.handle(changed('a', 'failed'));
    const [s] = rec.jobDurations();
    expect(s?.labels).toEqual({ lane: 'quick', outcome: 'failed' });
    expect(s?.counts.every((c) => c === 0)).toBe(true);
    expect(s?.count).toBe(1);
  });
});

describe('MetricsRecorder encoder busy time', () => {
  it('adds up the seconds each slot held a job, counting a slot busy now up to now', () => {
    const { rec, advance } = setup();
    rec.handle(slots({ encode: 'a', 'nvidia:1': null }));
    advance(30);
    rec.handle(slots({ encode: null, 'nvidia:1': 'b' }));
    advance(10);
    expect(rec.encoderBusy()).toEqual([
      { encoder: 'encode', busy: false, seconds: 30 },
      { encoder: 'nvidia:1', busy: true, seconds: 10 },
    ]);
    advance(5);
    rec.handle(slots({ encode: null, 'nvidia:1': 'c' })); // another job, same slot: still busy
    advance(5);
    expect(rec.encoderBusy()[1]).toEqual({ encoder: 'nvidia:1', busy: true, seconds: 20 });
  });

  it('retires a slot missing from a later snapshot at that moment', () => {
    const { rec, advance } = setup();
    rec.handle(slots({ encode: null, 'nvidia:1': 'a' }));
    advance(20);
    rec.handle(slots({ encode: null })); // the setting dropped nvidia:1 while it was busy
    advance(60);
    expect(rec.encoderBusy()).toEqual([{ encoder: 'encode', busy: false, seconds: 0 }]);
  });

  it('starts from the slots busy at start', () => {
    let now = t0;
    const rec = new MetricsRecorder({
      now: () => new Date(now),
      jobTimes: () => null,
      slots: () => [{ id: 'encode', label: 'Encode', jobId: 'a' }],
    });
    now += 7000;
    expect(rec.encoderBusy()).toEqual([{ encoder: 'encode', busy: true, seconds: 7 }]);
  });
});
