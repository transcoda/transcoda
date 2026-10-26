import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queue: { status: vi.fn(), pause: vi.fn(), resume: vi.fn() },
  events: { subscribe: vi.fn() },
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { EventsProvider } from '../hooks/useEvents.ts';
import { REFETCH_COALESCE_MS } from '../hooks/useRefetchOn.ts';
import { fakeEventSource, queueSnapshot } from '../test/fakeEventStream.ts';
import { renderAt } from '../test/render.tsx';
import { QueueBar } from './QueueBar.tsx';
import { useQueue } from './useQueue.ts';

let fake: ReturnType<typeof fakeEventSource>;
const idle = { encode: null, quick: null };

beforeEach(() => {
  fake = fakeEventSource();
  mocks.events.subscribe.mockReset().mockImplementation(fake.subscribe);
  mocks.queue.status.mockReset().mockResolvedValue({ paused: false, lanes: idle, preparing: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Bar() {
  return <QueueBar queue={useQueue()} fileNameOf={() => null} />;
}

function Named() {
  return <QueueBar queue={useQueue()} fileNameOf={(id) => `${id}.mkv`} />;
}

describe('QueueBar', () => {
  it('one encode slot reads as the encode lane, as before', async () => {
    mocks.queue.status.mockResolvedValue({
      paused: false,
      lanes: { encode: 'j1', quick: null },
      encodeSlots: [{ id: 'encode', label: 'Encode', jobId: 'j1' }],
      preparing: [],
    });
    renderAt(
      '/jobs',
      <EventsProvider>
        <Named />
      </EventsProvider>,
    );
    expect((await screen.findByTestId('lanes')).textContent).toBe(
      'Encode lane: j1.mkv · Quick lane: idle',
    );
  });

  it('several GPUs: each slot by name with its job', async () => {
    mocks.queue.status.mockResolvedValue({
      paused: false,
      lanes: { encode: 'j1', quick: 'j3' },
      encodeSlots: [
        { id: 'gpu:0', label: 'GPU 0 · RTX 3060', jobId: 'j1' },
        { id: 'gpu:1', label: 'GPU 1 · RTX 3060', jobId: null },
      ],
      preparing: [],
    });
    renderAt(
      '/jobs',
      <EventsProvider>
        <Named />
      </EventsProvider>,
    );
    expect((await screen.findByTestId('lanes')).textContent).toBe(
      'GPU 0 · RTX 3060: j1.mkv · GPU 1 · RTX 3060: idle · Quick lane: j3.mkv',
    );
  });

  it('drops its live snapshot on a resync and shows the refetched status', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    renderAt(
      '/jobs',
      <EventsProvider>
        <Bar />
      </EventsProvider>,
    );
    await screen.findByRole('button', { name: 'Pause queue' });
    await act(async () => fake.last().push(queueSnapshot));
    await act(async () =>
      fake.last().push({ type: 'queue.changed', paused: true, lanes: idle, encodeSlots: [] }),
    );
    expect(screen.getByRole('button', { name: 'Resume queue' })).toBeTruthy();

    // The server resumed meanwhile and the stream dropped that event: a resync refetches, and the
    // refetched status wins over the stale live one.
    const calls = mocks.queue.status.mock.calls.length;
    await act(async () => fake.last().push({ type: 'resync', at: '2026-10-17T00:00:00.000Z' }));
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS));
    await waitFor(() => expect(mocks.queue.status.mock.calls.length).toBeGreaterThan(calls));
    expect(await screen.findByRole('button', { name: 'Pause queue' })).toBeTruthy();
  });
});
