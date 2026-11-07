import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeExec } from '../capabilities/ffmpeg.ts';
import {
  decodeMemoryLimit,
  defaultDecodeMemoryBytes,
  isMemoryLimitError,
  MemoryLimitError,
  memoryLimitMessage,
  parseCgroupLimit,
  parseRss,
  setDecodeMemoryLimit,
  watchMemory,
} from './memory-guard.ts';

const GiB = 2 ** 30;

describe('parseRss', () => {
  it('reads VmRSS (kB) from /proc/<pid>/status; null without it', () => {
    expect(parseRss('Name:\tffmpeg\nVmPeak:\t 9000 kB\nVmRSS:\t  524288 kB\nThreads:\t9\n')).toBe(
      512 * 2 ** 20,
    );
    expect(parseRss('Name:\tkworker\nState:\tS (sleeping)\n')).toBeNull();
  });
});

describe('parseCgroupLimit', () => {
  it('reads a cgroup memory limit; "max" and the v1 no-limit value are no limit', () => {
    expect(parseCgroupLimit('8589934592\n')).toBe(8 * GiB);
    expect(parseCgroupLimit('max\n')).toBeNull();
    expect(parseCgroupLimit('9223372036854771712\n')).toBeNull();
    expect(parseCgroupLimit('')).toBeNull();
  });
});

describe('defaultDecodeMemoryBytes', () => {
  it('is 4 GiB, or half the memory when that is less, never under 1 GiB', () => {
    expect(defaultDecodeMemoryBytes(64 * GiB)).toBe(4 * GiB);
    expect(defaultDecodeMemoryBytes(8 * GiB)).toBe(4 * GiB);
    expect(defaultDecodeMemoryBytes(6 * GiB)).toBe(3 * GiB);
    expect(defaultDecodeMemoryBytes(1 * GiB)).toBe(1 * GiB);
    expect(defaultDecodeMemoryBytes(null)).toBe(4 * GiB);
  });
});

describe('memoryLimitMessage', () => {
  it('says the limit in GiB, or MiB below one', () => {
    expect(memoryLimitMessage(4 * GiB)).toBe(
      'ffmpeg used more than 4 GiB of memory and was stopped',
    );
    expect(memoryLimitMessage(1.5 * GiB)).toBe(
      'ffmpeg used more than 1.5 GiB of memory and was stopped',
    );
    expect(memoryLimitMessage(512 * 2 ** 20)).toBe(
      'ffmpeg used more than 512 MiB of memory and was stopped',
    );
  });
});

describe('MemoryLimitError', () => {
  it('is killed, carries the limit and stderr; recognised also when copied onto another error', () => {
    const e = new MemoryLimitError(4 * GiB, 'some stderr\n');
    expect(e).toMatchObject({
      name: 'MemoryLimitError',
      killed: true,
      memoryLimitBytes: 4 * GiB,
      stderr: 'some stderr\n',
      message: 'ffmpeg used more than 4 GiB of memory and was stopped',
    });
    expect(isMemoryLimitError(e)).toBe(true);
    expect(isMemoryLimitError(Object.assign(new Error('x'), { ...e }))).toBe(true);
    expect(isMemoryLimitError(Object.assign(new Error('x'), { killed: true }))).toBe(false);
    expect(isMemoryLimitError(null)).toBe(false);
  });
});

describe('watchMemory', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onExceed once when the RSS goes above the limit, and stops watching', async () => {
    vi.useFakeTimers();
    const seen = [100, 200, 5000, 6000];
    const read = vi.fn(async () => seen.shift() ?? null);
    const onExceed = vi.fn();
    const stop = watchMemory({ pid: 42, limitBytes: 1000, onExceed, read, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onExceed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onExceed).toHaveBeenCalledWith(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onExceed).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenCalledWith(42);
    stop();
  });

  it('an unreadable RSS (not Linux, the process gone) is never over the limit; stop() ends it', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => null);
    const onExceed = vi.fn();
    const stop = watchMemory({ pid: 42, limitBytes: 1, onExceed, read, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(onExceed).not.toHaveBeenCalled();
  });
});

describe('decodeMemoryLimit', () => {
  afterEach(() => {
    setDecodeMemoryLimit(undefined);
  });

  it('is the configured limit, null when turned off, the default otherwise', () => {
    setDecodeMemoryLimit(2 * GiB);
    expect(decodeMemoryLimit()).toBe(2 * GiB);
    setDecodeMemoryLimit(null);
    expect(decodeMemoryLimit()).toBeNull();
    setDecodeMemoryLimit(undefined);
    const limit = decodeMemoryLimit();
    expect(limit).toBeGreaterThanOrEqual(1 * GiB);
    expect(limit).toBeLessThanOrEqual(4 * GiB);
  });
});

describe('makeExec with the memory guard', () => {
  /** A child that idles for 10 s: only the guard can end it early. */
  const idle = [process.execPath, ['-e', 'setTimeout(() => {}, 10000)']] as const;

  it('SIGKILLs a child above the limit and rejects with a MemoryLimitError', async () => {
    const exec = makeExec({
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      memory: { limitBytes: GiB, read: async () => 5 * GiB, intervalMs: 50 },
    });
    const started = Date.now();
    const err = await exec(idle[0], [...idle[1]]).catch((e: unknown) => e);
    expect(isMemoryLimitError(err)).toBe(true);
    expect(err).toMatchObject({ killed: true, memoryLimitBytes: GiB });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('leaves a child below the limit alone', async () => {
    const exec = makeExec({
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      memory: { limitBytes: GiB, read: async () => 100 * 2 ** 20, intervalMs: 50 },
    });
    const r = await exec(process.execPath, ['-e', 'setTimeout(() => console.log("done"), 300)']);
    expect(r.stdout.trim()).toBe('done');
  });
});
