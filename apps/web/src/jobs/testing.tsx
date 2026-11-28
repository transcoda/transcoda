// Shared setup for the Jobs page tests: fixtures, the default mocked answers, render helpers.
import { act, screen, waitFor } from '@testing-library/react';
import type { EngineEvent, Job } from '@transcoda/contract';
import { afterEach, beforeEach, expect, type Mock, vi } from 'vitest';
import { EventsProvider } from '../hooks/use-events.ts';
import { fakeEventSource } from '../testing/fake-event-stream.ts';
import { counts, fx } from '../testing/fixtures/jobs.ts';
import { renderAt } from '../testing/render.tsx';
import { JobsPage } from './JobsPage.tsx';

/** The mocked client calls each Jobs page test file declares with vi.hoisted. */
export type JobsPageMocks = Record<
  | 'list'
  | 'problems'
  | 'stats'
  | 'history'
  | 'gpuLoad'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'retryFailed'
  | 'cancelAll'
  | 'queueStatus'
  | 'queuePause'
  | 'queueResume'
  | 'libraries'
  | 'subscribe',
  Mock
>;

let mocks: JobsPageMocks;

export const ALL_JOBS = [
  fx.running,
  fx.verifying,
  fx.queued,
  fx.replaced,
  fx.kept,
  fx.noop,
  fx.skipped,
  fx.failed,
  fx.dry,
];
export const COUNTS = counts({
  encoding: 1,
  verifying: 1,
  queued: 37,
  done: 1902,
  kept_original: 61,
  nothing_to_do: 118,
  skipped: 24,
  failed: 4,
  dry_run: 1,
});
export const QUEUE = {
  paused: false,
  lanes: { encode: 'j-maple-lane4', quick: null },
  preparing: [],
};

export let fake: ReturnType<typeof fakeEventSource>;
const realMatchMedia = window.matchMedia;

export function stubPhone(phone: boolean) {
  window.matchMedia = (query: string) =>
    ({
      matches: phone && query === '(max-width: 639px)',
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

/**
 * Registers the default answers of every mocked call before each test, and puts timers and
 * `matchMedia` back after it. Each test file declares `mocks` (vi.hoisted) and mocks the client.
 */
export function setupJobsPageMocks(m: JobsPageMocks) {
  mocks = m;
  beforeEach(() => {
    fake = fakeEventSource();
    mocks.subscribe.mockReset().mockImplementation(fake.subscribe);
    mocks.list.mockReset().mockResolvedValue({ jobs: ALL_JOBS, counts: COUNTS, problemCount: 0 });
    mocks.problems.mockReset().mockResolvedValue({ jobs: [], counts: COUNTS, problemCount: 3 });
    mocks.stats.mockReset().mockResolvedValue({
      files: 63,
      savedBytes: 41_800_000_000,
      failed: 4,
      queued: 37,
      running: 2,
    });
    mocks.history.mockReset().mockResolvedValue(HISTORY);
    mocks.gpuLoad.mockReset().mockResolvedValue({ intervalMs: 5000, gpus: [] });
    mocks.pause.mockReset().mockResolvedValue({ ok: true });
    mocks.resume.mockReset().mockResolvedValue({ ok: true });
    mocks.cancel.mockReset().mockResolvedValue({ ok: true });
    mocks.cancelAll.mockReset().mockResolvedValue({ cancelled: 39, writing: 0, failed: 0 });
    mocks.queueStatus.mockReset().mockResolvedValue(QUEUE);
    mocks.queuePause.mockReset().mockResolvedValue({ ...QUEUE, paused: true });
    mocks.queueResume.mockReset().mockResolvedValue(QUEUE);
    mocks.libraries.mockReset().mockResolvedValue({
      libraries: [
        { id: 'lib-movies', name: 'Movies' },
        { id: 'lib-shows', name: 'Shows' },
      ],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    window.matchMedia = realMatchMedia;
  });
}

export const GB = 1e9;
/** transcoda.lan's week of 19–25 Oct 2026 (the design's live data). */
export const HISTORY = {
  timeZone: 'America/New_York',
  days: [
    ['2026-10-19', 0, 0, 0, 0],
    ['2026-10-20', 0, 0, 0, 0],
    ['2026-10-21', 0, 0, 0, 0],
    ['2026-10-22', 60.7, 18, 13, 47.5],
    ['2026-10-23', 218.7, 93, 120, 208.3],
    ['2026-10-24', 152.8, 429, 690, 325.8],
    ['2026-10-25', 121.9, 96, 407, 215.2],
  ].map(([date, saved, replaced, kept, hours]) => ({
    date: date as string,
    savedBytes: Math.round((saved as number) * GB),
    replaced: replaced as number,
    kept: kept as number,
    seconds: (hours as number) * 3600,
  })),
  allTime: { savedBytes: 556 * GB, files: 642, since: '2026-10-18T00:08:41.000Z' },
};

/** `n` encoder samples 5 s apart ending at `end`. */
export function samples(n: number, end: number, encoder: number) {
  return Array.from({ length: n }, (_, i) => ({
    at: new Date(end - (n - 1 - i) * 5000).toISOString(),
    encoder,
    decoder: 40,
  }));
}

export async function renderPage(): Promise<ReturnType<typeof renderAt>> {
  const view = renderAt(
    '/jobs',
    <EventsProvider>
      <JobsPage />
    </EventsProvider>,
  );
  // Desktop names the title link "Maple Lane S01E03"; the phone's finished card adds its result line.
  await screen.findByRole('link', { name: /^Maple Lane S01E03/ });
  await waitFor(() => expect(fake.streams).toHaveLength(1));
  await act(async () =>
    fake.last().push({ type: 'queue.changed', paused: false, lanes: QUEUE.lanes, encodeSlots: [] }),
  );
  // The list was fetched before the stream was up: the first connect reloads it once.
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  return view;
}

export async function push(e: EngineEvent) {
  await act(async () => fake.last().push(e));
}

/** The table row of a job, found by its title link. */
export function rowOf(job: Pick<Job, 'id'>): HTMLElement {
  const link = document.querySelector(`a.row-link-main[href="/jobs/${job.id}"]`);
  const row = link?.closest('tr');
  if (!row) throw new Error(`no row for ${job.id}`);
  return row;
}

/** The lanes rows as one line: "Encoder: idle · Quick tasks: idle". */
export const lanesText = (el: HTMLElement) =>
  Array.from(
    el.querySelectorAll('.lane'),
    (r) => `${r.querySelector('dt')?.textContent}: ${r.querySelector('dd')?.textContent}`,
  ).join(' · ');
