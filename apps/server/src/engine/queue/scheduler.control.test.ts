import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type JobRow, updateJob } from '../../db/repos/jobs/jobs.ts';
import { getSetting, SETTING_KEYS } from '../../db/repos/settings.ts';
import { type EngineEvent, EngineEvents } from '../events.ts';
import { Scheduler, type StopReason } from './scheduler.ts';
import {
  db,
  events,
  executor,
  FakeExecutor,
  flush,
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
  it('cancel of a queued job → cancelled; of a running job → kill + abort', async () => {
    job('a', { queuedAt: 1 });
    job('b', { queuedAt: 2 });
    job('q', { queuedAt: 3 });
    scheduler.start();
    await flush();

    expect(scheduler.cancelJob('q')).toBe('ok');
    expect(row('q')).toMatchObject({ state: 'cancelled', lane: null });
    expect(row('q').finishedAt).not.toBeNull();

    executor.ready('a', 'encode');
    executor.ready('b', 'encode');
    await flush();
    expect(scheduler.cancelJob('b')).toBe('ok'); // ready, waiting for the lane
    expect(row('b').state).toBe('cancelled');

    const a = executor.exec('a');
    expect(scheduler.cancelJob('a')).toBe('ok');
    expect(a.proc.signals).toEqual(['SIGKILL']);
    expect(a.ctl.signal.aborted).toBe(true);
    expect(a.ctl.stopReason()).toBe<StopReason>('cancel');
    await flush();
    expect(row('a').state).toBe('cancelled');
    expect(scheduler.status().lanes.encode).toBeNull();
    expect(executor.prepareOrder).toEqual(['a', 'b']); // q never started
    expect(scheduler.cancelJob('a')).toBe('not-active');
    expect(scheduler.cancelJob('nope')).toBe('not-active');
  });

  it('a bulk cancel (beforeWrite) leaves a replacing or written job alone; a cancel under way answers already', async () => {
    job('a', { queuedAt: 1 });
    job('b', { queuedAt: 2 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    executor.ready('b', 'quick');
    await flush();
    const a = executor.exec('a');
    const b = executor.exec('b');

    a.ctl.changed(updateJob(db, 'a', { state: 'replacing' }, now()) as JobRow);
    expect(scheduler.cancelJob('a', { beforeWrite: true })).toBe('writing');
    b.ctl.markWritten?.();
    expect(scheduler.cancelJob('b', { beforeWrite: true })).toBe('writing');
    expect(a.ctl.signal.aborted || b.ctl.signal.aborted).toBe(false);
    expect([...a.proc.signals, ...b.proc.signals]).toEqual([]);

    // A single cancel is unchanged: it still stops them.
    expect(scheduler.cancelJob('b')).toBe('ok');
    expect(b.proc.signals).toEqual(['SIGKILL']);
    expect(scheduler.cancelJob('b')).toBe('already');
    expect(scheduler.cancelJob('b', { beforeWrite: true })).toBe('already');
    expect(b.proc.signals).toEqual(['SIGKILL']);
    await flush();
    expect(scheduler.cancelJob('b')).toBe('not-active');
  });

  it('queue pause freezes running jobs, blocks ready jobs (even one prepared after the pause), persists in settings, and survives a new Scheduler over the same db', async () => {
    job('a', { queuedAt: 1 });
    job('b', { queuedAt: 2 });
    job('c', { queuedAt: 3 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    await flush();
    const procA = executor.exec('a').proc;
    expect(executor.prepareOrder).toEqual(['a', 'b', 'c']);

    scheduler.pauseQueue();
    expect(procA.signals).toEqual(['SIGSTOP']);
    expect(getSetting(db, SETTING_KEYS.queuePaused, z.boolean())).toBe(true);
    expect(scheduler.status().paused).toBe(true);
    expect(row('a').paused).toBe(false); // frozen by the queue, not paused itself

    executor.ready('b', 'quick'); // prepared after the pause: the free quick lane stays free
    await flush();
    expect(scheduler.status().lanes).toEqual({ encode: 'a', quick: null });
    expect(executor.executeOrder).toEqual(['a']);
    job('d', { queuedAt: 4 });
    executor.ready('c', 'encode'); // frees a prep worker, but nothing new is taken
    await flush();
    expect(executor.prepareOrder).toEqual(['a', 'b', 'c']);

    scheduler.resumeQueue();
    await flush();
    expect(procA.signals).toEqual(['SIGSTOP', 'SIGCONT']);
    expect(getSetting(db, SETTING_KEYS.queuePaused, z.boolean())).toBe(false);
    expect(executor.executeOrder).toEqual(['a', 'b']);
    expect(executor.prepareOrder).toEqual(['a', 'b', 'c', 'd']);

    scheduler.pauseQueue();
    await scheduler.stop();
    job('e', { queuedAt: 5 });

    const executor2 = new FakeExecutor(db);
    setScheduler(newScheduler(executor2));
    scheduler.start();
    await flush();
    expect(scheduler.status().paused).toBe(true);
    expect(executor2.prepareOrder).toEqual([]);
    scheduler.resumeQueue();
    await flush();
    expect(executor2.prepareOrder).toEqual(['e']);
  });

  it('a job paused individually stays paused after queue resume', async () => {
    job('a', { queuedAt: 1 });
    job('f', { queuedAt: 2 });
    job('q', { queuedAt: 9 });
    scheduler.start();
    await flush();
    expect(scheduler.pauseJob('q')).toBe('ok'); // queued: skipped while paused
    executor.ready('a', 'encode');
    await flush();
    const procA = executor.exec('a').proc;

    expect(scheduler.pauseJob('a')).toBe('ok');
    scheduler.pauseQueue();
    scheduler.resumeQueue();
    await flush();
    expect(procA.signals).toEqual(['SIGSTOP']);
    expect(row('a').paused).toBe(true);
    expect(row('q')).toMatchObject({ state: 'queued', paused: true });
    expect(executor.prepareOrder).toEqual(['a', 'f']); // a's free prep worker skips q

    expect(scheduler.resumeJob('q')).toBe('ok');
    await flush();
    expect(executor.prepareOrder).toEqual(['a', 'f', 'q']);
  });

  it('stop() aborts with reason shutdown and kills attached processes; the job row is left in its running state', async () => {
    job('a', { queuedAt: 1 });
    job('b', { queuedAt: 2 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    await flush();
    const a = executor.exec('a');
    const b = executor.prep('b');

    await scheduler.stop();
    expect(a.ctl.stopReason()).toBe('shutdown');
    expect(a.ctl.signal.reason).toBe('shutdown');
    expect(b.ctl.stopReason()).toBe('shutdown');
    expect(a.proc.signals).toEqual(['SIGKILL']);
    expect(row('a')).toMatchObject({ state: 'encoding', lane: 'encode', finishedAt: null });
    expect(row('b')).toMatchObject({ state: 'probing', reason: null });
    // Nothing more is started or written after the stop.
    scheduler.tick();
    expect(scheduler.pauseJob('a')).toBe('not-active');
    expect(row('a').paused).toBe(false);
  });

  it('cancel of a frozen job kills it and leaves the lane to the job holding it', async () => {
    job('a', { queuedAt: 1 });
    job('b', { queuedAt: 2 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    executor.ready('b', 'encode');
    await flush();
    const a = executor.exec('a');
    scheduler.pauseJob('a');
    await flush();
    expect(scheduler.status().lanes.encode).toBe('b');

    expect(scheduler.cancelJob('a')).toBe('ok');
    expect(a.proc.signals).toEqual(['SIGSTOP', 'SIGKILL']);
    expect(a.ctl.stopReason()).toBe('cancel');
    await flush();
    expect(row('a').state).toBe('cancelled');
    expect(scheduler.status().lanes.encode).toBe('b');
    expect(executor.discarded).toEqual([]); // the executor recorded the cancel itself
  });

  it('cancel of a ready job discards it; a cancelled prepare that returns final without a final state is cancelled', async () => {
    job('a', { queuedAt: 1 });
    job('b', { queuedAt: 2 });
    job('c', { queuedAt: 3 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    executor.ready('b', 'encode');
    await flush();
    expect(scheduler.cancelJob('b')).toBe('ok');
    await flush();
    expect(row('b').state).toBe('cancelled');
    expect(executor.discarded).toEqual(['b']);

    const c = executor.prep('c');
    expect(scheduler.cancelJob('c')).toBe('ok');
    expect(c.ctl.stopReason()).toBe('cancel');
    c.d.resolve({ final: true });
    await flush();
    expect(row('c')).toMatchObject({ state: 'cancelled', lane: null });
    expect(executor.discarded).toEqual(['b', 'c']);
  });

  it('a prepare that returns final without recording a final state fails the job', async () => {
    job('a', { queuedAt: 1 });
    scheduler.start();
    await flush();
    executor.prep('a').d.resolve({ final: true });
    await flush();
    expect(row('a')).toMatchObject({
      state: 'failed',
      failureCode: 'internal',
      reason: 'internal error: prepare ended without a final state',
    });
  });

  it('an execute that asks for a requeue is queued only after its lane is released, then taken again', async () => {
    const published: EngineEvent[] = [];
    vi.spyOn(events, 'publish').mockImplementation((e) => published.push(e));
    job('a', { queuedAt: 1 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    await flush();
    expect(scheduler.status().lanes.encode).toBe('a');
    executor.exec('a').d.resolve({ requeue: { reason: 'verify failed', attempt: 2 } });
    await flush();
    expect(row('a')).toMatchObject({ state: 'probing', attempt: 2, reason: 'verify failed' });
    expect(executor.prepareOrder).toEqual(['a', 'a']);
    const queuedEvents = published.filter(
      (e) => e.type === 'job.changed' && e.jobId === 'a' && e.state === 'queued',
    );
    expect(queuedEvents).toHaveLength(1);
  });

  it('pauseJob during a queue pause frees the lane; queue resume leaves it stopped and starts the next job', async () => {
    job('a', { queuedAt: 1 });
    job('b', { queuedAt: 2 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    executor.ready('b', 'encode');
    await flush();
    const procA = executor.exec('a').proc;

    scheduler.pauseQueue();
    expect(scheduler.pauseJob('a')).toBe('ok');
    expect(procA.signals).toEqual(['SIGSTOP']); // stopped once
    expect(scheduler.status().lanes.encode).toBeNull();
    await flush();
    expect(executor.executeOrder).toEqual(['a']); // nothing granted while the queue is paused

    scheduler.resumeQueue();
    await flush();
    expect(procA.signals).toEqual(['SIGSTOP']);
    expect(scheduler.status().lanes.encode).toBe('b');
    expect(row('a').paused).toBe(true);
  });

  it('a user pause while holding the lane with no process keeps the lane until a process attaches', async () => {
    job('a', { queuedAt: 1 });
    job('b', { queuedAt: 2 });
    executor.attachOnExecute = false;
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    executor.ready('b', 'encode');
    await flush();
    const a = executor.exec('a');

    expect(scheduler.pauseJob('a')).toBe('ok');
    await flush();
    expect(row('a').paused).toBe(true);
    expect(scheduler.status().lanes.encode).toBe('a');
    expect(executor.executeOrder).toEqual(['a']);

    a.ctl.attach(a.proc);
    await flush();
    expect(a.proc.signals).toEqual(['SIGSTOP']);
    expect(scheduler.status().lanes.encode).toBe('b');
    expect(executor.executeOrder).toEqual(['a', 'b']);
  });

  it('stop() kills a user-frozen process and aborts a paused ready job without writing', async () => {
    job('a', { queuedAt: 1 });
    job('b', { queuedAt: 2 });
    job('c', { queuedAt: 3 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    executor.ready('b', 'encode');
    await flush();
    const a = executor.exec('a');
    scheduler.pauseJob('a'); // frozen; b takes the lane
    await flush();
    executor.ready('c', 'encode');
    await flush();
    scheduler.pauseJob('c'); // ready and paused
    const c = executor.prep('c');
    const before = row('c').updatedAt;

    await scheduler.stop();
    expect(a.proc.signals).toEqual(['SIGSTOP', 'SIGKILL']);
    expect(a.ctl.stopReason()).toBe('shutdown');
    expect(c.ctl.stopReason()).toBe('shutdown');
    expect(row('a')).toMatchObject({ state: 'encoding', paused: true, finishedAt: null });
    expect(row('c')).toMatchObject({ paused: true, finishedAt: null, updatedAt: before });
    expect(executor.discarded).toEqual([]);
  });

  it('releases the lane and logs, without an unhandled rejection, when recording an outcome throws', async () => {
    const errors: unknown[] = [];
    const failing = new (class extends EngineEvents {
      override publish(e: EngineEvent): void {
        if (e.type === 'run.changed') throw new Error('publish broke');
        super.publish(e);
      }
    })();
    setScheduler(
      new Scheduler({
        db,
        executor,
        events: failing,
        now,
        log: { info: () => {}, warn: () => {}, error: (e) => errors.push(e) },
      }),
    );
    job('a', { queuedAt: 1 });
    job('b', { queuedAt: 2 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    executor.ready('b', 'encode');
    await flush();
    executor.exec('a').d.reject(new Error('executor broke'));
    await flush();
    expect(row('a')).toMatchObject({
      state: 'failed',
      failureCode: 'internal',
      reason: 'internal error: executor broke',
    });
    expect(scheduler.status().lanes.encode).toBe('b');
    expect(errors).toContainEqual(
      expect.objectContaining({ msg: 'scheduler task failed', error: 'publish broke' }),
    );
  });
});
