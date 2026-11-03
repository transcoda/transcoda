import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { RunDetail } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runs: { get: vi.fn(), processAgain: vi.fn() },
  workflows: { get: vi.fn(), list: vi.fn() },
  libraries: { get: vi.fn() },
  events: { subscribe: vi.fn() },
  queue: { status: vi.fn() },
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { ORPCError } from '@orpc/client';
import { Route } from 'wouter';
import { EventsProvider } from '../hooks/useEvents.ts';
import { fakeEventSource } from '../test/fakeEventStream.ts';
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
): RunDetail['files'][number] {
  return {
    jobId,
    fileName,
    filePath: `/media/Shows/${fileName}`,
    state,
    reason: state === 'already_processed' ? 'already done on 2026-10-01T10:00:00.000Z' : null,
    beforeBytes: null,
    afterBytes: null,
    replacedTo: null,
    workflowVersion: 7,
    estimatedBytes: null,
    planSummary: null,
    dependsOnSize: null,
    paused: false,
  };
}

/** A scan with two already-processed files and one it replaced. */
function scanRun(extra: Partial<RunDetail['run']> = {}): RunDetail {
  return {
    run: {
      id: 'r1',
      libraryId: 'l1',
      workflowId: 'w1',
      workflowVersion: 7,
      requestedPath: '/media/Shows',
      dryRun: false,
      testEncode: false,
      force: false,
      note: null,
      createdBy: 'u1',
      createdAt: '2026-10-16T18:00:00.000Z',
      ...extra,
    },
    workflowName: 'TV cleanup',
    libraryName: 'Shows',
    counts: { ...zero, done: 1, already_processed: 2, total: 3 },
    files: [
      file('j1', 'Bluey S01E01.mkv', 'done'),
      file('j2', 'Bluey S01E02.mkv', 'already_processed'),
      file('j3', 'Bluey S01E03.mkv', 'already_processed'),
    ],
  };
}

const LIBRARY = {
  id: 'l1',
  name: 'Shows',
  path: '/media/Shows',
  recycleFolder: null,
  processHardlinked: false,
  verifyFullDecode: false,
  defaultWorkflowId: 'w1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const MAIN = {
  id: 'w1',
  name: 'TV cleanup',
  kind: 'workflow',
  version: 9,
  active: { version: 7, runnable: true },
};
const QUEUED = {
  runId: 'r2',
  jobIds: ['j8', 'j9'],
  dryRun: false,
  note: null,
  workflowVersion: 7,
  testEncode: false,
};

let fake: ReturnType<typeof fakeEventSource>;
beforeEach(() => {
  fake = fakeEventSource();
  mocks.events.subscribe.mockReset().mockImplementation(fake.subscribe);
  mocks.queue.status
    .mockReset()
    .mockResolvedValue({ paused: false, lanes: { encode: null, quick: null }, preparing: [] });
  mocks.runs.get.mockReset().mockResolvedValue(scanRun());
  mocks.runs.processAgain.mockReset().mockResolvedValue(QUEUED);
  mocks.workflows.get.mockReset().mockResolvedValue(MAIN);
  mocks.workflows.list.mockReset().mockResolvedValue({ workflows: [] });
  mocks.libraries.get.mockReset().mockResolvedValue(LIBRARY);
});
afterEach(() => cleanup());

async function open() {
  const view = renderAt(
    '/runs/r1',
    <EventsProvider>
      <Route path="/runs/:id" component={RunPage} />
    </EventsProvider>,
  );
  await screen.findByRole('heading', { level: 1, name: 'TV cleanup v7' });
  await act(async () => {});
  return view;
}

