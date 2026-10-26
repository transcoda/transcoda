// Moves queued jobs through preparation (probe/decide/build, at most `prepWorkers` at once) into
// one of two lanes, and handles job pause/resume/cancel, queue pause (persisted in settings),
// libraries' run hours (their automatic jobs start only inside the window) and shutdown. The quick
// lane runs one job; the encode lane one job per encode slot (one per GPU on a multi-GPU machine,
// else one), each job on its slot's device.
import { isFinalState, LANES, type Lane } from '@transcoda/shared';
import { z } from 'zod';
import type { EncodeSlot } from '../capabilities/devices.ts';
import type { Database } from '../db/open.ts';
import {
  findJob,
  findJobResult,
  type JobPatch,
  type JobRow,
  nextQueuedJobs,
  updateJob,
} from '../db/repos/jobs.ts';
import { findRun } from '../db/repos/runs.ts';
import { getSettingOr, SETTING_DEFAULTS, SETTING_KEYS, setSetting } from '../db/repos/settings.ts';
import type { Logger } from '../logger.ts';
import { type CurrentNode, type EngineEvents, jobChangedEvent } from './events.ts';
import type { RunnerProcess } from './process.ts';
import type { RenderDevice } from './render.ts';
import { closedLibraries, serverTimeZone } from './run-hours.ts';

export interface JobExecutor {
  /**
   * Probe, decide and build; resolves with the lane to run in, `final` when the job ended (dry
   * run, nothing to do, failed, cancelled), or a requeue (a plugin hook failed in a way a second
   * attempt may fix; nothing was written).
   */
  prepare(job: JobRow, ctl: JobControl): Promise<{ lane: Lane } | { final: true } | ExecuteOutcome>;
  /**
   * Encode, verify and finish; records the job's final state (nothing on a shutdown), or asks for
   * the job to go back to the queue: the scheduler writes that once the lane is released.
   * `device`: the GPU of the encode slot the job got (null: ffmpeg's default, and always for quick).
   */
  execute(
    job: JobRow,
    lane: Lane,
    ctl: JobControl,
    device: RenderDevice | null,
  ): Promise<ExecuteOutcome | null>;
  /**
   * Cleans up after a job the scheduler itself recorded as `cancelled` once it had been prepared
   * or started (a cancelled ready job, or an executor that settled without a final state after a
   * cancel): its temp dir. Errors are logged.
   */
  discard?(job: JobRow): Promise<void>;
}

export type StopReason = 'cancel' | 'shutdown';

/** Back to the queue (`queued`, not paused, no lane/progress/finish time) with this patch. */
export interface ExecuteOutcome {
  requeue: { reason: string; attempt?: number; requeues?: number };
}

export interface JobControl {
  /** Aborted with `reason: StopReason`. */
  readonly signal: AbortSignal;
  readonly stopReason: () => StopReason | null;
  /** The job is paused by the user (not by a queue pause). */
  readonly paused: () => boolean;
  /** The process now running for the job (null when it ended); pause/kill reach it from here on. */
  attach(p: RunnerProcess | null): void;
  /** Sets the node the job is at and publishes `job.changed`. */
  setCurrentNode(node: CurrentNode | null): void;
  /** Publishes `job.changed` for a row the executor just wrote (with the current node). */
  changed(job: JobRow): void;
  /**
   * The job is done with the GPU (encoded): its encode slot goes to the next job while this one
   * finishes (verify, replace, recycle, plugin steps) without a lane. Once per job; a retry is
   * queued again and waits for a slot. No effect for a quick job.
   */
  releaseEncoder?(): void;
}

export interface SchedulerOptions {
  db: Database;
  executor: JobExecutor;
  events: EngineEvents;
  now(): Date;
  /** Jobs in probe/decide/build at once (default 2). */
  prepWorkers?: number;
  /** The encode lane's slots, asked at every grant (default: one slot, no device). */
  encodeSlots?: () => EncodeSlot[];
  log: Logger;
  /** The zone run hours are read in (default the server's). */
  timeZone?: string;
  /** The wake-up timer for run hours (default setTimeout, unref'd). */
  timers?: WakeTimers;
}

export interface WakeTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: WakeTimers = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/** The longest the scheduler sleeps before looking at run hours again (a clock change is caught). */
export const MAX_WAKE_MS = 3_600_000;

type Phase = 'preparing' | 'ready' | 'running';

