import { describe, expect, it, vi } from 'vitest';
import { updateJob } from '../../db/repos/jobs/jobs.ts';
import { type EngineEvent, EngineEvents, MAX_BUFFERED_EVENTS } from '../events.ts';
import { MAX_READY } from './scheduler.ts';
import {
  at,
  cuda,
  db,
  events,
  executor,
  flush,
  gpuSlots,
  job,
  newScheduler,
  now,
  row,
  scheduler,
  setScheduler,
  useScheduler,
} from './testing/scheduler.ts';

useScheduler();

describe('Scheduler', () => {
  it('a job that starts preparing names no GPU, even when a row queued before #59 still has one', async () => {
    job('a', { queuedAt: 1 });
    updateJob(db, 'a', { encodedOn: 'GPU 0' }, now());
    scheduler.start();
    await flush();
    expect(row('a')).toMatchObject({ state: 'probing', encodedOn: null });
  });

  it('runs at most one encode and one quick job at once, quick alongside encode', async () => {
    const seen: EngineEvent[] = [];
    const ac = new AbortController();
    const collecting = (async () => {
      for await (const e of events.subscribe(ac.signal)) seen.push(e);
    })();
    job('a', { queuedAt: 1 });
    job('b', { queuedAt: 2 });
    job('c', { queuedAt: 3 });
    scheduler.start();
    await flush();
    expect(executor.prepareOrder).toEqual(['a', 'b']); // two prep workers
    expect(row('a').state).toBe('probing');
    expect(scheduler.status().preparing).toEqual(['a', 'b']);

    executor.ready('a', 'encode');
    await flush();
    expect(executor.prepareOrder).toEqual(['a', 'b', 'c']);
    executor.ready('b', 'encode');
    executor.ready('c', 'quick');
    await flush();
    expect(executor.executeOrder).toEqual(['a', 'c']);
    expect(scheduler.status().lanes).toEqual({ encode: 'a', quick: 'c' });
    expect(row('a').lane).toBe('encode');
    // Planned and waiting: the row names the lane it is waiting for, its state is not encoding yet.
    expect(row('b').lane).toBe('encode');
    expect(row('b').state).not.toBe('encoding');
    expect(scheduler.status().lanes.encode).toBe('a');

    executor.finish('a');
    await flush();
    expect(executor.executeOrder).toEqual(['a', 'c', 'b']);
    expect(scheduler.status().lanes).toEqual({ encode: 'b', quick: 'c' });

    ac.abort();
    await collecting;
    expect(seen).toContainEqual(
      expect.objectContaining({ type: 'job.changed', jobId: 'a', state: 'probing', lane: null }),
    );
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: 'job.changed',
        jobId: 'b',
        lane: 'encode',
        currentNode: null,
      }),
    );
    expect(seen).toContainEqual({
      type: 'queue.changed',
      paused: false,
      lanes: { encode: 'b', quick: 'c' },
      encodeSlots: [{ id: 'encode', label: 'Encode', jobId: 'b' }],
    });
    // One slot, as before: no device named.
    expect(executor.exec('a').device).toBeNull();
  });

  it('a job that is done with the encoder (encoded) frees its slot: the next encode starts while it verifies', async () => {
    job('a', { queuedAt: 1 });
    job('b', { queuedAt: 2 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    executor.ready('b', 'encode');
    await flush();
    expect(executor.executeOrder).toEqual(['a']);

    // a's ffmpeg ended: it now verifies its output and copies it into the library, without the GPU.
    executor.exec('a').ctl.releaseEncoder?.();
    await flush();
    expect(executor.executeOrder).toEqual(['a', 'b']);
    expect(scheduler.status().lanes.encode).toBe('b');

    // A pause and resume of a never takes the slot back from b; a second release is a no-op.
    scheduler.pauseJob('a');
    scheduler.resumeJob('a');
    executor.exec('a').ctl.releaseEncoder?.();
    await flush();
    expect(scheduler.status().lanes.encode).toBe('b');

    // a finishing later leaves b's slot alone.
    executor.finish('a');
    await flush();
    expect(scheduler.status().lanes.encode).toBe('b');
    executor.finish('b');
    await flush();
    expect(scheduler.status().lanes.encode).toBeNull();
  });

  it('a job that gave up the encoder and asks for a retry waits for a free slot again', async () => {
    job('a', { queuedAt: 1 });
    job('b', { queuedAt: 2 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    executor.ready('b', 'encode');
    await flush();
    executor.exec('a').ctl.releaseEncoder?.();
    await flush();
    expect(scheduler.status().lanes.encode).toBe('b');

    // a's verify failed: it is queued again and prepared, but b holds the only slot.
    executor.exec('a').d.resolve({ requeue: { reason: 'verify failed', attempt: 2 } });
    await flush();
    executor.ready('a', 'encode');
    await flush();
    expect(executor.executeOrder).toEqual(['a', 'b']);
    expect(scheduler.status().lanes.encode).toBe('b');

    // b is done: the retry takes the slot.
    executor.finish('b');
    await flush();
    expect(executor.executeOrder).toEqual(['a', 'b', 'a']);
    expect(scheduler.status().lanes.encode).toBe('a');
    expect(row('a')).toMatchObject({ state: 'encoding', attempt: 2 });
  });

  it('a quick job releasing the encoder changes nothing', async () => {
    job('q', { queuedAt: 1 });
    scheduler.start();
    await flush();
    executor.ready('q', 'quick');
    await flush();
    executor.exec('q').ctl.releaseEncoder?.();
    await flush();
    expect(scheduler.status().lanes).toEqual({ encode: null, quick: 'q' });
  });

  it('two GPUs: two encodes at once, each on its own GPU; a third waits for a free one', async () => {
    await scheduler.stop();
    setScheduler(newScheduler(executor, () => gpuSlots(2)));
    for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) job(id, { queuedAt: i + 1 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    executor.ready('b', 'encode');
    await flush();
    executor.ready('c', 'encode');
    executor.ready('d', 'quick');
    await flush();
    expect(executor.executeOrder).toEqual(['a', 'b', 'd']);
    expect(executor.exec('a').device).toEqual(cuda(0));
    expect(executor.exec('b').device).toEqual(cuda(1));
    expect(row('a').lane).toBe('encode');
    expect(scheduler.status().encodeSlots).toEqual([
      { id: 'gpu:0', label: 'GPU 0', jobId: 'a' },
      { id: 'gpu:1', label: 'GPU 1', jobId: 'b' },
    ]);
    // Older clients read one encode lane: the first busy slot.
    expect(scheduler.status().lanes).toEqual({ encode: 'a', quick: 'd' });

    executor.finish('b');
    await flush();
    expect(executor.executeOrder).toEqual(['a', 'b', 'd', 'c']);
    expect(executor.exec('c').device).toEqual(cuda(1));
    expect(scheduler.status().encodeSlots.map((s) => s.jobId)).toEqual(['a', 'c']);
  });

  it('two GPUs: a paused job gets its own GPU back, never the other one', async () => {
    await scheduler.stop();
    setScheduler(newScheduler(executor, () => gpuSlots(2)));
    for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) job(id, { queuedAt: i + 1 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    executor.ready('b', 'encode');
    await flush();
    const procA = executor.exec('a').proc;
    expect(scheduler.pauseJob('a')).toBe('ok');
    await flush();
    executor.ready('c', 'encode');
    await flush();
    expect(executor.exec('c').device).toEqual(cuda(0)); // a's GPU, freed by the pause
    expect(scheduler.resumeJob('a')).toBe('ok');
    executor.ready('d', 'encode');
    await flush();
    executor.finish('b'); // GPU 1 frees up: a's ffmpeg runs on GPU 0, so d takes GPU 1
    await flush();
    expect(procA.signals).toEqual(['SIGSTOP']);
    expect(executor.exec('d').device).toEqual(cuda(1));
    executor.finish('c');
    await flush();
    expect(procA.signals).toEqual(['SIGSTOP', 'SIGCONT']);
    expect(scheduler.status().encodeSlots.map((s) => s.jobId)).toEqual(['a', 'd']);
  });

  it('a paused job whose GPU is no longer a slot (the setting changed) takes any free one', async () => {
    let slots = gpuSlots(2);
    await scheduler.stop();
    setScheduler(newScheduler(executor, () => slots));
    job('a', { queuedAt: 1 });
    job('b', { queuedAt: 2 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    executor.ready('b', 'encode');
    await flush();
    expect(executor.exec('b').device).toEqual(cuda(1));
    scheduler.pauseJob('b');
    await flush();
    slots = [{ id: 'encode', label: 'Encode', device: null, gpuId: null }];
    scheduler.resumeJob('b');
    await flush();
    // a still runs on GPU 0 (shown until it ends); b continues in the one slot there is now.
    expect(executor.exec('b').proc.signals).toEqual(['SIGSTOP', 'SIGCONT']);
    expect(scheduler.status().encodeSlots).toEqual([
      { id: 'encode', label: 'Encode', jobId: 'b' },
      { id: 'gpu:0', label: 'GPU 0', jobId: 'a' },
    ]);
    executor.finish('a');
    await flush();
    expect(scheduler.status().encodeSlots).toEqual([{ id: 'encode', label: 'Encode', jobId: 'b' }]);
  });

  it('orders by priority then queued time', async () => {
    job('blocker', { priority: 10, queuedAt: 5 });
    job('x', { priority: 0, queuedAt: 1 });
    job('y', { priority: 0, queuedAt: 0 });
    job('z', { priority: 5, queuedAt: 2 });
    scheduler.start();
    await flush();
    expect(executor.prepareOrder).toEqual(['blocker', 'z']);
    executor.ready('blocker', 'encode');
    await flush();
    expect(executor.prepareOrder).toEqual(['blocker', 'z', 'y']);
    // y is prepared before z, but z has the higher priority.
    executor.ready('y', 'encode');
    executor.ready('z', 'encode');
    await flush();
    expect(scheduler.status().ready).toEqual(['z', 'y']);
    executor.finish('blocker');
    await flush();
    expect(executor.executeOrder).toEqual(['blocker', 'z']);
    expect(executor.prepareOrder).toEqual(['blocker', 'z', 'y', 'x']);
    executor.ready('x', 'encode');
    await flush();
    executor.finish('z');
    await flush();
    executor.finish('y');
    await flush();
    expect(executor.executeOrder).toEqual(['blocker', 'z', 'y', 'x']);
  });

  it('a long encode does not get the whole queue prepared: at most MAX_READY jobs wait', async () => {
    for (let i = 0; i < 8; i += 1) job(`j${i}`, { queuedAt: i });
    scheduler.start();
    await flush();
    executor.ready('j0', 'encode');
    await flush();
    // Every prepared job goes to the busy encode lane; keep settling whatever is prepared.
    for (let i = 1; i < 8 && executor.preps.has(`j${i}`); i += 1) {
      executor.ready(`j${i}`, 'encode');
      await flush();
      const { preparing, ready } = scheduler.status();
      expect(preparing.length + ready.length).toBeLessThanOrEqual(MAX_READY);
    }
    expect(scheduler.status()).toMatchObject({ preparing: [], ready: ['j1', 'j2', 'j3', 'j4'] });
    expect(executor.prepareOrder).toEqual(['j0', 'j1', 'j2', 'j3', 'j4']);
    expect(row('j5').state).toBe('queued');

    executor.finish('j0');
    await flush();
    expect(executor.executeOrder).toEqual(['j0', 'j1']);
    expect(executor.prepareOrder).toEqual(['j0', 'j1', 'j2', 'j3', 'j4', 'j5']);
  });

  it('looks ahead past ready encode jobs so a quick job runs alongside a long encode', async () => {
    job('a', { queuedAt: 1 });
    job('e1', { queuedAt: 2 });
    job('e2', { queuedAt: 3 });
    job('q', { queuedAt: 4 });
    job('later', { queuedAt: 5 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode'); // the long encode
    await flush();
    executor.ready('e1', 'encode');
    await flush();
    executor.ready('e2', 'encode');
    await flush();
    expect(executor.prepareOrder).toContain('q');
    executor.ready('q', 'quick');
    await flush();
    expect(executor.executeOrder).toEqual(['a', 'q']);
    expect(scheduler.status().lanes).toEqual({ encode: 'a', quick: 'q' });
  });

  it('stops looking ahead once every lane has a ready job waiting', async () => {
    for (const [i, id] of ['a', 'b', 'c', 'd', 'e', 'f'].entries()) job(id, { queuedAt: i });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    executor.ready('b', 'quick'); // both lanes busy
    await flush();
    executor.ready('c', 'encode'); // quick has no ready job yet: e is prepared too
    await flush();
    executor.ready('d', 'quick');
    executor.ready('e', 'encode');
    await flush();
    expect(scheduler.status()).toMatchObject({ preparing: [], ready: ['c', 'd', 'e'] });
    expect(row('f').state).toBe('queued');
  });

  it('a frozen job releases its lane; the next job starts; resume waits for the lane and sends SIGCONT first', async () => {
    job('a', { queuedAt: 1 });
    job('b', { queuedAt: 2 });
    job('c', { queuedAt: 3 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    executor.ready('b', 'encode');
    await flush();
    const procA = executor.exec('a').proc;

    expect(scheduler.pauseJob('a')).toBe('ok');
    await flush();
    expect(procA.signals).toEqual(['SIGSTOP']);
    expect(row('a')).toMatchObject({ state: 'encoding', paused: true });
    expect(executor.exec('a').ctl.paused()).toBe(true);
    expect(scheduler.status().lanes.encode).toBe('b');

    expect(scheduler.resumeJob('a')).toBe('ok');
    expect(scheduler.resumeJob('a')).toBe('not-paused');
    await flush();
    expect(procA.signals).toEqual(['SIGSTOP']); // the lane is still b's
    expect(row('a').paused).toBe(false);

    executor.ready('c', 'encode'); // ready, but the frozen job comes first
    await flush();
    executor.finish('b');
    await flush();
    expect(procA.signals).toEqual(['SIGSTOP', 'SIGCONT']);
    expect(scheduler.status().lanes.encode).toBe('a');
    expect(executor.executeOrder).toEqual(['a', 'b']);

    executor.finish('a');
    await flush();
    expect(executor.executeOrder).toEqual(['a', 'b', 'c']);
  });
});

describe('EngineEvents', () => {
  it('emits a ping every heartbeatMs to each subscriber and stops on abort', async () => {
    const ev = new EngineEvents({ heartbeatMs: 10, now: () => at(7) });
    const collect = async (ac: AbortController, out: EngineEvent[]): Promise<void> => {
      for await (const e of ev.subscribe(ac.signal)) {
        out.push(e);
        if (out.filter((x) => x.type === 'ping').length === 2) ac.abort();
      }
    };
    const one: EngineEvent[] = [];
    const two: EngineEvent[] = [];
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const done = Promise.all([collect(ac1, one), collect(ac2, two)]);
    ev.publish({ type: 'run.changed', runId: 'r1' });
    await done;
    for (const out of [one, two]) {
      expect(out[0]).toEqual({ type: 'run.changed', runId: 'r1' });
      expect(out.slice(1)).toEqual([
        { type: 'ping', at: at(7).toISOString() },
        { type: 'ping', at: at(7).toISOString() },
      ]);
    }
    // Aborted subscribers receive nothing more, and their heartbeat timers are gone.
    ev.publish({ type: 'run.changed', runId: 'r2' });
    await new Promise((r) => setTimeout(r, 30));
    expect(one).toHaveLength(3);
    expect(two).toHaveLength(3);
  });

  it('return() ends a subscription at once, even before the first next()', async () => {
    vi.useFakeTimers();
    try {
      const ev = new EngineEvents({ heartbeatMs: 10 });
      const it = ev.subscribe();
      expect(vi.getTimerCount()).toBe(1);
      await it.return?.();
      expect(vi.getTimerCount()).toBe(0);
      ev.publish({ type: 'run.changed', runId: 'r1' });
      expect(await it.next()).toEqual({ done: true, value: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a subscriber that falls behind gets one resync in place of the dropped events', async () => {
    const ev = new EngineEvents({ heartbeatMs: 60_000, now: () => at(7) });
    const ac = new AbortController();
    const it = ev.subscribe(ac.signal);
    for (let i = 0; i < MAX_BUFFERED_EVENTS + 5; i += 1) {
      ev.publish({ type: 'run.changed', runId: `r${i}` });
    }
    const got: EngineEvent[] = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await it.next();
      if (!r.done) got.push(r.value);
    }
    ac.abort();
    expect(got).toEqual([
      { type: 'resync', at: at(7).toISOString() },
      ...[100, 101, 102, 103, 104].map((i) => ({ type: 'run.changed', runId: `r${i}` })),
    ]);
    expect(await it.next()).toEqual({ done: true, value: undefined });
  });
});
