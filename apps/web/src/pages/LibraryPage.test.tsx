import { ORPCError } from '@orpc/client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { EngineEvent, Library, LibraryFilesOutput } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route } from 'wouter';

const mocks = vi.hoisted(() => ({
  libraries: { get: vi.fn(), titles: vi.fn(), seasons: vi.fn(), files: vi.fn() },
  workflows: { list: vi.fn(), get: vi.fn() },
  jobs: { queue: vi.fn() },
  events: { subscribe: vi.fn() },
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { EventsProvider } from '../hooks/useEvents.ts';
import { REFETCH_COALESCE_MS } from '../hooks/useRefetchOn.ts';
import { LIBRARY_VIEW_KEY } from '../libraries/viewPref.ts';
import { fakeEventSource, jobChanged, queueSnapshot } from '../test/fakeEventStream.ts';
import { renderAt } from '../test/render.tsx';
import { LibraryPage } from './LibraryPage.tsx';

const at = '2026-10-16T18:00:00.000Z';
const LIBRARY: Library = {
  id: 'l1',
  name: 'Classic TV',
  path: '/media/classic-tv',
  recycleFolder: null,
  processHardlinked: false,
  verifyFullDecode: false,
  runHours: null,
  watchFolder: true,
  feeds: { workflowId: 'w1', name: 'TV cleanup', version: 3 },
  namedByInactive: [],
  createdAt: at,
  updatedAt: at,
};
/** The key the server gives a show: base64url of [title, year]. */
const SHOW_KEY = 'WyJUaGUgQmV2ZXJseSBIaWxsYmlsbGllcyIsMTk2Ml0';
const CLOCK = { now: '2026-10-16T03:00:00.000Z', timeZone: 'America/New_York' };
const TITLES = { items: [], total: 0 };
const files = (total: number): LibraryFilesOutput => ({ files: [], total });

let fake: ReturnType<typeof fakeEventSource>;
const realMatchMedia = window.matchMedia;

beforeEach(() => {
  localStorage.clear();
  fake = fakeEventSource();
  mocks.events.subscribe.mockReset().mockImplementation(fake.subscribe);
  mocks.libraries.get.mockReset().mockResolvedValue({ ...LIBRARY, clock: CLOCK });
  mocks.libraries.titles.mockReset().mockResolvedValue(TITLES);
  mocks.libraries.seasons
    .mockReset()
    .mockResolvedValue({ title: 'The Beverly Hillbillies', year: 1962, seasons: [] });
  mocks.libraries.files.mockReset().mockResolvedValue(files(4214));
  mocks.workflows.list.mockReset().mockResolvedValue({ workflows: [] });
  mocks.workflows.get.mockReset().mockResolvedValue({ activeIssues: [] });
  mocks.jobs.queue.mockReset().mockResolvedValue({ runId: 'r9' });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.matchMedia = realMatchMedia;
});

function page() {
  return (
    <EventsProvider>
      <Route path="/libraries/:id">
        <LibraryPage />
      </Route>
      <Route path="/libraries/:id/shows/:show">
        <LibraryPage />
      </Route>
      <Route path="/libraries/:id/shows/:show/seasons/:season">
        <LibraryPage />
      </Route>
    </EventsProvider>
  );
}

async function renderPage(path = '/libraries/l1') {
  const view = renderAt(path, page());
  await screen.findByRole('heading', { level: 1, name: 'Classic TV' });
  await waitFor(() => expect(fake.streams.length).toBeGreaterThan(0));
  return view;
}

async function push(e: EngineEvent) {
  await act(async () => fake.last().push(e));
}

describe('LibraryPage', () => {
  it('shows the header: name, path, file count and Scan now', async () => {
    await renderPage();
    expect(screen.getByText('/media/classic-tv')).toBeTruthy();
    expect(await screen.findByText('4,214 files')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Scan now' })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search this library' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'View' })).toBeTruthy();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Libraries' }).getAttribute('href')).toBe(
      '/libraries',
    );
    expect(within(crumbs).getByText('Classic TV')).toBeTruthy();
    expect(mocks.libraries.files).toHaveBeenCalledWith(expect.objectContaining({ id: 'l1' }));
    // No show in the route: no seasons request.
    expect(mocks.libraries.seasons).not.toHaveBeenCalled();
  });

  it('Scan now asks first, then queues the scan and opens the run', async () => {
    const view = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Scan now' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Scan Classic TV now?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Scan now' }));
    await waitFor(() =>
      expect(mocks.jobs.queue).toHaveBeenCalledWith({ path: '/media/classic-tv', dryRun: false }),
    );
    await waitFor(() => expect(view.location()).toBe('/runs/r9'));
  });

  it('renders posters by default and the table after switching; the choice survives a remount', async () => {
    const first = await renderPage();
    expect(screen.getByRole('region', { name: 'Titles' })).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Files' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(await screen.findByRole('table', { name: 'Files' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Titles' })).toBeNull();
    expect(localStorage.getItem(LIBRARY_VIEW_KEY)).toBe('table');
    first.unmount();
    await renderPage();
    expect(await screen.findByRole('table', { name: 'Files' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Titles' })).toBeNull();
  });

  it('renders posters when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    await renderPage();
    expect(screen.getByRole('region', { name: 'Titles' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(await screen.findByRole('table', { name: 'Files' })).toBeTruthy();
  });

  it('search sends the query to the server after typing stops', async () => {
    await renderPage();
    const box = screen.getByRole('searchbox', { name: 'Search this library' });
    fireEvent.change(box, { target: { value: 'bev' } });
    fireEvent.change(box, { target: { value: 'beverly' } });
    // Nothing is sent while the box is still changing.
    expect(mocks.libraries.titles).not.toHaveBeenCalledWith(
      expect.objectContaining({ search: 'bev' }),
    );
    await waitFor(() =>
      expect(mocks.libraries.titles).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'l1', search: 'beverly', offset: 0 }),
      ),
    );
  });

  it('refetches on a job.changed of this library and not of another', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await renderPage();
    // The first connect reloads the list once (the page was fetched before the stream was up).
    await push(queueSnapshot);
    await waitFor(() => expect(mocks.libraries.titles.mock.calls.length).toBeGreaterThan(1));
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS));
    const settled = mocks.libraries.titles.mock.calls.length;

    await push(jobChanged('j1'));
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS));
    await waitFor(() => expect(mocks.libraries.titles).toHaveBeenCalledTimes(settled + 1));

    await push({ ...jobChanged('j2'), libraryId: 'l2' } as EngineEvent);
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));
    expect(mocks.libraries.titles).toHaveBeenCalledTimes(settled + 1);
  });

  it("Scan now words the run hours in the server's time zone, not the browser's", async () => {
    // The tests run in Asia/Kolkata. 03:00 UTC is 08:30 there (closed) and 23:00 in New York (open).
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(new Date(CLOCK.now));
    const night = [22, 23, 0, 1, 2, 3, 4, 5];
    mocks.libraries.get.mockResolvedValue({
      ...LIBRARY,
      runHours: { enabled: true, perDay: false, every: night, days: Array(7).fill(night) },
      clock: CLOCK,
    });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Scan now' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Its run hours are open now/)).toBeTruthy();
    expect(within(dialog).queryByText(/Its run hours are closed now/)).toBeNull();
  });

  it('says to scan when the library has no files', async () => {
    mocks.libraries.files.mockResolvedValue(files(0));
    await renderPage();
    expect(await screen.findByText('Scan now to list its files.')).toBeTruthy();
    expect(screen.getByText('0 files')).toBeTruthy();
  });

  it('an unknown library shows NotFound', async () => {
    mocks.libraries.get.mockRejectedValue(new ORPCError('NOT_FOUND', { defined: true }));
    renderAt('/libraries/nope', page());
    expect(await screen.findByRole('heading', { name: 'Library not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to libraries' }).getAttribute('href')).toBe(
      '/libraries',
    );
  });

  it('a show route has the show and season in the breadcrumb and asks for that show', async () => {
    renderAt('/libraries/l1/shows/WyJUaGUgQmV2ZXJseSBIaWxsYmlsbGllcyIsMTk2Ml0/seasons/2', page());
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await waitFor(() => expect(within(crumbs).getByText('Season 2')).toBeTruthy());
    const show = within(crumbs).getByRole('link', { name: 'The Beverly Hillbillies' });
    expect(show.getAttribute('href')).toBe(
      '/libraries/l1/shows/WyJUaGUgQmV2ZXJseSBIaWxsYmlsbGllcyIsMTk2Ml0',
    );
    expect(mocks.libraries.seasons).toHaveBeenCalledWith({
      id: 'l1',
      show: SHOW_KEY,
    });
    expect(await screen.findByRole('table', { name: 'Files' })).toBeTruthy();
    await waitFor(() =>
      expect(mocks.libraries.files).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'l1', show: SHOW_KEY, season: '2' }),
      ),
    );
  });
});
