import { emptyGraph, type JobState, type Lane } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { EncodeSlot } from '../capabilities/devices.ts';
import type { Database } from '../db/open.ts';
import { findJob, insertJob, type JobRow, updateJob } from '../db/repos/jobs.ts';
import { insertLibrary, updateLibrary } from '../db/repos/libraries.ts';
import { insertRun } from '../db/repos/runs.ts';
import { getSetting, SETTING_KEYS } from '../db/repos/settings.ts';
import { insertWorkflow } from '../db/repos/workflows.ts';
import { createTestDb } from '../db/test-db.ts';
import type { Logger } from '../logger.ts';
import { type EngineEvent, EngineEvents, MAX_BUFFERED_EVENTS } from './events.ts';
import type { ProcessResult, RunnerProcess } from './process.ts';
import type { RenderDevice } from './render.ts';
import {
  type ExecuteOutcome,
  type JobControl,
  type JobExecutor,
  MAX_READY,
  MAX_WAKE_MS,
  pickSlot,
  Scheduler,
  type SlotFit,
  type StopReason,
} from './scheduler.ts';

const t0 = Date.parse('2026-03-01T12:00:00.000Z');
const at = (s: number): Date => new Date(t0 + s * 1000);
const now = (): Date => at(100);
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (v: T) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Records the signals a job's process receives; `kill()` ends it. */
class FakeProcess implements RunnerProcess {
  readonly pid = 4242;
  readonly signals: string[] = [];
  private readonly end = deferred<ProcessResult>();
  readonly done = this.end.promise;
  pause(): void {
    this.signals.push('SIGSTOP');
  }
  resume(): void {
    this.signals.push('SIGCONT');
  }
  kill(): void {
    this.signals.push('SIGKILL');
    this.end.resolve({ code: null, signal: 'SIGKILL' });
  }
}

interface Prep {
  job: JobRow;
  ctl: JobControl;
  d: Deferred<{ lane: Lane; fit?: SlotFit } | { final: true }>;
}
interface Exec {
  job: JobRow;
  lane: Lane;
  device: RenderDevice | null;
  ctl: JobControl;
  proc: FakeProcess;
  d: Deferred<ExecuteOutcome | null>;
}

/**
 * prepare/execute return promises the test settles. `execute` moves the job to `encoding`,
 * attaches a FakeProcess and, like the real executor, records `cancelled` on a cancel and writes
 * nothing on a shutdown.
 */
class FakeExecutor implements JobExecutor {
  readonly preps = new Map<string, Prep>();
  readonly execs = new Map<string, Exec>();
  readonly prepareOrder: string[] = [];
  readonly executeOrder: string[] = [];
  readonly discarded: string[] = [];
  /** When false, `execute` attaches no process (the test attaches one later). */
  attachOnExecute = true;
  constructor(private readonly db: Database) {}

  prepare(job: JobRow, ctl: JobControl): Promise<{ lane: Lane; fit?: SlotFit } | { final: true }> {
    const d = deferred<{ lane: Lane; fit?: SlotFit } | { final: true }>();
    this.prepareOrder.push(job.id);
    this.preps.set(job.id, { job, ctl, d });
    ctl.signal.addEventListener('abort', () => {
      if (ctl.stopReason() === 'shutdown') d.reject(new Error('aborted'));
    });
    return d.promise;
  }

  execute(
    job: JobRow,
    lane: Lane,
    ctl: JobControl,
    slot: EncodeSlot | null,
  ): Promise<ExecuteOutcome | null> {
    const d = deferred<ExecuteOutcome | null>();
    const proc = new FakeProcess();
    this.executeOrder.push(job.id);
    this.execs.set(job.id, { job, lane, device: slot?.device ?? null, ctl, proc, d });
    updateJob(this.db, job.id, { state: 'encoding' }, now());
    if (this.attachOnExecute) ctl.attach(proc);
    ctl.signal.addEventListener('abort', () => {
      if (ctl.stopReason() === 'cancel') {
        updateJob(this.db, job.id, { state: 'cancelled', lane: null }, now());
      }
      d.resolve(null);
    });
    return d.promise;
  }

  async discard(job: JobRow): Promise<void> {
    this.discarded.push(job.id);
  }

  /** Prepares `id` into `lane` (with `fit`, the slots it fits). */
  ready(id: string, lane: Lane, fit?: SlotFit): void {
    this.prep(id).d.resolve(fit ? { lane, fit } : { lane });
  }
  /** Ends `id`'s execute as done. */
  finish(id: string): void {
    const e = this.exec(id);
    updateJob(this.db, id, { state: 'done', lane: null }, now());
    e.d.resolve(null);
  }
  prep(id: string): Prep {
    const p = this.preps.get(id);
    if (!p) throw new Error(`${id} was not prepared`);
    return p;
  }
  exec(id: string): Exec {
    const e = this.execs.get(id);
    if (!e) throw new Error(`${id} was not executed`);
    return e;
  }
}

