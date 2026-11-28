import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Job } from '@transcoda/contract';
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

import { fx } from '../testing/fixtures/jobs.ts';
import { renderAt } from '../testing/render.tsx';
import { JobsPage } from './JobsPage.tsx';
import { ALL_JOBS, COUNTS, renderPage, rowOf, setupJobsPageMocks } from './testing.tsx';

setupJobsPageMocks(mocks);
afterEach(cleanup);

describe('Jobs table', () => {
  const withJobs = (jobs: Job[]) =>
    mocks.list.mockResolvedValue({ jobs: [fx.replaced, ...jobs], counts: COUNTS, problemCount: 0 });
  const headers = () =>
    within(screen.getByRole('table', { name: 'Job list' }))
      .getAllByRole('columnheader')
      .map((h) => h.textContent);

  it('is a table with Title, Library, Workflow, Status, Result and When; an Actions column only while a job is active', async () => {
    await renderPage();
    expect(headers()).toEqual([
      'Title',
      'Library',
      'Workflow',
      'Status',
      'Result',
      'When',
      'Actions',
    ]);
    const actions = within(screen.getByRole('table', { name: 'Job list' })).getByRole(
      'columnheader',
      { name: 'Actions' },
    );
    expect(actions.querySelector('.sr-only')?.textContent).toBe('Actions');
    expect(screen.getByRole('table', { name: 'Job list' }).classList).toContain('has-actions');
    cleanup();
    mocks.list.mockResolvedValue({
      jobs: [fx.replaced, fx.failed],
      counts: COUNTS,
      problemCount: 0,
    });
    renderAt('/jobs', <JobsPage />);
    await screen.findByRole('link', { name: 'Maple Lane S01E03' });
    expect(headers()).toEqual(['Title', 'Library', 'Workflow', 'Status', 'Result', 'When']);
    expect(screen.getByRole('table', { name: 'Job list' }).classList).not.toContain('has-actions');
  });

  it('an episode row: the show title links to the job with the file name on hover, then code, library, workflow and state; no file name', async () => {
    const ep = {
      ...fx.replaced,
      id: 'j-bh17',
      media: {
        ...fx.replaced.media,
        title: 'The Bramblewood Family',
        season: 1,
        episode: 17,
        episodeTitle: "Ada's Dilemma",
      },
      fileName: 'The.Bramblewood.Family.S01E17.mkv',
    };
    withJobs([ep, fx.queued]);
    await renderPage();
    const row = rowOf(ep);
    const link = within(row).getByRole('link', { name: 'The Bramblewood Family S01E17' });
    expect(link.textContent).toBe('The Bramblewood Family');
    expect(link.getAttribute('href')).toBe('/jobs/j-bh17');
    expect(link.getAttribute('title')).toBe(ep.fileName);
    const code = within(row).getByText('S01E17');
    expect(code.closest('.job-title-sub')?.textContent).toBe("S01E17 · Ada's Dilemma");
    expect(within(row).getByText('Shows')).toBeTruthy();
    expect(within(row).getByText('TV cleanup v7')).toBeTruthy();
    expect(row.querySelector('.job-chip')?.textContent).toBe('Replaced');
    expect(within(row).queryByText(ep.fileName)).toBeNull();
    expect(row.textContent).not.toContain(ep.fileName);
    expect(within(rowOf(fx.queued)).getByText('S02E07')).toBeTruthy();
  });

  it('a movie row shows its year under the title; a row with no match has no sub line', async () => {
    const unknown = {
      ...fx.noop,
      id: 'j-home',
      media: {
        kind: 'unknown' as const,
        title: 'Lake trip',
        year: null,
        season: null,
        episode: null,
        episodeTitle: null,
        source: 'filename' as const,
        poster: false,
      },
      fileName: 'Lake trip.mkv',
    };
    withJobs([fx.kept, unknown]);
    await renderPage();
    const movie = rowOf(fx.kept);
    expect(within(movie).getByRole('link', { name: 'Nosferatu (1922)' }).textContent).toBe(
      'Nosferatu',
    );
    expect(movie.querySelector('.job-title-sub')?.textContent).toBe('1922');
    const none = rowOf(unknown);
    expect(within(none).getByRole('link', { name: 'Lake trip' })).toBeTruthy();
    expect(none.querySelector('.job-title-sub')).toBeNull();
  });

  it('every row has a poster box; a job with a poster shows its thumbnail', async () => {
    const withPoster = { ...fx.kept, media: { ...fx.kept.media, poster: true } };
    withJobs([withPoster]);
    await renderPage();
    const img = rowOf(withPoster).querySelector('.poster-row img');
    expect(img?.getAttribute('src')).toBe(`/api/v1/jobs/${fx.kept.id}/poster`);
    expect(rowOf(fx.replaced).querySelector('.poster-row.poster-empty')).not.toBeNull();
  });

  it('a kept original with both sizes: the reason first, the sizes under it, no change line', async () => {
    const kept = {
      ...fx.kept,
      result: {
        outcome: 'kept_original' as const,
        beforeBytes: 2_000_000_000,
        afterBytes: 1_880_000_000,
        replacedTo: null,
        sourceDamaged: false,
      },
    };
    withJobs([kept]);
    await renderPage();
    const cell = rowOf(kept).querySelector('td.job-outcome') as HTMLElement;
    const reason = within(cell).getByText('Only 6% smaller, size gate needs 20%');
    expect(reason.classList.contains('is-kept')).toBe(true);
    const lines = [...cell.children].map((c) => c.textContent);
    expect(lines).toEqual(['Only 6% smaller, size gate needs 20%', '2.00 GB → 1.88 GB']);
    expect(cell.textContent).not.toContain('saved');
  });

  it('a replaced job shows its sizes, then the saving in the accent; one that grew in muted; no recycle folder note', async () => {
    const grew = {
      ...fx.replaced,
      id: 'j-grew',
      media: { ...fx.replaced.media, episode: 9 },
      result: {
        outcome: 'done' as const,
        beforeBytes: 1_000_000_000,
        afterBytes: 1_047_000_000,
        replacedTo: 'recycle' as const,
        sourceDamaged: false,
      },
    };
    withJobs([grew]);
    await renderPage();
    const cell = rowOf(fx.replaced).querySelector('td.job-outcome') as HTMLElement;
    expect([...cell.children].map((c) => c.textContent)).toEqual([
      '2.41 GB → 1.62 GB',
      'saved 33% · 790 MB',
    ]);
    expect(within(cell).getByText('saved 33% · 790 MB').classList.contains('is-saved')).toBe(true);
    expect(cell.textContent).not.toContain('original in recycle folder');
    const grewChange = within(rowOf(grew)).getByText('grew 4.7% · 47.0 MB');
    expect(grewChange.classList.contains('is-grew')).toBe(true);
  });

  it('a failed job shows its reason in the failed colour with the whole text on hover', async () => {
    await renderPage();
    const text = 'Verification failed: output 4 s shorter · original untouched';
    const detail = within(rowOf(fx.failed)).getByText(text);
    expect(detail.classList.contains('is-failed')).toBe(true);
    expect(detail.getAttribute('title')).toBe(text);
  });

  it('a row has no run link; the job page links to the run', async () => {
    await renderPage();
    for (const j of ALL_JOBS) {
      expect(within(rowOf(j)).queryByRole('link', { name: /^Run summary/ })).toBeNull();
      expect(rowOf(j).querySelector('a[href^="/runs/"]')).toBeNull();
    }
  });

  it('a failed pause names the job by its title', async () => {
    mocks.pause.mockRejectedValueOnce(new Error('nope'));
    await renderPage();
    fireEvent.click(
      within(rowOf(fx.running)).getByRole('button', { name: 'Pause Maple Lane S01E04' }),
    );
    expect(await screen.findByText("Couldn't pause Maple Lane S01E04")).toBeTruthy();
  });

  it('a button in a row does not open the job', async () => {
    const view = await renderPage();
    fireEvent.click(
      within(rowOf(fx.queued)).getByRole('button', { name: 'Pause Starfall S02E07' }),
    );
    await waitFor(() => expect(mocks.pause).toHaveBeenCalledWith({ id: 'j-starfall' }));
    fireEvent.click(
      within(rowOf(fx.queued)).getByRole('button', { name: 'Cancel Starfall S02E07' }),
    );
    expect(await screen.findByRole('dialog', { name: 'Cancel Starfall S02E07?' })).toBeTruthy();
    expect(view.location()).toBe('/jobs');
  });

  it('a 200-character title sits in the one-line, ellipsized title text', async () => {
    const long = 'A'.repeat(200);
    const job = { ...fx.kept, id: 'j-long', media: { ...fx.kept.media, title: long, year: null } };
    withJobs([job]);
    await renderPage();
    const text = within(rowOf(job)).getByText(long);
    expect(text.closest('.job-title-text')).not.toBeNull();
  });
});
