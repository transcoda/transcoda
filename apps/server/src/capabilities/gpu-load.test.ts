import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Gpu } from './devices.ts';
import type { Exec } from './ffmpeg.ts';
import { GpuLoadSampler, parseGpuLoad } from './gpu-load.ts';

const rtx: Gpu = { id: 'nvidia:0', vendor: 'nvidia', index: 0, name: 'NVIDIA GeForce RTX 3060' };
const ok = (stdout: string): Exec => vi.fn(async () => ({ stdout, stderr: '' }));

describe('parseGpuLoad', () => {
  it('parses one line per GPU and skips N/A', () => {
    expect(parseGpuLoad('0, 97, 41\n1, [N/A], [N/A]\n')).toEqual([
      { index: 0, encoder: 97, decoder: 41 },
    ]);
  });
});

describe('GpuLoadSampler', () => {
  let t = 0;
  const now = () => new Date(t);
  beforeEach(() => {
    t = Date.parse('2026-10-25T23:00:00.000Z');
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps one hour of samples per GPU and drops older ones', async () => {
    const s = new GpuLoadSampler({ exec: ok('0, 97, 41\n'), now, gpus: () => [rtx] });
    for (let i = 0; i < 721; i += 1) {
      await s.sampleOnce();
      t += 5000;
    }
    const samples = s.snapshot().gpus[0]?.samples ?? [];
    expect(samples).toHaveLength(720);
    const span = Date.parse(samples.at(-1)?.at ?? '') - Date.parse(samples[0]?.at ?? '');
    expect(span).toBe(3_595_000);
    expect(samples[0]).toMatchObject({ encoder: 97, decoder: 41 });
  });

  it('names GPUs from capabilities; a GPU nvidia-smi does not report has no entry', async () => {
    const two: Gpu = { id: 'nvidia:1', vendor: 'nvidia', index: 1, name: 'Second' };
    const s = new GpuLoadSampler({ exec: ok('0, 10, 5\n'), now, gpus: () => [rtx, two] });
    await s.sampleOnce();
    expect(s.snapshot()).toEqual({
      intervalMs: 5000,
      gpus: [
        {
          index: 0,
          name: 'NVIDIA GeForce RTX 3060',
          samples: [{ at: '2026-10-25T23:00:00.000Z', encoder: 10, decoder: 5 }],
        },
      ],
    });
  });

  it('a failing or missing nvidia-smi leaves no samples and never throws', async () => {
    const exec: Exec = vi.fn(async () => {
      throw Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' });
    });
    const s = new GpuLoadSampler({ exec, now, gpus: () => [rtx] });
    await expect(s.sampleOnce()).resolves.toBeUndefined();
    expect(s.snapshot().gpus).toEqual([]);
  });

  it('never starts a sample while the previous one is still running', async () => {
    const exec: Exec = vi.fn(() => new Promise<never>(() => {}));
    const s = new GpuLoadSampler({ exec, now, gpus: () => [rtx] });
    s.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(exec).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('does not start without GPUs', async () => {
    const exec = ok('0, 1, 1\n');
    const s = new GpuLoadSampler({ exec, now, gpus: () => [] });
    s.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exec).not.toHaveBeenCalled();
  });

  it('stop clears the timer', async () => {
    const exec = ok('0, 1, 1\n');
    const s = new GpuLoadSampler({ exec, now, gpus: () => [rtx] });
    s.start();
    await vi.advanceTimersByTimeAsync(5_000);
    const calls = vi.mocked(exec).mock.calls.length;
    s.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(exec).mock.calls.length).toBe(calls);
  });
});