let db: Database;
let executor: FakeExecutor;
let events: EngineEvents;
let scheduler: Scheduler;
const log: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function job(
  id: string,
  opts: { priority?: number; queuedAt?: number; state?: JobState; runId?: string } = {},
) {
  return insertJob(
    db,
    {
      id,
      runId: opts.runId ?? 'r1',
      libraryId: 'l1',
      fileId: null,
      path: `/lib/${id}.mkv`,
      workflowId: 'w1',
      workflowVersion: 1,
      dryRun: false,
      testEncode: false,
      state: opts.state ?? 'queued',
      priority: opts.priority ?? 0,
    },
    at(opts.queuedAt ?? 0),
  );
}

function newScheduler(exec: JobExecutor = executor, slots?: () => EncodeSlot[]): Scheduler {
  return new Scheduler({
    db,
    executor: exec,
    events,
    now,
    log,
    ...(slots ? { encodeSlots: slots } : {}),
  });
}

const cuda = (index: number): RenderDevice => ({ kind: 'cuda', index });
const gpuSlots = (n: number): EncodeSlot[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `gpu:${i}`,
    label: `GPU ${i}`,
    device: cuda(i),
    gpuId: `nvidia:${i}`,
  }));

const qsv = (renderNode: string): RenderDevice => ({ kind: 'qsv', renderNode });
const NVIDIA_SLOT: EncodeSlot = {
  id: 'gpu:0',
  label: 'GPU 0',
  device: cuda(0),
  gpuId: 'nvidia:0',
};
const INTEL_SLOT: EncodeSlot = {
  id: 'gpu:intel:0000:07:00.0',
  label: 'Intel Arc A310 · 07:00.0',
  device: qsv('/dev/dri/renderD128'),
  gpuId: 'intel:0000:07:00.0',
};

const row = (id: string): JobRow => {
  const r = findJob(db, id);
  if (!r) throw new Error(`no job ${id}`);
  return r;
};

beforeEach(() => {
  db = createTestDb();
  insertWorkflow(
    db,
    { id: 'w1', kind: 'workflow', name: 'Shrink', graph: emptyGraph('workflow'), createdBy: 'u' },
    at(0),
  );
  insertLibrary(
    db,
    {
      id: 'l1',
      name: 'TV',
      path: '/lib',
      recycleFolder: null,
      processHardlinked: false,
    },
    at(0),
  );
  insertRun(
    db,
    {
      id: 'r1',
      libraryId: 'l1',
      workflowId: 'w1',
      workflowVersion: 1,
      requestedPath: '/lib',
      dryRun: false,
      testEncode: false,
      force: false,
      createdBy: 'u',
    },
    at(0),
  );
  executor = new FakeExecutor(db);
  events = new EngineEvents();
  scheduler = newScheduler();
});

afterEach(async () => {
  await scheduler.stop();
});

describe('Scheduler', () => {
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
    scheduler = newScheduler(executor, () => gpuSlots(2));
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
    scheduler = newScheduler(executor, () => gpuSlots(2));
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
    scheduler = newScheduler(executor, () => slots);
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
    scheduler = newScheduler(executor2);
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
    scheduler = new Scheduler({
      db,
      executor,
      events: failing,
      now,
      log: { info: () => {}, warn: () => {}, error: (e) => errors.push(e) },
    });
    job('a', { queuedAt: 1 });
    job('b', { queuedAt: 2 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode');
    executor.ready('b', 'encode');
    await flush();
    executor.exec('a').d.reject(new Error('executor broke'));
    await flush();
    expect(row('a')).toMatchObject({ state: 'failed', reason: 'internal error: executor broke' });
    expect(scheduler.status().lanes.encode).toBe('b');
    expect(errors).toContainEqual(
      expect.objectContaining({ msg: 'scheduler task failed', error: 'publish broke' }),
    );
  });
});

