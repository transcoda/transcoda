import { act, cleanup, render, screen } from '@testing-library/react';
import type { EngineEvent } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = vi.hoisted(() => ({ subscribe: vi.fn() }));
vi.mock('../api/client.ts', () => ({
  api: { events: { subscribe: source.subscribe } },
  isDefinedError: () => false,
  safe: async (p: Promise<unknown>) => {
    try {
      return [null, await p];
    } catch (e) {
      return [e, undefined];
    }
  },
}));

import { LiveDot } from '../components/LiveDot.tsx';
import { fakeEventSource, jobChanged, ping, queueSnapshot } from '../test/fakeEventStream.ts';
import { EventsProvider, useEvents, useOnReconnect, useStreamStatus } from './useEvents.ts';

let fake: ReturnType<typeof fakeEventSource>;

function Probe({ onEvent, onReconnect }: { onEvent(e: EngineEvent): void; onReconnect(): void }) {
  useEvents(onEvent, []);
  useOnReconnect(onReconnect);
  return <p data-testid="status">{useStreamStatus()}</p>;
}

function mount() {
  const onEvent = vi.fn();
  const onReconnect = vi.fn();
  const view = render(
    <EventsProvider>
      <Probe onEvent={onEvent} onReconnect={onReconnect} />
      <LiveDot />
    </EventsProvider>,
  );
  return { onEvent, onReconnect, view, status: () => screen.getByTestId('status').textContent };
}

/** Lets the provider's async loop run (microtasks) without moving the clock. */
const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  fake = fakeEventSource();
  source.subscribe.mockReset().mockImplementation(fake.subscribe);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('EventsProvider', () => {
  it('delivers events to subscribers and reports live after the first message', async () => {
    const { onEvent, onReconnect, status } = mount();
    await flush();
    expect(source.subscribe).toHaveBeenCalledTimes(1);
    expect(status()).toBe('connecting');
    expect(screen.getByRole('status').textContent).toBe('reconnecting…');

    await act(async () => fake.last().push(queueSnapshot));
    await flush();
    expect(status()).toBe('live');
    expect(screen.getByRole('status').textContent).toBe('Live');
    await act(async () => fake.last().push(jobChanged('j1')));
    await flush();
    expect(onEvent.mock.calls.map(([e]) => e.type)).toEqual(['queue.changed', 'job.changed']);
    // Mounted (and fetching) before the stream was up: the first connect counts as a reconnect,
    // so nothing published between that fetch and the subscription is missed.
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('a listener added after the stream is live is not called on that first connect', async () => {
    const early = vi.fn();
    const late = vi.fn();
    function Listener({ fn }: { fn(): void }) {
      useOnReconnect(fn);
      return null;
    }
    const view = render(
      <EventsProvider>
        <Listener fn={early} />
      </EventsProvider>,
    );
    await flush();
    await act(async () => fake.last().push(queueSnapshot));
    await flush();
    view.rerender(
      <EventsProvider>
        <Listener fn={early} />
        <Listener fn={late} />
      </EventsProvider>,
    );
    await act(async () => fake.last().push(jobChanged('j1')));
    await flush();
    expect(early).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();
  });

  it('a throwing listener does not keep the event from the others or drop the stream', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen = vi.fn();
    function Thrower() {
      useEvents(() => {
        throw new Error('listener bug');
      }, []);
      useOnReconnect(() => {
        throw new Error('reconnect bug');
      });
      return null;
    }
    function Seen() {
      useEvents(seen, []);
      return null;
    }
    render(
      <EventsProvider>
        <Thrower />
        <Seen />
      </EventsProvider>,
    );
    await flush();
    await act(async () => fake.last().push(queueSnapshot));
    await act(async () => fake.last().push(jobChanged('j1')));
    await flush();
    expect(seen).toHaveBeenCalledTimes(2);
    expect(fake.last().aborted).toBe(false);
    expect(source.subscribe).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('reconnects with backoff 1 s, 2 s, 4 s after the iterator ends and fires onReconnect once per reconnect', async () => {
    const { onReconnect, status } = mount();
    await flush();
    await act(async () => fake.last().push(queueSnapshot));
    await flush();
    expect(status()).toBe('live');

    // The stream ends: wait 1 s, reconnect; that attempt fails: 2 s; fails again: 4 s.
    await act(async () => fake.last().end());
    await flush();
    expect(status()).toBe('reconnecting');
    await advance(999);
    expect(source.subscribe).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(source.subscribe).toHaveBeenCalledTimes(2);

    await act(async () => fake.last().fail());
    await advance(1999);
    expect(source.subscribe).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(source.subscribe).toHaveBeenCalledTimes(3);

    await act(async () => fake.last().fail());
    await advance(3999);
    expect(source.subscribe).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(source.subscribe).toHaveBeenCalledTimes(4);
    // Once for the first connect.
    expect(onReconnect).toHaveBeenCalledTimes(1);

    await act(async () => fake.last().push(queueSnapshot));
    await flush();
    expect(status()).toBe('live');
    expect(onReconnect).toHaveBeenCalledTimes(2);
    await act(async () => fake.last().push(ping));
    await flush();
    expect(onReconnect).toHaveBeenCalledTimes(2);

    // After a live connection the backoff starts at 1 s again.
    await act(async () => fake.last().end());
    await advance(1000);
    expect(source.subscribe).toHaveBeenCalledTimes(5);
    await act(async () => fake.last().push(queueSnapshot));
    await flush();
    expect(onReconnect).toHaveBeenCalledTimes(3);
  });

  it('caps the backoff at 30 s', async () => {
    mount();
    await flush();
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const [i, delay] of delays.entries()) {
      await act(async () => fake.last().fail());
      await advance(delay - 1);
      expect(source.subscribe).toHaveBeenCalledTimes(i + 1);
      await advance(1);
      expect(source.subscribe).toHaveBeenCalledTimes(i + 2);
    }
  });

  it('a 45 s silence triggers a reconnect; a ping resets the timer', async () => {
    const { status } = mount();
    await flush();
    await act(async () => fake.last().push(queueSnapshot));
    await flush();

    await advance(44_000);
    await act(async () => fake.last().push(ping));
    await flush();
    await advance(44_000);
    expect(fake.last().aborted).toBe(false);
    expect(status()).toBe('live');

    await advance(1000);
    expect(fake.last().aborted).toBe(true);
    expect(status()).toBe('reconnecting');
    await advance(1000);
    expect(source.subscribe).toHaveBeenCalledTimes(2);
  });

  it('a resync fires the reconnect listeners (missed events: refetch)', async () => {
    const { onReconnect } = mount();
    await flush();
    await act(async () => fake.last().push(queueSnapshot));
    await flush();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    await act(async () => fake.last().push({ type: 'resync', at: '2026-10-16T18:00:00.000Z' }));
    await flush();
    expect(onReconnect).toHaveBeenCalledTimes(2);
    expect(source.subscribe).toHaveBeenCalledTimes(1);
  });

  it('opens one stream for every subscriber and closes it on unmount', async () => {
    const { view } = mount();
    await flush();
    expect(source.subscribe).toHaveBeenCalledTimes(1);
    const stream = fake.last();
    view.unmount();
    expect(stream.aborted).toBe(true);
    await advance(60_000);
    expect(source.subscribe).toHaveBeenCalledTimes(1);
  });

  it('does not connect while disabled', async () => {
    render(
      <EventsProvider enabled={false}>
        <LiveDot />
      </EventsProvider>,
    );
    await advance(5000);
    expect(source.subscribe).not.toHaveBeenCalled();
  });
});
