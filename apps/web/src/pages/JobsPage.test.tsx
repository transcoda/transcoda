import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { EngineEvent } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { EventsProvider } from '../hooks/useEvents.ts';
import { REFETCH_COALESCE_MS } from '../hooks/useRefetchOn.ts';
import { fakeEventSource, jobChanged } from '../test/fakeEventStream.ts';
import { counts, fx } from '../test/fixtures/jobs.ts';
import { renderAt } from '../test/render.tsx';
import { JobsPage } from './JobsPage.tsx';

const ALL_JOBS = [
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
const COUNTS = counts({
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
const QUEUE = { paused: false, lanes: { encode: 'j-bluey4', quick: null }, preparing: [] };

let fake: ReturnType<typeof fakeEventSource>;
const realMatchMedia = window.matchMedia;

function stubPhone(phone: boolean) {
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
  cleanup();
  vi.useRealTimers();
  window.matchMedia = realMatchMedia;
});

const GB = 1e9;
/** transcoda.lan's week of 19–25 Oct 2026 (the design's live data). */
const HISTORY = {
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
function samples(n: number, end: number, encoder: number) {
  return Array.from({ length: n }, (_, i) => ({
    at: new Date(end - (n - 1 - i) * 5000).toISOString(),
    encoder,
    decoder: 40,
  }));
}

async function renderPage() {
  const view = renderAt(
    '/jobs',
    <EventsProvider>
      <JobsPage />
    </EventsProvider>,
  );
  await screen.findByText('Bluey S01E03.mp4');
  await waitFor(() => expect(fake.streams).toHaveLength(1));
  await act(async () =>
    fake.last().push({ type: 'queue.changed', paused: false, lanes: QUEUE.lanes, encodeSlots: [] }),
  );
  // The list was fetched before the stream was up: the first connect reloads it once.
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  return view;
}

async function push(e: EngineEvent) {
  await act(async () => fake.last().push(e));
}

const rowOf = (fileName: string) =>
  screen.getByRole('link', { name: fileName }).closest('.job-row') as HTMLElement;

describe('JobsPage', () => {
  it('"Retry failed" queues every failed job again and says how many; hidden with none failed', async () => {
    mocks.retryFailed.mockResolvedValue({ retried: 2 });
    mocks.list.mockResolvedValue({
      jobs: ALL_JOBS,
      counts: { ...COUNTS, failed: 2 },
      problemCount: 0,
    });
    renderAt('/jobs', <JobsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry failed' }));
    await waitFor(() => expect(mocks.retryFailed).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Queued 2 failed jobs again')).toBeTruthy();
    cleanup();
    mocks.list.mockResolvedValue({
      jobs: ALL_JOBS,
      counts: { ...COUNTS, failed: 0 },
      problemCount: 0,
    });
    renderAt('/jobs', <JobsPage />);
    await screen.findAllByRole('heading', { name: 'Jobs' });
    expect(screen.queryByRole('button', { name: 'Retry failed' })).toBeNull();
  });

  it('a queued real job\'s version is described as "runs on the version active when it starts"; a dry-run or running job has no such description', async () => {
    const queuedDry = { ...fx.queued, id: 'j-qd', fileName: 'Queued dry.mkv', dryRun: true };
    mocks.list.mockResolvedValue({
      jobs: [...ALL_JOBS, queuedDry],
      counts: COUNTS,
      problemCount: 0,
    });
    await renderPage();
    const tip = 'runs on the version active when it starts';
    await screen.findByRole('link', { name: 'Queued dry.mkv' });
    const version = within(rowOf(fx.queued.fileName)).getByText('v7');
    expect(version.getAttribute('title')).toBe(tip);
    expect(version.getAttribute('aria-describedby')).toBeTruthy();
    expect(
      document.getElementById(version.getAttribute('aria-describedby') as string)?.textContent,
    ).toBe(tip);
    for (const name of [fx.running.fileName, fx.dry.fileName, 'Queued dry.mkv']) {
      expect(rowOf(name).querySelector('[aria-describedby]')).toBeNull();
      expect(rowOf(name).textContent).not.toContain(tip);
    }
  });

  it('a verifying row fills its bar by the checks done and counts them', async () => {
    const verifying = {
      ...fx.verifying,
      progress: {
        percent: 21.4,
        outTimeSeconds: 0,
        speed: null,
        fps: null,
        sizeBytes: null,
        etaSeconds: null,
        verify: { stage: 'checks' as const, done: 3, total: 14 },
      },
    };
    mocks.list.mockResolvedValue({
      jobs: ALL_JOBS.map((j) => (j.id === verifying.id ? verifying : j)),
      counts: COUNTS,
      problemCount: 0,
    });
    await renderPage();
    const row = rowOf(fx.verifying.fileName);
    expect(within(row).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('21');
    expect(
      within(row).getByText('Checking duration, streams and decode · 3 of 14 done'),
    ).toBeTruthy();
  });

  it('a finished dry run shows its would-be verdict with the Dry run badge beside it', async () => {
    await renderPage();
    const row = rowOf(fx.dry.fileName);
    expect(within(row).getByText('Would replace')).toBeTruthy();
    expect(within(row).queryByText('Plan ready')).toBeNull();
    expect(within(row).getByText('Dry run').closest('.badge-dry')).not.toBeNull();
  });

  it('a dry run with an estimate says "Would replace · −34%" and words its plan in the detail; one without an estimate says only "Would replace"', async () => {
    const withEstimate = {
      ...fx.dry,
      reason: null,
      estimatedBytes: 660,
      planSummary: 'convert 1 video track; drop 1 subtitle track',
      result: {
        outcome: 'dry_run' as const,
        beforeBytes: 1000,
        afterBytes: null,
        replacedTo: null,
      },
    };
    const noEstimate = {
      ...withEstimate,
      id: 'j-noest',
      fileName: 'No history.mkv',
      estimatedBytes: null,
    };
    mocks.list.mockResolvedValue({
      jobs: [fx.replaced, withEstimate, noEstimate],
      counts: COUNTS,
      problemCount: 0,
    });
    await renderPage();
    const est = rowOf(withEstimate.fileName);
    expect(within(est).getByText('Would replace · −34%')).toBeTruthy();
    expect(within(est).getByText('Convert 1 video track; drop 1 subtitle track')).toBeTruthy();
    const none = rowOf('No history.mkv');
    expect(within(none).getByText('Would replace')).toBeTruthy();
    expect(none.textContent).not.toContain('%');
  });

  it('each row says when it last moved, the exact time on hover (polish review)', async () => {
    await renderPage();
    const time = rowOf(fx.dry.fileName).querySelector('time') as HTMLTimeElement;
    const when = fx.dry.finishedAt ?? fx.dry.startedAt ?? fx.dry.queuedAt;
    expect(time.getAttribute('datetime')).toBe(when);
    expect(time.getAttribute('title')).toBeTruthy();
    expect(time.textContent).toBeTruthy();
  });

  it('the job link has one name, "Details for <file>", on finished rows', async () => {
    await renderPage();
    const link = within(rowOf(fx.dry.fileName)).getByRole('link', {
      name: `Details for ${fx.dry.fileName}`,
    });
    expect(link.textContent).toBe('Details');
  });

  it('tags dry-run jobs with a "Dry run" badge in every state; real jobs have none', async () => {
    const queuedDry = { ...fx.queued, id: 'j-qd', fileName: 'Queued dry.mkv', dryRun: true };
    mocks.list.mockResolvedValue({
      jobs: [...ALL_JOBS, queuedDry],
      counts: COUNTS,
      problemCount: 0,
    });
    await renderPage();
    await screen.findByRole('link', { name: 'Queued dry.mkv' });
    expect(
      within(rowOf('Queued dry.mkv')).getByText('Dry run').closest('.badge-dry'),
    ).not.toBeNull();
    expect(rowOf(fx.running.fileName).querySelector('.badge-dry')).toBeNull();
  });

  it('a planned job waiting for a lane reads "Planned" with "waiting for the encoder"', async () => {
    const planned = {
      ...fx.queued,
      id: 'j-pl',
      fileName: 'Planned.mkv',
      state: 'building' as const,
      lane: 'encode' as const,
    };
    mocks.list.mockResolvedValue({
      jobs: [...ALL_JOBS, planned],
      counts: COUNTS,
      problemCount: 0,
    });
    await renderPage();
    await screen.findByRole('link', { name: 'Planned.mkv' });
    const row = rowOf('Planned.mkv');
    expect(within(row).getByText('Planned')).toBeTruthy();
    expect(within(row).getByText('Planned · waiting for the encoder')).toBeTruthy();
  });

  it('a queued real job on the phone layout says it runs on the version active when it starts', async () => {
    stubPhone(true);
    await renderPage();
    expect(await screen.findAllByText('Runs on the version active when it starts.')).toHaveLength(
      1,
    );
  });

  it('renders header, stats line, filter chips with counts and one row per job with chip word and detail', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Jobs' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Live')).toBeTruthy());
    // The "Today:" line is gone: its file count lives in the Saved tile.
    expect(screen.queryByTestId('jobs-today')).toBeNull();
    expect(await screen.findByText('across 63 files')).toBeTruthy();
    // The server's today, not the browser's.
    expect(mocks.stats).toHaveBeenCalledWith({});

    const all = screen.getByRole('button', { name: 'All 2,149' });
    expect(all.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Running 2' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(screen.getByRole('button', { name: 'Replaced 1,902' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kept original 61' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Paused 0' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Library All libraries' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All libraries',
      'Movies',
      'Shows',
    ]);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });

    const list = screen.getByRole('region', { name: 'Job list' });
    expect(list.querySelectorAll('.job-row')).toHaveLength(ALL_JOBS.length);
    const replaced = rowOf('Bluey S01E03.mp4');
    expect(within(replaced).getByText('Shows · TV cleanup v7')).toBeTruthy();
    expect(
      within(replaced)
        .getByRole('link', { name: 'Run summary for Bluey S01E03.mp4' })
        .getAttribute('href'),
    ).toBe('/runs/r1');
    expect(replaced.querySelector('.job-chip')?.textContent).toBe('Replaced');
    expect(
      within(replaced).getByText('2.41 GB → 1.62 GB, saved 790 MB · original in recycle folder'),
    ).toBeTruthy();
    expect(
      within(replaced)
        .getByRole('link', { name: 'Details for Bluey S01E03.mp4' })
        .getAttribute('href'),
    ).toBe('/jobs/j-bluey3');
    const running = rowOf('Bluey S01E04.mp4');
    expect(running.querySelector('.job-chip')?.textContent).toBe('Encoding');
    expect(within(running).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
    expect(within(running).getByText('42% · 118 fps · ETA 3 min')).toBeTruthy();
    // Per-row controls are named for their file (one "Pause" per row is ambiguous to a reader).
    expect(within(running).getByRole('button', { name: 'Pause Bluey S01E04.mp4' })).toBeTruthy();
    expect(within(running).getByRole('button', { name: 'Cancel Bluey S01E04.mp4' })).toBeTruthy();
    expect(within(running).queryByRole('link', { name: /^Details/ })).toBeNull();
    // A queued job while the queue runs waits for a lane.
    expect(within(rowOf('Andor S02E07.mkv')).getByText('Waiting for a lane')).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledWith({ limit: 200 });
  });

  it('filters by chip and library', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Failed 4' }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith({ state: ['failed'], limit: 200 }));
    // The paused flag lives on active jobs only: their page backs the "Paused" chip.
    expect(mocks.list).toHaveBeenCalledWith({
      state: ['queued', 'probing', 'deciding', 'building', 'encoding', 'verifying', 'replacing'],
      limit: 200,
    });
    expect(screen.getByRole('button', { name: 'Failed 4' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // Keyboard: open the library listbox, arrow to "Shows", Enter applies the filter.
    fireEvent.click(screen.getByRole('button', { name: 'Library All libraries' }));
    const listbox = screen.getByRole('listbox', { name: 'Library' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Library Shows' })).toBeTruthy();
    await waitFor(() =>
      expect(mocks.list).toHaveBeenCalledWith({
        libraryId: 'lib-shows',
        state: ['failed'],
        limit: 200,
      }),
    );
  });

  it('the Needs attention chip lists jobs with problems and counts them', async () => {
    mocks.list.mockResolvedValue({
      jobs: [fx.replaced],
      counts: COUNTS,
      problemCount: 2,
    });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Needs attention 2' }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith({ limit: 200, problems: true }));
    expect(
      screen.getByRole('button', { name: 'Needs attention 2' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('the Depends on size chip lists plan-only dry runs the size gate decides and counts them (#41)', async () => {
    mocks.list.mockResolvedValue({
      jobs: ALL_JOBS,
      counts: COUNTS,
      problemCount: 0,
      dependsOnSizeCount: 2,
    });
    await renderPage();
    const chips = [...document.querySelectorAll('.filter-chip')].map((c) => c.textContent);
    expect(chips.indexOf('Depends on size 2')).toBe(
      chips.findIndex((c) => c?.startsWith('Would replace')) + 1,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Depends on size 2' }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenCalledWith({
        limit: 200,
        state: ['dry_run'],
        dependsOnSize: true,
      }),
    );
    expect(
      screen.getByRole('button', { name: 'Depends on size 2' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('desktop shows the stat tiles; a tile applies the same filter as its chip', async () => {
    await renderPage();
    const tiles = await screen.findByRole('list', { name: 'Today' });
    await waitFor(() =>
      expect([...tiles.querySelectorAll('.stat-tile')].map((t) => t.textContent)).toEqual([
        'Saved today41.8 GBacross 63 files',
        'Queued37',
        'Failed4',
        'Needs attention3',
      ]),
    );
    // The saved tile is information only; the other three are buttons.
    expect(within(tiles).getAllByRole('button')).toHaveLength(3);
    const attention = within(tiles).getByRole('button', { name: 'Show Needs attention: 3' });
    expect(attention.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(attention);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith({ limit: 200, problems: true }));
    expect(attention.getAttribute('aria-pressed')).toBe('true');
    // The chip with the same filter is pressed too, and clicking the tile again clears it.
    expect(
      screen
        .getAllByRole('button', { name: /Needs attention/ })
        .map((b) => b.getAttribute('aria-pressed')),
    ).toEqual(['true', 'true']);
    fireEvent.click(attention);
    expect(attention.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(within(tiles).getByRole('button', { name: 'Show Failed: 4' }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith({ state: ['failed'], limit: 200 }));
    expect(screen.getByRole('button', { name: 'Failed 4' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('the pressed tile alone shows a check before its label, on every filter tile', async () => {
    await renderPage();
    const tiles = await screen.findByRole('list', { name: 'Today' });
    const queued = await within(tiles).findByRole('button', { name: 'Show Queued: 37' });
    expect(tiles.querySelector('[data-icon="check"]')).toBeNull();
    fireEvent.click(queued);
    expect(
      within(tiles)
        .getAllByRole('button')
        .map((b) => [b.getAttribute('aria-label'), b.getAttribute('aria-pressed')]),
    ).toEqual([
      ['Show Queued: 37', 'true'],
      ['Show Failed: 4', 'false'],
      ['Show Needs attention: 3', 'false'],
    ]);
    const checks = tiles.querySelectorAll('[data-icon="check"]');
    expect(checks).toHaveLength(1);
    expect(checks[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(queued.contains(checks[0] ?? null)).toBe(true);
    // The chip with the same filter is pressed together with the tile.
    expect(screen.getByRole('button', { name: 'Queued 37' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(within(tiles).getByRole('button', { name: 'Show Failed: 4' }));
    const failed = within(tiles).getByRole('button', { name: 'Show Failed: 4' });
    expect(tiles.querySelectorAll('[data-icon="check"]')).toHaveLength(1);
    expect(failed.querySelector('[data-icon="check"]')).not.toBeNull();
  });

  it('a done job with problems reads Needs attention in its row', async () => {
    mocks.list.mockResolvedValue({
      jobs: [
        { ...fx.replaced, problems: ['the server stopped before the remaining finish actions'] },
      ],
      counts: COUNTS,
      problemCount: 1,
    });
    await renderPage();
    const row = rowOf('Bluey S01E03.mp4');
    expect(row.querySelector('.job-chip')?.textContent).toBe('Needs attention');
    expect(
      within(row).getByText(
        'done · needs attention: the server stopped before the remaining finish actions',
      ),
    ).toBeTruthy();
  });

  it('applies job.changed progress in place without calling jobs.list again, and reloads for a job it does not know', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await renderPage();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    const p = fx.running.progress as NonNullable<typeof fx.running.progress>;
    await push({
      ...jobChanged('j-bluey4'),
      progress: { ...p, percent: 61, etaSeconds: 120 },
    } as EngineEvent);
    const running = rowOf('Bluey S01E04.mp4');
    expect(within(running).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('61');
    expect(within(running).getByText('61% · 118 fps · ETA 2 min')).toBeTruthy();
    // The queued job starts probing: the state moves in place and the counts follow.
    await push({ ...jobChanged('j-andor'), state: 'probing', lane: 'quick' } as EngineEvent);
    expect(rowOf('Andor S02E07.mkv').querySelector('.job-chip')?.textContent).toBe('Probing');
    expect(screen.getByRole('button', { name: 'Running 3' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Queued 36' })).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledTimes(2);

    await push(jobChanged('j-unknown'));
    // Inside the coalescing window of the first-connect reload: the trailing reload.
    expect(mocks.list).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
  });

  it('a job reaching a final state reloads the list (coalesced)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await renderPage();
    await push({ ...jobChanged('j-bluey4'), state: 'done', lane: null } as EngineEvent);
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
  });

  it('Pause queue calls queue.pause and shows the paused banner; lanes line names the running file', async () => {
    await renderPage();
    expect((await screen.findByTestId('lanes')).textContent).toBe(
      'Encode lane: Bluey S01E04.mp4 · Quick lane: idle',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pause queue' }));
    await waitFor(() => expect(mocks.queuePause).toHaveBeenCalled());
    expect(
      await screen.findByText('Queue paused — running jobs are frozen, nothing new starts'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume queue' }));
    await waitFor(() => expect(mocks.queueResume).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.queryByText('Queue paused — running jobs are frozen, nothing new starts'),
      ).toBeNull(),
    );
    // A queue.changed event from elsewhere is applied too.
    await push({
      type: 'queue.changed',
      paused: true,
      lanes: { encode: null, quick: 'j-severance' },
      encodeSlots: [],
    });
    expect(screen.getByTestId('lanes').textContent).toBe(
      'Encode lane: idle · Quick lane: Severance S02E01.mkv',
    );
    expect(screen.getByRole('button', { name: 'Resume queue' })).toBeTruthy();
    // Nothing starts while the queue is paused: a queued row says so.
    expect(within(rowOf('Andor S02E07.mkv')).getByText('Queue paused')).toBeTruthy();
  });

  it('Pause and Resume a single job', async () => {
    await renderPage();
    fireEvent.click(
      within(rowOf('Bluey S01E04.mp4')).getByRole('button', { name: 'Pause Bluey S01E04.mp4' }),
    );
    await waitFor(() => expect(mocks.pause).toHaveBeenCalledWith({ id: 'j-bluey4' }));
    await push({
      ...jobChanged('j-bluey4'),
      paused: true,
      progress: fx.running.progress,
    } as EngineEvent);
    const row = rowOf('Bluey S01E04.mp4');
    expect([...row.querySelectorAll('.job-chip')].map((c) => c.textContent)).toEqual([
      'Encoding',
      'Paused',
    ]);
    expect(screen.getByRole('button', { name: 'Paused 1' })).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Resume Bluey S01E04.mp4' }));
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith({ id: 'j-bluey4' }));
  });

  it('Cancel asks for confirmation and handles JOB_NOT_ACTIVE with a toast and reload', async () => {
    await renderPage();
    fireEvent.click(
      within(rowOf('Bluey S01E04.mp4')).getByRole('button', { name: 'Cancel Bluey S01E04.mp4' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Cancel Bluey S01E04.mp4?' });
    expect(within(dialog).getByText('The original stays untouched.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep running' }));
    expect(mocks.cancel).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    mocks.cancel.mockRejectedValueOnce({ defined: true, code: 'JOB_NOT_ACTIVE' });
    fireEvent.click(
      within(rowOf('Bluey S01E04.mp4')).getByRole('button', { name: 'Cancel Bluey S01E04.mp4' }),
    );
    const again = await screen.findByRole('dialog', { name: 'Cancel Bluey S01E04.mp4?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Cancel job' }));
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith({ id: 'j-bluey4' }));
    expect(await screen.findByText('That job already finished')).toBeTruthy();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
  });

  it('tiles are neutral at zero and tinted only above zero', async () => {
    mocks.stats.mockResolvedValue({
      files: 0,
      savedBytes: 0,
      failed: 0,
      queued: 0,
      running: 0,
    });
    mocks.list.mockResolvedValue({ jobs: [fx.replaced], counts: COUNTS, problemCount: 0 });
    mocks.problems.mockResolvedValue({ jobs: [], counts: COUNTS, problemCount: 0 });
    await renderPage();
    const tiles = await screen.findByRole('list', { name: 'Today' });
    await waitFor(() => expect(within(tiles).getByText('0 B')).toBeTruthy());
    for (const tile of tiles.querySelectorAll('.stat-tile')) {
      expect(tile.classList.contains('is-saved')).toBe(false);
      expect(tile.classList.contains('is-failed')).toBe(false);
      expect(tile.classList.contains('is-attention')).toBe(false);
    }
  });

  it('tiles tint when their value is above zero', async () => {
    await renderPage();
    const tiles = await screen.findByRole('list', { name: 'Today' });
    await waitFor(() => expect(tiles.querySelector('.stat-tile.is-saved')).not.toBeNull());
    expect(tiles.querySelector('.stat-tile.is-failed')).not.toBeNull();
    expect(tiles.querySelector('.stat-tile.is-attention')).not.toBeNull();
  });

  it('an empty filter result offers "Show all", which clears the filters', async () => {
    mocks.list.mockImplementation(async (input?: { state?: string[] }) =>
      input?.state?.[0] === 'failed'
        ? { jobs: [], counts: COUNTS, problemCount: 0 }
        : { jobs: ALL_JOBS, counts: COUNTS, problemCount: 3 },
    );
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Failed 4' }));
    expect(await screen.findByText('No jobs match this filter.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(await screen.findByText('Bluey S01E03.mp4')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All 2,149' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
  });

  it('the first load shows the shared Loading component', () => {
    mocks.list.mockReturnValue(new Promise(() => {}));
    renderAt(
      '/jobs',
      <EventsProvider>
        <JobsPage />
      </EventsProvider>,
    );
    const status = screen.getByText('Loading jobs…').closest('[role="status"]') as HTMLElement;
    expect(status.classList.contains('loading')).toBe(true);
  });

  it('the phone list has the status filters too', async () => {
    stubPhone(true);
    renderAt(
      '/jobs',
      <EventsProvider>
        <JobsPage />
      </EventsProvider>,
    );
    await screen.findByText('Bluey S01E03.mp4');
    fireEvent.click(await screen.findByRole('button', { name: 'Failed 4' }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith({ state: ['failed'], limit: 200 }));
  });

  it('phone width renders the tiles and Running/Queued/Finished sections', async () => {
    stubPhone(true);
    renderAt(
      '/jobs',
      <EventsProvider>
        <JobsPage />
      </EventsProvider>,
    );
    await screen.findByText('Bluey S01E03.mp4');
    const tiles = await screen.findByRole('list', { name: 'Today' });
    await waitFor(() =>
      expect([...tiles.querySelectorAll('.stat-tile')].map((t) => t.textContent)).toEqual([
        'Saved today41.8 GBacross 63 files',
        'Queued37',
        'Failed4',
        'Needs attention3',
      ]),
    );
    expect(mocks.problems).toHaveBeenCalledWith({ limit: 1, problems: true });
    const running = screen.getByRole('region', { name: 'Running' });
    expect(within(running).getByText('Bluey S01E04.mp4')).toBeTruthy();
    expect(within(running).getByText('42%')).toBeTruthy();
    expect(within(running).getByText('Encoding · 118 fps · ETA 3 min')).toBeTruthy();
    expect(within(running).getByText('Checking duration, streams and decode')).toBeTruthy();
    expect(within(running).getAllByRole('button', { name: /^Cancel / })).toHaveLength(2);
    const finished = screen.getByRole('region', { name: 'Finished' });
    expect(within(finished).getByText('Replaced · saved 790 MB')).toBeTruthy();
    expect(within(finished).getByText('Kept original · only 6% smaller')).toBeTruthy();
    expect(within(finished).getByText('Failed · original untouched')).toBeTruthy();
    expect(
      within(finished)
        .getByRole('link', { name: /Bluey S01E03\.mp4/ })
        .getAttribute('href'),
    ).toBe('/jobs/j-bluey3');
    expect(screen.queryByRole('region', { name: 'Job list' })).toBeNull();
    // Queued jobs are listed too, with their controls.
    const queued = screen.getByRole('region', { name: 'Queued' });
    expect(within(queued).getByText('Andor S02E07.mkv')).toBeTruthy();
    expect(within(queued).getByText('Waiting for a lane')).toBeTruthy();
    expect(within(queued).getByRole('button', { name: 'Pause Andor S02E07.mkv' })).toBeTruthy();
    expect(within(queued).getByRole('button', { name: 'Cancel Andor S02E07.mkv' })).toBeTruthy();
    // The phone header and its Menu drawer belong to the shell now, not to this page.
    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Jobs' })).toBeTruthy();
  });
});

describe('Jobs page stats', () => {
  it('shows saved all time with its file count and start date', async () => {
    await renderPage();
    const tile = await screen.findByRole('group', { name: 'All time' });
    expect(within(tile).getByText('Saved all time')).toBeTruthy();
    expect(within(tile).getByText('556 GB')).toBeTruthy();
    // 00:08 UTC on the 18th is the evening of the 17th on the server.
    expect(within(tile).getByText('642 files since 17 Oct')).toBeTruthy();
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

  it('three 7-day cards with week totals', async () => {
    await renderPage();
    const week = await screen.findByRole('region', { name: 'Last 7 days' });
    expect(within(week).getByRole('figure', { name: 'Data saved' })).toBeTruthy();
    expect(within(week).getByText('554 GB')).toBeTruthy();
    expect(within(week).getByRole('figure', { name: 'Files done' })).toBeTruthy();
    expect(within(week).getByText('1,866')).toBeTruthy();
    expect(within(week).getByText('636 replaced · 1,230 kept')).toBeTruthy();
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

  it('hides the encoder strip without GPUs', async () => {
    await renderPage();
    await waitFor(() => expect(mocks.gpuLoad).toHaveBeenCalled());
    expect(screen.queryByText('Encoder · last hour')).toBeNull();
  });

  it('shows one encoder line per GPU and the current value', async () => {
    const end = Date.now();
    mocks.gpuLoad.mockResolvedValue({
      intervalMs: 5000,
      gpus: [
        { index: 0, name: 'RTX 3060', samples: samples(10, end, 97) },
        { index: 1, name: 'RTX 4060', samples: samples(10, end, 40) },
      ],
    });
    await renderPage();
    const strip = await screen.findByRole('region', { name: 'Encoder · last hour' });
    expect(within(strip).getByText('RTX 3060')).toBeTruthy();
    expect(within(strip).getByText('RTX 4060')).toBeTruthy();
    expect(within(strip).getByText('now 97%')).toBeTruthy();
    expect(strip.querySelectorAll('path.load-line')).toHaveLength(2);
  });

  it('one GPU shows its encoder and decoder', async () => {
    mocks.gpuLoad.mockResolvedValue({
      intervalMs: 5000,
      gpus: [{ index: 0, name: 'RTX 3060', samples: samples(10, Date.now(), 97) }],
    });
    await renderPage();
    const strip = await screen.findByRole('region', { name: 'Encoder · last hour' });
    expect(within(strip).getByText('encoder')).toBeTruthy();
    expect(within(strip).getByText('decoder')).toBeTruthy();
    expect(strip.querySelectorAll('path.load-line')).toHaveLength(2);
  });

  it('refetches history when a job finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await renderPage();
    const before = mocks.history.mock.calls.length;
    await act(async () =>
      fake.last().push({ ...jobChanged('j-bluey4'), state: 'done', lane: null } as EngineEvent),
    );
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS));
    await waitFor(() => expect(mocks.history.mock.calls.length).toBeGreaterThan(before));
  });
});
