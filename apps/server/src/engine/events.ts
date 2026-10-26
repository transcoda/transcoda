// Engine events for the SSE stream: job and queue changes, trace entries, and a heartbeat.
import { EventPublisher } from '@orpc/server';
import type { JobState, Lane, PluginState, TraceEntry } from '@transcoda/shared';
import type { JobProgress, JobRow } from '../db/repos/jobs.ts';

/** Heartbeat interval while a subscriber is connected. */
export const HEARTBEAT_MS = 30_000;
/** Unread events kept per subscriber; beyond this the buffer is replaced by one `resync`. */
export const MAX_BUFFERED_EVENTS = 100;

/** The graph node a job is at: Run-node ids from the top level down, and the node id. */
export interface CurrentNode {
  workflowPath: string[];
  nodeId: string;
}

export type EngineEvent =
  | {
      type: 'job.changed';
      jobId: string;
      runId: string;
      libraryId: string;
      workflowId: string;
      state: JobState;
      paused: boolean;
      progress: JobProgress | null;
      lane: Lane | null;
      currentNode: CurrentNode | null;
      /** The result's problems of a finished job (empty otherwise). */
      problems: string[];
      /** The job's reason; while running, what it waits for ("waiting for 5.4 GB free on …"). */
      reason: string | null;
    }
  | { type: 'plugins.changed'; name: string; state: PluginState; stateReason: string | null }
  | { type: 'ping'; at: string }
  /** Events were dropped for a subscriber that fell behind: refetch the state, then go on. */
  | { type: 'resync'; at: string }
  | { type: 'job.trace'; jobId: string; entry: TraceEntry }
  | { type: 'run.changed'; runId: string }
  | {
      type: 'queue.changed';
      paused: boolean;
      lanes: Record<Lane, string | null>;
      encodeSlots: { id: string; label: string; jobId: string | null }[];
    };

export function jobChangedEvent(
  job: JobRow,
  currentNode: CurrentNode | null,
  problems: string[] = [],
): EngineEvent {
  return {
    type: 'job.changed',
    jobId: job.id,
    runId: job.runId,
    libraryId: job.libraryId,
    workflowId: job.workflowId,
    state: job.state,
    paused: job.paused,
    progress: job.progress,
    lane: job.lane,
    currentNode,
    problems,
    reason: job.reason,
  };
}

export class EngineEvents {
  private readonly publisher = new EventPublisher<{ event: EngineEvent }>();
  private readonly heartbeatMs: number;
  private readonly now: () => Date;

  constructor(opts: { heartbeatMs?: number; now?: () => Date } = {}) {
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    this.now = opts.now ?? (() => new Date());
  }

  publish(e: EngineEvent): void {
    this.publisher.publish('event', e);
  }

  /**
   * Every event published from now on, with a `ping` every `heartbeatMs`. The subscription starts
   * at the call (not at the first `next()`) and ends when `signal` aborts (a pending `next()` then
   * finishes) or `return()` is called (at once, even before the first `next()`). A subscriber that
   * falls more than {@link MAX_BUFFERED_EVENTS} behind loses its unread events (the oldest ones,
   * all superseded by a refetch) and reads a single `resync` in their place.
   */
  subscribe(signal?: AbortSignal): AsyncIterableIterator<EngineEvent> {
    const queue: EngineEvent[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const notify = (): void => {
      const w = wake;
      wake = null;
      w?.();
    };
    const push = (e: EngineEvent): void => {
      if (queue.length >= MAX_BUFFERED_EVENTS) {
        queue.length = 0;
        queue.push({ type: 'resync', at: this.now().toISOString() });
      }
      queue.push(e);
      notify();
    };
    const unsubscribe = this.publisher.subscribe('event', push);
    const timer = setInterval(
      () => push({ type: 'ping', at: this.now().toISOString() }),
      this.heartbeatMs,
    );
    const onAbort = (): void => close();
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      queue.length = 0;
      notify();
    };
    if (signal?.aborted) close();
    else signal?.addEventListener('abort', onAbort);

    const done = (): IteratorResult<EngineEvent> => ({ done: true, value: undefined });
    const iterator: AsyncIterableIterator<EngineEvent> = {
      async next() {
        for (;;) {
          if (closed) return done();
          const e = queue.shift();
          if (e !== undefined) return { done: false, value: e };
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
      async return() {
        close();
        return done();
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return iterator;
  }
}
