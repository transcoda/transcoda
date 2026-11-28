// Shared setup for the Scheduler tests (scheduler*.test.ts): a fake executor and processes, a test
// database with one workflow, library and run, job builders, and the encode slots.
import { emptyGraph, type JobState, type Lane } from '@transcoda/shared';
import { afterEach, beforeEach } from 'vitest';
import type { EncodeSlot } from '../../../capabilities/devices.ts';
import type { Database } from '../../../db/open.ts';
import { findJob, insertJob, type JobRow, updateJob } from '../../../db/repos/jobs/jobs.ts';
import { insertLibrary } from '../../../db/repos/libraries.ts';
import { insertRun } from '../../../db/repos/runs.ts';
import { insertWorkflow } from '../../../db/repos/workflows.ts';
import { createTestDb } from '../../../db/testing.ts';
import type { Logger } from '../../../platform/logger.ts';
import type { ProcessResult, RunnerProcess } from '../../encode/process.ts';
import { EngineEvents } from '../../events.ts';
import type { RenderDevice } from '../../model/model.ts';
import {
  type ExecuteOutcome,
  type JobControl,
  type JobExecutor,
  Scheduler,
  type SlotFit,
} from '../scheduler.ts';

const t0 = Date.parse('2026-03-01T12:00:00.000Z');
export const at = (s: number): Date => new Date(t0 + s * 1000);
export const now = (): Date => at(100);
export const flush = async (): Promise<void> => {
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
export class FakeExecutor implements JobExecutor {
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

export let db: Database;
export let executor: FakeExecutor;
export let events: EngineEvents;
export let scheduler: Scheduler;
export const log: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export function job(
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

export function newScheduler(exec: JobExecutor = executor, slots?: () => EncodeSlot[]): Scheduler {
  return new Scheduler({
    db,
    executor: exec,
    events,
    now,
    log,
    ...(slots ? { encodeSlots: slots } : {}),
  });
}

export const cuda = (index: number): RenderDevice => ({ kind: 'cuda', index });
export const gpuSlots = (n: number): EncodeSlot[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `gpu:${i}`,
    label: `GPU ${i}`,
    device: cuda(i),
    gpuId: `nvidia:${i}`,
  }));

export const qsv = (renderNode: string): RenderDevice => ({ kind: 'qsv', renderNode });
export const NVIDIA_SLOT: EncodeSlot = {
  id: 'gpu:0',
  label: 'GPU 0',
  device: cuda(0),
  gpuId: 'nvidia:0',
};
export const INTEL_SLOT: EncodeSlot = {
  id: 'gpu:intel:0000:07:00.0',
  label: 'Intel Arc A310 · 07:00.0',
  device: qsv('/dev/dri/renderD128'),
  gpuId: 'intel:0000:07:00.0',
};

export const row = (id: string): JobRow => {
  const r = findJob(db, id);
  if (!r) throw new Error(`no job ${id}`);
  return r;
};

/** Replaces the scheduler the shared setup stops after each test. */
export function setScheduler(next: Scheduler): void {
  scheduler = next;
}

/** Registers the setup and teardown every test in these files shares. */
export function useScheduler(): void {
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
}