describe('Scheduler with an NVIDIA and an Intel slot', () => {
  const nvidiaFirst = (): EncodeSlot[] => [NVIDIA_SLOT, INTEL_SLOT];
  const intelFirst = (): EncodeSlot[] => [INTEL_SLOT, NVIDIA_SLOT];
  /** The slot ids in status order, each with its job. */
  const holders = () => scheduler.status().encodeSlots.map((s) => [s.id, s.jobId]);

  beforeEach(async () => {
    await scheduler.stop();
    scheduler = newScheduler(executor, nvidiaFirst);
  });

  it('one ready gpu job takes gpu:0', async () => {
    job('a', { queuedAt: 1 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode', 'gpu');
    await flush();
    expect(executor.exec('a').device).toEqual(cuda(0));
  });

  it('two ready gpu jobs take one slot each', async () => {
    job('a', { queuedAt: 1 });
    job('b', { queuedAt: 2 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode', 'gpu');
    executor.ready('b', 'encode', 'gpu');
    await flush();
    expect(holders()).toEqual([
      ['gpu:0', 'a'],
      ['gpu:intel:0000:07:00.0', 'b'],
    ]);
  });

  it('an nvidia job waits for the NVIDIA slot; a gpu job behind it takes the free Intel slot', async () => {
    job('x', { queuedAt: 1 });
    job('a', { queuedAt: 2 });
    job('b', { queuedAt: 3 });
    scheduler.start();
    await flush();
    executor.ready('x', 'encode', 'gpu');
    await flush();
    expect(executor.exec('x').device).toEqual(cuda(0));
    executor.ready('a', 'encode', 'nvidia');
    await flush();
    // Only the Intel slot is free and a does not fit it: preparation goes on to b.
    expect(executor.executeOrder).toEqual(['x']);
    executor.ready('b', 'encode', 'gpu');
    await flush();
    expect(executor.executeOrder).toEqual(['x', 'b']);
    expect(executor.exec('b').device).toEqual(qsv('/dev/dri/renderD128'));
    executor.finish('x');
    await flush();
    expect(executor.executeOrder).toEqual(['x', 'b', 'a']);
    expect(executor.exec('a').device).toEqual(cuda(0));
  });

  it('with gpu:0 busy, the Intel slot free and only an nvidia job ready, another queued job is prepared', async () => {
    await scheduler.stop();
    scheduler = new Scheduler({
      db,
      executor,
      events,
      now,
      log,
      prepWorkers: 1,
      encodeSlots: nvidiaFirst,
    });
    for (const [i, id] of ['x', 'q1', 'q2', 'a', 'b'].entries()) job(id, { queuedAt: i });
    scheduler.start();
    await flush();
    executor.ready('x', 'encode', 'gpu');
    await flush();
    executor.ready('q1', 'quick');
    await flush();
    executor.ready('q2', 'quick'); // the quick lane has a job waiting
    await flush();
    executor.ready('a', 'encode', 'nvidia');
    await flush();
    expect(executor.executeOrder).toEqual(['x', 'q1']);
    expect(executor.prepareOrder).toEqual(['x', 'q1', 'q2', 'a', 'b']);
  });

  it('a software job takes the last free slot', async () => {
    job('a', { queuedAt: 1 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode', 'software');
    await flush();
    expect(executor.exec('a').device).toEqual(qsv('/dev/dri/renderD128'));
  });

  it('a paused job on the Intel slot gets it back after the order changes to Intel first', async () => {
    let slots = nvidiaFirst();
    await scheduler.stop();
    scheduler = newScheduler(executor, () => slots);
    for (const [i, id] of ['x', 'a', 'c'].entries()) job(id, { queuedAt: i });
    scheduler.start();
    await flush();
    executor.ready('x', 'encode', 'gpu');
    executor.ready('a', 'encode', 'gpu');
    await flush();
    expect(executor.exec('a').device).toEqual(qsv('/dev/dri/renderD128'));
    scheduler.pauseJob('a');
    await flush();
    executor.ready('c', 'encode', 'gpu');
    await flush();
    expect(executor.exec('c').device).toEqual(qsv('/dev/dri/renderD128'));
    slots = intelFirst();
    scheduler.resumeJob('a');
    executor.finish('x'); // gpu:0 frees up; a's ffmpeg runs on the Intel GPU, so it waits
    await flush();
    expect(executor.exec('a').proc.signals).toEqual(['SIGSTOP']);
    executor.finish('c');
    await flush();
    expect(executor.exec('a').proc.signals).toEqual(['SIGSTOP', 'SIGCONT']);
    expect(holders()).toEqual([
      ['gpu:intel:0000:07:00.0', 'a'],
      ['gpu:0', null],
    ]);
  });

  it('with Intel first, a gpu job takes the Intel slot', async () => {
    await scheduler.stop();
    scheduler = newScheduler(executor, intelFirst);
    job('a', { queuedAt: 1 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode', 'gpu');
    await flush();
    expect(executor.exec('a').device).toEqual(qsv('/dev/dri/renderD128'));
  });

  it('a requeue after a GPU failure writes the failed GPUs, keeps the attempt, and the next grant skips that GPU', async () => {
    job('a', { queuedAt: 1 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode', 'gpu');
    await flush();
    expect(executor.exec('a').device).toEqual(cuda(0));
    executor.exec('a').d.resolve({
      requeue: { reason: 'GPU 0 failed (x); trying another GPU', failedGpus: ['nvidia:0'] },
    });
    await flush();
    expect(row('a')).toMatchObject({
      state: 'probing',
      attempt: 1,
      reason: 'GPU 0 failed (x); trying another GPU',
      failedGpus: ['nvidia:0'],
    });
    executor.ready('a', 'encode', 'gpu');
    await flush();
    expect(executor.executeOrder).toEqual(['a', 'a']);
    expect(executor.exec('a').device).toEqual(qsv('/dev/dri/renderD128'));
  });

  it('a job that failed on every GPU it could take still runs: with only gpu:0 left it gets gpu:0', async () => {
    let slots = nvidiaFirst();
    await scheduler.stop();
    scheduler = newScheduler(executor, () => slots);
    job('a', { queuedAt: 1 });
    scheduler.start();
    await flush();
    executor.ready('a', 'encode', 'gpu');
    await flush();
    executor.exec('a').d.resolve({
      requeue: { reason: 'GPU 0 failed (x); trying another GPU', failedGpus: ['nvidia:0'] },
    });
    await flush();
    // Encoding device pinned to nvidia:0 while it waits: only gpu:0 is left.
    slots = [NVIDIA_SLOT];
    executor.ready('a', 'encode', 'gpu');
    await flush();
    expect(executor.executeOrder).toEqual(['a', 'a']);
    expect(executor.exec('a').device).toEqual(cuda(0));
  });

  it('a gpu job that failed on NVIDIA GPU 0 takes the Intel slot, and waits while only gpu:0 is free', async () => {
    job('a', { queuedAt: 1 });
    updateJob(db, 'a', { failedGpus: ['nvidia:0'] }, now());
    scheduler.start();
    await flush();
    executor.ready('a', 'encode', 'gpu');
    await flush();
    expect(executor.exec('a').device).toEqual(qsv('/dev/dri/renderD128'));

    // Only gpu:0 free: x holds the Intel slot.
    for (const [i, id] of ['x', 'b'].entries()) job(id, { queuedAt: 10 + i });
    executor.finish('a');
    await flush();
    executor.ready('x', 'encode', 'software');
    await flush();
    expect(executor.exec('x').device).toEqual(qsv('/dev/dri/renderD128'));
    updateJob(db, 'b', { failedGpus: ['nvidia:0'] }, now());
    executor.ready('b', 'encode', 'gpu');
    await flush();
    expect(executor.executeOrder).toEqual(['a', 'x']);
    expect(holders()).toEqual([
      ['gpu:0', null],
      ['gpu:intel:0000:07:00.0', 'x'],
    ]);
  });
});

describe('pickSlot', () => {
  const NULL_SLOT: EncodeSlot = { id: 'encode', label: 'Encode', device: null, gpuId: null };
  const both = [NVIDIA_SLOT, INTEL_SLOT];
  const cases: [string, SlotFit, EncodeSlot[], EncodeSlot[], EncodeSlot | undefined][] = [
    ['gpu: the first free slot', 'gpu', both, both, NVIDIA_SLOT],
    ['software: the last free slot', 'software', both, both, INTEL_SLOT],
    ['nvidia: only an NVIDIA slot', 'nvidia', [INTEL_SLOT], both, undefined],
    ['intel: the first Intel slot', 'intel', both, both, INTEL_SLOT],
    [
      'nvidia with no NVIDIA slot at all: the first free one',
      'nvidia',
      [INTEL_SLOT],
      [INTEL_SLOT],
      INTEL_SLOT,
    ],
    ['a slot with no device fits intel', 'intel', [NULL_SLOT], [NULL_SLOT], NULL_SLOT],
    [
      'a slot with no device fits nvidia',
      'nvidia',
      [INTEL_SLOT, NULL_SLOT],
      [INTEL_SLOT, NULL_SLOT],
      NULL_SLOT,
    ],
    ['nothing free: none', 'gpu', [], both, undefined],
  ];
  it.each(cases)('%s', (_name, fit, free, all, want) => {
    expect(pickSlot(free, all, fit)).toBe(want);
  });

  it('skips the GPUs a job failed on', () => {
    expect(pickSlot(both, both, 'gpu', ['nvidia:0'])).toBe(INTEL_SLOT);
    expect(pickSlot([NVIDIA_SLOT], both, 'gpu', ['nvidia:0'])).toBeUndefined();
    // Its vendor's only GPU failed: no slot (it never moves to the other vendor).
    expect(pickSlot(both, both, 'nvidia', ['nvidia:0'])).toBeUndefined();
    expect(pickSlot(both, both, 'intel', ['intel:0000:07:00.0'])).toBeUndefined();
  });
});

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
    scheduler = gated();
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
    scheduler = gated(() => gpuSlots(2));
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
