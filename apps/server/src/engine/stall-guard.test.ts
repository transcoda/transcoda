import { describe, expect, it } from 'vitest';
import type { RunnerProcess } from './process.ts';
import { OutputStallGuard, stallReason, watchForStall } from './stall-guard.ts';

const MIN = 60_000;

function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const sample = (outTimeSeconds: number, sizeBytes: number | null) => ({
  outTimeSeconds,
  sizeBytes,
  speed: null,
  fps: null,
});

describe('OutputStallGuard', () => {
  it('stalls after the limit with no progress at all (the muxer never started)', () => {
    const c = clock();
    const g = new OutputStallGuard(60 * MIN, c.now);
    c.advance(59 * MIN);
    expect(g.stalled()).toBe(false);
    c.advance(MIN);
    expect(g.stalled()).toBe(true);
  });

  it('a growing out time or size resets the clock; repeated samples with neither do not', () => {
    const c = clock();
    const g = new OutputStallGuard(10 * MIN, c.now);
    c.advance(9 * MIN);
    g.sample(sample(5, 1000));
    c.advance(9 * MIN);
    g.sample(sample(5, 2000)); // size grew
    c.advance(9 * MIN);
    g.sample(sample(6, 2000)); // time grew
    c.advance(9 * MIN);
    expect(g.stalled()).toBe(false);
    g.sample(sample(6, 2000));
    g.sample(sample(4, null));
    c.advance(MIN);
    expect(g.stalled()).toBe(true);
  });

  it('a slow encode that writes a little every few minutes never stalls', () => {
    const c = clock();
    const g = new OutputStallGuard(60 * MIN, c.now);
    for (let i = 1; i <= 24 * 12; i += 1) {
      c.advance(5 * MIN);
      g.sample(sample(i * 0.2, i * 50_000));
      expect(g.stalled()).toBe(false);
    }
  });

  it('time paused does not count', () => {
    const c = clock();
    const g = new OutputStallGuard(10 * MIN, c.now);
    c.advance(8 * MIN);
    g.pause();
    c.advance(120 * MIN);
    expect(g.stalled()).toBe(false);
    g.resume();
    c.advance(MIN);
    expect(g.stalled()).toBe(false);
    c.advance(MIN);
    expect(g.stalled()).toBe(true);
  });
});

describe('watchForStall', () => {
  function fakeProc() {
    const signals: string[] = [];
    const proc: RunnerProcess = {
      pid: 1,
      pause: () => signals.push('STOP'),
      resume: () => signals.push('CONT'),
      kill: () => signals.push('KILL'),
      done: new Promise(() => {}),
    };
    return { proc, signals };
  }

  it('kills the process once, after onStall, when the guard stalls', async () => {
    const c = clock();
    const g = new OutputStallGuard(40, c.now);
    const { proc, signals } = fakeProc();
    let calls = 0;
    const w = watchForStall(proc, g, 40, () => {
      calls += 1;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(signals).toEqual([]);
    c.advance(40);
    await new Promise((r) => setTimeout(r, 40));
    expect([calls, signals]).toEqual([1, ['KILL']]);
    w.stop();
  });

  it('pause and resume reach the process and hold the guard clock', async () => {
    const c = clock();
    const g = new OutputStallGuard(40, c.now);
    const { proc, signals } = fakeProc();
    const w = watchForStall(proc, g, 40, () => {});
    w.proc.pause();
    c.advance(1000);
    await new Promise((r) => setTimeout(r, 30));
    w.proc.resume();
    expect(signals).toEqual(['STOP', 'CONT']);
    expect(g.stalled()).toBe(false);
    w.stop();
  });
});

describe('stallReason', () => {
  it('says what happened in plain words', () => {
    expect(stallReason(60)).toMatch(/^ffmpeg wrote no output for 1 hour and was stopped\. /);
    expect(stallReason(120)).toMatch(/for 2 hours /);
    expect(stallReason(45)).toMatch(/for 45 minutes /);
    expect(stallReason(1)).toMatch(/for 1 minute /);
  });
});
