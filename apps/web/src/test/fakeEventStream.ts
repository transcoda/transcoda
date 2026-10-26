// A controllable stand-in for `api.events.subscribe` (oRPC event iterator). Each call opens a new
// stream the test drives with push/end/fail; aborting the call's signal fails the pending read with
// an AbortError, as the real RPC link does.
import type { EngineEvent } from '@transcoda/contract';
import { vi } from 'vitest';

export interface FakeStream {
  push(e: EngineEvent): void;
  end(): void;
  fail(error?: unknown): void;
  readonly aborted: boolean;
}

function makeStream(signal: AbortSignal | undefined): {
  stream: FakeStream;
  iterator: AsyncIterableIterator<EngineEvent>;
} {
  const queue: IteratorResult<EngineEvent>[] = [];
  let failure: { error: unknown } | null = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const stream: FakeStream = {
    push: (e) => {
      queue.push({ done: false, value: e });
      notify();
    },
    end: () => {
      queue.push({ done: true, value: undefined });
      notify();
    },
    fail: (error = new Error('stream failed')) => {
      failure = { error };
      notify();
    },
    get aborted() {
      return signal?.aborted ?? false;
    },
  };
  signal?.addEventListener('abort', () =>
    stream.fail(new DOMException('This operation was aborted', 'AbortError')),
  );
  const iterator: AsyncIterableIterator<EngineEvent> = {
    async next() {
      for (;;) {
        const r = queue.shift();
        if (r) return r;
        if (failure) throw failure.error;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    async return() {
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return { stream, iterator };
}

export function fakeEventSource() {
  const streams: FakeStream[] = [];
  const subscribe = vi.fn((_input?: unknown, options?: { signal?: AbortSignal }) => {
    const { stream, iterator } = makeStream(options?.signal);
    streams.push(stream);
    return Promise.resolve(iterator);
  });
  return {
    subscribe,
    streams,
    last(): FakeStream {
      const s = streams.at(-1);
      if (!s) throw new Error('no stream opened yet');
      return s;
    },
  };
}

export const queueSnapshot: EngineEvent = {
  type: 'queue.changed',
  paused: false,
  lanes: { encode: null, quick: null },
  encodeSlots: [{ id: 'encode', label: 'Encode', jobId: null }],
};
export const ping: EngineEvent = { type: 'ping', at: '2026-10-16T18:00:00.000Z' };
export function jobChanged(jobId: string): EngineEvent {
  return {
    type: 'job.changed',
    jobId,
    runId: 'r1',
    libraryId: 'l1',
    workflowId: 'w1',
    state: 'encoding',
    paused: false,
    progress: null,
    lane: 'encode',
    currentNode: null,
    problems: [],
    reason: null,
  };
}
