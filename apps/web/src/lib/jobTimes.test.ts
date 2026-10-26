import { describe, expect, it } from 'vitest';
import { fmtDuration, jobLastTime, jobTimesLine } from './time.ts';

describe('job times', () => {
  const now = new Date('2026-10-23T21:30:00');
  const at = (hm: string) => new Date(`2026-10-23T${hm}:00`).toISOString();

  it('says when a job was queued, started and finished, and how long it took', () => {
    const line = jobTimesLine(
      { queuedAt: at('21:03'), startedAt: at('21:04'), finishedAt: at('21:05') },
      now,
    );
    expect(line).toMatch(/^Queued .*21.03 · started .*21.04 · finished .*21.05 · took 1 min$/);
    expect(jobTimesLine({ queuedAt: at('21:03'), startedAt: null, finishedAt: null }, now)).toMatch(
      /^Queued .*21.03$/,
    );
  });

  it('a job from another day names the day', () => {
    const line = jobTimesLine(
      { queuedAt: '2026-10-12T08:00:00.000Z', startedAt: null, finishedAt: null },
      now,
    );
    expect(line).toMatch(/12/);
    expect(line).toMatch(/Oct/);
  });

  it('durations read like a person says them', () => {
    expect(fmtDuration(4_200)).toBe('4 s');
    expect(fmtDuration(62_000)).toBe('1 min 2 s');
    expect(fmtDuration(120_000)).toBe('2 min');
    expect(fmtDuration(3_780_000)).toBe('1 h 3 min');
  });

  it('a row shows the last thing that happened: finished, else started, else queued', () => {
    expect(jobLastTime({ queuedAt: 'q', startedAt: 's', finishedAt: 'f' })).toBe('f');
    expect(jobLastTime({ queuedAt: 'q', startedAt: 's', finishedAt: null })).toBe('s');
    expect(jobLastTime({ queuedAt: 'q', startedAt: null, finishedAt: null })).toBe('q');
  });
});
