import { ORPCError } from '@orpc/client';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import type { EngineEvent, RunDetail } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route } from 'wouter';

const mocks = vi.hoisted(() => ({ get: vi.fn(), subscribe: vi.fn(), queueStatus: vi.fn() }));
vi.mock('../api/client.ts', () => ({
  api: {
    runs: { get: mocks.get },
    events: { subscribe: mocks.subscribe },
    queue: { status: mocks.queueStatus },
  },
  isDefinedError: (e: unknown) => typeof e === 'object' && e !== null && 'defined' in e,
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
import { fmtDate, fmtStamp } from '../lib/time.ts';
import { fakeEventSource, jobChanged, queueSnapshot } from '../test/fakeEventStream.ts';
import { renderAt } from '../test/render.tsx';
import { RunPage } from './RunPage.tsx';

const zero = {
  done: 0,
  nothing_to_do: 0,
  kept_original: 0,
  failed: 0,
  cancelled: 0,
  dry_run: 0,
  skipped: 0,
  already_processed: 0,
  queued: 0,
  in_progress: 0,
  total: 0,
  beforeBytes: 0,
  afterBytes: 0,
  dependsOnSize: 0,
};

function file(
  jobId: string,
  fileName: string,
  state: RunDetail['files'][number]['state'],
  extra: Partial<RunDetail['files'][number]> = {},
): RunDetail['files'][number] {
  return {
    jobId,
    fileName,
    filePath: `/transcode/shows/${fileName}`,
    state,
    reason: null,
    beforeBytes: null,
    afterBytes: null,
    replacedTo: null,
    workflowVersion: 7,
    estimatedBytes: null,
    planSummary: null,
    dependsOnSize: null,
    ...extra,
  };
}

/** Five files, one per trust class: replaced, kept, nothing to do, failed, skipped. */
function settledRun(): RunDetail {
  return {
    run: {
      id: 'r1',
      libraryId: 'l1',
      workflowId: 'w1',
      workflowVersion: 7,
      requestedPath: '/transcode/shows/Bluey',
      dryRun: false,
      testEncode: false,
      force: false,
      note: null,
      createdBy: 'u1',
      createdAt: '2026-10-16T18:00:00.000Z',
    },
    workflowName: 'TV cleanup',
    libraryName: 'Shows',
    counts: {
      ...zero,
      done: 1,
      kept_original: 1,
      nothing_to_do: 1,
      failed: 1,
      skipped: 1,
      total: 5,
      beforeBytes: 2_410_000_000,
      afterBytes: 1_620_000_000,
    },
    files: [
      file('j1', 'Bluey S01E01.mkv', 'done', {
        reason: 'Re-encoded to HEVC',
        beforeBytes: 2_410_000_000,
        afterBytes: 1_620_000_000,
        replacedTo: 'recycle',
      }),
      file('j2', 'Bluey S01E02.mkv', 'kept_original', {
        reason: 'Only 6% smaller, size gate needs 20%',
        beforeBytes: 1_000_000_000,
        afterBytes: 940_000_000,
      }),
      file('j3', 'Bluey S01E03.mkv', 'nothing_to_do', { reason: 'Already HEVC' }),
      file('j4', 'Bluey S01E04.mkv', 'failed', {
        reason: 'Verification failed: output 4 s shorter',
        beforeBytes: 800_000_000,
      }),
      file('j5', 'Bluey S01E05.mkv', 'skipped', { reason: 'Hardlinked by the torrent client' }),
    ],
  };
}

function liveRun(): RunDetail {
  const r = settledRun();
  return {
    ...r,
    counts: {
      ...zero,
      done: 1,
      queued: 3,
      in_progress: 1,
      total: 5,
      beforeBytes: 2_410_000_000,
      afterBytes: 1_620_000_000,
    },
    files: [
      r.files[0] as RunDetail['files'][number],
      file('j2', 'Bluey S01E02.mkv', 'encoding'),
      file('j3', 'Bluey S01E03.mkv', 'queued'),
      file('j4', 'Bluey S01E04.mkv', 'queued'),
      file('j5', 'Bluey S01E05.mkv', 'queued'),
    ],
  };
}

type JobChanged = Extract<EngineEvent, { type: 'job.changed' }>;

const page = () => <Route path="/runs/:id" component={RunPage} />;

let fake: ReturnType<typeof fakeEventSource>;
beforeEach(() => {
  fake = fakeEventSource();
  mocks.subscribe.mockReset().mockImplementation(fake.subscribe);
  mocks.get.mockReset();
  mocks.queueStatus
    .mockReset()
    .mockResolvedValue({ paused: false, lanes: { encode: null, quick: null } });
});
const realMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.matchMedia = realMatchMedia;
});

describe('RunPage', () => {
  it('leads with the saved total, then one tile per outcome that happened; no reconcile line', async () => {
    mocks.get.mockResolvedValue(settledRun());
    renderAt('/runs/r1', page());

    expect(await screen.findByRole('heading', { level: 1, name: 'TV cleanup v7' })).toBeTruthy();
    expect(mocks.get).toHaveBeenCalledWith({ id: 'r1' });
    // The muted subtitle: library and when the run started; the path is only a hover title.
    const sub = document.querySelector('.page-head .head-sub') as HTMLElement;
    expect(sub.textContent).toBe(`Run on Shows · ${fmtStamp('2026-10-16T18:00:00.000Z')}`);
    expect(within(sub).getByText('Shows').getAttribute('title')).toBe('/transcode/shows/Bluey');
    expect(sub.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-16T18:00:00.000Z');

    const counts = screen.getByRole('list', { name: 'Outcomes' });
    const tiles = within(counts).getAllByRole('listitem');
    expect(tiles.map((t) => t.textContent)).toEqual([
      'Saved790 MB2.41 GB → 1.62 GB',
      'Replaced1',
      'Kept original1',
      'Nothing to do1',
      'Failed1',
      'Skipped1',
    ]);
    // Plain tiles (convention 6), none at zero.
    for (const t of tiles) expect(t.className).toBe('stat-tile');
    expect(within(counts).queryByText('Dry run')).toBeNull();

    expect(screen.queryByText(/accounted for/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // A settled run is not live.
    expect(screen.queryByText('Live')).toBeNull();
    expect(screen.queryByText('reconnecting…')).toBeNull();
    const files = screen.getByRole('heading', { level: 2 });
    expect(files.textContent).toBe('Files5');
    expect(files.querySelector('.section-count')?.textContent).toBe('5');
  });

  it('shows "Dry run · No active version" from run.note and each file\'s version when it differs from the run\'s', async () => {
    const r = settledRun();
    mocks.get.mockResolvedValue({
      ...r,
      run: { ...r.run, dryRun: true, note: 'no active version' },
      files: [
        file('j1', 'Bluey S01E01.mkv', 'dry_run'),
        file('j2', 'Bluey S01E02.mkv', 'dry_run', { workflowVersion: 6 }),
      ],
      counts: { ...r.counts, total: 2 },
    });
    renderAt('/runs/r1', page());

    expect(await screen.findByText('Dry run · No active version')).toBeTruthy();
    const rows = screen.getAllByRole('row');
    const first = rows.find((row) => row.textContent?.includes('Bluey S01E01.mkv'));
    const second = rows.find((row) => row.textContent?.includes('Bluey S01E02.mkv'));
    expect(first?.textContent).not.toContain('v6');
    expect(first?.textContent).not.toMatch(/mkv\s*v7/);
    expect(second?.textContent).toContain('ran on v6');
  });

  it('has a breadcrumb above the title that names only the parent: "Jobs /"', async () => {
    mocks.get.mockResolvedValue(settledRun());
    renderAt('/runs/r1', page());
    const heading = await screen.findByRole('heading', { level: 1, name: 'TV cleanup v7' });
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumbs.classList.contains('job-crumbs')).toBe(true);
    const jobs = within(crumbs).getByRole('link', { name: 'Jobs' });
    expect(jobs.getAttribute('href')).toBe('/jobs');
    expect(jobs.classList.contains('job-crumb-link')).toBe(true);
    expect(crumbs.textContent).toBe('Jobs/');
    expect(crumbs.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('has no note line for an ordinary run', async () => {
    mocks.get.mockResolvedValue(settledRun());
    renderAt('/runs/r1', page());
    await screen.findByRole('heading', { level: 1, name: 'TV cleanup v7' });
    expect(screen.queryByText(/no active version/i)).toBeNull();
  });

  it('says how many files are unaccounted for, only when some are', async () => {
    const r = settledRun();
    mocks.get.mockResolvedValue({ ...r, counts: { ...r.counts, total: 6 } });
    renderAt('/runs/r1', page());

    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0]?.textContent).toContain('1 of 6 files are not accounted for');
    // Five files listed of six queued.
    expect(alerts[1]?.textContent).toContain('The list shows 5 of 6 files');
  });

  it('says so when the file list does not hold every queued file', async () => {
    const r = settledRun();
    mocks.get.mockResolvedValue({ ...r, files: r.files.slice(0, 4) });
    renderAt('/runs/r1', page());
    expect((await screen.findByRole('alert')).textContent).toContain('The list shows 4 of 5 files');
  });

  it('lists every file as File / Outcome / Size; the row is the link to its job', async () => {
    mocks.get.mockResolvedValue(settledRun());
    renderAt('/runs/r1', page());

    const table = await screen.findByRole('table', { name: 'Files' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['File', 'Outcome', 'Size']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(5);

    const cells = (i: number) =>
      within(rows[i] as HTMLElement)
        .getAllByRole('cell')
        .map((c) => c.textContent);
    // The reason is a muted line under the name, only when it says more than the chip.
    expect(cells(0)).toEqual(['Bluey S01E01.mkv', 'Replaced', '2.41 GB → 1.62 GB']);
    expect(cells(1)).toEqual([
      'Bluey S01E02.mkvOnly 6% smaller, size gate needs 20%',
      'Kept original',
      '1.00 GB',
    ]);
    expect(cells(2)).toEqual(['Bluey S01E03.mkvAlready HEVC', 'Nothing to do', '—']);
    expect(cells(3)).toEqual([
      'Bluey S01E04.mkvVerification failed: output 4 s shorter',
      'Failed',
      '800 MB',
    ]);
    expect(cells(4)).toEqual(['Bluey S01E05.mkvHardlinked by the torrent client', 'Skipped', '—']);

    // The Jobs list's chip: icon and word, "Kept original" neutral.
    expect(
      within(rows[3] as HTMLElement)
        .getByText('Failed')
        .querySelector('[data-icon="cross"]'),
    ).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('Kept original').className).toBe(
      'job-chip is-kept',
    );
    // No "Details" links: the file name is the row's link.
    expect(within(table).queryByText('Details')).toBeNull();
    const links = within(table).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/jobs/j1',
      '/jobs/j2',
      '/jobs/j3',
      '/jobs/j4',
      '/jobs/j5',
    ]);
    expect(links[0]?.textContent).toBe('Bluey S01E01.mkv');
    expect(rows[0]?.classList.contains('row-link')).toBe(true);
    expect(links[0]?.getAttribute('title')).toBe('/transcode/shows/Bluey S01E01.mkv');
  });

  it('phone: stacked cards like the Jobs phone list, no table', async () => {
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
    mocks.get.mockResolvedValue(settledRun());
    renderAt('/runs/r1', page());
    const first = await screen.findByRole('link', { name: /Bluey S01E01\.mkv/ });
    expect(first.getAttribute('href')).toBe('/jobs/j1');
    expect(first.className).toBe('phone-finished');
    expect(within(first).getByText('Replaced · 2.41 GB → 1.62 GB')).toBeTruthy();
    expect(screen.getByText('Kept original · 1.00 GB')).toBeTruthy();
    expect(
      within(screen.getByRole('link', { name: /Bluey S01E03\.mkv/ })).getByText('Nothing to do'),
    ).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('words an already-processed reason and a nothing-to-do row without one', async () => {
    const at = '2026-10-17T04:18:10.386Z';
    mocks.get.mockResolvedValue({
      ...settledRun(),
      files: [
        file('j1', 'tigger-pooh.mp4', 'already_processed', {
          reason: `already nothing_to_do on ${at}`,
          beforeBytes: 133_331,
        }),
        file('j2', 'h264-big.mkv', 'nothing_to_do', { beforeBytes: 1_252_833 }),
      ],
    });
    renderAt('/runs/r1', page());
    const table = await screen.findByRole('table', { name: 'Files' });
    const rows = within(table).getAllByRole('row').slice(1);
    const note = (i: number) => rows[i]?.querySelector('.run-file-note')?.textContent ?? null;
    expect(note(0)).toBe(`Processed on ${fmtDate(at)}: nothing to do`);
    // "Nothing to do" without a reason of its own: the chip says it all.
    expect(note(1)).toBeNull();
  });

  it('stays live while in_progress > 0 and refetches on run.changed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mocks.get
      .mockResolvedValueOnce(liveRun())
      .mockResolvedValueOnce(liveRun())
      .mockResolvedValue(settledRun());
    renderAt(
      '/runs/r1',
      <EventsProvider>
        <Route path="/runs/:id" component={RunPage} />
      </EventsProvider>,
    );
    await screen.findByRole('table', { name: 'Files' });
    await act(async () => fake.last().push(queueSnapshot));
    expect(await screen.findByText('Live')).toBeTruthy();
    const table = within(screen.getByRole('table', { name: 'Files' }));
    expect(table.getAllByText('In progress')).toHaveLength(1);
    expect(table.getAllByText('Queued')).toHaveLength(3);
    // Fetched before the stream was up: the first connect refetches once.
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));

    // Events for other runs are ignored.
    await act(async () => fake.last().push({ type: 'run.changed', runId: 'other' }));
    await act(async () => fake.last().push({ ...(jobChanged('x') as JobChanged), runId: 'other' }));
    expect(mocks.get).toHaveBeenCalledTimes(2);

    await act(async () => fake.last().push({ type: 'run.changed', runId: 'r1' }));
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(3));
    expect(mocks.get).toHaveBeenLastCalledWith({ id: 'r1' });
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Files' })).queryAllByText(/In progress|Queued/),
      ).toHaveLength(0),
    );
    expect(screen.queryByText('Live')).toBeNull();
    // Tiles at 0 are hidden: no Queued tile once nothing waits.
    expect(within(screen.getByRole('list', { name: 'Outcomes' })).queryByText('Queued')).toBeNull();
  });

  it('a paused queue: queued files read "Queued", the run says the queue is paused and is not live (P1)', async () => {
    mocks.queueStatus.mockResolvedValue({ paused: true, lanes: { encode: null, quick: null } });
    const paused = liveRun();
    paused.counts = { ...paused.counts, queued: 4, in_progress: 0 };
    paused.files = paused.files.map((f) =>
      f.state === 'encoding' ? { ...f, state: 'queued' } : f,
    );
    mocks.get.mockResolvedValue(paused);
    renderAt(
      '/runs/r1',
      <EventsProvider>
        <Route path="/runs/:id" component={RunPage} />
      </EventsProvider>,
    );
    const table = within(await screen.findByRole('table', { name: 'Files' }));
    expect(table.getAllByText('Queued')).toHaveLength(4);
    expect(table.queryAllByText('In progress')).toHaveLength(0);
    expect(await screen.findByText(/Queue paused/)).toBeTruthy();
    expect(screen.queryByText('Live')).toBeNull();
    const tiles = within(screen.getByRole('list', { name: 'Outcomes' }));
    expect(tiles.getByText('Queued').closest('li')?.textContent).toContain('4');
  });

  it('refetches on job.changed of this run', async () => {
    mocks.get.mockResolvedValue(liveRun());
    renderAt(
      '/runs/r1',
      <EventsProvider>
        <Route path="/runs/:id" component={RunPage} />
      </EventsProvider>,
    );
    await screen.findByRole('table', { name: 'Files' });
    await act(async () => fake.last().push(queueSnapshot));
    await act(async () => fake.last().push(jobChanged('j2')));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
  });

  it('keeps the last counts on screen when a refetch fails', async () => {
    mocks.get.mockResolvedValueOnce(liveRun()).mockRejectedValue(new TypeError('fetch failed'));
    renderAt(
      '/runs/r1',
      <EventsProvider>
        <Route path="/runs/:id" component={RunPage} />
      </EventsProvider>,
    );
    await screen.findByRole('table', { name: 'Files' });
    await act(async () => fake.last().push(queueSnapshot));
    await act(async () => fake.last().push({ type: 'run.changed', runId: 'r1' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not refresh: Could not reach the server',
    );
    expect(screen.getByText('Saved')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Files' })).toBeTruthy();
  });

  it('says so when the run does not exist', async () => {
    mocks.get.mockRejectedValue(
      new ORPCError('NOT_FOUND', { defined: true, status: 404, message: 'Run not found' }),
    );
    renderAt('/runs/nope', page());
    expect((await screen.findByRole('alert')).textContent).toContain('This run does not exist');
    expect(screen.getByRole('link', { name: 'Back to jobs' }).getAttribute('href')).toBe('/jobs');
  });
});

describe('RunPage loading', () => {
  it('shows the shared Loading component while the run loads', () => {
    mocks.get.mockReturnValue(new Promise(() => {}));
    renderAt('/runs/r1', page());
    const status = screen.getByText('Loading run…');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.classList.contains('loading')).toBe(true);
  });
});

describe('RunPage dry run', () => {
  it('a plan-only dry run counts would replace, depend on size and nothing to do apart (#41)', async () => {
    const base = settledRun();
    mocks.get.mockResolvedValue({
      ...base,
      run: { ...base.run, dryRun: true },
      counts: { ...zero, dry_run: 3, dependsOnSize: 2, nothing_to_do: 1, total: 4 },
      files: [
        file('j1', 'a.mkv', 'dry_run', {
          beforeBytes: 1000,
          estimatedBytes: 600,
          dependsOnSize: { minSavingPercent: 25 },
        }),
        file('j2', 'b.mkv', 'dry_run', {
          beforeBytes: 1000,
          dependsOnSize: { minSavingPercent: 25 },
        }),
        file('j3', 'c.mkv', 'dry_run', { beforeBytes: 1000 }),
        file('j4', 'd.mkv', 'nothing_to_do'),
      ],
    });
    renderAt('/runs/r1', <Route path="/runs/:id" component={RunPage} />);
    const tiles = within(await screen.findByRole('list', { name: 'Outcomes' })).getAllByRole(
      'listitem',
    );
    expect(tiles.slice(0, 2).map((t) => t.textContent)).toEqual([
      'Would replace1',
      'Depends on size2',
    ]);
    expect(screen.getByText('1 would replace · 2 depend on size · 1 nothing to do')).toBeTruthy();
    const rows = within(screen.getByRole('table', { name: 'Files' }))
      .getAllByRole('row')
      .slice(1);
    const chip = (i: number) => within(rows[i] as HTMLElement).getAllByRole('cell')[1]?.textContent;
    // No estimate claims what the gate will decide.
    expect(chip(0)).toBe('Would replace if it saves ≥ 25%Dry run');
    expect(chip(2)).toBe('Would replaceDry run');
  });

  it('badges a dry run and says nothing was changed instead of "No file replaced"', async () => {
    const base = settledRun();
    mocks.get.mockResolvedValue({
      ...base,
      run: { ...base.run, dryRun: true },
      counts: { ...zero, dry_run: 1, total: 1 },
      files: [file('j1', 'Bluey S01E01.mp4', 'dry_run', { beforeBytes: 1000 })],
    });
    renderAt('/runs/r1', <Route path="/runs/:id" component={RunPage} />);
    const heading = await screen.findByRole('heading', { level: 1 });
    const badge = within(heading.parentElement as HTMLElement).getByText('Dry run');
    expect(badge.closest('.badge-dry')).not.toBeNull();
    expect(screen.getByText('Dry run: no file was changed.')).toBeTruthy();
    expect(screen.queryByText('No file replaced.')).toBeNull();
  });

  it("shows each file's would-be verdict with the Dry run badge, counted like a real run", async () => {
    const base = settledRun();
    mocks.get.mockResolvedValue({
      ...base,
      run: { ...base.run, dryRun: true },
      counts: { ...zero, dry_run: 2, kept_original: 1, nothing_to_do: 1, total: 4 },
      files: [
        file('j1', 'a.mkv', 'dry_run', { beforeBytes: 1000, reason: 'would drop 9 tracks' }),
        file('j2', 'b.mkv', 'dry_run', { beforeBytes: 1000 }),
        file('j3', 'c.mkv', 'kept_original', { reason: 'path never writes the result' }),
        file('j4', 'd.mkv', 'nothing_to_do'),
      ],
    });
    renderAt('/runs/r1', <Route path="/runs/:id" component={RunPage} />);
    const tiles = within(await screen.findByRole('list', { name: 'Outcomes' })).getAllByRole(
      'listitem',
    );
    // Same tiles as a real run (no Dry run tile, no saved tile, none at 0); "would" words, and
    // the dry runs fold into the first.
    expect(tiles.map((t) => t.textContent)).toEqual([
      'Would replace2',
      'Would keep original1',
      'Nothing to do1',
    ]);
    const rows = within(screen.getByRole('table', { name: 'Files' }))
      .getAllByRole('row')
      .slice(1);
    const cells = (i: number) =>
      within(rows[i] as HTMLElement)
        .getAllByRole('cell')
        .map((c) => c.textContent);
    // The dashed badge sits beside the verdict; the reason is the muted line under the name.
    expect(cells(0)[1]).toBe('Would replaceDry run');
    expect(cells(0)[0]).toBe('a.mkvWould drop 9 tracks');
    expect(cells(1)[0]).toBe('b.mkv');
    expect(cells(2)[1]).toBe('Would keep originalDry run');
    expect(cells(3)[1]).toBe('Nothing to doDry run');
    expect(rows[0]?.querySelector('.badge-dry')).not.toBeNull();
  });

  describe('estimated savings', () => {
    const dryRun = (files: ReturnType<typeof file>[]): RunDetail => {
      const base = settledRun();
      return {
        ...base,
        run: { ...base.run, dryRun: true },
        counts: { ...zero, dry_run: files.length, total: files.length },
        files,
      };
    };
    const rowsOf = () =>
      within(screen.getByRole('table', { name: 'Files' }))
        .getAllByRole('row')
        .slice(1)
        .map((r) => within(r as HTMLElement).getAllByRole('cell'));

    it('a file with an estimate says how much smaller it would be, shows the estimated size and its plan instead of "no file changed"', async () => {
      mocks.get.mockResolvedValue(
        dryRun([
          file('j1', 'a.mkv', 'dry_run', {
            beforeBytes: 2_410_000_000,
            estimatedBytes: 1_590_000_000,
            planSummary: 'convert 1 video track; drop 1 subtitle track',
          }),
        ]),
      );
      renderAt('/runs/r1', <Route path="/runs/:id" component={RunPage} />);
      await screen.findByRole('table', { name: 'Files' });
      const cells = rowsOf()[0] as HTMLElement[];
      expect(cells[1]?.textContent).toBe('Would replace · −34%Dry run');
      expect(cells[0]?.textContent).toBe('a.mkvConvert 1 video track; drop 1 subtitle track');
      expect(cells[2]?.textContent).toBe('2.41 GB → ≈1.59 GB');
    });

    it('a file without an estimate or plan reads "Would replace" with the original size and no note', async () => {
      mocks.get.mockResolvedValue(
        dryRun([file('j1', 'a.mkv', 'dry_run', { beforeBytes: 2_410_000_000 })]),
      );
      renderAt('/runs/r1', <Route path="/runs/:id" component={RunPage} />);
      await screen.findByRole('table', { name: 'Files' });
      const cells = rowsOf()[0] as HTMLElement[];
      expect(cells[1]?.textContent).toBe('Would replaceDry run');
      expect(cells[0]?.textContent).toBe('a.mkv');
      expect(cells[2]?.textContent).toBe('2.41 GB');
    });

    it('totals the estimate and labels it estimated, saying how many files it covers when some have none', async () => {
      mocks.get.mockResolvedValue(
        dryRun([
          file('j1', 'a.mkv', 'dry_run', {
            beforeBytes: 2_410_000_000,
            estimatedBytes: 1_590_000_000,
          }),
          file('j2', 'b.mkv', 'dry_run', {
            beforeBytes: 1_000_000_000,
            estimatedBytes: 700_000_000,
          }),
          file('j3', 'c.mkv', 'dry_run', { beforeBytes: 500_000_000 }),
        ]),
      );
      renderAt('/runs/r1', <Route path="/runs/:id" component={RunPage} />);
      await screen.findByRole('table', { name: 'Files' });
      expect(
        screen.getByText('Dry run: no file was changed. ≈ −1.12 GB estimated (2 of 3 files).'),
      ).toBeTruthy();
    });

    it('no parenthesis when every file has an estimate; a growing estimate is "+"; no estimate at all keeps the plain line', async () => {
      mocks.get.mockResolvedValue(
        dryRun([
          file('j1', 'a.mkv', 'dry_run', {
            beforeBytes: 1_000_000_000,
            estimatedBytes: 1_200_000_000,
          }),
        ]),
      );
      const first = renderAt('/runs/r1', <Route path="/runs/:id" component={RunPage} />);
      expect(
        await screen.findByText('Dry run: no file was changed. ≈ +200 MB estimated.'),
      ).toBeTruthy();
      first.unmount();

      mocks.get.mockResolvedValue(dryRun([file('j1', 'a.mkv', 'dry_run', { beforeBytes: 1000 })]));
      renderAt('/runs/r1', <Route path="/runs/:id" component={RunPage} />);
      expect(await screen.findByText('Dry run: no file was changed.')).toBeTruthy();
      expect(screen.queryByText(/estimated/)).toBeNull();
    });
  });

  it("a test-encode run shows each file's measured outcome where a plan-only dry run shows its plan", async () => {
    const base = settledRun();
    mocks.get.mockResolvedValue({
      ...base,
      run: { ...base.run, dryRun: true, testEncode: true },
      counts: { ...zero, dry_run: 1, kept_original: 1, failed: 1, total: 3 },
      files: [
        file('j1', 'a.mkv', 'dry_run', {
          beforeBytes: 315_000_000,
          afterBytes: 190_000_000,
          planSummary: 'convert 1 video track',
        }),
        file('j2', 'b.mkv', 'kept_original', {
          reason: 'saved only 3.0%, below 10%',
          beforeBytes: 315_000_000,
          afterBytes: 305_000_000,
        }),
        file('j3', 'c.mkv', 'failed', { reason: 'encode failed', beforeBytes: 1000 }),
      ],
    });
    renderAt('/runs/r1', <Route path="/runs/:id" component={RunPage} />);
    const table = await screen.findByRole('table', { name: 'Files' });
    const rows = within(table).getAllByRole('row').slice(1);
    const cells = (i: number) =>
      within(rows[i] as HTMLElement)
        .getAllByRole('cell')
        .map((c) => c.textContent);
    expect(cells(0)[1]).toBe('Would replace · −40%Test encode');
    expect(cells(0)[0]).toBe('a.mkvWould replace · 315 MB → 190 MB (−40%)');
    expect(cells(0)[2]).toBe('315 MB → 190 MB');
    expect(cells(1)[0]).toBe('b.mkvWould keep the original · saved only 3% (gate ≥ 10%)');
    expect(cells(2)[0]).toBe('c.mkvEncode failed');
    const tiles = within(screen.getByRole('list', { name: 'Outcomes' })).getAllByRole('listitem');
    expect(tiles.map((t) => t.textContent).slice(0, 2)).toEqual([
      'Would replace1',
      'Would keep original1',
    ]);
  });

  it('a real run has no badge', async () => {
    mocks.get.mockResolvedValue(settledRun());
    renderAt('/runs/r1', <Route path="/runs/:id" component={RunPage} />);
    await screen.findByRole('heading', { level: 1 });
    expect(document.querySelector('.page-head .badge-dry')).toBeNull();
  });
});
