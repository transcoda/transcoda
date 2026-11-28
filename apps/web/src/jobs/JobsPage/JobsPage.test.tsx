import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
vi.mock('../../api/client.ts', () => ({
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

import { EventsProvider } from '../../hooks/use-events.ts';
import { REFETCH_COALESCE_MS } from '../../hooks/use-refetch-on.ts';
import { jobChanged } from '../../testing/fake-event-stream.ts';
import { counts, fx, job } from '../../testing/fixtures/jobs.ts';
import { renderAt } from '../../testing/render.tsx';
import { jobTitle } from '../media-text.ts';
import { JobsPage } from './JobsPage.tsx';
import {
  ALL_JOBS,
  COUNTS,
  lanesText,
  push,
  QUEUE,
  renderPage,
  rowOf,
  setupJobsPageMocks,
  stubPhone,
} from './testing.tsx';

setupJobsPageMocks(mocks);
afterEach(cleanup);

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

  it('"Cancel all" asks with the count of unfinished jobs, cancels every library and says how many; hidden with none unfinished', async () => {
    renderAt('/jobs', <JobsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel all' }));
    // 1 encoding + 1 verifying + 37 queued.
    const dialog = await screen.findByRole('dialog', { name: 'Cancel 39 jobs?' });
    expect(
      within(dialog).getByText(
        'Every queued, running and paused job in every library is canceled.',
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        'Running encodes stop now and their partial output is deleted. Their originals stay untouched. Jobs already replacing their file finish.',
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep running' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.cancelAll).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel all' }));
    const again = await screen.findByRole('dialog', { name: 'Cancel 39 jobs?' });
    const confirm = within(again).getByRole('button', { name: 'Cancel 39 jobs' });
    expect(confirm.className).toContain('btn-danger');
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.cancelAll).toHaveBeenCalledWith({}));
    expect(await screen.findByText('Canceled 39 jobs')).toBeTruthy();

    cleanup();
    mocks.list.mockResolvedValue({
      jobs: [fx.replaced, fx.failed],
      counts: counts({ done: 1902, failed: 4, cancelled: 3 }),
      problemCount: 0,
    });
    renderAt('/jobs', <JobsPage />);
    await screen.findAllByRole('heading', { name: 'Jobs' });
    await screen.findByRole('link', { name: jobTitle(fx.replaced) });
    expect(screen.queryByRole('button', { name: 'Cancel all' })).toBeNull();
  });

  it('"Cancel all" leaves replacing jobs out of its count and reports jobs left to finish, failed cancels and a refusal honestly', async () => {
    mocks.list.mockResolvedValue({
      jobs: ALL_JOBS,
      counts: { ...COUNTS, replacing: 5 },
      problemCount: 0,
    });
    mocks.cancelAll.mockResolvedValueOnce({ cancelled: 0, writing: 5, failed: 0 });
    renderAt('/jobs', <JobsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel all' }));
    let dialog = await screen.findByRole('dialog', { name: 'Cancel 39 jobs?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel 39 jobs' }));
    expect(
      await screen.findByText(
        'Nothing was canceled. 5 jobs already replacing their file will finish',
      ),
    ).toBeTruthy();

    mocks.cancelAll.mockResolvedValueOnce({ cancelled: 36, writing: 1, failed: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel all' }));
    dialog = await screen.findByRole('dialog', { name: 'Cancel 39 jobs?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel 39 jobs' }));
    expect(
      await screen.findByText(
        'Canceled 36 jobs. 1 job already replacing their file will finish. 2 jobs could not be canceled',
      ),
    ).toBeTruthy();

    mocks.cancelAll.mockRejectedValueOnce(
      new Error('The server is stopping; nothing was canceled'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel all' }));
    dialog = await screen.findByRole('dialog', { name: 'Cancel 39 jobs?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel 39 jobs' }));
    expect(
      await screen.findByText(
        "Couldn't cancel the jobs: The server is stopping; nothing was canceled",
      ),
    ).toBeTruthy();

    cleanup();
    mocks.list.mockResolvedValue({
      jobs: [fx.replaced],
      counts: counts({ done: 1902, replacing: 2 }),
      problemCount: 0,
    });
    renderAt('/jobs', <JobsPage />);
    await screen.findByRole('link', { name: jobTitle(fx.replaced) });
    expect(screen.queryByRole('button', { name: 'Cancel all' })).toBeNull();
  });

  it('"Cancel all" keeps to the library filter and says the status filter does not limit it', async () => {
    renderAt('/jobs', <JobsPage />);
    await screen.findByRole('button', { name: 'Cancel all' });
    fireEvent.click(screen.getByRole('button', { name: 'Library All libraries' }));
    fireEvent.click(screen.getByRole('option', { name: 'Movies' }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ libraryId: 'lib-movies' }),
      ),
    );
    // The filter chip (the "Queued" stat tile's name starts with the same word).
    const chips = document.querySelector('.filter-chips') as HTMLElement;
    fireEvent.click(within(chips).getByRole('button', { name: /^Queued/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel all' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel 39 jobs?' });
    expect(
      within(dialog).getByText(
        'Every queued, running and paused job in Movies is canceled. The status and run filters do not limit this.',
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel 39 jobs' }));
    await waitFor(() => expect(mocks.cancelAll).toHaveBeenCalledWith({ libraryId: 'lib-movies' }));
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
    await waitFor(() => rowOf(queuedDry));
    const version = within(rowOf(fx.queued)).getByText('v7');
    expect(version.getAttribute('title')).toBe(tip);
    expect(version.getAttribute('aria-describedby')).toBeTruthy();
    expect(
      document.getElementById(version.getAttribute('aria-describedby') as string)?.textContent,
    ).toBe(tip);
    for (const j of [fx.running, fx.dry, queuedDry]) {
      expect(rowOf(j).querySelector('[aria-describedby]')).toBeNull();
      expect(rowOf(j).textContent).not.toContain(tip);
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
    const row = rowOf(fx.verifying);
    expect(within(row).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('21');
    expect(
      within(row).getByText('Checking duration, streams and decode · 3 of 14 done'),
    ).toBeTruthy();
  });

  it('a failed row clamps its reason to two lines, the whole line on hover (#44)', async () => {
    await renderPage();
    const detail = within(rowOf(fx.failed)).getByText(
      'Verification failed: output 4 s shorter · original untouched',
    );
    expect(detail.classList.contains('job-detail-clamp')).toBe(true);
    expect(detail.classList.contains('is-failed')).toBe(true);
    expect(detail.getAttribute('title')).toBe(detail.textContent);
  });

  it('a finished dry run shows its would-be verdict with the Dry run badge beside it', async () => {
    await renderPage();
    const row = rowOf(fx.dry);
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
    const est = rowOf(withEstimate);
    expect(within(est).getByText('Would replace · −34%')).toBeTruthy();
    expect(within(est).getByText('Convert 1 video track; drop 1 subtitle track')).toBeTruthy();
    const none = rowOf(noEstimate);
    expect(within(none).getByText('Would replace')).toBeTruthy();
    expect(none.textContent).not.toContain('%');
  });

  it('each row says when it last moved, the exact time on hover (polish review)', async () => {
    await renderPage();
    const time = rowOf(fx.dry).querySelector('td.job-when time') as HTMLTimeElement;
    const when = fx.dry.finishedAt ?? fx.dry.startedAt ?? fx.dry.queuedAt;
    expect(time.getAttribute('datetime')).toBe(when);
    expect(time.getAttribute('title')).toBeTruthy();
    expect(time.textContent).toBeTruthy();
  });

  it('the row is the link: the title opens the job, no "Details" links (convention 9)', async () => {
    await renderPage();
    const row = rowOf(fx.dry);
    expect(row.classList.contains('row-link')).toBe(true);
    const link = within(row).getByRole('link', { name: jobTitle(fx.dry) });
    expect(link.getAttribute('href')).toBe(`/jobs/${fx.dry.id}`);
    expect(link.classList.contains('row-link-main')).toBe(true);
    // The file name shows on hover only.
    expect(link.getAttribute('title')).toBe(fx.dry.fileName);
    expect(within(row).queryByText('Details')).toBeNull();
    expect(within(row).queryByRole('link', { name: /^Details/ })).toBeNull();
  });

  it('tags dry-run jobs with a "Dry run" badge in every state; real jobs have none', async () => {
    const queuedDry = { ...fx.queued, id: 'j-qd', fileName: 'Queued dry.mkv', dryRun: true };
    mocks.list.mockResolvedValue({
      jobs: [...ALL_JOBS, queuedDry],
      counts: COUNTS,
      problemCount: 0,
    });
    await renderPage();
    await waitFor(() => rowOf(queuedDry));
    expect(within(rowOf(queuedDry)).getByText('Dry run').closest('.badge-dry')).not.toBeNull();
    expect(rowOf(fx.running).querySelector('.badge-dry')).toBeNull();
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
    await waitFor(() => rowOf(planned));
    const row = rowOf(planned);
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
    expect(await screen.findByText('41.8 GB')).toBeTruthy();
    expect(screen.queryByText('across 63 files')).toBeNull();
    // The server's today, not the browser's.
    expect(mocks.stats).toHaveBeenCalledWith({});

    const all = screen.getByRole('button', { name: 'All 2,149' });
    expect(all.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Running 2' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(screen.getByRole('button', { name: 'Replaced 1,902' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kept original 61' })).toBeTruthy();
    // Options at 0 are hidden, except "All" and the current one (convention 15).
    expect(screen.queryByRole('button', { name: 'Paused 0' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Library All libraries' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All libraries',
      'Movies',
      'Shows',
    ]);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });

    const list = screen.getByRole('table', { name: 'Job list' });
    expect(within(list).getAllByRole('row')).toHaveLength(ALL_JOBS.length + 1);
    const replaced = rowOf(fx.replaced);
    expect(within(replaced).getByText('Shows')).toBeTruthy();
    expect(within(replaced).getByText('TV cleanup v7')).toBeTruthy();
    expect(replaced.querySelector('.job-chip')?.textContent).toBe('Replaced');
    expect(within(replaced).getByText('2.41 GB → 1.62 GB')).toBeTruthy();
    expect(
      within(replaced).getByRole('link', { name: 'Maple Lane S01E03' }).getAttribute('href'),
    ).toBe('/jobs/j-maple-lane3');
    const running = rowOf(fx.running);
    expect(running.querySelector('.job-chip')?.textContent).toBe('Encoding');
    expect(within(running).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
    expect(within(running).getByText('42% · 118 fps · ETA 3 min')).toBeTruthy();
    // Per-row controls are named for their job (one "Pause" per row is ambiguous to a reader).
    expect(within(running).getByRole('button', { name: 'Pause Maple Lane S01E04' })).toBeTruthy();
    expect(within(running).getByRole('button', { name: 'Cancel Maple Lane S01E04' })).toBeTruthy();
    expect(within(running).queryByRole('link', { name: /^Details/ })).toBeNull();
    // A queued job while the queue runs waits for a lane.
    expect(within(rowOf(fx.queued)).getByText('Waiting its turn')).toBeTruthy();
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

  it('the Waiting for approval chip lists the results an Approval step holds and counts them; none hides it', async () => {
    const waiting = job({
      id: 'j-wait',
      state: 'verifying',
      reason: 'waiting for approval',
      approval: {
        parkedAt: '2026-10-16T18:20:00.000Z',
        expiresAt: '2026-10-23T18:20:00.000Z',
        beforeBytes: 2_000_000_000,
        afterBytes: 1_200_000_000,
      },
    });
    mocks.list.mockResolvedValue({
      jobs: ALL_JOBS,
      counts: COUNTS,
      problemCount: 0,
      dependsOnSizeCount: 0,
      awaitingApprovalCount: 1,
    });
    await renderPage();
    mocks.list.mockResolvedValue({
      jobs: [waiting],
      counts: COUNTS,
      problemCount: 0,
      dependsOnSizeCount: 0,
      awaitingApprovalCount: 1,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Waiting for approval 1' }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenCalledWith({ limit: 200, awaitingApproval: true }),
    );
    expect((await screen.findAllByText('Waiting for approval')).length).toBeGreaterThan(0);

    mocks.list.mockResolvedValue({
      jobs: ALL_JOBS,
      counts: COUNTS,
      problemCount: 0,
      dependsOnSizeCount: 0,
      awaitingApprovalCount: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Waiting for approval/ })).toBeNull(),
    );
  });

  it('desktop shows the stat tiles; a tile applies the same filter as its chip', async () => {
    await renderPage();
    const tiles = await screen.findByRole('list', { name: 'Today' });
    await waitFor(() =>
      expect([...tiles.querySelectorAll('.stat-tile')].map((t) => t.textContent)).toEqual([
        'Needs attention3',
        'Saved today41.8 GB',
        'Queued37',
        'Failed4',
      ]),
    );
    // One figure leads: Needs attention, the count that asks for something to be done.
    expect([...tiles.querySelectorAll('.stat-tile.is-lead')].map((t) => t.textContent)).toEqual([
      'Needs attention3',
    ]);
    // The saved tile is information only; the other three are buttons.
    expect(within(tiles).getAllByRole('button')).toHaveLength(3);
    const attention = within(tiles).getByRole('button', {
      name: 'Needs attention: 3, show these jobs',
    });
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
    fireEvent.click(within(tiles).getByRole('button', { name: 'Failed: 4, show these jobs' }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith({ state: ['failed'], limit: 200 }));
    expect(screen.getByRole('button', { name: 'Failed 4' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('the pressed tile alone shows a check before its label, on every filter tile', async () => {
    await renderPage();
    const tiles = await screen.findByRole('list', { name: 'Today' });
    const queued = await within(tiles).findByRole('button', {
      name: 'Queued: 37, show these jobs',
    });
    expect(tiles.querySelector('[data-icon="check"]')).toBeNull();
    fireEvent.click(queued);
    expect(
      within(tiles)
        .getAllByRole('button')
        .map((b) => [b.getAttribute('aria-label'), b.getAttribute('aria-pressed')]),
    ).toEqual([
      ['Needs attention: 3, show these jobs', 'false'],
      ['Queued: 37, show these jobs', 'true'],
      ['Failed: 4, show these jobs', 'false'],
    ]);
    const checks = tiles.querySelectorAll('[data-icon="check"]');
    expect(checks).toHaveLength(1);
    expect(checks[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(queued.contains(checks[0] ?? null)).toBe(true);
    // The chip with the same filter is pressed together with the tile.
    expect(screen.getByRole('button', { name: 'Queued 37' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(within(tiles).getByRole('button', { name: 'Failed: 4, show these jobs' }));
    const failed = within(tiles).getByRole('button', { name: 'Failed: 4, show these jobs' });
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
    const row = rowOf(fx.replaced);
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
      ...jobChanged('j-maple-lane4'),
      progress: { ...p, percent: 61, etaSeconds: 120 },
    } as EngineEvent);
    const running = rowOf(fx.running);
    expect(within(running).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('61');
    expect(within(running).getByText('61% · 118 fps · ETA 2 min')).toBeTruthy();
    // The queued job starts probing: the state moves in place and the counts follow.
    await push({ ...jobChanged('j-starfall'), state: 'probing', lane: 'quick' } as EngineEvent);
    expect(rowOf(fx.queued).querySelector('.job-chip')?.textContent).toBe('Probing');
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
    await push({ ...jobChanged('j-maple-lane4'), state: 'done', lane: null } as EngineEvent);
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
  });

  it('a result parked for approval reloads the list, though the job stays in the same state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await renderPage();
    await push({
      ...jobChanged('j-maple-lane4'),
      state: 'verifying',
      reason: 'waiting for approval',
    } as EngineEvent);
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
  });

  it('Pause queue calls queue.pause and shows the paused banner; lanes line names the running job', async () => {
    await renderPage();
    expect(lanesText(await screen.findByTestId('lanes'))).toBe(
      'Encoder: Maple Lane S01E04 · Quick tasks: idle',
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
      lanes: { encode: null, quick: 'j-blue-ledger' },
      encodeSlots: [],
    });
    expect(lanesText(screen.getByTestId('lanes'))).toBe(
      'Encoder: idle · Quick tasks: Blue Ledger S02E01',
    );
    expect(screen.getByRole('button', { name: 'Resume queue' })).toBeTruthy();
    // Nothing starts while the queue is paused: a queued row says so.
    expect(within(rowOf(fx.queued)).getByText('Queue paused')).toBeTruthy();
  });

  it("hides a job's own Pause while the whole queue is paused; Cancel stays (#54)", async () => {
    await renderPage();
    const starfall = rowOf(fx.queued);
    expect(within(starfall).getByRole('button', { name: 'Pause Starfall S02E07' })).toBeTruthy();
    await push({ type: 'queue.changed', paused: true, lanes: QUEUE.lanes, encodeSlots: [] });
    const paused = rowOf(fx.queued);
    expect(within(paused).queryByRole('button', { name: 'Pause Starfall S02E07' })).toBeNull();
    expect(within(paused).getByRole('button', { name: 'Cancel Starfall S02E07' })).toBeTruthy();
  });

  it('the Runs facet narrows the list and its counts to dry or real runs; Cancel all keeps counting both (#54)', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Runs Real and dry runs' }));
    const listbox = screen.getByRole('listbox', { name: 'Runs' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Runs Dry runs' })).toBeTruthy();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith({ limit: 200, dryRun: true }));
    // "Cancel all" covers real and dry runs, so it counts them apart from the narrowed list.
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith({ limit: 1 }));
  });

  it('Cancel all refreshes its own counts after cancelling while the Runs facet is on (#54)', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Runs Real and dry runs' }));
    const runs = screen.getByRole('listbox', { name: 'Runs' });
    fireEvent.keyDown(runs, { key: 'ArrowDown' });
    fireEvent.keyDown(runs, { key: 'ArrowDown' });
    fireEvent.keyDown(runs, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel all' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel 39 jobs?' });
    const before = mocks.list.mock.calls.filter(([input]) => input?.limit === 1).length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel 39 jobs' }));
    await waitFor(() => expect(mocks.cancelAll).toHaveBeenCalled());
    // Without the event stream, only a reload tells Cancel all that nothing is left.
    await waitFor(() =>
      expect(mocks.list.mock.calls.filter(([input]) => input?.limit === 1).length).toBeGreaterThan(
        before,
      ),
    );
  });

  it("Cancel all never shows another library's counts while the Runs facet is on (#54)", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Runs Real and dry runs' }));
    const runs = screen.getByRole('listbox', { name: 'Runs' });
    fireEvent.keyDown(runs, { key: 'ArrowDown' });
    fireEvent.keyDown(runs, { key: 'ArrowDown' });
    fireEvent.keyDown(runs, { key: 'Enter' });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith({ limit: 1 }));
    expect(await screen.findByRole('button', { name: 'Cancel all' })).toBeTruthy();
    // Shows' own counts never arrive: Cancel all must not keep offering every library's 39 jobs.
    const base = mocks.list.getMockImplementation();
    mocks.list.mockImplementation((input?: { limit?: number; libraryId?: string }) =>
      input?.limit === 1 && input.libraryId === 'lib-shows' ? new Promise(() => {}) : base?.(input),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Library All libraries' }));
    const libs = screen.getByRole('listbox', { name: 'Library' });
    fireEvent.keyDown(libs, { key: 'ArrowDown' });
    fireEvent.keyDown(libs, { key: 'ArrowDown' });
    fireEvent.keyDown(libs, { key: 'Enter' });
    await waitFor(() =>
      expect(mocks.list).toHaveBeenCalledWith({ limit: 1, libraryId: 'lib-shows' }),
    );
    expect(screen.queryByRole('button', { name: 'Cancel all' })).toBeNull();
  });

  it("Cancel all never counts with the dry-run list's counts after the Runs facet is cleared (#54)", async () => {
    await renderPage();
    const base = mocks.list.getMockImplementation();
    // The dry-run list counts one queued job; every job in the library is 39.
    mocks.list.mockImplementation((input?: { limit?: number; dryRun?: boolean }) =>
      input?.dryRun === true
        ? Promise.resolve({ jobs: [], counts: counts({ queued: 1 }), problemCount: 0 })
        : base?.(input),
    );
    const pick = (button: string, key: 'ArrowDown' | 'ArrowUp') => {
      fireEvent.click(screen.getByRole('button', { name: button }));
      const lb = screen.getByRole('listbox', { name: 'Runs' });
      fireEvent.keyDown(lb, { key });
      fireEvent.keyDown(lb, { key });
      fireEvent.keyDown(lb, { key: 'Enter' });
    };
    pick('Runs Real and dry runs', 'ArrowDown');
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith({ limit: 200, dryRun: true }));
    expect(await screen.findByRole('button', { name: 'Cancel all' })).toBeTruthy();
    // Back to real and dry runs; the unfiltered list's answer is held back.
    mocks.list.mockImplementation((input?: { limit?: number; dryRun?: boolean }) =>
      input?.limit === 200 && input.dryRun === undefined ? new Promise(() => {}) : base?.(input),
    );
    const calls = mocks.list.mock.calls.length;
    pick('Runs Dry runs', 'ArrowUp');
    await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThan(calls));
    expect(screen.getByRole('button', { name: 'Runs Real and dry runs' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel all' })).toBeNull();
  });

  it('Pause and Resume a single job', async () => {
    await renderPage();
    fireEvent.click(
      within(rowOf(fx.running)).getByRole('button', { name: 'Pause Maple Lane S01E04' }),
    );
    await waitFor(() => expect(mocks.pause).toHaveBeenCalledWith({ id: 'j-maple-lane4' }));
    await push({
      ...jobChanged('j-maple-lane4'),
      paused: true,
      progress: fx.running.progress,
    } as EngineEvent);
    const row = rowOf(fx.running);
    expect([...row.querySelectorAll('.job-chip')].map((c) => c.textContent)).toEqual([
      'Encoding',
      'Paused',
    ]);
    expect(screen.getByRole('button', { name: 'Paused 1' })).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Resume Maple Lane S01E04' }));
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith({ id: 'j-maple-lane4' }));
  });

  it('Cancel asks for confirmation and handles JOB_NOT_ACTIVE with a toast and reload', async () => {
    await renderPage();
    fireEvent.click(
      within(rowOf(fx.running)).getByRole('button', { name: 'Cancel Maple Lane S01E04' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Cancel Maple Lane S01E04?' });
    expect(within(dialog).getByText('The original stays untouched.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep running' }));
    expect(mocks.cancel).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    mocks.cancel.mockRejectedValueOnce({ defined: true, code: 'JOB_NOT_ACTIVE' });
    fireEvent.click(
      within(rowOf(fx.running)).getByRole('button', { name: 'Cancel Maple Lane S01E04' }),
    );
    const again = await screen.findByRole('dialog', { name: 'Cancel Maple Lane S01E04?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Cancel job' }));
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith({ id: 'j-maple-lane4' }));
    expect(await screen.findByText('That job already finished')).toBeTruthy();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
  });

  it('no tile is ever tinted, at zero or above', async () => {
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

  it('tiles are never tinted; only a zero that is not good news is dimmed (convention 6)', async () => {
    mocks.stats.mockResolvedValue({ savedBytes: 0, files: 0, queued: 0, failed: 0 });
    await renderPage();
    const tiles = await screen.findByRole('list', { name: 'Today' });
    await waitFor(() => expect(within(tiles).getByText('0 B')).toBeTruthy());
    const dimmed = [...tiles.querySelectorAll('.stat-tile')].map((t) =>
      t.classList.contains('is-zero'),
    );
    // Needs attention leads. Saved and Queued dim at 0; 0 failed and 0 needing attention are good
    // news.
    expect(dimmed).toEqual([false, true, true, false]);
  });

  it('a day where files grew shows the growth plainly, not in the accent colour of a saving', async () => {
    mocks.stats.mockResolvedValue({ savedBytes: -104, files: 2, queued: 0, failed: 0 });
    await renderPage();
    const tiles = await screen.findByRole('list', { name: 'Today' });
    const value = await within(tiles).findByText('Grew 104 B');
    const tile = value.closest('.stat-tile') as HTMLElement;
    expect(tile.classList.contains('has-accent-value')).toBe(false);
    expect(within(tile).getByText('Saved today')).toBeTruthy();
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
    expect(await screen.findByRole('link', { name: 'Maple Lane S01E03' })).toBeTruthy();
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
    await screen.findByText('Maple Lane S01E03');
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
    await screen.findByText('Maple Lane S01E03');
    const tiles = await screen.findByRole('list', { name: 'Today' });
    await waitFor(() =>
      expect([...tiles.querySelectorAll('.stat-tile')].map((t) => t.textContent)).toEqual([
        'Needs attention3',
        'Saved today41.8 GB',
        'Queued37',
        'Failed4',
      ]),
    );
    expect(mocks.problems).toHaveBeenCalledWith({ limit: 1, problems: true });
    const running = screen.getByRole('region', { name: 'Running' });
    expect(within(running).getByRole('link', { name: 'Maple Lane S01E04' }).textContent).toBe(
      'Maple Lane',
    );
    expect(within(running).getByText('S01E04')).toBeTruthy();
    expect(within(running).getByText('42%')).toBeTruthy();
    expect(within(running).getByText('Encoding · 118 fps · ETA 3 min')).toBeTruthy();
    expect(within(running).getByText('Checking duration, streams and decode')).toBeTruthy();
    expect(within(running).getAllByRole('button', { name: /^Cancel / })).toHaveLength(2);
    const finished = screen.getByRole('region', { name: 'Finished' });
    // Sentence-case section heading, not a mono capital label (convention 4).
    expect(within(finished).getByRole('heading', { level: 2 }).className).toBe('section-h2');
    expect(within(finished).getByText('Replaced · saved 790 MB')).toBeTruthy();
    expect(within(finished).getByText('Kept original · only 6% smaller')).toBeTruthy();
    expect(within(finished).getByText('Failed · original untouched')).toBeTruthy();
    expect(
      within(finished)
        .getByRole('link', { name: /Maple Lane S01E03/ })
        .getAttribute('href'),
    ).toBe('/jobs/j-maple-lane3');
    expect(screen.queryByRole('table', { name: 'Job list' })).toBeNull();
    // Queued jobs are listed too, with their controls.
    const queued = screen.getByRole('region', { name: 'Queued' });
    expect(within(queued).getByRole('link', { name: 'Starfall S02E07' }).textContent).toBe(
      'Starfall',
    );
    expect(within(queued).getByText('S02E07')).toBeTruthy();
    expect(within(queued).getByText('Waiting its turn')).toBeTruthy();
    expect(within(queued).getByRole('button', { name: 'Pause Starfall S02E07' })).toBeTruthy();
    expect(within(queued).getByRole('button', { name: 'Cancel Starfall S02E07' })).toBeTruthy();
    // Titles, not file names; no posters on the phone list.
    for (const j of ALL_JOBS) expect(screen.queryByText(j.fileName)).toBeNull();
    expect(document.querySelector('.phone-section img, .phone-section .poster')).toBeNull();
    // The phone header and its Menu drawer belong to the shell now, not to this page.
    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Jobs' })).toBeTruthy();
  });
});