/** A job the scheduler holds in memory, from `probing` until its executor settles. */
class ActiveJob implements JobControl {
  readonly controller = new AbortController();
  phase: Phase = 'preparing';
  lane: Lane | null = null;
  /** The encode slot it runs in; kept while frozen, since its ffmpeg is bound to that GPU. */
  slot: EncodeSlot | null = null;
  proc: RunnerProcess | null = null;
  currentNode: CurrentNode | null = null;
  /** Paused by the user. */
  userPaused = false;
  /** Running and holding its lane (false while frozen by a user pause, or waiting to get it back). */
  holdsLane = false;
  /** Its process was stopped by a queue pause. */
  queueFrozen = false;
  /** Order of becoming ready (ties after priority and queued time). */
  readySeq = 0;
  /** From a `library` run: it waits for its library's run hours before it gets a lane. */
  automatic = false;
  /** Gave its encode slot up after encoding (it never takes one back). */
  encoderReleased = false;

  constructor(
    private readonly scheduler: Scheduler,
    public job: JobRow,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }
  readonly stopReason = (): StopReason | null =>
    this.signal.aborted ? (this.signal.reason as StopReason) : null;
  readonly paused = (): boolean => this.userPaused;
  attach(p: RunnerProcess | null): void {
    this.scheduler.onAttach(this, p);
  }
  setCurrentNode(node: CurrentNode | null): void {
    this.currentNode = node;
    this.scheduler.publishJob(this.job.id);
  }
  changed(job: JobRow): void {
    this.job = job;
    this.scheduler.publishJob(job.id, job);
  }
  releaseEncoder(): void {
    this.scheduler.onEncoderReleased(this);
  }
}

/** The encode lane as it always was: one slot, ffmpeg's default device. */
export const SINGLE_ENCODE_SLOT: EncodeSlot = { id: 'encode', label: 'Encode', device: null };

/** Who holds each encode slot, for status and `queue.changed`. */
export type EncodeSlotStatus = { id: string; label: string; jobId: string | null };

