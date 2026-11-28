import { ORPCError } from '@orpc/client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { EngineEvent, Library, LibraryFilesOutput } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route } from 'wouter';

const mocks = vi.hoisted(() => ({
  libraries: { get: vi.fn(), titles: vi.fn(), seasons: vi.fn(), files: vi.fn() },
  workflows: { list: vi.fn(), get: vi.fn() },
  jobs: { queue: vi.fn(), queueFilesPreview: vi.fn(), queueFiles: vi.fn() },
  events: { subscribe: vi.fn() },
  queue: { status: vi.fn() },
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { EventsProvider } from '../hooks/use-events.ts';
import { REFETCH_COALESCE_MS } from '../hooks/use-refetch-on.ts';
import { fakeEventSource, jobChanged, queueSnapshot } from '../testing/fake-event-stream.ts';
import { fx } from '../testing/fixtures/jobs.ts';
import { renderAt } from '../testing/render.tsx';
import { LibraryPage } from './LibraryPage.tsx';
import { LIBRARY_VIEW_KEY } from './view-pref.ts';

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
/** The page of a `total`-file listing that a files request asks for, each file titled by its index. */
function filesPage(q: { offset: number; limit: number }, total: number): LibraryFilesOutput {
  const n = Math.max(0, Math.min(q.limit, total - q.offset));
  return {
    files: Array.from({ length: n }, (_, i) => {
      const k = q.offset + i;
      return {
        id: `f${k}`,
        path: `/media/classic-tv/File ${k}.mkv`,
        fileName: `File ${k}.mkv`,
        sizeBytes: 1000,
        originalBytes: null,
        mtime: at,
        gone: false,
        poster: null,
        latest: { ...fx.kept, media: { ...fx.kept.media, title: `File ${k}` } },
      };
    }),
    total,
  };
}

let fake: ReturnType<typeof fakeEventSource>;
const realMatchMedia = window.matchMedia;

beforeEach(() => {
  localStorage.clear();
  fake = fakeEventSource();
  mocks.events.subscribe.mockReset().mockImplementation(fake.subscribe);
  mocks.libraries.get.mockReset().mockResolvedValue({ ...LIBRARY, clock: CLOCK, fileCount: 4214 });
  mocks.libraries.titles.mockReset().mockResolvedValue(TITLES);
  mocks.libraries.seasons
    .mockReset()
    .mockResolvedValue({ title: 'The Bramblewood Family', year: 1962, seasons: [] });
  mocks.libraries.files.mockReset().mockResolvedValue(files(7));
  mocks.workflows.list.mockReset().mockResolvedValue({ workflows: [] });
  mocks.workflows.get.mockReset().mockResolvedValue({ activeIssues: [] });
  mocks.queue.status.mockReset().mockResolvedValue({ paused: false, lanes: {}, encodeSlots: 1 });
  mocks.jobs.queue.mockReset().mockResolvedValue({ runId: 'r9' });
  mocks.jobs.queueFilesPreview.mockReset().mockResolvedValue({
    willRun: 2,
    alreadyHandled: 0,
    heldByAnotherRun: 0,
    notFound: 0,
    skipped: 0,
    workflowVersion: 2,
    dryRun: false,
  });
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
    // The count is the library's fileCount: the posters view asks for no file listing at all.
    expect(mocks.libraries.files).not.toHaveBeenCalled();
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
    expect(await screen.findByRole('region', { name: 'Titles' })).toBeTruthy();
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
    expect(await screen.findByRole('region', { name: 'Titles' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(await screen.findByRole('table', { name: 'Files' })).toBeTruthy();
  });

  it('search sends the query to the server after typing stops', async () => {
    await renderPage();
    const box = screen.getByRole('searchbox', { name: 'Search this library' });
    fireEvent.change(box, { target: { value: 'bev' } });
    fireEvent.change(box, { target: { value: 'bramble' } });
    // Nothing is sent while the box is still changing.
    expect(mocks.libraries.titles).not.toHaveBeenCalledWith(
      expect.objectContaining({ search: 'bev' }),
    );
    await waitFor(() =>
      expect(mocks.libraries.titles).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'l1', search: 'bramble', offset: 0 }),
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

  it('refetches on a library.changed of this library (media filled) and not of another', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await renderPage();
    await push(queueSnapshot);
    await waitFor(() => expect(mocks.libraries.titles.mock.calls.length).toBeGreaterThan(1));
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS));
    const settled = mocks.libraries.titles.mock.calls.length;

    await push({ type: 'library.changed', libraryId: 'l1' });
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS));
    await waitFor(() => expect(mocks.libraries.titles).toHaveBeenCalledTimes(settled + 1));

    await push({ type: 'library.changed', libraryId: 'l2' });
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));
    expect(mocks.libraries.titles).toHaveBeenCalledTimes(settled + 1);
  });

  it('a progress-only job.changed does not refetch; a state change does', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await renderPage();
    await push(queueSnapshot);
    await waitFor(() => expect(mocks.libraries.titles.mock.calls.length).toBeGreaterThan(1));
    await push(jobChanged('j1'));
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));
    const titles = mocks.libraries.titles.mock.calls.length;
    const gets = mocks.libraries.get.mock.calls.length;

    // The same job, same state, only its progress moves: one tick a second while it encodes.
    for (const percent of [10, 20, 30]) {
      await push({ ...jobChanged('j1'), progress: { percent } } as EngineEvent);
      await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));
    }
    expect(mocks.libraries.titles).toHaveBeenCalledTimes(titles);
    expect(mocks.libraries.get).toHaveBeenCalledTimes(gets);

    await push({ ...jobChanged('j1'), state: 'done' } as EngineEvent);
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));
    await waitFor(() => expect(mocks.libraries.titles).toHaveBeenCalledTimes(titles + 1));
    expect(mocks.libraries.get).toHaveBeenCalledTimes(gets + 1);
  });

  it('pausing or resuming a job refetches; progress while paused does not', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await renderPage();
    await push(queueSnapshot);
    await waitFor(() => expect(mocks.libraries.titles.mock.calls.length).toBeGreaterThan(1));
    await push(jobChanged('j1'));
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));
    const titles = mocks.libraries.titles.mock.calls.length;

    // Same state, now paused: the row's status changes.
    await push({ ...jobChanged('j1'), paused: true } as EngineEvent);
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));
    await waitFor(() => expect(mocks.libraries.titles).toHaveBeenCalledTimes(titles + 1));

    await push({ ...jobChanged('j1'), paused: true, progress: { percent: 40 } } as EngineEvent);
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));
    expect(mocks.libraries.titles).toHaveBeenCalledTimes(titles + 1);

    await push(jobChanged('j1'));
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));
    await waitFor(() => expect(mocks.libraries.titles).toHaveBeenCalledTimes(titles + 2));
  });

  it('the header count follows the library: it reloads on a state change', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await renderPage();
    expect(await screen.findByText('4,214 files')).toBeTruthy();
    await push(queueSnapshot);
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));
    mocks.libraries.get.mockResolvedValue({ ...LIBRARY, clock: CLOCK, fileCount: 4215 });
    await push({ ...jobChanged('j9'), state: 'queued' } as EngineEvent);
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));
    expect(await screen.findByText('4,215 files')).toBeTruthy();
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
      fileCount: 4214,
    });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Scan now' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Its run hours are open now/)).toBeTruthy();
    expect(within(dialog).queryByText(/Its run hours are closed now/)).toBeNull();
  });

  it('says to scan when the library has no files', async () => {
    mocks.libraries.get.mockResolvedValue({ ...LIBRARY, clock: CLOCK, fileCount: 0 });
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
    // The show title arrives with the seasons response, after the route's Season 2 crumb.
    const show = await within(crumbs).findByRole('link', { name: 'The Bramblewood Family' });
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

  it('table view sends sort and offset to libraries.files', async () => {
    const file = {
      id: 'f1',
      path: '/media/classic-tv/Nocturne of the Quiet Moon.mkv',
      fileName: 'Nocturne of the Quiet Moon.mkv',
      sizeBytes: 1000,
      originalBytes: null,
      mtime: at,
      gone: false,
      poster: null,
      latest: { ...fx.kept, media: { ...fx.kept.media, title: 'Nocturne of the Quiet Moon' } },
    };
    mocks.libraries.files.mockImplementation(async (q: { limit: number; offset: number }) => ({
      files: q.limit === 1 ? [] : [file],
      total: 250,
    }));
    await renderPage();
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    await screen.findByText('Nocturne of the Quiet Moon');
    expect(mocks.libraries.files).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'l1', sort: 'title', desc: false, offset: 0, limit: 100 }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Size' }));
    await waitFor(() =>
      expect(mocks.libraries.files).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: 'size', desc: false, offset: 0 }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(mocks.libraries.files).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: 'size', offset: 100 }),
      ),
    );
    // A new sort starts again at the first page.
    fireEvent.click(screen.getByRole('button', { name: 'Size' }));
    await waitFor(() =>
      expect(mocks.libraries.files).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: 'size', desc: true, offset: 0 }),
      ),
    );
    // So does a search, and the search stays applied.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(mocks.libraries.files).toHaveBeenLastCalledWith(
        expect.objectContaining({ offset: 100 }),
      ),
    );
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search this library' }), {
      target: { value: 'night' },
    });
    await waitFor(() =>
      expect(mocks.libraries.files).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'night', sort: 'size', desc: true, offset: 0 }),
      ),
    );
  });
  it('going back to an earlier sort or search starts at its first page, not the page left there', async () => {
    mocks.libraries.files.mockImplementation(async (q: { offset: number; limit: number }) =>
      filesPage(q, 250),
    );
    await renderPage();
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    await screen.findByText('1–100 of 250');
    fireEvent.click(screen.getByRole('button', { name: 'Size' }));
    await screen.findByText('1–100 of 250');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('101–200 of 250');
    // Size descending, then ascending again: the first page, not the second.
    fireEvent.click(screen.getByRole('button', { name: 'Size' }));
    await waitFor(() =>
      expect(mocks.libraries.files).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: 'size', desc: true, offset: 0 }),
      ),
    );
    await screen.findByText('1–100 of 250');
    fireEvent.click(screen.getByRole('button', { name: 'Size' }));
    await waitFor(() =>
      expect(mocks.libraries.files).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: 'size', desc: false, offset: 0 }),
      ),
    );
    expect(await screen.findByText('1–100 of 250')).toBeTruthy();

    // The same for a search typed and cleared.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('101–200 of 250');
    const box = screen.getByRole('searchbox', { name: 'Search this library' });
    fireEvent.change(box, { target: { value: 'night' } });
    await waitFor(() =>
      expect(mocks.libraries.files).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'night', offset: 0 }),
      ),
    );
    await screen.findByText('1–100 of 250');
    fireEvent.change(box, { target: { value: '' } });
    await waitFor(() =>
      expect(mocks.libraries.files.mock.lastCall?.[0]).not.toHaveProperty('search'),
    );
    expect(mocks.libraries.files).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }));
    expect(await screen.findByText('1–100 of 250')).toBeTruthy();
  });

  it('a refresh that shrinks the list below the shown page moves to its last page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let total = 250;
    mocks.libraries.files.mockImplementation(async (q: { offset: number; limit: number }) =>
      filesPage(q, total),
    );
    await renderPage();
    await push(queueSnapshot);
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    await screen.findByText('1–100 of 250');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('101–200 of 250');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('201–250 of 250');
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));

    total = 150;
    await push({ ...jobChanged('j1'), state: 'done' } as EngineEvent);
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));
    await waitFor(() =>
      expect(mocks.libraries.files).toHaveBeenLastCalledWith(
        expect.objectContaining({ offset: 100 }),
      ),
    );
    expect(await screen.findByText('101–150 of 150')).toBeTruthy();
  });

  it('the next page shows no rows of the last one while it loads, and no pager to skip it', async () => {
    let release: (() => void) | undefined;
    mocks.libraries.files.mockImplementation(async (q: { offset: number; limit: number }) => {
      if (q.offset > 0) await new Promise<void>((r) => (release = r));
      return filesPage(q, 250);
    });
    await renderPage();
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    await screen.findByText('1–100 of 250');
    expect(screen.getByRole('link', { name: /^File 0\b/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Loading files…')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^File 0\b/ })).toBeNull();
    expect(screen.queryByText('101–200 of 250')).toBeNull();
    // No pager while the page loads: a second Next cannot skip the page being asked for.
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    await waitFor(() => expect(release).toBeDefined());
    await act(async () => release?.());
    expect(await screen.findByText('101–200 of 250')).toBeTruthy();
    expect(screen.getByRole('link', { name: /^File 100\b/ })).toBeTruthy();
    expect(mocks.libraries.files).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 100 }),
    );
  });

  it('a live refresh of the same page keeps its rows while it reloads', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let hold = false;
    let release: (() => void) | undefined;
    mocks.libraries.files.mockImplementation(async (q: { offset: number; limit: number }) => {
      if (hold) await new Promise<void>((r) => (release = r));
      return filesPage(q, 250);
    });
    await renderPage();
    await push(queueSnapshot);
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    await screen.findByText('1–100 of 250');
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));
    hold = true;
    await push({ ...jobChanged('j1'), state: 'done' } as EngineEvent);
    await waitFor(() => expect(release).toBeDefined());
    expect(screen.getByRole('link', { name: /^File 0\b/ })).toBeTruthy();
    expect(screen.queryByText('Loading files…')).toBeNull();
    await act(async () => release?.());
  });

  it('a show route in Posters view asks for the show seasons and shows the season cards', async () => {
    mocks.libraries.seasons.mockResolvedValue({
      title: 'The Bramblewood Family',
      year: 1962,
      seasons: [
        {
          season: 1,
          episodes: 3,
          poster: null,
          outcomes: { replaced: 1, kept: 0, failed: 0, other: 0 },
          savedBytes: 400,
        },
      ],
    });
    renderAt(`/libraries/l1/shows/${SHOW_KEY}`, page());
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await waitFor(() => expect(within(crumbs).getByText('The Bramblewood Family')).toBeTruthy());
    expect(within(crumbs).getByRole('link', { name: 'Libraries' })).toBeTruthy();
    expect(mocks.libraries.seasons).toHaveBeenCalledWith({ id: 'l1', show: SHOW_KEY });
    const card = await screen.findByRole('link', { name: /Season 1/ });
    expect(card.getAttribute('href')).toBe(`/libraries/l1/shows/${SHOW_KEY}/seasons/1`);
  });

  it('a show page asks for its seasons once: the breadcrumbs and the cards share the answer', async () => {
    renderAt(`/libraries/l1/shows/${SHOW_KEY}`, page());
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await waitFor(() => expect(within(crumbs).getByText('The Bramblewood Family')).toBeTruthy());
    expect(await screen.findByRole('region', { name: 'Seasons' })).toBeTruthy();
    expect(mocks.libraries.seasons).toHaveBeenCalledTimes(1);
    expect(mocks.libraries.seasons).toHaveBeenCalledWith({ id: 'l1', show: SHOW_KEY });
  });

  it('a non-empty search on a show route lists the matching episodes, an empty one the seasons', async () => {
    mocks.libraries.seasons.mockResolvedValue({
      title: 'The Bramblewood Family',
      year: 1962,
      seasons: [
        {
          season: 1,
          episodes: 3,
          poster: null,
          outcomes: { replaced: 0, kept: 0, failed: 0, other: 0 },
          savedBytes: 0,
        },
      ],
    });
    renderAt(`/libraries/l1/shows/${SHOW_KEY}`, page());
    await screen.findByRole('link', { name: /Season 1/ });
    const box = screen.getByRole('searchbox', { name: 'Search this library' });
    fireEvent.change(box, { target: { value: 'oil' } });
    await waitFor(() =>
      expect(mocks.libraries.files).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'l1', show: SHOW_KEY, search: 'oil' }),
      ),
    );
    expect(mocks.libraries.files.mock.lastCall?.[0]).not.toHaveProperty('season');
    expect(await screen.findByRole('table', { name: 'Files' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Season 1/ })).toBeNull();
    fireEvent.change(box, { target: { value: '' } });
    expect(await screen.findByRole('link', { name: /Season 1/ })).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Files' })).toBeNull();
  });

  it('the season page has no view switch; the library and show pages do', async () => {
    renderAt(`/libraries/l1/shows/${SHOW_KEY}/seasons/1`, page());
    await screen.findByRole('table', { name: 'Files' });
    expect(screen.queryByRole('radiogroup', { name: 'View' })).toBeNull();
    cleanup();
    renderAt(`/libraries/l1/shows/${SHOW_KEY}`, page());
    expect(await screen.findByRole('radiogroup', { name: 'View' })).toBeTruthy();
    cleanup();
    renderAt('/libraries/l1', page());
    expect(await screen.findByRole('radiogroup', { name: 'View' })).toBeTruthy();
  });

  it('the season page lists its episodes and applies the search', async () => {
    renderAt(`/libraries/l1/shows/${SHOW_KEY}/seasons/1`, page());
    await screen.findByRole('table', { name: 'Files' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search this library' }), {
      target: { value: 'oil' },
    });
    await waitFor(() =>
      expect(mocks.libraries.files).toHaveBeenLastCalledWith(
        expect.objectContaining({ show: SHOW_KEY, season: '1', search: 'oil' }),
      ),
    );
  });

  it('Show more appends the next 60 titles while fewer than the total are shown', async () => {
    const movie = (n: number) => ({
      type: 'movie' as const,
      fileId: `f${n}`,
      poster: null,
      latest: {
        ...fx.kept,
        media: { ...fx.kept.media, title: `Film ${n}`, kind: 'movie' as const },
      },
    });
    const items = (from: number, n: number) => Array.from({ length: n }, (_, i) => movie(from + i));
    mocks.libraries.titles.mockImplementation(async (q: { offset: number }) => ({
      items: q.offset === 0 ? items(0, 60) : items(60, 40),
      total: 100,
    }));
    await renderPage();
    await screen.findByRole('link', { name: /Film 59/ });
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() =>
      expect(mocks.libraries.titles).toHaveBeenLastCalledWith(
        expect.objectContaining({ offset: 60, limit: 60 }),
      ),
    );
    expect(await screen.findByRole('link', { name: /Film 99/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Film 0 / })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('Show more shows a card that moved onto the next page once', async () => {
    const movie = (n: number) => ({
      type: 'movie' as const,
      fileId: `f${n}`,
      poster: null,
      latest: {
        ...fx.kept,
        media: { ...fx.kept.media, title: `Film ${n}`, kind: 'movie' as const },
      },
    });
    const items = (from: number, n: number) => Array.from({ length: n }, (_, i) => movie(from + i));
    // A title was added before Film 59 in between: the second page starts with Film 59 again.
    mocks.libraries.titles.mockImplementation(async (q: { offset: number }) => ({
      items: q.offset === 0 ? items(0, 60) : items(59, 41),
      total: 101,
    }));
    await renderPage();
    await screen.findByRole('link', { name: /Film 59/ });
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('link', { name: /Film 99/ })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /^Film 59\b/ })).toHaveLength(1);
    const grid = screen.getByRole('list', { name: 'Titles' });
    expect(within(grid).getAllByRole('listitem')).toHaveLength(100);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('a live refresh after Show more reloads every page shown; Show more alone asks for the next page only', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let rev = 1;
    const movie = (n: number) => ({
      type: 'movie' as const,
      fileId: `f${n}`,
      poster: null,
      latest: {
        ...fx.kept,
        media: { ...fx.kept.media, title: `Film ${n} rev ${rev}`, kind: 'movie' as const },
      },
    });
    const items = (from: number, n: number) => Array.from({ length: n }, (_, i) => movie(from + i));
    mocks.libraries.titles.mockImplementation(async (q: { offset: number }) => ({
      items: q.offset === 0 ? items(0, 60) : q.offset === 60 ? items(60, 60) : items(120, 30),
      total: 150,
    }));
    await renderPage();
    await push(queueSnapshot);
    await screen.findByRole('link', { name: /^Film 59 rev 1/ });
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));

    mocks.libraries.titles.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('link', { name: /^Film 119 rev 1/ })).toBeTruthy();
    expect(mocks.libraries.titles).toHaveBeenCalledTimes(1);
    expect(mocks.libraries.titles).toHaveBeenCalledWith(expect.objectContaining({ offset: 60 }));
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));

    mocks.libraries.titles.mockClear();
    rev = 2;
    await push({ ...jobChanged('j1'), state: 'done' } as EngineEvent);
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));
    expect(await screen.findByRole('link', { name: /^Film 0 rev 2/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Film 119 rev 2/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /rev 1/ })).toBeNull();
    const offsets = mocks.libraries.titles.mock.calls.map(
      ([q]) => (q as { offset: number }).offset,
    );
    expect(offsets.sort((x, y) => x - y)).toEqual([0, 60]);
    const grid = screen.getByRole('list', { name: 'Titles' });
    expect(within(grid).getAllByRole('listitem')).toHaveLength(120);
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
  });

  it('the search box takes at most 200 characters, the server’s limit', async () => {
    await renderPage();
    const box = screen.getByRole('searchbox', { name: 'Search this library' });
    expect(box.getAttribute('maxlength')).toBe('200');
  });
});

