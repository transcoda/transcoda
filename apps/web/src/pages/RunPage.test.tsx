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
import { fmtDate } from '../lib/time.ts';
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
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RunPage', () => {
  it('renders the counts with words and icons and the "N files in this run · M accounted for" line that reconciles', async () => {
    mocks.get.mockResolvedValue(settledRun());
    renderAt('/runs/r1', page());

    expect(
      await screen.findByRole('heading', { name: 'Run · TV cleanup v7 · Shows' }),
    ).toBeTruthy();
    expect(mocks.get).toHaveBeenCalledWith({ id: 'r1' });
    expect(screen.getByText('/transcode/shows/Bluey')).toBeTruthy();

    const counts = screen.getByRole('list', { name: 'Outcomes' });
    const tiles = within(counts).getAllByRole('listitem');
    expect(tiles.map((t) => t.textContent)).toEqual([
      'Replaced1',
      'Kept original1',
      'Nothing to do1',
      'Failed1',
      'Cancelled0',
      'Skipped1',
      'Already processed0',
      'Queued0',
      'In progress0',
    ]);
    // Colour never carries meaning alone: every tile has an icon next to its word.
    for (const t of tiles) expect(t.querySelector('svg[data-icon]')).toBeTruthy();
    expect(tiles[0]?.querySelector('[data-icon="check"]')).toBeTruthy();
    expect(tiles[4]?.className).toContain('is-zero');
    // No "Dry run" tile: a dry run is counted like a real run.
    expect(within(counts).queryByText('Dry run')).toBeNull();
    expect(tiles[0]?.className).not.toContain('is-zero');

    expect(screen.getByText('5 files in this run · 5 accounted for')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('2.41 GB → 1.62 GB, saved 790 MB')).toBeTruthy();
    // A settled run is not live.
    expect(screen.queryByText('Live')).toBeNull();
    expect(screen.queryByText('reconnecting…')).toBeNull();
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

  it('has a breadcrumb above the title, like the job page: Jobs (a link) / Run · workflow vN (M12)', async () => {
    mocks.get.mockResolvedValue(settledRun());
    renderAt('/runs/r1', page());
    const heading = await screen.findByRole('heading', { name: 'Run · TV cleanup v7 · Shows' });
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumbs.classList.contains('job-crumbs')).toBe(true);
    const jobs = within(crumbs).getByRole('link', { name: 'Jobs' });
    expect(jobs.getAttribute('href')).toBe('/jobs');
    expect(jobs.classList.contains('job-crumb-link')).toBe(true);
    expect(crumbs.textContent).toBe('Jobs/Run · TV cleanup v7');
    expect(crumbs.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('has no note line for an ordinary run', async () => {
    mocks.get.mockResolvedValue(settledRun());
    renderAt('/runs/r1', page());
    await screen.findByRole('heading', { name: 'Run · TV cleanup v7 · Shows' });
    expect(screen.queryByText(/no active version/i)).toBeNull();
  });

  it('shows the alert when the counts do not add up', async () => {
    const r = settledRun();
    mocks.get.mockResolvedValue({ ...r, counts: { ...r.counts, total: 6 } });
    renderAt('/runs/r1', page());

    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0]?.textContent).toContain("Counts don't add up (6 vs 5)");
    // Five files listed of six queued.
    expect(alerts[1]?.textContent).toContain('The list shows 5 of 6 files');
    expect(screen.getByText('6 files in this run · 5 accounted for')).toBeTruthy();
  });

  it('says so when the file list does not hold every queued file', async () => {
    const r = settledRun();
    mocks.get.mockResolvedValue({ ...r, files: r.files.slice(0, 4) });
    renderAt('/runs/r1', page());
    expect((await screen.findByRole('alert')).textContent).toContain('The list shows 4 of 5 files');
  });

  it('lists every file with outcome, reason and sizes and links to its job', async () => {
    mocks.get.mockResolvedValue(settledRun());
    renderAt('/runs/r1', page());

    const table = await screen.findByRole('table', { name: 'Files' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(5);

    const cells = (i: number) =>
      within(rows[i] as HTMLElement)
        .getAllByRole('cell')
        .map((c) => c.textContent);
    expect(cells(0)).toEqual([
      'Bluey S01E01.mkv',
      'Replaced',
      'Re-encoded to HEVC · original in recycle folder',
      '2.41 GB → 1.62 GB',
      'Details',
    ]);
    expect(cells(1)).toEqual([
      'Bluey S01E02.mkv',
      'Kept original',
      'Only 6% smaller, size gate needs 20% · original untouched',
      '1.00 GB',
      'Details',
    ]);
    expect(cells(2)).toEqual(['Bluey S01E03.mkv', 'Nothing to do', 'Already HEVC', '—', 'Details']);
    expect(cells(3)).toEqual([
      'Bluey S01E04.mkv',
      'Failed',
      'Verification failed: output 4 s shorter · original untouched',
      '800 MB',
      'Details',
    ]);
    expect(cells(4)).toEqual([
      'Bluey S01E05.mkv',
      'Skipped',
      'Hardlinked by the torrent client',
      '—',
      'Details',
    ]);

    // The outcome chip pairs an icon with the word.
    expect(
      within(rows[3] as HTMLElement)
        .getByText('Failed')
        .querySelector('[data-icon="cross"]'),
    ).toBeTruthy();
    // One name for the job link, shared with the Jobs list: "Details for <file>".
    const jobs = within(table).getAllByRole('link', { name: /^Details for / });
    expect(jobs[0]?.getAttribute('aria-label')).toBe('Details for Bluey S01E01.mkv');
    expect(jobs.map((a) => a.getAttribute('href'))).toEqual([
      '/jobs/j1',
      '/jobs/j2',
      '/jobs/j3',
      '/jobs/j4',
      '/jobs/j5',
    ]);
    expect(screen.getByText('Bluey S01E01.mkv').getAttribute('title')).toBe(
      '/transcode/shows/Bluey S01E01.mkv',
    );
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
    const reason = (i: number) =>
      within(rows[i] as HTMLElement).getAllByRole('cell')[2]?.textContent;
    expect(reason(0)).toBe(`Processed on ${fmtDate(at)}: nothing to do`);
    expect(reason(1)).toBe('Already complies with every rule');
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
    await screen.findByText('5 files in this run · 5 accounted for');
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
    expect(
      within(screen.getByRole('list', { name: 'Outcomes' })).getAllByRole('listitem')[7]?.className,
    ).toContain('is-zero');
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
    await screen.findByText('5 files in this run · 5 accounted for');
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
    await screen.findByText('5 files in this run · 5 accounted for');
    await act(async () => fake.last().push(queueSnapshot));
    await act(async () => fake.last().push({ type: 'run.changed', runId: 'r1' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not refresh: Could not reach the server',
    );
    expect(screen.getByText('5 files in this run · 5 accounted for')).toBeTruthy();
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
    // Same tiles as a real run (no Dry run tile) plus "Depends on size" (#41); "would" words, and
    // the dry runs fold into the first.
    expect(tiles.map((t) => t.textContent)).toEqual([
      'Would replace2',
      'Depends on size0',
      'Would keep original1',
      'Nothing to do1',
      'Failed0',
      'Cancelled0',
      'Skipped0',
      'Already processed0',
      'Queued0',
      'In progress0',
    ]);
    expect(screen.getByText('4 files in this run · 4 accounted for')).toBeTruthy();
    const rows = within(screen.getByRole('table', { name: 'Files' }))
      .getAllByRole('row')
      .slice(1);
    const cells = (i: number) =>
      within(rows[i] as HTMLElement)
        .getAllByRole('cell')
        .map((c) => c.textContent);
    // The dashed badge sits beside the verdict; the plan summary is the REASON (never an empty dash).
    expect(cells(0)[1]).toBe('Would replaceDry run');
    expect(cells(0)[2]).toBe('Would drop 9 tracks · no file changed');
    expect(cells(1)[2]).toBe('No file changed');
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
      expect(cells[2]?.textContent).toBe('Convert 1 video track; drop 1 subtitle track');
      expect(cells[3]?.textContent).toBe('2.41 GB → ≈1.59 GB');
    });

    it('a file without an estimate or plan reads as before: "Would replace", "No file changed", the original size', async () => {
      mocks.get.mockResolvedValue(
        dryRun([file('j1', 'a.mkv', 'dry_run', { beforeBytes: 2_410_000_000 })]),
      );
      renderAt('/runs/r1', <Route path="/runs/:id" component={RunPage} />);
      await screen.findByRole('table', { name: 'Files' });
      const cells = rowsOf()[0] as HTMLElement[];
      expect(cells[1]?.textContent).toBe('Would replaceDry run');
      expect(cells[2]?.textContent).toBe('No file changed');
      expect(cells[3]?.textContent).toBe('2.41 GB');
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
    expect(cells(0)[2]).toBe('Would replace · 315 MB → 190 MB (−40%)');
    expect(cells(0)[3]).toBe('315 MB → 190 MB');
    expect(cells(1)[2]).toBe('Would keep the original · saved only 3% (gate ≥ 10%)');
    expect(cells(2)[2]).toBe('Encode failed · original untouched');
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
