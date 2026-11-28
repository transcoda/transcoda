import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import type { EngineEvent } from '@transcoda/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  problems: vi.fn(),
  stats: vi.fn(),
  history: vi.fn(),
  gpuLoad: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
  retryFailed: vi.fn(),
  cancelAll: vi.fn(),
  queueStatus: vi.fn(),
  queuePause: vi.fn(),
  queueResume: vi.fn(),
  libraries: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock('../api/client.ts', () => ({
  api: {
    jobs: {
      // The "Needs attention" tile's own request is told apart from the list's.
      list: (input?: { limit?: number; problems?: boolean }) =>
        input?.problems === true && input.limit === 1 ? mocks.problems(input) : mocks.list(input),
      stats: mocks.stats,
      history: mocks.history,
      pause: mocks.pause,
      resume: mocks.resume,
      cancel: mocks.cancel,
      retryFailed: mocks.retryFailed,
      cancelAll: mocks.cancelAll,
    },
    queue: { status: mocks.queueStatus, pause: mocks.queuePause, resume: mocks.queueResume },
    libraries: { list: mocks.libraries },
    system: { gpuLoad: mocks.gpuLoad },
    events: { subscribe: mocks.subscribe },
  },
  isDefinedError: (e: unknown) =>
    typeof e === 'object' && e !== null && (e as { defined?: boolean }).defined === true,
  safe: async (p: Promise<unknown>) => {
    try {
      return [null, await p];
    } catch (e) {
      return [e, undefined];
    }
  },
}));

import { REFETCH_COALESCE_MS } from '../hooks/use-refetch-on.ts';
import { jobChanged } from '../testing/fake-event-stream.ts';
import { fake, HISTORY, renderPage, samples, setupJobsPageMocks } from './testing.tsx';

setupJobsPageMocks(mocks);
afterEach(cleanup);

describe('Jobs page stats', () => {
  it('shows saved all time with its file count and start date', async () => {
    await renderPage();
    const tile = await screen.findByRole('group', { name: 'All time' });
    expect(within(tile).getByText('Saved all time')).toBeTruthy();
    expect(within(tile).getByText('556 GB')).toBeTruthy();
    // 00:08 UTC on the 18th is the evening of the 17th on the server.
    expect(within(tile).getByText('642 files since Oct 17')).toBeTruthy();
  });

  it('all time on a fresh install says 0 B and no since line', async () => {
    mocks.history.mockResolvedValue({
      ...HISTORY,
      days: HISTORY.days.map((d) => ({ ...d, savedBytes: 0, replaced: 0, kept: 0, seconds: 0 })),
      allTime: { savedBytes: 0, files: 0, since: null },
    });
    await renderPage();
    const tile = await screen.findByRole('group', { name: 'All time' });
    expect(within(tile).getByText('0 B')).toBeTruthy();
    expect(within(tile).queryByText(/since/)).toBeNull();
    expect(screen.getByRole('figure', { name: 'Data saved' })).toBeTruthy();
  });

  it('three half-height 7-day cards with week totals, kept in neutral grey', async () => {
    await renderPage();
    const week = await screen.findByRole('region', { name: 'Last 7 days' });
    expect(within(week).getByRole('figure', { name: 'Data saved' })).toBeTruthy();
    expect(within(week).getByText('554 GB')).toBeTruthy();
    expect(within(week).getByRole('figure', { name: 'Files done' })).toBeTruthy();
    expect(within(week).getByText('1,866')).toBeTruthy();
    expect(within(week).getByText('636 replaced')).toBeTruthy();
    expect(within(week).getByText('1,230 kept')).toBeTruthy();
    expect(within(week).getByRole('group', { name: 'Video processed' })).toBeTruthy();
    expect(within(week).getByRole('figure', { name: 'Hours of video processed' })).toBeTruthy();
    expect(within(week).getByText('797 h')).toBeTruthy();
    expect(
      within(week).getByRole('img', { name: 'Sat 24 Oct: 429 replaced · 690 kept original' }),
    ).toBeTruthy();
  });

  it("today's tiles ask the server for its today", async () => {
    await renderPage();
    expect(mocks.stats).toHaveBeenCalledWith({});
    expect(mocks.stats.mock.calls.every((c) => c[0] && !('since' in c[0]))).toBe(true);
  });

  it('always shows the encoder card: "idle" without GPUs', async () => {
    await renderPage();
    await waitFor(() => expect(mocks.gpuLoad).toHaveBeenCalled());
    const card = await screen.findByRole('group', { name: 'Encoder · last hour' });
    expect(await within(card).findByText('idle')).toBeTruthy();
  });

  it('shows one encoder line per GPU and the current value', async () => {
    const end = Date.now();
    mocks.gpuLoad.mockResolvedValue({
      intervalMs: 5000,
      gpus: [
        { id: 'nvidia:0', index: 0, name: 'RTX 3060', samples: samples(10, end, 97) },
        { id: 'nvidia:1', index: 1, name: 'RTX 4060', samples: samples(10, end, 40) },
      ],
    });
    await renderPage();
    const strip = await screen.findByRole('group', { name: 'Encoder · last hour' });
    expect(within(strip).getByText('RTX 3060')).toBeTruthy();
    expect(within(strip).getByText('RTX 4060')).toBeTruthy();
    expect(await within(strip).findByText('now 97%')).toBeTruthy();
    expect(strip.querySelectorAll('path.load-line')).toHaveLength(2);
  });

  it('one GPU shows its encoder and decoder', async () => {
    mocks.gpuLoad.mockResolvedValue({
      intervalMs: 5000,
      gpus: [{ id: 'nvidia:0', index: 0, name: 'RTX 3060', samples: samples(10, Date.now(), 97) }],
    });
    await renderPage();
    const strip = await screen.findByRole('group', { name: 'Encoder · last hour' });
    expect(within(strip).getByText('encoder')).toBeTruthy();
    expect(within(strip).getByText('decoder')).toBeTruthy();
    expect(strip.querySelectorAll('path.load-line')).toHaveLength(2);
  });

  it('refetches history when a job finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await renderPage();
    const before = mocks.history.mock.calls.length;
    await act(async () =>
      fake
        .last()
        .push({ ...jobChanged('j-maple-lane4'), state: 'done', lane: null } as EngineEvent),
    );
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS));
    await waitFor(() => expect(mocks.history.mock.calls.length).toBeGreaterThan(before));
  });
});