describe('LibraryPage selection and running', () => {
  const episode = (id: string, title: string) => ({
    id,
    path: `/media/classic-tv/${title}.mkv`,
    fileName: `${title}.mkv`,
    sizeBytes: 1000,
    originalBytes: null,
    mtime: at,
    gone: false,
    poster: null,
    latest: { ...fx.kept, media: { ...fx.kept.media, title } },
  });
  const RUNNABLE = {
    id: 'w1',
    name: 'TV cleanup',
    kind: 'workflow',
    active: { version: 2, runnable: true, activatedAt: at, activatedBy: 'u1' },
    currentVersion: 3,
  };

  beforeEach(() => {
    mocks.workflows.list.mockResolvedValue({ workflows: [RUNNABLE] });
    mocks.libraries.files.mockImplementation(async (q: { limit: number }) => ({
      files:
        q.limit === 1
          ? []
          : [episode('f1', 'Nocturne of the Quiet Moon'), episode('f2', 'Shepherd Jr.')],
      total: 2,
    }));
  });
  const stubPhone = () => {
    window.matchMedia = (query: string) =>
      ({
        matches: query === '(max-width: 639px)',
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  };

  async function selectBoth() {
    localStorage.setItem(LIBRARY_VIEW_KEY, 'table');
    await renderPage();
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Select Nocturne of the Quiet Moon.mkv' }),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Shepherd Jr..mkv' }));
  }

  it('a new search clears the selection', async () => {
    await selectBoth();
    expect(screen.getByText('2 selected')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search this library' }), {
      target: { value: 'night' },
    });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull());
    // The searched list's rows come with its answer: none of the last list's rows show meanwhile.
    expect(
      (await screen.findByRole('checkbox', {
        name: 'Select Shepherd Jr..mkv',
      })) as HTMLInputElement,
    ).toHaveProperty('checked', false);
  });

  it('switching to Posters clears the selection', async () => {
    await selectBoth();
    expect(screen.getByText('2 selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Posters' }));
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(
      (await screen.findByRole('checkbox', {
        name: 'Select Shepherd Jr..mkv',
      })) as HTMLInputElement,
    ).toHaveProperty('checked', false);
  });

  it('the selection bar comes after the files so it can stick to the bottom', async () => {
    await selectBoth();
    const bar = screen.getByRole('region', { name: 'Selection' });
    const table = screen.getByRole('table', { name: 'Files' });
    expect(table.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the selection survives a sort', async () => {
    await selectBoth();
    fireEvent.click(screen.getByRole('button', { name: 'Size' }));
    await waitFor(() =>
      expect(mocks.libraries.files).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: 'size' }),
      ),
    );
    expect(screen.getByText('2 selected')).toBeTruthy();
  });

  it('Run a workflow… opens the dialog for the selected files and focus returns to the button', async () => {
    await selectBoth();
    const open = screen.getByRole('button', { name: 'Run a workflow…' });
    open.focus();
    fireEvent.click(open);
    expect(await screen.findByRole('dialog', { name: 'Run a workflow on 2 files' })).toBeTruthy();
    await waitFor(() =>
      expect(mocks.jobs.queueFilesPreview).toHaveBeenCalledWith(
        expect.objectContaining({ libraryId: 'l1', fileIds: ['f1', 'f2'] }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(open);
  });

  it('the season page offers Run a workflow on this season with the show and season', async () => {
    await renderPageAt(`/libraries/l1/shows/${SHOW_KEY}/seasons/1`);
    fireEvent.click(screen.getByRole('button', { name: 'Run a workflow on this season' }));
    expect(
      await screen.findByRole('dialog', { name: 'Run a workflow on this season' }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(mocks.jobs.queueFilesPreview).toHaveBeenCalledWith(
        expect.objectContaining({ show: SHOW_KEY, season: '1' }),
      ),
    );
  });

  it('the show page offers Run a workflow on this show with the show only', async () => {
    await renderPageAt(`/libraries/l1/shows/${SHOW_KEY}`);
    fireEvent.click(screen.getByRole('button', { name: 'Run a workflow on this show' }));
    expect(await screen.findByRole('dialog', { name: 'Run a workflow on this show' })).toBeTruthy();
    await waitFor(() => expect(mocks.jobs.queueFilesPreview).toHaveBeenCalled());
    const sent = mocks.jobs.queueFilesPreview.mock.calls.at(-1)?.[0];
    expect(sent.show).toBe(SHOW_KEY);
    expect('season' in sent).toBe(false);
  });

  it('the library page has no run button for a whole library', async () => {
    await renderPage();
    expect(screen.queryByRole('button', { name: /Run a workflow on/ })).toBeNull();
  });

  it('on a phone the show and season pages have no Run a workflow button and no checkboxes', async () => {
    stubPhone();
    await renderPageAt(`/libraries/l1/shows/${SHOW_KEY}/seasons/1`);
    expect(screen.queryByRole('button', { name: /Run a workflow on/ })).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  async function renderPageAt(path: string) {
    renderAt(path, page());
    await screen.findByRole('heading', { level: 1, name: 'Classic TV' });
    await screen.findByRole('table', { name: 'Files' }).catch(() => null);
  }
});
