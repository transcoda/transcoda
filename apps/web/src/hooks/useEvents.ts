// The engine event stream: one `api.events.subscribe()` per tab, shared by every component through
// EventsProvider. The stream reconnects on its own (1 s, 2 s, 4 s … capped at 30 s); 45 s without
// any message (the server pings every 30 s) counts as a dead stream. After every reconnect, and on a
// `resync` (the server dropped events for a slow reader), the reconnect listeners fire so views
// refetch what they may have missed. The first connect fires them too: a view that fetched before
// the stream was up could miss what changed in between. A listener that throws is reported and
// skipped; the others still run and the stream stays up.
import type { EngineEvent } from '@transcoda/contract';
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import { api } from '../api/client.ts';

export type { EngineEvent };
export type StreamStatus = 'connecting' | 'live' | 'reconnecting';

export const BACKOFF_START_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
/** No event and no ping for this long: the stream is dead (the server pings every 30 s). */
export const DEAD_STREAM_MS = 45_000;

type Listener<T> = (value: T) => void;

/** Calls every listener; one that throws is reported and does not stop the rest. */
function callEach<T>(listeners: Iterable<Listener<T>>, value: T): void {
  for (const fn of [...listeners]) {
    try {
      fn(value);
    } catch (error) {
      console.error('event listener failed', error);
    }
  }
}

class EventBus {
  private readonly eventListeners = new Set<Listener<EngineEvent>>();
  private readonly reconnectListeners = new Set<() => void>();
  private readonly statusListeners = new Set<Listener<undefined>>();
  status: StreamStatus = 'connecting';

  onEvent(fn: Listener<EngineEvent>): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }
  onReconnect(fn: () => void): () => void {
    this.reconnectListeners.add(fn);
    return () => this.reconnectListeners.delete(fn);
  }
  onStatus = (fn: () => void): (() => void) => {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  };
  getStatus = (): StreamStatus => this.status;

  setStatus(s: StreamStatus): void {
    if (this.status === s) return;
    this.status = s;
    callEach(this.statusListeners, undefined);
  }
  emit(e: EngineEvent): void {
    callEach(this.eventListeners, e);
  }
  reconnected(): void {
    callEach(this.reconnectListeners, undefined);
  }
}

/** Outside a provider (unit tests of single components): no stream, never live. */
const EventsContext = createContext<EventBus>(new EventBus());

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

async function runStream(bus: EventBus, stop: AbortSignal): Promise<void> {
  let failures = 0;
  while (!stop.aborted) {
    const attempt = new AbortController();
    const abortAttempt = () => attempt.abort();
    stop.addEventListener('abort', abortAttempt);
    let deadTimer: ReturnType<typeof setTimeout> | undefined;
    const armDeadTimer = () => {
      clearTimeout(deadTimer);
      deadTimer = setTimeout(abortAttempt, DEAD_STREAM_MS);
    };
    armDeadTimer();
    let live = false;
    try {
      const stream = await api.events.subscribe(undefined, { signal: attempt.signal });
      for await (const e of stream) {
        armDeadTimer();
        if (!live) {
          // The first message (the queue snapshot) proves the stream is up. Every listener
          // registered now subscribed before it (its view may have fetched before it too).
          live = true;
          failures = 0;
          bus.setStatus('live');
          bus.reconnected();
        }
        bus.emit(e);
        if (e.type === 'resync') bus.reconnected();
      }
    } catch {
      // Network error, 401, server restart, or our own abort: all mean "reconnect".
    } finally {
      clearTimeout(deadTimer);
      stop.removeEventListener('abort', abortAttempt);
      attempt.abort();
    }
    if (stop.aborted) return;
    bus.setStatus('reconnecting');
    await sleep(Math.min(BACKOFF_START_MS * 2 ** failures, BACKOFF_MAX_MS), stop);
    failures++;
  }
}

/** Opens the stream while `enabled` (the app passes "signed in"); every hook below reads it. */
export function EventsProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const busRef = useRef<EventBus | null>(null);
  if (!busRef.current) busRef.current = new EventBus();
  const bus = busRef.current;
  useEffect(() => {
    if (!enabled) return;
    const stop = new AbortController();
    bus.setStatus('connecting');
    void runStream(bus, stop.signal);
    return () => stop.abort();
  }, [bus, enabled]);
  return createElement(EventsContext.Provider, { value: bus }, children);
}

/** Calls `onEvent` for every event while the component is mounted (re-subscribes when deps change). */
export function useEvents(onEvent: (e: EngineEvent) => void, deps: unknown[]): void {
  const bus = useContext(EventsContext);
  const ref = useRef(onEvent);
  ref.current = onEvent;
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are caller-supplied
  useEffect(() => bus.onEvent((e) => ref.current(e)), [bus, ...deps]);
}

export function useStreamStatus(): StreamStatus {
  const bus = useContext(EventsContext);
  return useSyncExternalStore(bus.onStatus, bus.getStatus);
}

/**
 * Calls `fn` when the stream comes up (the first connect too, when `fn` was registered before it)
 * and on a `resync`: the moments a view may have missed events.
 */
export function useOnReconnect(fn: () => void): void {
  const bus = useContext(EventsContext);
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => bus.onReconnect(() => ref.current()), [bus]);
}
