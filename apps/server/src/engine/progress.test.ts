import { describe, expect, it } from 'vitest';
import { parseProgressBlock, progressReader, toJobProgress, toVerifyProgress } from './progress.ts';

const BLOCK = [
  'frame=10',
  'fps=25.0',
  'out_time_us=2000000',
  'total_size=1234',
  'speed=1.5x',
  'progress=continue',
];

describe('parseProgressBlock', () => {
  it('reads out time, speed, fps, size and the frame count from a -progress block', () => {
    expect(parseProgressBlock(BLOCK)).toEqual({
      outTimeSeconds: 2,
      speed: 1.5,
      fps: 25,
      sizeBytes: 1234,
      frames: 10,
    });
  });

  it('reads N/A values as null', () => {
    const sample = parseProgressBlock([
      'fps=N/A',
      'out_time_us=500000',
      'total_size=N/A',
      'speed=N/A',
      'progress=end',
    ]);
    expect(sample).toEqual({ outTimeSeconds: 0.5, speed: null, fps: null, sizeBytes: null });
  });

  it('falls back to out_time_ms (also microseconds) and out_time', () => {
    expect(parseProgressBlock(['out_time_ms=3000000', 'progress=continue'])?.outTimeSeconds).toBe(
      3,
    );
    expect(
      parseProgressBlock(['out_time=00:01:02.500000', 'progress=continue'])?.outTimeSeconds,
    ).toBe(62.5);
  });

  it('clamps a negative start time to 0', () => {
    expect(parseProgressBlock(['out_time_us=-577', 'progress=continue'])?.outTimeSeconds).toBe(0);
  });

  it('returns null for an incomplete block or one without an out time', () => {
    expect(parseProgressBlock(['frame=1', 'out_time_us=1000000'])).toBeNull();
    expect(parseProgressBlock(['out_time_us=N/A', 'speed=N/A', 'progress=continue'])).toBeNull();
    expect(parseProgressBlock([])).toBeNull();
  });
});

describe('toJobProgress', () => {
  it('computes percent and eta from the duration and speed', () => {
    const sample = parseProgressBlock(BLOCK);
    if (!sample) throw new Error('no sample');
    expect(toJobProgress(sample, 4)).toEqual({
      percent: 50,
      outTimeSeconds: 2,
      speed: 1.5,
      fps: 25,
      sizeBytes: 1234,
      etaSeconds: 1.3,
    });
  });

  it('rounds percent to one decimal and caps it at 100', () => {
    const s = { outTimeSeconds: 1, speed: 2, fps: null, sizeBytes: null };
    expect(toJobProgress(s, 3).percent).toBe(33.3);
    expect(toJobProgress({ ...s, outTimeSeconds: 5 }, 4)).toMatchObject({
      percent: 100,
      etaSeconds: 0,
    });
  });

  it('has no eta without a positive speed and no percent without a duration', () => {
    const s = { outTimeSeconds: 1, speed: null, fps: null, sizeBytes: null };
    expect(toJobProgress(s, 4).etaSeconds).toBeNull();
    expect(toJobProgress({ ...s, speed: 0 }, 4).etaSeconds).toBeNull();
    expect(toJobProgress({ ...s, speed: 1 }, 0)).toMatchObject({ percent: null, etaSeconds: null });
  });
});

describe('progressReader', () => {
  it('turns stdout chunks, split anywhere, into one sample per block', () => {
    const samples: number[] = [];
    const read = progressReader((s) => samples.push(s.outTimeSeconds));
    read('out_time_us=1000000\nspeed=2x\npro');
    read('gress=continue\r\nout_time_us=2500000\n');
    expect(samples).toEqual([1]);
    read('progress=end\n');
    expect(samples).toEqual([1, 2.5]);
  });
});

describe('toVerifyProgress', () => {
  it('fills by the checks done and says how many', () => {
    expect(toVerifyProgress({ stage: 'checks', done: 3, total: 14 })).toEqual({
      percent: 21.4,
      outTimeSeconds: 0,
      speed: null,
      fps: null,
      sizeBytes: null,
      etaSeconds: null,
      verify: { stage: 'checks', done: 3, total: 14 },
    });
  });

  it('a whole-file decode is measured by its time against the output duration', () => {
    const sample = { outTimeSeconds: 30, speed: 10, fps: 240, sizeBytes: null };
    expect(toVerifyProgress({ stage: 'full-decode', sample, durationSeconds: 120 })).toEqual({
      percent: 25,
      outTimeSeconds: 30,
      speed: 10,
      fps: 240,
      sizeBytes: null,
      etaSeconds: 9,
      verify: { stage: 'full-decode', done: null, total: null },
    });
    expect(
      toVerifyProgress({ stage: 'full-decode', sample, durationSeconds: null }).percent,
    ).toBeNull();
  });

  it('re-checking the source has no measure', () => {
    expect(toVerifyProgress({ stage: 'source' })).toMatchObject({
      percent: null,
      verify: { stage: 'source', done: null, total: null },
    });
  });
});
