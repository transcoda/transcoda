import { beforeEach, describe, expect, it } from 'vitest';
import type { EncodeSlot } from '../../capabilities/devices.ts';
import { updateLibrary } from '../../db/repos/libraries.ts';
import { insertRun } from '../../db/repos/runs.ts';
import { MAX_WAKE_MS, Scheduler } from './scheduler.ts';
import {
  at,
  db,
  events,
  executor,
  flush,
  gpuSlots,
  job,
  log,
  row,
  scheduler,
  setScheduler,
  useScheduler,
} from './testing/scheduler.ts';

useScheduler();

describe('Scheduler run hours', () => {
  // t0 is Sunday 2026-03-01 12:00 UTC; the clock here starts at 12:01:40.
  let clock: Date;
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const armed = () => timers.filter((t) => !t.cleared);

  function gated(slots?: () => EncodeSlot[]): Scheduler {
    return new Scheduler({
      db,
      executor,
      events,
      now: () => clock,
      log,
      ...(slots ? { encodeSlots: slots } : {}),
      timeZone: 'UTC',
      timers: {
        set(fn, ms) {
          const t = { fn, ms, cleared: false };
          timers.push(t);
          return t;
        },
        clear(handle) {
          (handle as { cleared: boolean }).cleared = true;
        },
      },
    });
  }

  /** Run hours on l1: the given UTC hours every day. */
  function restrict(every: number[]): void {
    updateLibrary(
      db,
      'l1',
      { runHours: { enabled: true, perDay: false, every, days: [[], [], [], [], [], [], []] } },
      at(0),
    );
  }

  beforeEach(async () => {
    await scheduler.stop();
    clock = at(100);
    timers.length = 0;
    insertRun(
      db,
      {
        id: 'r2',
        libraryId: 'l1',
        workflowId: 'w1',
        workflowVersion: 1,
        requestedPath: '/lib',
        dryRun: false,
        testEncode: false,
        force: false,
        createdBy: 'u',
        source: 'library',
      },
      at(0),
    );
    setScheduler(gated());
  });

  it('holds library jobs outside the window while manual jobs of the same library start', async () => {
    restrict([22, 23, 0, 1]);
    job('auto', { runId: 'r2', queuedAt: 1 });
    job('hand', { runId: 'r1', queuedAt: 2 });
    scheduler.start();
    await flush();
    expect(executor.prepareOrder).toEqual(['hand']);
    expect(row('auto').state).toBe('queued');
  });

  it('starts library jobs as before while the restriction is off or the window is open', async () => {
    job('auto', { runId: 'r2' });
    scheduler.start();
    await flush();
    expect(executor.prepareOrder).toEqual(['auto']);

    restrict([12]);
    job('auto2', { runId: 'r2', queuedAt: 5 });
    scheduler.tick();
    await flush();
    expect(executor.prepareOrder).toEqual(['auto', 'auto2']);
  });

  it('wakes at the start of the next window and starts the held job then', async () => {
    restrict([13]);
    job('auto', { runId: 'r2' });
    scheduler.start();
    await flush();
    expect(executor.prepareOrder).toEqual([]);
    const [timer] = armed();
    // 12:01:40 → 13:00:00.
    expect(timer?.ms).toBe(58 * 60_000 + 20_000);

    clock = new Date(Date.parse('2026-03-01T13:00:00Z'));
    if (timer) timer.cleared = true; // it fired
    timer?.fn();
    await flush();
    expect(executor.prepareOrder).toEqual(['auto']);
    expect(armed()).toHaveLength(0);
  });

  it('wakes at most an hour ahead, and not at all for a window that never opens', async () => {
    restrict([22]);
    job('auto', { runId: 'r2' });
    scheduler.start();
    await flush();
    expect(armed().map((t) => t.ms)).toEqual([MAX_WAKE_MS]);

    restrict([]);
    scheduler.tick();
    expect(armed()).toHaveLength(0);
  });

  it('lets a running job finish after the window closes; the next library job waits', async () => {
    restrict([12]);
    job('a', { runId: 'r2', queuedAt: 1 });
    job('b', { runId: 'r2', queuedAt: 2 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    await flush();
    expect(executor.executeOrder).toEqual(['a']);

    // 13:00: closed. a keeps running; b, prepared at 12:xx, gets no lane when a ends.
    clock = new Date(Date.parse('2026-03-01T13:00:00Z'));
    executor.ready('b', 'encode');
    await flush();
    expect(executor.exec('a').proc.signals).toEqual([]);
    executor.finish('a');
    await flush();
    expect(row('a').state).toBe('done');
    expect(executor.executeOrder).toEqual(['a']);
    expect(scheduler.status().ready).toEqual(['b']);
  });

  it('two GPUs: a held job takes no free GPU; a paused job gets its GPU back after the window closes', async () => {
    setScheduler(gated(() => gpuSlots(2)));
    restrict([12]);
    for (const id of ['a', 'b', 'c']) job(id, { runId: 'r2', queuedAt: 1 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    executor.ready('b', 'encode');
    await flush();
    expect(executor.executeOrder).toEqual(['a', 'b']);

    // 13:00: closed. b is paused (GPU 1 frees up) and c becomes ready: c is held, GPU 1 stays idle.
    clock = new Date(Date.parse('2026-03-01T13:00:00Z'));
    scheduler.pauseJob('b');
    await flush();
    executor.ready('c', 'encode');
    await flush();
    expect(executor.executeOrder).toEqual(['a', 'b']);
    expect(scheduler.status().encodeSlots.map((x) => x.jobId)).toEqual(['a', null]);

    // A running job keeps or regains its slot whatever the hour.
    scheduler.resumeJob('b');
    await flush();
    expect(executor.exec('b').proc.signals).toEqual(['SIGSTOP', 'SIGCONT']);
    executor.finish('a');
    await flush();
    expect(executor.executeOrder).toEqual(['a', 'b']);
    expect(scheduler.status().encodeSlots.map((x) => x.jobId)).toEqual([null, 'b']);
    expect(scheduler.status().ready).toEqual(['c']);
  });

  it('a held ready job does not keep a manual job from preparing or from its lane', async () => {
    restrict([12]);
    for (const id of ['a', 'b', 'c', 'd']) job(id, { runId: 'r2', queuedAt: 1 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    executor.ready('b', 'encode');
    await flush();
    executor.ready('c', 'encode');
    executor.ready('d', 'encode');
    await flush();
    // 13:00: b, c and d are prepared but held once a ends.
    clock = new Date(Date.parse('2026-03-01T13:00:00Z'));
    executor.finish('a');
    await flush();
    expect(executor.executeOrder).toEqual(['a']);

    job('hand', { runId: 'r1', queuedAt: 9 });
    scheduler.tick();
    await flush();
    expect(executor.prepareOrder).toContain('hand');
    executor.ready('hand', 'encode');
    await flush();
    expect(executor.executeOrder).toEqual(['a', 'hand']);
  });
});
