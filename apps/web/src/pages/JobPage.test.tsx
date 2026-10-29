import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jobs: {
    get: vi.fn(),
    log: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    deleteTestOutput: vi.fn(),
  },
  workflows: { get: vi.fn(), list: vi.fn() },
  nodes: { list: vi.fn() },
  queue: { status: vi.fn() },
  events: { subscribe: vi.fn() },
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import type { JobDetail } from '@transcoda/contract';
import { Route } from 'wouter';
import { resetCatalogCache } from '../hooks/useCatalog.ts';
import { EventsProvider } from '../hooks/useEvents.ts';
import { REFETCH_COALESCE_MS } from '../hooks/useRefetchOn.ts';
import { fakeEventSource, queueSnapshot } from '../test/fakeEventStream.ts';
import { nodesFixture } from '../test/fixtures/catalog.ts';
import {
  COMMAND,
  ELSE_PATH,
  ELSE_TRACE,
  jobDetail,
  runningJobDetail,
  SUB_ID,
  TRACE,
  traceSub,
} from '../test/fixtures/trace.ts';
import { renderAt } from '../test/render.tsx';
import { JobPage } from './JobPage.tsx';

let fake: ReturnType<typeof fakeEventSource>;

beforeEach(() => {
  resetCatalogCache();
  fake = fakeEventSource();
  mocks.events.subscribe.mockReset().mockImplementation(fake.subscribe);
  mocks.nodes.list.mockReset().mockResolvedValue({ nodes: nodesFixture });
  mocks.workflows.get.mockReset().mockResolvedValue({
    id: SUB_ID,
    name: 'Language cleanup',
    kind: 'subworkflow',
    version: 3,
    graph: traceSub(),
  });
  mocks.workflows.list.mockReset().mockResolvedValue({
    workflows: [
      {
        id: SUB_ID,
        name: 'Language cleanup',
        kind: 'subworkflow',
        active: null,
        currentVersion: 3,
        valid: true,
        errorCount: 0,
        usesOutdatedSubworkflow: false,
        usedBy: [],
        createdAt: '2026-10-16T10:00:00.000Z',
        updatedAt: '2026-10-16T10:00:00.000Z',
      },
    ],
  });
  mocks.jobs.get.mockReset().mockResolvedValue(jobDetail());
  mocks.jobs.log.mockReset().mockResolvedValue({ log: 'frame=100 fps=118' });
  mocks.queue.status
    .mockReset()
    .mockResolvedValue({ paused: false, lanes: { encode: null, quick: null }, preparing: [] });
  for (const fn of [mocks.jobs.pause, mocks.jobs.resume, mocks.jobs.cancel]) {
    fn.mockReset().mockResolvedValue({ ok: true });
  }
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function open(path = '/jobs/j1') {
  const view = renderAt(
    path,
    <EventsProvider>
      <Route path="/jobs/:id">
        <JobPage />
      </Route>
    </EventsProvider>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Tigger and Pooh S01E01.mkv' });
  await act(async () => {});
  return view;
}

describe('JobPage', () => {
  it('shows which GPU encoded the job, and no row when none did', async () => {
    mocks.jobs.get.mockResolvedValue({ ...jobDetail(), encodedOn: 'Intel Arc A310 · 07:00.0' });
    const view = await open();
    expect(screen.getByText('Encoded on Intel Arc A310 · 07:00.0')).toBeTruthy();
    view.unmount();
    mocks.jobs.get.mockResolvedValue(jobDetail());
    await open();
    expect(screen.queryByText(/^Encoded on/)).toBeNull();
  });

  it('says "Encoding on" while the job is active', async () => {
    mocks.jobs.get.mockResolvedValue(
      jobDetail({ state: 'building', lane: 'encode', encodedOn: 'GPU 0' }),
    );
    await open();
    expect(screen.getByText('Encoding on GPU 0')).toBeTruthy();
    expect(screen.queryByText(/^Encoded on/)).toBeNull();
  });

  it("the trace's Run cards show their sub-workflow's name and pinned version", async () => {
    await open();
    await waitFor(() =>
      expect(screen.getByTestId('tc-node-run-b').getAttribute('aria-label')).toContain(
        'Language cleanup · v3',
      ),
    );
    expect(mocks.workflows.list).toHaveBeenCalledTimes(1);
    expect(
      within(screen.getByTestId('tc-node-run-a')).getByText('Language cleanup · v3'),
    ).toBeTruthy();
  });

  it('shows header, one sentence per step with its badge, the result, and the command with Copy in the raw output', async () => {
    await open();
    expect(mocks.jobs.get).toHaveBeenCalledWith({ id: 'j1' });
    // One muted meta line: where, then when it finished and how long it took.
    expect(document.querySelector('.job-head-meta')?.textContent).toMatch(
      /^Shows · TV cleanup v7 · Run · Finished .* · took /,
    );
    // The crumb names only the parent.
    expect(document.querySelector('.job-crumbs')?.textContent).toBe('Jobs/');
    expect(screen.getAllByText('Replaced').length).toBeGreaterThan(0);

    const section = screen.getByRole('region', { name: 'What the workflow did' });
    const list = within(section).getByRole('list', { name: 'What the workflow did' });
    const items = within(list).getAllByRole('listitem');
    expect(within(items[0] as HTMLElement).getByText('Manual input')).toBeTruthy();
    expect(
      within(items[0] as HTMLElement).getByText('Started on a file picked by hand'),
    ).toBeTruthy();
    expect(within(items[0] as HTMLElement).getByText('Start')).toBeTruthy();
    // A condition: its answer is the badge, the engine's words the sentence.
    expect(items[1]?.textContent).toContain('Already HEVC ≤ 8 Mb/s');
    expect(within(items[1] as HTMLElement).getByText('Yes')).toBeTruthy();
    // Nothing to expand on a condition: no chevron button.
    expect(
      within(items[1] as HTMLElement).queryByRole('button', { name: /^Details for/ }),
    ).toBeNull();
    // The sub-workflow's graph is fetched for its node titles and types.
    await waitFor(() =>
      expect(within(list).getByText('Dropped 1 audio track (French)')).toBeTruthy(),
    );
    expect(mocks.workflows.get).toHaveBeenCalledWith({ id: SUB_ID, version: 3 });
    const keep = within(list)
      .getByText('Dropped 1 audio track (French)')
      .closest('li') as HTMLElement;
    expect(within(keep).getByText('Changed file')).toBeTruthy();
    fireEvent.click(within(keep).getByRole('button', { name: 'Details for Keep languages' }));
    expect(within(keep).getByText('Drops: French audio')).toBeTruthy();
    const cover = within(list)
      .getByText('Covers and attachments stayed as they were')
      .closest('li');
    expect(cover?.className).toContain('is-quiet');
    expect(within(cover as HTMLElement).getByText('No change')).toBeTruthy();
    expect(items.at(-1)?.textContent).toContain(
      "Replaced the original, which is now in this library's recycle folder",
    );
    expect(within(items.at(-1) as HTMLElement).getByText('After verification')).toBeTruthy();
    expect(section.querySelector('.section-count')?.textContent).toMatch(/^\d+ steps$/);

    const result = screen.getByRole('region', { name: 'Result' });
    expect(within(result).getByText('2.41 GB → 1.62 GB')).toBeTruthy();
    expect(within(result).getByText('−33%')).toBeTruthy();
    expect(within(result).getByText('Original in recycle folder')).toBeTruthy();

    // Nothing to note: no "Notes from ffmpeg" section. The command and the log are in the
    // Result's collapsed raw output.
    const raw = (await within(result).findByText('Show command and log')).closest(
      'details',
    ) as HTMLDetailsElement;
    expect(screen.queryByRole('region', { name: 'Notes from ffmpeg' })).toBeNull();
    expect(raw.open).toBe(false);
    expect(document.querySelectorAll('section.command-block')).toHaveLength(1);
    const command = within(raw).getByRole('region', { name: 'ffmpeg command' });
    expect(within(command).getByText(COMMAND)).toBeTruthy();
    fireEvent.click(within(command).getByRole('button', { name: 'Copy' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(COMMAND);
    expect(await screen.findByText('Copied')).toBeTruthy();
    expect(within(raw).getByText('frame=100 fps=118')).toBeTruthy();
    expect(within(raw).getByRole('link', { name: 'Download full log' }).getAttribute('href')).toBe(
      '/api/v1/jobs/j1/log/download',
    );
    expect(mocks.jobs.log).toHaveBeenCalledWith({ id: 'j1' });
    // No "Technical details" or "Reload log" any more.
    expect(screen.queryByText('Technical details')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reload log' })).toBeNull();

    // Clicking a step selects the node on the canvas.
    fireEvent.click(within(items[1] as HTMLElement).getAllByRole('button')[0] as HTMLElement);
    expect(
      document.querySelector('.react-flow__node[data-id="vi"]')?.classList.contains('selected'),
    ).toBe(true);
  });

  it('"Changes" hides the steps that change nothing', async () => {
    await open();
    const section = screen.getByRole('region', { name: 'What the workflow did' });
    await waitFor(() =>
      expect(within(section).getByText('Dropped 1 audio track (French)')).toBeTruthy(),
    );
    const group = section.querySelector('.job-steps-filter') as HTMLElement;
    const [all, only] = within(group).getAllByRole('button') as [HTMLElement, HTMLElement];
    expect(all.textContent).toMatch(/^All/);
    expect(all.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(only);
    expect(only.getAttribute('aria-pressed')).toBe('true');
    expect(within(section).queryByText('Covers and attachments stayed as they were')).toBeNull();
    expect(within(section).getByText('Dropped 1 audio track (French)')).toBeTruthy();
    fireEvent.click(all);
    expect(within(section).getByText('Covers and attachments stayed as they were')).toBeTruthy();
  });

  it('known ffmpeg warnings become notes; the set_mempolicy flood is one line in the raw output', async () => {
    mocks.jobs.log.mockResolvedValue({
      log: [
        "[hevc_nvenc @ 0x1] Incompatible pixel format 'yuv420p10le' for codec 'hevc_nvenc', auto-selecting format 'p010le'",
        ...Array.from({ length: 500 }, () => 'set_mempolicy: Operation not permitted'),
        '[mp4 @ 0x2] something nobody mapped',
      ].join('\n'),
    });
    await open();
    const notes = screen.getByRole('region', { name: 'Notes from ffmpeg' });
    expect(await within(notes).findByText('2 notes, nothing blocking')).toBeTruthy();
    const cards = within(notes).getAllByRole('listitem');
    expect(cards.map((c) => c.querySelector('.ffmpeg-note-tag')?.textContent)).toEqual([
      'Expected',
      'Expected',
    ]);
    expect(cards[1]?.textContent).toContain('printed this 500 times');
    const result = screen.getByRole('region', { name: 'Result' });
    const raw = within(result).getByText('Show command and log').closest('details') as HTMLElement;
    expect(within(raw).getByText('502 lines')).toBeTruthy();
    const text = raw.querySelector('.job-log-text')?.textContent ?? '';
    expect(text.match(/set_mempolicy/g)).toHaveLength(1);
    expect(text).toContain('[500 times, see Notes from ffmpeg]');
    // Not known: only in the raw output.
    expect(text).toContain('something nobody mapped');
    expect(cards.some((c) => c.textContent?.includes('nobody mapped'))).toBe(false);
  });

  it('a planned job waiting for the encoder says so and does not name the last node', async () => {
    mocks.jobs.get.mockResolvedValue(runningJobDetail({ state: 'building', lane: 'encode' }));
    await open();
    expect(screen.getByText('Planned · waiting for the encoder')).toBeTruthy();
    expect(screen.getAllByText('Planned').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Building the plan/)).toBeNull();
    expect(screen.queryByText(/^At:/)).toBeNull();
    // No node is lit as current while it waits.
    expect(
      document.querySelector('.tc-node.is-running, [data-testid^="tc-node-"].is-running'),
    ).toBeNull();
  });

  it('a job still building shows the plan being built and the node it is at', async () => {
    mocks.jobs.get.mockResolvedValue(runningJobDetail({ state: 'building', lane: null }));
    await open();
    expect(screen.getByText('Building the plan')).toBeTruthy();
    expect(screen.getByText(/^At: /)).toBeTruthy();
  });

  it('a job.changed that hands the job its lane switches the wording live', async () => {
    mocks.jobs.get.mockResolvedValue(runningJobDetail({ state: 'building', lane: null }));
    await open();
    await act(async () => fake.last().push(queueSnapshot));
    await act(async () =>
      fake.last().push({
        type: 'job.changed',
        jobId: 'j1',
        runId: 'r1',
        libraryId: 'l1',
        workflowId: 'w1',
        state: 'building',
        paused: false,
        progress: null,
        lane: 'encode',
        currentNode: { workflowPath: [], nodeId: 'sg' },
        problems: [],
        reason: null,
      }),
    );
    expect(await screen.findByText('Planned · waiting for the encoder')).toBeTruthy();
    expect(screen.queryByText(/^At:/)).toBeNull();
  });

  it('a job.changed while the replace waits for space shows what it waits for, live (C4)', async () => {
    mocks.jobs.get.mockResolvedValue(runningJobDetail({ state: 'replacing', lane: 'encode' }));
    await open();
    await act(async () => fake.last().push(queueSnapshot));
    expect(await screen.findByText('Replacing the original')).toBeTruthy();
    await act(async () =>
      fake.last().push({
        type: 'job.changed',
        jobId: 'j1',
        runId: 'r1',
        libraryId: 'l1',
        workflowId: 'w1',
        state: 'replacing',
        paused: false,
        progress: null,
        lane: 'encode',
        currentNode: null,
        problems: [],
        reason: 'waiting for 5.4 GB free on /media (5.1 GB free)',
      }),
    );
    expect(await screen.findByText('Waiting for 5.4 GB free on /media (5.1 GB free)')).toBeTruthy();
  });

  it('a dry run is badged in the header whatever its state, and a real run is not', async () => {
    mocks.jobs.get.mockResolvedValue(runningJobDetail({ state: 'encoding', dryRun: true }));
    await open();
    const head = document.querySelector('.job-head-chips') as HTMLElement;
    expect(within(head).getByText('Dry run')).toBeTruthy();
    cleanup();
    mocks.jobs.get.mockResolvedValue(jobDetail());
    await open();
    expect(document.querySelector('.job-head-chips .badge-dry')).toBeNull();
  });

  it('never shows "Replaced" for a job in replacing state', async () => {
    mocks.jobs.get.mockResolvedValue(
      runningJobDetail({
        state: 'replacing',
        result: {
          outcome: 'replacing',
          beforeBytes: 2_410_000_000,
          afterBytes: 1_620_000_000,
          estimatedBytes: null,
          command: COMMAND,
          replacedTo: null,
          sourceDamaged: false,
          warnings: [],
          problems: [],
        },
      }),
    );
    await open();
    expect(screen.getAllByText('Replacing').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Replaced/)).toBeNull();
    expect(screen.queryByText(/recycle folder/)).toBeNull();
    expect(screen.queryByText(/original replaced/i)).toBeNull();
  });

  it('refetches on job.trace for this job and applies progress from job.changed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mocks.jobs.get.mockResolvedValue(runningJobDetail({ state: 'encoding' }));
    await open();
    await act(async () => fake.last().push(queueSnapshot));
    // Fetched before the stream was up: the first connect refetches once.
    await waitFor(() => expect(mocks.jobs.get).toHaveBeenCalledTimes(2));
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS));

    await act(async () =>
      fake.last().push({
        type: 'job.trace',
        jobId: 'other',
        entry: runningJobDetail().trace[0] as never,
      }),
    );
    expect(mocks.jobs.get).toHaveBeenCalledTimes(2);
    await act(async () =>
      fake.last().push({
        type: 'job.trace',
        jobId: 'j1',
        entry: runningJobDetail().trace[0] as never,
      }),
    );
    await waitFor(() => expect(mocks.jobs.get).toHaveBeenCalledTimes(3));

    await act(async () =>
      fake.last().push({
        type: 'job.changed',
        jobId: 'j1',
        runId: 'r1',
        libraryId: 'l1',
        workflowId: 'w1',
        state: 'encoding',
        paused: false,
        progress: {
          percent: 42,
          outTimeSeconds: 600,
          speed: 4.9,
          fps: 118,
          sizeBytes: null,
          etaSeconds: 180,
        },
        lane: 'encode',
        currentNode: { workflowPath: [], nodeId: 'sg' },
        problems: [],
        reason: null,
      }),
    );
    expect(await screen.findByText('42% · 118 fps · ETA 3 min')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByTestId('tc-node-sg').classList.contains('is-running')).toBe(true);
    // The running node is the bar: its fill follows the job's percent.
    expect(screen.getByTestId('tc-node-sg').style.getPropertyValue('--tc-progress')).toBe('42%');
    expect(screen.getByText('At: Size gate')).toBeTruthy();
    expect(mocks.jobs.get).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(mocks.jobs.pause).toHaveBeenCalledWith({ id: 'j1' }));
  });

  it('asks before cancelling', async () => {
    mocks.jobs.get.mockResolvedValue(runningJobDetail({ state: 'encoding' }));
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Cancel Tigger and Pooh S01E01.mkv?',
    });
    expect(within(dialog).getByText('The original stays untouched.')).toBeTruthy();
    // Focus starts on the safe choice.
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Keep running' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel job' }));
    await waitFor(() => expect(mocks.jobs.cancel).toHaveBeenCalledWith({ id: 'j1' }));
  });

  it('starts over when the route moves to another job (no selection or log carried over)', async () => {
    const view = await open();
    expect(await screen.findByText('frame=100 fps=118')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'What the workflow did' });
    fireEvent.click(
      within(within(list).getAllByRole('listitem')[1] as HTMLElement).getAllByRole(
        'button',
      )[0] as HTMLElement,
    );
    expect(document.querySelector('.react-flow__node.selected')).not.toBeNull();

    mocks.jobs.log.mockResolvedValue({ log: '' });
    mocks.jobs.get.mockResolvedValue(jobDetail({ id: 'j2', fileName: 'Andor S02E07.mkv' }));
    view.navigate('/jobs/j2');
    await screen.findByRole('heading', { level: 1, name: 'Andor S02E07.mkv' });
    await act(async () => {});
    expect(mocks.jobs.get).toHaveBeenLastCalledWith({ id: 'j2' });
    expect(screen.queryByText('frame=100 fps=118')).toBeNull();
    expect(document.querySelector('.react-flow__node.selected')).toBeNull();
  });

  it('an empty log shows no notes section and no empty code block; the command stays in the raw output', async () => {
    mocks.jobs.get.mockResolvedValue(runningJobDetail({ state: 'encoding' }));
    mocks.jobs.log.mockReset().mockResolvedValue({ log: '' });
    await open();
    await waitFor(() => expect(mocks.jobs.log).toHaveBeenCalled());
    expect(document.querySelector('.job-log-text')).toBeNull();
    cleanup();

    mocks.jobs.get.mockResolvedValue(jobDetail());
    await open();
    expect(screen.queryByRole('region', { name: 'Notes from ffmpeg' })).toBeNull();
    expect(document.querySelector('.job-log-text')).toBeNull();
    expect(screen.getByText('Show command')).toBeTruthy();
    cleanup();

    mocks.jobs.get.mockResolvedValue(jobDetail({ state: 'dry_run', dryRun: true }));
    await open();
    // The planned command is still there, in the raw output.
    expect(screen.getByRole('region', { name: 'ffmpeg command (not run)' })).toBeTruthy();
  });

  it('reads the log again when the job moves on; a failed read can be retried', async () => {
    mocks.jobs.get.mockResolvedValue(runningJobDetail({ state: 'encoding' }));
    mocks.jobs.log
      .mockReset()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ log: 'frame=1' })
      .mockResolvedValue({ log: 'frame=1\nframe=2 (done)' });
    await open();
    const notes = screen.getByRole('region', { name: 'Notes from ffmpeg' });
    expect((await within(notes).findByRole('alert')).textContent).toContain(
      "Couldn't load the log",
    );
    fireEvent.click(within(notes).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('frame=1')).toBeTruthy();

    mocks.jobs.get.mockResolvedValue(jobDetail());
    await act(async () => fake.last().push(queueSnapshot));
    await waitFor(() => expect(screen.getAllByText('Replaced').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByText(/frame=2 \(done\)/)).toBeTruthy());
  });

  it('keeps the last job on screen when a refetch fails', async () => {
    mocks.jobs.get.mockResolvedValue(runningJobDetail({ state: 'encoding' }));
    await open();
    mocks.jobs.get.mockRejectedValue(new Error('server restarting'));
    await act(async () => fake.last().push(queueSnapshot));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not refresh: server restarting — showing the last state.',
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'Tigger and Pooh S01E01.mkv' }),
    ).toBeTruthy();
    expect(screen.getByRole('list', { name: 'What the workflow is doing' })).toBeTruthy();
  });

  it('a queued job says "Queue paused" while the whole queue is paused', async () => {
    mocks.jobs.get.mockResolvedValue(
      runningJobDetail({ state: 'queued', lane: null, trace: [], path: [], startedAt: null }),
    );
    mocks.queue.status.mockResolvedValue({
      paused: true,
      lanes: { encode: null, quick: null },
      preparing: [],
    });
    await open();
    expect(await screen.findByText('Queue paused')).toBeTruthy();
    expect(screen.queryByText('Waiting for a lane')).toBeNull();
    expect(screen.queryByText(/^At: /)).toBeNull();
  });

  it('lights Encode video while encoding, not the Run node the engine last built', async () => {
    mocks.jobs.get.mockResolvedValue(
      runningJobDetail({ state: 'encoding', trace: ELSE_TRACE.slice(0, 9), path: ELSE_PATH }),
    );
    await open();
    await act(async () =>
      fake.last().push({
        type: 'job.changed',
        jobId: 'j1',
        runId: 'r1',
        libraryId: 'l1',
        workflowId: 'w1',
        state: 'encoding',
        paused: false,
        progress: null,
        lane: 'encode',
        currentNode: { workflowPath: ['run-b'], nodeId: 'rt' },
        problems: [],
        reason: null,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('tc-node-ev').classList.contains('is-running')).toBe(true),
    );
    expect(screen.getByTestId('tc-node-run-b').classList.contains('is-running')).toBe(false);
    expect(screen.getByText('At: Encode video')).toBeTruthy();
    // The sub-workflow's steps say where they are.
    const list = screen.getByRole('list', { name: 'What the workflow is doing' });
    await waitFor(() =>
      expect(
        within(list)
          .getByText(/Keep languages/)
          .closest('li')?.textContent,
      ).toContain('Keep languages in Language cleanup'),
    );
  });

  it('Encode video shows the verify checks, then the whole-file decode, as they progress', async () => {
    mocks.jobs.get.mockResolvedValue(
      runningJobDetail({ state: 'verifying', trace: ELSE_TRACE.slice(0, 9), path: ELSE_PATH }),
    );
    await open();
    const push = (
      verify: {
        stage: 'checks' | 'full-decode' | 'source';
        done: number | null;
        total: number | null;
      },
      percent: number | null,
    ) =>
      act(async () =>
        fake.last().push({
          type: 'job.changed',
          jobId: 'j1',
          runId: 'r1',
          libraryId: 'l1',
          workflowId: 'w1',
          state: 'verifying',
          paused: false,
          progress: {
            percent,
            outTimeSeconds: 0,
            speed: null,
            fps: null,
            sizeBytes: null,
            etaSeconds: null,
            verify,
          },
          lane: 'encode',
          currentNode: { workflowPath: ['run-b'], nodeId: 'rt' },
          problems: [],
          reason: null,
        }),
      );
    await push({ stage: 'checks', done: 3, total: 14 }, 21.4);
    const node = () => screen.getByTestId('tc-node-ev');
    await waitFor(() => expect(node().textContent).toContain('Verifying · 3 of 14 checks'));
    expect(node().style.getPropertyValue('--tc-progress')).toBe('21%');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('21');
    expect(screen.getByText('Checking duration, streams and decode · 3 of 14 done')).toBeTruthy();

    await push({ stage: 'full-decode', done: null, total: null }, 43.2);
    await waitFor(() => expect(node().textContent).toContain('Verifying · whole file 43%'));
    expect(node().style.getPropertyValue('--tc-progress')).toBe('43%');

    // No measure while the source is re-checked: words, and no fill.
    await push({ stage: 'source', done: null, total: null }, null);
    await waitFor(() => expect(node().textContent).toContain('Verifying · checking the source'));
    expect(node().style.getPropertyValue('--tc-progress')).toBe('');
  });

  it("a paused job's node is lit but still, and says paused", async () => {
    mocks.jobs.get.mockResolvedValue(runningJobDetail({ state: 'building', paused: true }));
    await open();
    const ca = screen.getByTestId('tc-node-ca');
    expect(ca.classList.contains('is-paused')).toBe(true);
    expect(within(ca).getByText('Paused')).toBeTruthy();
    expect(screen.getByText('At: Cover and attachments')).toBeTruthy();
  });

  it('reads the workflow (for the dry-run plan) only for a dry run with a plan', async () => {
    await open();
    expect(mocks.workflows.get).not.toHaveBeenCalledWith({ id: 'w1' });
  });

  it('asks for a sub-workflow again after a failure other than NOT_FOUND', async () => {
    mocks.workflows.get.mockReset().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({
      id: SUB_ID,
      name: 'Language cleanup',
      kind: 'subworkflow',
      version: 3,
      graph: traceSub(),
    });
    // Every fetch answers a new object, as the API does.
    mocks.jobs.get.mockImplementation(async () => jobDetail());
    await open();
    expect(mocks.workflows.get).toHaveBeenCalledTimes(1);
    // The next update of the job (here the first connect's refetch) asks again.
    await act(async () => fake.last().push(queueSnapshot));
    await waitFor(() => expect(mocks.workflows.get).toHaveBeenCalledTimes(2));
    const list = screen.getByRole('list', { name: 'What the workflow did' });
    await waitFor(() => expect(within(list).getByText(/Keep languages/)).toBeTruthy());
  });

  it('a done job with problems lists them in the result (no separate banner) with the Needs attention chip', async () => {
    const problems = ['the server stopped before the remaining finish actions'];
    mocks.jobs.get.mockResolvedValue(
      jobDetail({
        problems,
        result: { ...(jobDetail().result as NonNullable<JobDetail['result']>), problems },
      }),
    );
    await open();
    expect(document.querySelector('.problem-banner')).toBeNull();
    expect(screen.getAllByText('Needs attention').length).toBeGreaterThan(0);
    const result = screen.getByRole('region', { name: 'Result' });
    const list = within(result).getByRole('list', { name: 'Problems' });
    expect(within(list).getByText(problems[0] as string)).toBeTruthy();
    expect(result.classList.contains('is-warning')).toBe(true);
  });

  it('a plugin trace entry shows the plug icon beside its title in the steps', async () => {
    mocks.jobs.get.mockResolvedValue(
      jobDetail({
        trace: TRACE.map((e) => (e.nodeId === 'vi' ? { ...e, source: 'plugin' as const } : e)),
      }),
    );
    await open();
    const items = within(screen.getByRole('list', { name: 'What the workflow did' })).getAllByRole(
      'listitem',
    );
    expect(items[1]?.querySelector('[data-icon="plug"]')).not.toBeNull();
    expect(items[0]?.querySelector('[data-icon="plug"]')).toBeNull();
  });
  it("M12: the subtitle links the library, the workflow at the job's version, and the run", async () => {
    await open();
    const where = document.querySelector('.job-head-meta') as HTMLElement;
    const link = (name: string) => within(where).getByRole('link', { name }) as HTMLAnchorElement;
    expect(link('Shows').getAttribute('href')).toBe('/libraries');
    expect(link('TV cleanup v7').getAttribute('href')).toBe('/workflows/w1?version=7');
    expect(link('Run').getAttribute('href')).toBe('/runs/r1');
  });

  it('M3: the raw ffmpeg output shows a chevron that turns when it opens', async () => {
    await open();
    const raw = (await screen.findByText('Show command and log')).closest('details') as HTMLElement;
    const summary = raw.querySelector(':scope > summary') as HTMLElement;
    expect(summary.querySelector('.icon')?.getAttribute('aria-hidden')).toBe('true');
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.ffmpeg-raw\[open\] > summary \.icon[^{]*\{[^}]*rotate\(90deg\)/);
    expect(css).toMatch(/\.ffmpeg-raw > summary::-webkit-details-marker/);
  });

  it('one order for every outcome: header, Result, Before and after, steps, the flow last', async () => {
    await open();
    const page = document.querySelector('.job-page') as HTMLElement;
    const order = [...page.children]
      .filter((c) => c.tagName !== 'DIALOG')
      .map(
        (c) =>
          c.getAttribute('aria-label') ??
          (c.getAttribute('aria-labelledby')
            ? document.getElementById(c.getAttribute('aria-labelledby') as string)?.textContent
            : c.tagName.toLowerCase()),
      );
    expect(order[0]).toBe('header');
    expect(order[1]).toBe('Result');
    expect(order.indexOf('What the workflow did')).toBeGreaterThan(1);
    expect(order.at(-1)).toBe('Workflow trace');
  });

  it('a failed probe leads with the cause in plain words, keeps the raw error, and makes Process again the primary', async () => {
    const reason = 'probe failed: Invalid data found when processing input';
    mocks.jobs.get.mockResolvedValue(
      jobDetail({ state: 'failed', reason, result: null, trace: [], path: [] }),
    );
    mocks.jobs.log.mockReset().mockResolvedValue({ log: '' });
    await open();
    const result = screen.getByRole('region', { name: 'Result' });
    expect(within(result).getByText('The file could not be read')).toBeTruthy();
    const raw = within(result).getByText('Show error').closest('details') as HTMLElement;
    expect(raw.querySelector('.job-log-text')?.textContent).toBe(reason);
    // Never planned, no log: no steps and no notes section.
    expect(screen.queryByRole('region', { name: /What the workflow/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Notes from ffmpeg' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Process again' }).className).toContain(
      'btn-primary',
    );
  });

  it('a finished job that did not fail has no lime primary in the header', async () => {
    await open();
    expect(screen.getByRole('button', { name: 'Process again' }).className).not.toContain(
      'btn-primary',
    );
  });

  it('a finished test-encode shows its kept output after the result; Delete now refetches the job', async () => {
    const keptUntil = new Date(Date.now() + 3_600_000).toISOString();
    mocks.jobs.get.mockResolvedValue(
      jobDetail({
        state: 'dry_run',
        dryRun: true,
        testEncode: true,
        testOutput: { keptUntil, sizeBytes: 190_000_000, container: 'mp4' },
      }),
    );
    mocks.jobs.deleteTestOutput.mockReset().mockResolvedValue({ ok: true });
    await open();
    const panel = screen.getByRole('region', { name: /^Test output kept until/ });
    const result = screen.getByRole('region', { name: 'Result' });
    expect(result.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Download' }).getAttribute('href')).toBe(
      '/api/v1/jobs/j1/test-output',
    );
    mocks.jobs.get.mockClear();
    mocks.jobs.get.mockResolvedValue(
      jobDetail({ state: 'dry_run', dryRun: true, testEncode: true, testOutputNote: 'deleted' }),
    );
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Delete now' }));
    });
    expect(mocks.jobs.deleteTestOutput).toHaveBeenCalledWith({ id: 'j1' });
    expect(await screen.findByText('Test output deleted')).toBeTruthy();
    expect(mocks.jobs.get).toHaveBeenCalledWith({ id: 'j1' });
  });

  it.each([
    ['a plan-only dry run', { state: 'dry_run', dryRun: true, testEncode: false }],
    ['a real job', { state: 'done', dryRun: false, testEncode: false }],
  ] as const)('%s has no test-output panel', async (_name, over) => {
    mocks.jobs.get.mockResolvedValue(
      jobDetail({
        ...over,
        testOutput: {
          keptUntil: new Date(Date.now() + 3_600_000).toISOString(),
          sizeBytes: 1,
          container: 'mkv',
        },
        testOutputNote: 'deleted',
      }),
    );
    await open();
    expect(document.querySelector('.test-output')).toBeNull();
    expect(screen.queryByText('Test output deleted')).toBeNull();
  });
});
