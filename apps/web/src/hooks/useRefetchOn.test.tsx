import { act, cleanup, render } from '@testing-library/react';
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

import { fakeEventSource, jobChanged, ping, queueSnapshot } from '../test/fakeEventStream.ts';
import { EventsProvider } from './useEvents.ts';
import { useRefetchOn } from './useRefetchOn.ts';

let fake: ReturnType<typeof fakeEventSource>;

const isJob = (e: EngineEvent) => e.type === 'job.changed';

function Probe({ reload }: { reload(): void }) {
  useRefetchOn(isJob, reload);
  return null;
}

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

async function mountLive() {
  const reload = vi.fn();
  render(
    <EventsProvider>
      <Probe reload={reload} />
    </EventsProvider>,
  );
  await flush();
  await act(async () => fake.last().push(queueSnapshot));
  await flush();
  // The first connect reloads once (the view fetched before the stream was up); then the
  // coalescing window passes and the tests start from a clean count.
  expect(reload).toHaveBeenCalledTimes(1);
  await advance(1000);
  reload.mockClear();
  return reload;
}

beforeEach(() => {
  vi.useFakeTimers();
  fake = fakeEventSource();
  source.subscribe.mockReset().mockImplementation(fake.subscribe);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useRefetchOn', () => {
  it('useRefetchOn calls reload at most once per second for a burst of 10 matching events, and once on reconnect', async () => {
    const reload = await mountLive();
    expect(reload).not.toHaveBeenCalled();

    // Leading call at once, one trailing call 1 s later for the rest of the burst.
    for (let i = 0; i < 10; i++) {
      await act(async () => fake.last().push(jobChanged(`j${i}`)));
      await advance(50);
    }
    expect(reload).toHaveBeenCalledTimes(1);
    await advance(499);
    expect(reload).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(reload).toHaveBeenCalledTimes(2);
    await advance(5000);
    expect(reload).toHaveBeenCalledTimes(2);

    // Non-matching events never reload.
    await act(async () => fake.last().push(ping));
    await advance(2000);
    expect(reload).toHaveBeenCalledTimes(2);

    // The stream drops and comes back: one reload for the missed events.
    await act(async () => fake.last().end());
    await advance(1000);
    await act(async () => fake.last().push(queueSnapshot));
    await flush();
    expect(reload).toHaveBeenCalledTimes(3);
    await advance(5000);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it('a reconnect inside the coalescing window becomes the trailing reload', async () => {
    const reload = await mountLive();
    await act(async () => fake.last().push(jobChanged('j1')));
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    await act(async () => fake.last().push({ type: 'resync', at: '2026-10-16T18:00:00.000Z' }));
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    await advance(1000);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending trailing reload on unmount', async () => {
    const reload = await mountLive();
    await act(async () => fake.last().push(jobChanged('j1')));
    await act(async () => fake.last().push(jobChanged('j2')));
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    cleanup();
    await advance(2000);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