describe('RunPage: Process again', () => {
  it('a run with no already-processed files offers nothing', async () => {
    mocks.runs.get.mockResolvedValue({
      ...scanRun(),
      counts: { ...zero, done: 1, total: 1 },
      files: [file('j1', 'Bluey S01E01.mkv', 'done')],
    });
    await open();
    expect(screen.queryByRole('button', { name: 'Process again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dry run again' })).toBeNull();
  });

  it("asks first, naming how many files and the recycle folder, then queues the run's already-processed files and opens the new run", async () => {
    const view = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Process again' }));
    const dialog = await screen.findByRole('dialog', { name: 'Process 2 files again?' });
    await waitFor(() => expect(dialog.textContent).toContain('/media/Shows/.transcoda-recycle'));
    expect(dialog.textContent).toContain(
      'Runs TV cleanup (its active version) again on the 2 files of this run marked Already processed',
    );
    expect(dialog.textContent).toContain('The other files of the run are left alone.');
    expect(mocks.libraries.get).toHaveBeenCalledWith({ id: 'l1' });
    expect(mocks.runs.processAgain).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Process again' }));
    await waitFor(() => expect(mocks.runs.processAgain).toHaveBeenCalledTimes(1));
    expect(mocks.runs.processAgain).toHaveBeenCalledWith({ id: 'r1', dryRun: false });
    await waitFor(() => expect(view.location()).toBe('/runs/r2'));
  });

  it('one file queued opens its job', async () => {
    mocks.runs.processAgain.mockResolvedValue({ ...QUEUED, jobIds: ['j8'] });
    const view = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Process again' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Process again' }));
    await waitFor(() => expect(view.location()).toBe('/jobs/j8'));
  });

  it('Cancel in the dialog queues nothing', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Process again' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mocks.runs.processAgain).not.toHaveBeenCalled();
  });

  it("when the active version can't run the dialog says so and the primary button is disabled", async () => {
    mocks.workflows.get.mockResolvedValue({ ...MAIN, active: { version: 7, runnable: false } });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Process again' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain("TV cleanup v7 is active but can't run");
    expect(
      (within(dialog).getByRole('button', { name: 'Process again' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('with no active version it offers Dry run again with the reason, and queues a dry run without asking', async () => {
    mocks.workflows.list.mockResolvedValue({ workflows: [{ id: 'w1', active: null }] });
    mocks.runs.processAgain.mockResolvedValue({ ...QUEUED, dryRun: true });
    const view = await open();
    const dry = await screen.findByRole('button', { name: 'Dry run again' });
    expect(screen.queryByRole('button', { name: 'Process again' })).toBeNull();
    const hint = screen.getByText('Activate a version to run for real');
    expect(dry.getAttribute('aria-describedby')).toBe(hint.id);
    fireEvent.click(dry);
    await waitFor(() =>
      expect(mocks.runs.processAgain).toHaveBeenCalledWith({ id: 'r1', dryRun: true }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(view.location()).toBe('/runs/r2'));
  });

  it('a workflow found inactive only when Process again is pressed opens no dialog: the button becomes Dry run again', async () => {
    mocks.workflows.get.mockResolvedValue({ ...MAIN, active: null });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Process again' }));
    await screen.findByText('TV cleanup has no active version: use Dry run again');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Process again' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Dry run again' })).toBeTruthy();
    expect(mocks.runs.processAgain).not.toHaveBeenCalled();
  });

  it("a dry run's page offers Dry run again, with no hint", async () => {
    mocks.runs.get.mockResolvedValue(scanRun({ dryRun: true }));
    await open();
    expect(screen.getByRole('button', { name: 'Dry run again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Process again' })).toBeNull();
    expect(screen.queryByText('Activate a version to run for real')).toBeNull();
  });

  it('a failed queue says why and stays on the run', async () => {
    mocks.runs.processAgain.mockRejectedValue(
      new ORPCError('PATH_REJECTED', {
        defined: true,
        status: 400,
        data: { path: '/media/Shows', reason: 'not found' },
      }),
    );
    const view = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Process again' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Process again' }));
    await screen.findByText("Couldn't queue 2 files again: not found");
    expect(view.location()).toBe('/runs/r1');
  });
});