/** Most jobs preparing or ready (not user-paused) at once. */
export const MAX_READY = 4;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class Scheduler {
  private readonly db: Database;
  private readonly executor: JobExecutor;
  private readonly events: EngineEvents;
  private readonly now: () => Date;
  private readonly prepWorkers: number;
  private readonly log: Logger;
  private readonly active = new Map<string, ActiveJob>();
  private readonly encodeSlots: () => EncodeSlot[];
  /** The quick lane's job. */
  private quick: string | null = null;
  /** Encode slot id → the slot and the job holding it. */
  private readonly slotHolders = new Map<string, { slot: EncodeSlot; jobId: string }>();
  private readonly pending = new Set<Promise<void>>();
  private queuePaused = false;
  private started = false;
  private stopping = false;
  private readySeq = 0;
  private readonly timeZone: string;
  private readonly timers: WakeTimers;
  private wake: { handle: unknown; at: number } | null = null;
  /** Libraries whose run hours are closed, as of the last tick. */
  private closed = new Map<string, Date | null>();

  constructor(opts: SchedulerOptions) {
    this.db = opts.db;
    this.executor = opts.executor;
    this.events = opts.events;
    this.now = opts.now;
    this.prepWorkers = opts.prepWorkers ?? 2;
    this.encodeSlots = opts.encodeSlots ?? (() => [SINGLE_ENCODE_SLOT]);
    this.log = opts.log;
    this.timeZone = opts.timeZone ?? serverTimeZone();
    this.timers = opts.timers ?? defaultTimers;
  }

  /** Reads the persisted queue pause and starts taking jobs. */
  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    this.queuePaused = getSettingOr(
      this.db,
      SETTING_KEYS.queuePaused,
      z.boolean(),
      SETTING_DEFAULTS.queuePaused,
    );
    this.tick();
  }

  /**
   * Aborts every job with `shutdown`, kills attached processes and waits for the executors to
   * settle. Nothing is written: job rows and temp stay for the startup sweep.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.disarm();
    for (const a of this.active.values()) {
      if (!a.signal.aborted) a.controller.abort('shutdown' satisfies StopReason);
      a.proc?.kill();
    }
    await Promise.allSettled([...this.pending]);
  }

  /**
   * Grants free lanes, then starts preparing queued jobs. A job's lane is only known after Build,
   * so preparation looks ahead until every lane has a ready job waiting (a quick job further down
   * the queue still reaches the idle quick lane while encode jobs wait), bounded by fewer than
   * `prepWorkers` preparing and at most {@link MAX_READY} jobs preparing or ready (so a long encode
   * never gets the whole queue prepared). User-paused ready jobs do not count, nor do automatic
   * ones held by their library's run hours: those neither start preparing nor get a lane while
   * the window is closed, and the scheduler wakes when the next window opens. Idempotent.
   */
  tick(): void {
    if (!this.started || this.stopping || this.queuePaused) return;
    this.closed = closedLibraries(this.db, this.now(), this.timeZone);
    this.armWake();
    this.grantLanes();
    const all = [...this.active.values()];
    const preparing = all.filter((a) => a.phase === 'preparing').length;
    const waiting = all.filter((a) => a.phase === 'ready' && !a.userPaused && !this.held(a));
    if (LANES.every((lane) => waiting.some((a) => a.lane === lane))) return;
    const free = Math.min(this.prepWorkers - preparing, MAX_READY - preparing - waiting.length);
    if (free <= 0) return;
    // A queued job is never in memory (preparation starts by moving it to `probing`).
    for (const job of nextQueuedJobs(this.db, free, [...this.closed.keys()])) {
      this.beginPrepare(job);
    }
  }

  pauseJob(id: string): 'ok' | 'not-active' {
    if (this.stopping) return 'not-active';
    const a = this.active.get(id);
    if (a) {
      if (a.userPaused) return 'ok';
      a.userPaused = true;
      this.update(id, { paused: true });
      if (a.phase === 'running' && a.holdsLane && a.proc) this.freeze(a);
      return 'ok';
    }
    const row = findJob(this.db, id);
    if (row?.state !== 'queued') return 'not-active';
    if (!row.paused) this.update(id, { paused: true });
    return 'ok';
  }

  resumeJob(id: string): 'ok' | 'not-paused' {
    if (this.stopping) return 'not-paused';
    const a = this.active.get(id);
    if (a) {
      if (!a.userPaused) return 'not-paused';
      a.userPaused = false;
      this.update(id, { paused: false });
      this.tick();
      return 'ok';
    }
    const row = findJob(this.db, id);
    if (row?.state !== 'queued' || !row.paused) return 'not-paused';
    this.update(id, { paused: false });
    this.tick();
    return 'ok';
  }

  cancelJob(id: string): 'ok' | 'not-active' {
    if (this.stopping) return 'not-active';
    const a = this.active.get(id);
    if (a) {
      if (a.signal.aborted) return 'ok';
      a.controller.abort('cancel' satisfies StopReason);
      if (a.phase === 'ready') {
        // Not running anything: cancelled right here; the executor cleans up its temp.
        this.active.delete(id);
        const row = this.markCancelled(id);
        if (row) this.discard(row);
        this.tick();
      } else {
        a.proc?.kill();
      }
      return 'ok';
    }
    const row = findJob(this.db, id);
    if (row?.state !== 'queued') return 'not-active';
    this.markCancelled(id);
    return 'ok';
  }

  /** Persists `queue.paused`, stops every running process and grants nothing new. */
  pauseQueue(): void {
    this.queuePaused = true;
    setSetting(this.db, SETTING_KEYS.queuePaused, true, this.now());
    for (const a of this.active.values()) {
      if (a.phase === 'running' && a.holdsLane && a.proc && !a.queueFrozen) {
        a.proc.pause();
        a.queueFrozen = true;
      }
    }
    this.publishQueue();
  }

  /** Clears `queue.paused` and continues the processes the queue pause stopped (not user-paused jobs). */
  resumeQueue(): void {
    this.queuePaused = false;
    setSetting(this.db, SETTING_KEYS.queuePaused, false, this.now());
    for (const a of this.active.values()) {
      if (!a.queueFrozen) continue;
      a.queueFrozen = false;
      a.proc?.resume();
    }
    this.publishQueue();
    this.tick();
  }

  status(): {
    paused: boolean;
    lanes: Record<Lane, string | null>;
    encodeSlots: EncodeSlotStatus[];
    preparing: string[];
    ready: string[];
  } {
    const ids = (phase: Phase): string[] =>
      [...this.active.values()].filter((a) => a.phase === phase).map((a) => a.job.id);
    return {
      paused: this.queuePaused,
      lanes: this.lanes(),
      encodeSlots: this.slotStatus(),
      preparing: ids('preparing'),
      ready: ids('ready'),
    };
  }

  /** @internal Called through {@link JobControl.attach}. */
  onAttach(a: ActiveJob, p: RunnerProcess | null): void {
    a.proc = p;
    a.queueFrozen = false;
    if (p === null) return;
    if (a.signal.aborted) {
      p.kill();
      return;
    }
    if (a.phase !== 'running' || !a.holdsLane) return;
    if (a.userPaused) this.freeze(a);
    else if (this.queuePaused) {
      p.pause();
      a.queueFrozen = true;
    }
  }

  /**
   * @internal Called through {@link JobControl.releaseEncoder}: an encode job whose ffmpeg ended frees
   * its slot, and the next encode starts while it finishes.
   */
  onEncoderReleased(a: ActiveJob): void {
    if (this.stopping || a.lane !== 'encode' || a.phase !== 'running' || a.encoderReleased) return;
    a.encoderReleased = true;
    if (a.holdsLane) {
      a.holdsLane = false;
      this.release(a);
    }
    this.publishQueue();
    this.tick();
  }

  /** @internal Publishes `job.changed` for `id` (re-read unless the row is given). */
  publishJob(id: string, row?: JobRow): void {
    const job = row ?? findJob(this.db, id);
    if (!job) return;
    // Problems exist only on a final job's result (a plugin step after the write).
    const problems = isFinalState(job.state) ? (findJobResult(this.db, id)?.problems ?? []) : [];
    this.events.publish(jobChangedEvent(job, this.active.get(id)?.currentNode ?? null, problems));
  }

  // ---- internals ----

  /** An automatic job whose library's run hours are closed (as of the last tick). */
  private held(a: ActiveJob): boolean {
    return a.automatic && this.closed.has(a.job.libraryId);
  }

  /**
   * One timer for the earliest window that opens among the closed libraries, at most
   * {@link MAX_WAKE_MS} ahead; none when no library is closed or none of them ever opens.
   */
  private armWake(): void {
    const now = this.now().getTime();
    let next: number | null = null;
    for (const opens of this.closed.values()) {
      if (opens !== null && (next === null || opens.getTime() < next)) next = opens.getTime();
    }
    const at = next === null ? null : Math.min(next, now + MAX_WAKE_MS);
    if (this.wake?.at === at) return;
    this.disarm();
    if (at === null) return;
    const handle = this.timers.set(
      () => {
        if (this.wake?.handle === handle) this.wake = null;
        this.tick();
      },
      Math.max(0, at - now),
    );
    this.wake = { handle, at };
  }

  private disarm(): void {
    if (this.wake) this.timers.clear(this.wake.handle);
    this.wake = null;
  }

  private beginPrepare(job: JobRow): void {
    const row = this.update(job.id, { state: 'probing', startedAt: this.now().toISOString() });
    if (!row) return;
    const a = new ActiveJob(this, row);
    a.userPaused = row.paused;
    a.automatic = findRun(this.db, row.runId)?.source === 'library';
    this.active.set(job.id, a);
    this.track(this.runPrepare(a));
  }

  private async runPrepare(a: ActiveJob): Promise<void> {
    let ready = false;
    let requeue: ExecuteOutcome | null = null;
    try {
      let out: { lane: Lane } | { final: true } | ExecuteOutcome;
      try {
        out = await Promise.resolve().then(() => this.executor.prepare(a.job, a));
      } catch (err) {
        if (this.stopping) return;
        if (a.stopReason() === 'cancel') this.settleCancelled(a.job.id);
        else this.failUnexpected(a, err);
        return;
      }
      if (this.stopping) return;
      if ('requeue' in out) {
        if (a.stopReason() === 'cancel') this.settleCancelled(a.job.id);
        else requeue = out;
        return;
      }
      if ('final' in out) {
        if (a.stopReason() === 'cancel') this.settleCancelled(a.job.id);
        else this.ensureFinal(a, 'prepare ended without a final state');
        return;
      }
      if (a.stopReason() === 'cancel') {
        // Cancelled while preparing but the executor did not record it.
        this.settleCancelled(a.job.id);
        return;
      }
      a.job = findJob(this.db, a.job.id) ?? a.job;
      a.lane = out.lane;
      // Planned: the row names the lane the job waits for (its state stays `building` until it
      // runs), so screens can say "waiting for the encoder" instead of the last node it walked.
      a.job = this.update(a.job.id, { lane: out.lane }) ?? a.job;
      a.phase = 'ready';
      a.readySeq = this.readySeq++;
      ready = true;
    } finally {
      if (!ready) this.active.delete(a.job.id);
      // Requeued only now: the job is out of memory when it is queued again.
      if (requeue && !this.stopping && a.stopReason() === null) this.requeue(a.job.id, requeue);
      if (!this.stopping) this.tick();
    }
  }

  private async runExecute(a: ActiveJob, lane: Lane): Promise<void> {
    let outcome: ExecuteOutcome | null = null;
    try {
      try {
        const device = a.slot?.device ?? null;
        outcome = await Promise.resolve().then(() => this.executor.execute(a.job, lane, a, device));
      } catch (err) {
        if (!this.stopping && a.stopReason() !== 'cancel') this.failUnexpected(a, err);
      }
      if (!this.stopping && a.stopReason() === 'cancel') this.settleCancelled(a.job.id);
    } finally {
      // Always released, even when recording the outcome threw.
      this.active.delete(a.job.id);
      this.release(a);
      // Requeued only now: the job is out of memory and holds no lane when it is queued again.
      if (outcome && !this.stopping && a.stopReason() === null) this.requeue(a.job.id, outcome);
      if (!this.stopping) {
        this.publishQueue();
        this.tick();
      }
    }
  }

  private requeue(id: string, { requeue }: ExecuteOutcome): void {
    const row = findJob(this.db, id);
    if (!row || isFinalState(row.state)) return;
    const queued = this.update(id, {
      state: 'queued',
      reason: requeue.reason,
      lane: null,
      progress: null,
      paused: false,
      finishedAt: null,
      ...(requeue.attempt !== undefined ? { attempt: requeue.attempt } : {}),
      ...(requeue.requeues !== undefined ? { requeues: requeue.requeues } : {}),
    });
    if (queued) this.events.publish({ type: 'run.changed', runId: queued.runId });
  }

  /**
   * Lanes go first to resumed jobs waiting to get theirs back, then to ready jobs in order. A
   * resumed encode job waits for its own slot (its ffmpeg runs on that GPU), unless the slot is
   * gone (the setting changed): then any free one.
   */
  private grantLanes(): void {
    const waiting = (lane: Lane) =>
      [...this.active.values()].filter((a) => a.lane === lane && !a.userPaused);
    // A running job keeps or regains its lane whatever the hour; a held one waits for its window.
    const nextReady = (lane: Lane) =>
      waiting(lane)
        .filter((a) => a.phase === 'ready' && !this.held(a))
        .sort(
          (x, y) =>
            y.job.priority - x.job.priority ||
            x.job.queuedAt.localeCompare(y.job.queuedAt) ||
            x.readySeq - y.readySeq,
        )[0];

    if (this.quick === null) {
      const resumed = waiting('quick').find((a) => a.phase === 'running' && !a.holdsLane);
      if (resumed) this.regain(resumed, null);
      else {
        const next = nextReady('quick');
        if (next) this.beginExecute(next, 'quick', null);
      }
    }

    const slots = this.encodeSlots();
    const free = () => slots.filter((s) => !this.slotHolders.has(s.id));
    const resuming = waiting('encode').filter(
      (j) => j.phase === 'running' && !j.holdsLane && !j.encoderReleased,
    );
    for (const a of resuming) {
      const own = a.slot !== null && slots.some((s) => s.id === a.slot?.id);
      const slot = own ? free().find((s) => s.id === a.slot?.id) : free()[0];
      if (slot) this.regain(a, slot);
    }
    for (const slot of free()) {
      const next = nextReady('encode');
      if (!next) break;
      this.beginExecute(next, 'encode', slot);
    }
  }

  /** A resumed job takes its lane (or `slot`) back and continues. */
  private regain(a: ActiveJob, slot: EncodeSlot | null): void {
    this.hold(a, slot);
    a.proc?.resume();
    this.publishQueue();
  }

  private beginExecute(a: ActiveJob, lane: Lane, slot: EncodeSlot | null): void {
    a.phase = 'running';
    this.hold(a, slot);
    a.job = this.update(a.job.id, { lane }) ?? a.job;
    this.publishQueue();
    this.track(this.runExecute(a, lane));
  }

  /** `a` holds its lane: the quick lane, or `slot` of the encode lane. */
  private hold(a: ActiveJob, slot: EncodeSlot | null): void {
    a.holdsLane = true;
    if (a.lane === 'encode' && slot !== null) {
      // A job that kept a slot from before a setting change runs on that slot's GPU still.
      if (a.slot === null || a.slot.id !== slot.id) a.slot = slot;
      this.slotHolders.set(slot.id, { slot, jobId: a.job.id });
    } else this.quick = a.job.id;
  }

  /** Frees whatever lane or slot `a` holds. */
  private release(a: ActiveJob): void {
    if (a.lane === 'quick' && this.quick === a.job.id) this.quick = null;
    if (a.slot !== null && this.slotHolders.get(a.slot.id)?.jobId === a.job.id)
      this.slotHolders.delete(a.slot.id);
  }

  /** Every current slot with its job, then slots no longer offered that a job still runs in. */
  private slotStatus(): EncodeSlotStatus[] {
    const slots = this.encodeSlots();
    const ids = new Set(slots.map((s) => s.id));
    const out = slots.map((s) => ({
      id: s.id,
      label: s.label,
      jobId: this.slotHolders.get(s.id)?.jobId ?? null,
    }));
    for (const [id, h] of this.slotHolders) {
      if (!ids.has(id)) out.push({ id, label: h.slot.label, jobId: h.jobId });
    }
    return out;
  }

  /** The two lanes for older clients: the encode lane is the first busy slot. */
  private lanes(): Record<Lane, string | null> {
    return {
      encode: this.slotStatus().find((s) => s.jobId !== null)?.jobId ?? null,
      quick: this.quick,
    };
  }

  /** A user pause of a job holding its lane: stop its process and free the lane. */
  private freeze(a: ActiveJob): void {
    if (!a.queueFrozen) a.proc?.pause();
    a.queueFrozen = false;
    a.holdsLane = false;
    this.release(a);
    this.publishQueue();
    this.tick();
  }

  private markCancelled(id: string): JobRow | null {
    const row = this.update(id, { state: 'cancelled', lane: null, progress: null });
    if (row) this.events.publish({ type: 'run.changed', runId: row.runId });
    return row;
  }

  /** After a cancel: `cancelled` (and discard) unless the executor already recorded a final state. */
  private settleCancelled(id: string): void {
    const row = findJob(this.db, id);
    if (!row || isFinalState(row.state)) return;
    const cancelled = this.markCancelled(id);
    if (cancelled) this.discard(cancelled);
  }

  /** An executor that said the job ended without recording a final state: logged, then failed. */
  private ensureFinal(a: ActiveJob, what: string): void {
    const row = findJob(this.db, a.job.id);
    if (!row || isFinalState(row.state)) return;
    this.failUnexpected(a, new Error(what));
  }

  private discard(job: JobRow): void {
    const discard = this.executor.discard;
    if (!discard) return;
    this.track(Promise.resolve().then(() => discard.call(this.executor, job)));
  }

  private failUnexpected(a: ActiveJob, err: unknown): void {
    this.log.error({ msg: 'job executor failed', job: a.job.id, error: errorMessage(err) });
    const row = findJob(this.db, a.job.id);
    if (!row || isFinalState(row.state)) return;
    const failed = this.update(a.job.id, {
      state: 'failed',
      reason: `internal error: ${errorMessage(err)}`,
      lane: null,
      progress: null,
    });
    if (failed) this.events.publish({ type: 'run.changed', runId: failed.runId });
  }

  private update(id: string, patch: JobPatch): JobRow | null {
    const row = updateJob(this.db, id, patch, this.now());
    if (row) {
      const a = this.active.get(id);
      if (a) a.job = row;
      this.publishJob(id, row);
    }
    return row;
  }

  private publishQueue(): void {
    this.events.publish({
      type: 'queue.changed',
      paused: this.queuePaused,
      lanes: this.lanes(),
      encodeSlots: this.slotStatus(),
    });
  }

  /** Keeps `p` for `stop()`; a rejection is logged, never left unhandled. */
  private track(p: Promise<void>): void {
    const settled = p
      .catch((err: unknown) => {
        this.log.error({ msg: 'scheduler task failed', error: errorMessage(err) });
      })
      .finally(() => this.pending.delete(settled));
    this.pending.add(settled);
  }
}
