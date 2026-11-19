import { ORPCError } from '@orpc/client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { EngineEvent, LibraryFileDetail } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route } from 'wouter';

const mocks = vi.hoisted(() => ({
  libraries: { file: vi.fn(), get: vi.fn() },
  workflows: { list: vi.fn() },
  jobs: { queueFilesPreview: vi.fn(), queueFiles: vi.fn() },
  events: { subscribe: vi.fn() },
  queue: { status: vi.fn() },
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { EventsProvider } from '../hooks/useEvents.ts';
import { REFETCH_COALESCE_MS } from '../hooks/useRefetchOn.ts';
import { fakeEventSource, jobChanged, queueSnapshot } from '../test/fakeEventStream.ts';
import { fx, job } from '../test/fixtures/jobs.ts';
import { renderAt } from '../test/render.tsx';
import { LibraryFilePage } from './LibraryFilePage.tsx';

const at = '2026-10-16T18:00:00.000Z';
/** Whatever the server sends: the page links to it as it is. */
const SHOW_KEY = 'key-from-the-server';

const EPISODE = {
  ...fx.replaced.media,
  kind: 'episode' as const,
  title: 'The Beverly Hillbillies',
  year: null,
  season: 1,
  episode: 2,
  episodeTitle: 'Jed Buys Stock',
};

const probeOf = (container: string, seconds: number, codec: string, sizeBytes: number) => ({
  container,
  durationSeconds: seconds,
  sizeBytes,
  bitrateKbps: null,
  streams: [
    {
      index: 0,
      type: 'video' as const,
      codec,
      language: null,
      title: null,
      default: true,
      forced: false,
      attachedPic: false,
      dispositions: [],
      width: 1920,
      height: 1080,
      profile: null,
      level: null,
      pixelFormat: null,
      bitDepth: null,
      hdr: null,
      channels: null,
      sampleRate: null,
      bitrateKbps: null,
      frameRate: null,
      tagBitrateKbps: null,
    },
    {
      index: 1,
      type: 'audio' as const,
      codec: 'aac',
      language: 'eng',
      title: null,
      default: true,
      forced: false,
      attachedPic: false,
      dispositions: [],
      width: null,
      height: null,
      profile: null,
      level: null,
      pixelFormat: null,
      bitDepth: null,
      hdr: null,
      channels: 6,
      sampleRate: null,
      bitrateKbps: null,
      frameRate: null,
      tagBitrateKbps: null,
    },
  ],
});

const latest = job({ id: 'j3', media: EPISODE, libraryId: 'l1', libraryName: 'Classic TV' });
const detail = (over: Partial<LibraryFileDetail> = {}): LibraryFileDetail => ({
  file: {
    id: 'f1',
    path: '/media/classic-tv/The Beverly Hillbillies S01E02.mkv',
    fileName: 'The Beverly Hillbillies S01E02.mkv',
    sizeBytes: 700_000_000,
    originalBytes: null,
    mtime: at,
    gone: false,
    poster: { id: 'j3', media: EPISODE },
    latest,
  },
  showKey: SHOW_KEY,
  season: 1,
  now: probeOf('mkv', 5520, 'hevc', 700_000_000),
  before: null,
  jobs: [
    latest,
    job({ id: 'j2', media: EPISODE, state: 'failed', finishedAt: '2026-10-15T18:00:00.000Z' }),
    job({ id: 'j1', media: EPISODE, state: 'done', finishedAt: '2026-10-14T18:00:00.000Z' }),
  ],
  jobsTotal: 3,
  ...over,
});

let fake: ReturnType<typeof fakeEventSource>;
const realMatchMedia = window.matchMedia;

beforeEach(() => {
  fake = fakeEventSource();
  mocks.events.subscribe.mockReset().mockImplementation(fake.subscribe);
  mocks.libraries.file.mockReset().mockResolvedValue(detail());
  mocks.libraries.get.mockReset().mockResolvedValue({
    id: 'l1',
    name: 'Classic TV',
    path: '/media/classic-tv',
    recycleFolder: null,
    processHardlinked: false,
    verifyFullDecode: false,
    runHours: null,
    watchFolder: true,
    feeds: null,
    namedByInactive: [],
    createdAt: at,
    updatedAt: at,
    clock: { now: at, timeZone: 'UTC' },
  });
  mocks.workflows.list.mockReset().mockResolvedValue({
    workflows: [
      {
        id: 'w1',
        name: 'TV cleanup',
        kind: 'workflow',
        active: { version: 2, runnable: true, activatedAt: at, activatedBy: 'u1' },
        currentVersion: 3,
      },
    ],
  });
  mocks.jobs.queueFilesPreview.mockReset().mockResolvedValue({
    willRun: 1,
    alreadyHandled: 0,
    heldByAnotherRun: 0,
    notFound: 0,
    skipped: 0,
    workflowVersion: 2,
    dryRun: false,
  });
  mocks.queue.status.mockReset().mockResolvedValue({ paused: false, lanes: {}, encodeSlots: 1 });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.matchMedia = realMatchMedia;
});

async function renderPage() {
  const view = renderAt(
    '/libraries/l1/files/f1',
    <EventsProvider>
      <Route path="/libraries/:id/files/:fileId">
        <LibraryFilePage />
      </Route>
    </EventsProvider>,
  );
  await screen.findByRole('heading', { level: 1 });
  return view;
}

const fact = (term: string) => {
  const dt = screen.getAllByText(term, { selector: 'dt' })[0] as HTMLElement;
  return dt.parentElement as HTMLElement;
};

function stubPhone() {
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
}

describe('LibraryFilePage', () => {
  it('the file page runs one file', async () => {
    await renderPage();
    const open = await screen.findByRole('button', { name: 'Run a workflow' });
    await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(open);
    expect(await screen.findByRole('dialog', { name: 'Run a workflow on 1 file' })).toBeTruthy();
    await waitFor(() =>
      expect(mocks.jobs.queueFilesPreview).toHaveBeenCalledWith(
        expect.objectContaining({ libraryId: 'l1', fileIds: ['f1'] }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(open);
  });

  it('a phone still has Run a workflow', async () => {
    stubPhone();
    await renderPage();
    expect(await screen.findByRole('button', { name: 'Run a workflow' })).toBeTruthy();
  });

  it('a file no longer on disk has no Run a workflow', async () => {
    mocks.libraries.file.mockResolvedValue(detail({ file: { ...detail().file, gone: true } }));
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Run a workflow' })).toBeNull();
  });

  it('on a phone the jobs are cards linking to their job pages, not a table', async () => {
    stubPhone();
    await renderPage();
    expect(screen.queryByRole('table')).toBeNull();
    const cards = screen.getByRole('region', { name: 'Jobs on this file' });
    expect(
      within(cards)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/jobs/j3', '/jobs/j2', '/jobs/j1']);
  });

  it('a movie shows its year once', async () => {
    const movie = job({
      id: 'j9',
      libraryName: 'Classic TV',
      media: {
        ...EPISODE,
        kind: 'movie',
        title: 'Night of the Living Dead',
        year: 1968,
        season: null,
        episode: null,
        episodeTitle: null,
      },
    });
    mocks.libraries.file.mockResolvedValue(
      detail({
        file: { ...detail().file, latest: movie, poster: { id: 'j9', media: movie.media } },
        showKey: null,
        season: null,
        jobs: [movie],
        jobsTotal: 1,
      }),
    );
    const { container } = await renderPage();
    const head = container.querySelector('.job-head') as HTMLElement;
    expect(within(head).getAllByText('1968')).toHaveLength(1);
  });

  it('a file with no probe of what it is now says so instead of showing tracks', async () => {
    mocks.libraries.file.mockResolvedValue(detail({ now: null }));
    await renderPage();
    expect(within(fact('Tracks')).getByText('Not probed yet')).toBeTruthy();
    expect(screen.queryByText('Container', { selector: 'dt' })).toBeNull();
    expect(screen.queryByText('Video', { selector: 'dt' })).toBeNull();
    expect(within(fact('Size')).getByText('700 MB')).toBeTruthy();
  });

  it('refetches on a state change of a job of the library, not on a progress tick', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await renderPage();
      await waitFor(() => expect(fake.streams.length).toBeGreaterThan(0));
      const push = (e: EngineEvent) => act(async () => fake.last().push(e));
      await push(queueSnapshot);
      await push(jobChanged('j9'));
      await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));
      const calls = mocks.libraries.file.mock.calls.length;
      for (const percent of [10, 20]) {
        await push({ ...jobChanged('j9'), progress: { percent } } as EngineEvent);
        await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));
      }
      expect(mocks.libraries.file).toHaveBeenCalledTimes(calls);
      await push({ ...jobChanged('j9'), state: 'done' } as EngineEvent);
      await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));
      await waitFor(() => expect(mocks.libraries.file).toHaveBeenCalledTimes(calls + 1));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a gone file wears a badge with an icon and the words', async () => {
    mocks.libraries.file.mockResolvedValue(
      detail({ file: { ...detail().file, gone: true }, now: null }),
    );
    const { container } = await renderPage();
    const chip = container.querySelector('.chip') as HTMLElement;
    expect(chip.textContent).toBe('No longer on disk');
    expect(chip.querySelector('svg')).toBeTruthy();
  });

  it('shows poster, title, path, size and the probe facts', async () => {
    const { container } = await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'The Beverly Hillbillies' })).toBeTruthy();
    const head = container.querySelector('.job-head') as HTMLElement;
    expect(within(head).getByText('S01E02', { selector: 'b' })).toBeTruthy();
    expect(within(head).getByText(/Jed Buys Stock/)).toBeTruthy();
    expect(screen.getByText('/media/classic-tv/The Beverly Hillbillies S01E02.mkv')).toBeTruthy();
    expect(container.querySelector('.poster-page')).toBeTruthy();
    expect(within(fact('Size')).getByText('700 MB')).toBeTruthy();
    expect(within(fact('Container')).getByText('mkv')).toBeTruthy();
    expect(within(fact('Length')).getByText('1 h 32 min')).toBeTruthy();
    expect(within(fact('Video')).getByText('HEVC 1920×1080')).toBeTruthy();
    expect(within(fact('Audio')).getByText('English · AAC 5.1 (default)')).toBeTruthy();
    expect(screen.getByText('Changed', { selector: 'dt' })).toBeTruthy();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Libraries' }).getAttribute('href')).toBe(
      '/libraries',
    );
    expect(within(crumbs).getByRole('link', { name: 'Classic TV' }).getAttribute('href')).toBe(
      '/libraries/l1',
    );
    expect(
      within(crumbs).getByRole('link', { name: 'The Beverly Hillbillies' }).getAttribute('href'),
    ).toBe(`/libraries/l1/shows/${SHOW_KEY}`);
    expect(within(crumbs).getByRole('link', { name: 'Season 1' }).getAttribute('href')).toBe(
      `/libraries/l1/shows/${SHOW_KEY}/seasons/1`,
    );
  });

  it('a movie has only the library in its breadcrumbs', async () => {
    const movie = job({
      id: 'j9',
      libraryName: 'Classic TV',
      media: {
        ...EPISODE,
        kind: 'movie',
        title: 'Night of the Living Dead',
        year: 1968,
        season: null,
        episode: null,
        episodeTitle: null,
      },
    });
    mocks.libraries.file.mockResolvedValue(
      detail({
        file: { ...detail().file, latest: movie, poster: { id: 'j9', media: movie.media } },
        showKey: null,
        season: null,
        jobs: [movie],
        jobsTotal: 1,
      }),
    );
    await renderPage();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(
      within(crumbs)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Libraries', 'Classic TV']);
  });

  it('breadcrumbs whose labels repeat each keep their own entry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const same = job({ id: 'j9', libraryName: 'Libraries', media: EPISODE });
    mocks.libraries.file.mockResolvedValue(
      detail({
        file: { ...detail().file, latest: same },
        showKey: null,
        season: null,
        jobs: [same],
        jobsTotal: 1,
      }),
    );
    await renderPage();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(
      within(crumbs)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/libraries', '/libraries/l1']);
    expect(error).not.toHaveBeenCalled();
  });

  it('takes title and page title from the stored media the poster comes from, not the latest job', async () => {
    // The latest job has no media of its own: its row carries the file name's guess.
    const bare = job({
      id: 'j8',
      libraryName: 'Classic TV',
      media: { ...EPISODE, title: 'S01E02 guess', episodeTitle: null, source: 'filename' },
    });
    mocks.libraries.file.mockResolvedValue(
      detail({ file: { ...detail().file, latest: bare }, jobs: [bare], jobsTotal: 1 }),
    );
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'The Beverly Hillbillies' })).toBeTruthy();
    expect(document.title).toContain('The Beverly Hillbillies S01E02');
  });

  it('falls back to the file name when no job has stored media', async () => {
    mocks.libraries.file.mockResolvedValue(
      detail({ file: { ...detail().file, poster: null }, showKey: null, season: null }),
    );
    await renderPage();
    expect(
      screen.getByRole('heading', { level: 1, name: 'The Beverly Hillbillies S01E02.mkv' }),
    ).toBeTruthy();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getAllByRole('link')).toHaveLength(2);
  });

  it('a replaced file shows its size now and what it was', async () => {
    mocks.libraries.file.mockResolvedValue(
      detail({
        file: { ...detail().file, originalBytes: 1_000_000_000 },
        before: probeOf('mp4', 5500, 'h264', 1_000_000_000),
      }),
    );
    await renderPage();
    expect(within(fact('Size')).getByText('700 MB')).toBeTruthy();
    expect(screen.getByText('was 1.00 GB')).toBeTruthy();
  });

  it('shows a Before disclosure with the original facts when the file was replaced', async () => {
    mocks.libraries.file.mockResolvedValue(
      detail({
        file: { ...detail().file, originalBytes: 1_000_000_000 },
        before: probeOf('mp4', 5500, 'h264', 1_000_000_000),
      }),
    );
    await renderPage();
    const toggle = screen.getByRole('button', { name: /Before/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('H.264 1920×1080')).toBeTruthy();
    expect(screen.getByText('mp4')).toBeTruthy();
    expect(screen.getByText('1 h 31 min')).toBeTruthy();
  });

  it('without before, no Before disclosure is shown', async () => {
    await renderPage();
    expect(screen.queryByRole('button', { name: /Before/ })).toBeNull();
    expect(screen.queryByText(/^was /)).toBeNull();
  });

  it('lists every job newest first, each linking to its job page', async () => {
    await renderPage();
    const table = screen.getByRole('table', { name: 'Jobs on this file' });
    const hrefs = within(table)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/jobs/j3', '/jobs/j2', '/jobs/j1']);
    expect(mocks.libraries.file).toHaveBeenCalledWith({
      id: 'l1',
      fileId: 'f1',
      jobsOffset: 0,
      jobsLimit: 50,
    });
    expect(screen.queryByRole('button', { name: 'Show older jobs' })).toBeNull();
  });

  it('Show older jobs asks for the next page', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => job({ id: `n${i}`, media: EPISODE }));
    const page2 = [job({ id: 'old1', media: EPISODE })];
    mocks.libraries.file.mockImplementation(({ jobsOffset }: { jobsOffset: number }) =>
      Promise.resolve(detail({ jobs: jobsOffset === 0 ? page1 : page2, jobsTotal: 51 })),
    );
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Show older jobs' }));
    await waitFor(() =>
      expect(mocks.libraries.file).toHaveBeenLastCalledWith({
        id: 'l1',
        fileId: 'f1',
        jobsOffset: 50,
        jobsLimit: 50,
      }),
    );
    await waitFor(() => {
      const table = screen.getByRole('table', { name: 'Jobs on this file' });
      expect(within(table).getAllByRole('link')).toHaveLength(51);
    });
    expect(
      within(screen.getByRole('table', { name: 'Jobs on this file' }))
        .getAllByRole('link')
        .at(-1)
        ?.getAttribute('href'),
    ).toBe('/jobs/old1');
    expect(screen.queryByRole('button', { name: 'Show older jobs' })).toBeNull();
  });

  it('a job arriving between older pages leaves none missing and none doubled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      // 101 jobs, newest first, served by offset like the server does.
      let all = Array.from({ length: 101 }, (_, i) => job({ id: `a${i + 1}`, media: EPISODE }));
      mocks.libraries.file.mockImplementation(
        ({ jobsOffset, jobsLimit }: { jobsOffset: number; jobsLimit: number }) =>
          Promise.resolve(
            detail({
              jobs: all.slice(jobsOffset, jobsOffset + jobsLimit),
              jobsTotal: all.length,
            }),
          ),
      );
      await renderPage();
      const table = () => screen.getByRole('table', { name: 'Jobs on this file' });
      const hrefs = () =>
        within(table())
          .getAllByRole('link')
          .map((a) => a.getAttribute('href'));
      fireEvent.click(await screen.findByRole('button', { name: 'Show older jobs' }));
      await waitFor(() => expect(hrefs()).toHaveLength(100));

      // A job arrives; the refreshed head shifts everything down by one.
      all = [job({ id: 'new', media: EPISODE }), ...all];
      await waitFor(() => expect(fake.streams.length).toBeGreaterThan(0));
      await act(async () => fake.last().push(queueSnapshot));
      await act(async () => fake.last().push(jobChanged('new')));
      await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS * 2));
      await waitFor(() => expect(hrefs()[0]).toBe('/jobs/new'));

      // Read on until the button goes away.
      for (let i = 0; i < 3; i++) {
        const more = screen.queryByRole('button', { name: 'Show older jobs' });
        if (!more) break;
        const before = hrefs().length;
        fireEvent.click(more);
        await waitFor(() => expect(hrefs().length).toBeGreaterThan(before));
      }
      const links = hrefs();
      expect(links).toEqual(all.map((j) => `/jobs/${j.id}`));
      expect(screen.queryByRole('button', { name: 'Show older jobs' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a gone file opens with No longer on disk', async () => {
    mocks.libraries.file.mockResolvedValue(
      detail({ file: { ...detail().file, gone: true }, now: null }),
    );
    await renderPage();
    expect(screen.getByText('No longer on disk')).toBeTruthy();
  });

  it('an unknown file shows NotFound', async () => {
    mocks.libraries.file.mockRejectedValue(new ORPCError('NOT_FOUND', { message: 'no such file' }));
    renderAt(
      '/libraries/l1/files/nope',
      <EventsProvider>
        <Route path="/libraries/:id/files/:fileId">
          <LibraryFilePage />
        </Route>
      </EventsProvider>,
    );
    expect(await screen.findByText('File not found')).toBeTruthy();
  });
});
