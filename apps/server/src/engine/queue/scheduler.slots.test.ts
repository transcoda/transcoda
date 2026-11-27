import { beforeEach, describe, expect, it } from 'vitest';
import type { EncodeSlot } from '../../capabilities/devices.ts';
import { updateJob } from '../../db/repos/jobs/jobs.ts';
import { pickSlot, Scheduler, type SlotFit } from './scheduler.ts';
import {
  cuda,
  db,
  events,
  executor,
  flush,
  INTEL_SLOT,
  job,
  log,
  NVIDIA_SLOT,
  newScheduler,
  now,
  qsv,
  row,
  scheduler,
  setScheduler,
  useScheduler,
} from './testing/scheduler.ts';

useScheduler();

describe('Scheduler with an NVIDIA and an Intel slot', () => {
  const nvidiaFirst = (): EncodeSlot[] => [NVIDIA_SLOT, INTEL_SLOT];
  const intelFirst = (): EncodeSlot[] => [INTEL_SLOT, NVIDIA_SLOT];
  /** The slot ids in status order, each with its job. */
  const holders = () => scheduler.status().encodeSlots.map((s) => [s.id, s.jobId]);

  beforeEach(async () => {
    await scheduler.stop();
    setScheduler(newScheduler(executor, nvidiaFirst));
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
    setScheduler(
      new Scheduler({
        db,
        executor,
        events,
        now,
        log,
        prepWorkers: 1,
        encodeSlots: nvidiaFirst,
      }),
    );
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
    setScheduler(newScheduler(executor, () => slots));
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
    setScheduler(newScheduler(executor, intelFirst));
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
    updateJob(db, 'a', { encodedOn: 'GPU 0' }, now());
    // Paused, the requeued row stays queued, so this checks requeue itself clears the GPU
    // (preparing clears it too).
    scheduler.pauseQueue();
    executor.exec('a').d.resolve({
      requeue: { reason: 'GPU 0 failed (x); trying another GPU', failedGpus: ['nvidia:0'] },
    });
    await flush();
    expect(row('a')).toMatchObject({
      state: 'queued',
      attempt: 1,
      reason: 'GPU 0 failed (x); trying another GPU',
      failedGpus: ['nvidia:0'],
      encodedOn: null,
    });
    scheduler.resumeQueue();
    await flush();
    expect(row('a').state).toBe('probing');
    executor.ready('a', 'encode', 'gpu');
    await flush();
    expect(executor.executeOrder).toEqual(['a', 'a']);
    expect(executor.exec('a').device).toEqual(qsv('/dev/dri/renderD128'));
  });

  it('a job that failed on every GPU it could take still runs: with only gpu:0 left it gets gpu:0', async () => {
    let slots = nvidiaFirst();
    await scheduler.stop();
    setScheduler(newScheduler(executor, () => slots));
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
