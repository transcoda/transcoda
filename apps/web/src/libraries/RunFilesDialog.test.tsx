import { ORPCError } from '@orpc/client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Library, WorkflowSummary } from '@transcoda/contract';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '../testing/render.tsx';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  queueFiles: vi.fn(),
  preview: vi.fn(),
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return {
    api: {
      workflows: { list: mocks.list },
      jobs: { queueFiles: mocks.queueFiles, queueFilesPreview: mocks.preview },
    },
    isDefinedError: orpc.isDefinedError,
    safe: orpc.safe,
  };
});

import { ACTIVATE_TO_RUN } from '../jobs/use-run-on-file.tsx';
import { RunFilesDialog, type RunSelection, runHoursWindow } from './RunFilesDialog.tsx';

const NIGHT = [22, 23, 0, 1, 2, 3, 4, 5];

function library(over: Partial<Library> = {}): Library {
  return {
    id: 'shows',
    name: 'Shows',
    path: '/media/shows',
    recycleFolder: null,
    processHardlinked: false,
    verifyFullDecode: false,
    runHours: { enabled: true, perDay: false, every: NIGHT, days: [[], [], [], [], [], [], []] },
    watchFolder: false,
    feeds: { workflowId: 'w1', name: 'Shows Cleanup', version: 2 },
    namedByInactive: [],
    createdAt: '2026-10-16T18:00:00.000Z',
    updatedAt: '2026-10-16T18:00:00.000Z',
    ...over,
  };
}

function workflow(id: string, name: string, over: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    id,
    name,
    kind: 'workflow',
    active: {
      version: 2,
      runnable: true,
      activatedAt: '2026-10-16T18:00:00.000Z',
      activatedBy: 'u1',
    },
    currentVersion: 3,
    ...over,
  } as unknown as WorkflowSummary;
}

const WORKFLOWS = [
  workflow('w1', 'Shows Cleanup'),
  workflow('w2', 'Movie Shrink', { active: null, currentVersion: 1 }),
  workflow('w3', 'Episode Tidy', {
    active: {
      version: 5,
      runnable: true,
      activatedAt: '2026-10-16T18:00:00.000Z',
      activatedBy: 'u1',
    },
    currentVersion: 5,
  }),
  workflow('w4', 'Shared Steps', { kind: 'subworkflow' }),
];

const answer = (over: Record<string, unknown> = {}) => ({
  willRun: 3,
  alreadyHandled: 9,
  heldByAnotherRun: 0,
  notFound: 0,
  skipped: 0,
  workflowVersion: 2,
  dryRun: false,
  ...over,
});

const SELECTION: RunSelection = { kind: 'files', fileIds: ['f1', 'f2', 'f3'] };

function mount(lib: Library = library(), selection: RunSelection = SELECTION) {
  const onClose = vi.fn();
  const view = renderAt(
    '/libraries/shows',
    <RunFilesDialog open library={lib} selection={selection} label="3 files" onClose={onClose} />,
  );
  return { ...view, onClose };
}

function OpenOnClick() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        show dialog
      </button>
      <RunFilesDialog
        open={open}
        library={library()}
        selection={SELECTION}
        label="3 files"
        onClose={() => setOpen(false)}
      />
    </>
  );
}

beforeEach(() => {
  mocks.list.mockReset().mockResolvedValue({ workflows: WORKFLOWS });
  mocks.preview.mockReset().mockResolvedValue(answer());
  mocks.queueFiles.mockReset().mockResolvedValue({
    runId: 'r9',
    jobIds: ['j1'],
    dryRun: false,
    note: null,
    workflowVersion: 2,
  });
});
afterEach(cleanup);

describe('RunFilesDialog', () => {
  it('says 1 file, not 1 files, for a single handled file', async () => {
    mocks.preview.mockResolvedValue(answer({ willRun: 2, alreadyHandled: 1 }));
    mount();
    expect(
      await screen.findByRole('checkbox', {
        name: 'Also run the 1 file Shows Cleanup v2 already handled',
      }),
    ).toBeTruthy();
  });

  it('shows a workflow list load failure with a retry, not an empty selector', async () => {
    mocks.list
      .mockRejectedValueOnce(new ORPCError('INTERNAL_SERVER_ERROR', { message: 'db is down' }))
      .mockResolvedValue({ workflows: WORKFLOWS });
    mount();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load the workflows');
    expect(alert.textContent).toContain('db is down');
    expect(screen.queryByRole('button', { name: /Workflow/ })).toBeNull();
    expect(mocks.preview).not.toHaveBeenCalled();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    const button = await screen.findByRole('button', { name: /Workflow/ });
    expect(button.textContent).toContain('Shows Cleanup v2');
    expect(screen.queryByText(/Could not load the workflows/)).toBeNull();
  });

  it('lists only workflows that can run, defaulting to the library feeder', async () => {
    mount(library({ feeds: { workflowId: 'w3', name: 'Episode Tidy', version: 5 } }));
    expect(await screen.findByRole('dialog', { name: 'Run a workflow on 3 files' })).toBeTruthy();
    const button = await screen.findByRole('button', { name: /Workflow/ });
    expect(button.textContent).toContain('Episode Tidy v5');
    fireEvent.click(button);
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Shows Cleanup v2', 'Episode Tidy v5']);
  });

  it('defaults to the first runnable workflow when the feeder is not listed', async () => {
    mount(library({ feeds: null }));
    const button = await screen.findByRole('button', { name: /Workflow/ });
    expect(button.textContent).toContain('Shows Cleanup v2');
  });

  it('names the recycle folder and the version each mode uses', async () => {
    mount();
    expect(await screen.findByText('Real run: v2 (active)')).toBeTruthy();
    expect(
      screen.getByRole('radio', {
        name: 'Run for real: originals go to /media/shows/.transcoda-recycle',
      }),
    ).toBeTruthy();
    const group = screen.getByRole('radiogroup');
    expect(within(group).getAllByRole('radio')).toHaveLength(2);
    mocks.preview.mockResolvedValue(answer({ workflowVersion: 3, dryRun: true }));
    fireEvent.click(screen.getByRole('radio', { name: /Dry run/ }));
    expect(await screen.findByText('Dry run: v3 (newest)')).toBeTruthy();
    expect(mocks.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ workflowId: 'w1', dryRun: true, libraryId: 'shows' }),
    );
  });

  it('names the version the preview checked, not the one the list reports', async () => {
    mocks.preview.mockResolvedValue(answer({ workflowVersion: 4 }));
    mount();
    expect(await screen.findByText('Real run: v4 (active)')).toBeTruthy();
    expect(
      screen.getByRole('checkbox', {
        name: 'Also run the 9 files Shows Cleanup v4 already handled',
      }),
    ).toBeTruthy();
    mocks.preview.mockResolvedValue(answer({ workflowVersion: 6, dryRun: true }));
    fireEvent.click(screen.getByRole('radio', { name: /Dry run/ }));
    expect(await screen.findByText('Dry run: v6 (newest)')).toBeTruthy();
  });

  it('counts the files that will run; the box adds the already handled ones', async () => {
    mount();
    expect(await screen.findByRole('button', { name: 'Run 3 files now' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add 3 files to queue' })).toBeTruthy();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Also run the 9 files Shows Cleanup v2 already handled',
      }),
    );
    expect(screen.getByRole('button', { name: 'Run 12 files now' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add 12 files to queue' })).toBeTruthy();
  });

  it('says "file" for one and hides the box when nothing was handled', async () => {
    mocks.preview.mockResolvedValue(answer({ willRun: 1, alreadyHandled: 0 }));
    mount();
    expect(await screen.findByRole('button', { name: 'Run 1 file now' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add 1 file to queue' })).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('announces the count in a polite live region', async () => {
    mount();
    await screen.findByRole('button', { name: 'Run 3 files now' });
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).toBeTruthy();
    expect(live?.textContent).toContain('3 files will run');
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Also run the 9 files Shows Cleanup v2 already handled',
      }),
    );
    expect(live?.textContent).toContain('12 files will run');
  });

  it('puts focus inside the dialog on open', async () => {
    mount();
    const dialog = await screen.findByRole('dialog', { name: 'Run a workflow on 3 files' });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('Add to queue sends start runHours and says when it starts', async () => {
    const { location } = mount();
    expect(await screen.findByText('Starts in your run hours (22:00–06:00)')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Add 3 files to queue' }));
    await waitFor(() => expect(mocks.queueFiles).toHaveBeenCalledTimes(1));
    expect(mocks.queueFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        libraryId: 'shows',
        fileIds: ['f1', 'f2', 'f3'],
        workflowId: 'w1',
        start: 'runHours',
        priority: 0,
        force: false,
        dryRun: false,
      }),
    );
    await waitFor(() => expect(location()).toBe('/runs/r9'));
  });

  it('says the queue order when the library has no run hours', async () => {
    mount(library({ runHours: null }));
    expect(
      await screen.findByText('Added to the queue after what is already waiting'),
    ).toBeTruthy();
  });

  it('Run now sends start now with priority 1', async () => {
    const { location } = mount();
    fireEvent.click(
      await screen.findByRole('checkbox', {
        name: 'Also run the 9 files Shows Cleanup v2 already handled',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run 12 files now' }));
    await waitFor(() => expect(mocks.queueFiles).toHaveBeenCalledTimes(1));
    expect(mocks.queueFiles).toHaveBeenCalledWith(
      expect.objectContaining({ start: 'now', priority: 1, force: true, dryRun: false }),
    );
    await waitFor(() => expect(location()).toBe('/runs/r9'));
  });

  it('sends a season selection as show and season', async () => {
    mount(library(), { kind: 'show', show: 'the-general', season: '1' });
    fireEvent.click(await screen.findByRole('button', { name: 'Run 3 files now' }));
    await waitFor(() => expect(mocks.queueFiles).toHaveBeenCalledTimes(1));
    const sent = mocks.queueFiles.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ show: 'the-general', season: '1' });
    expect(sent).not.toHaveProperty('fileIds');
  });

  it('ignores a stale preview', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    mocks.preview.mockImplementation(({ workflowId }: { workflowId: string }) =>
      workflowId === 'w1'
        ? new Promise((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve(answer({ willRun: 5, alreadyHandled: 0, workflowVersion: 5 })),
    );
    mount();
    const button = await screen.findByRole('button', { name: /Workflow/ });
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('option', { name: /Episode Tidy/ }));
    expect(await screen.findByRole('button', { name: 'Run 5 files now' })).toBeTruthy();
    resolveFirst(answer({ willRun: 3 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole('button', { name: 'Run 5 files now' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run 3 files now' })).toBeNull();
  });

  it('a real run answered as a dry run toasts and stays', async () => {
    mocks.queueFiles.mockResolvedValue({
      runId: 'r9',
      jobIds: ['j1'],
      dryRun: true,
      note: 'no active version',
      workflowVersion: 3,
    });
    const { location } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Run 3 files now' }));
    expect(mocks.list).toHaveBeenCalledTimes(1);
    // The version was deactivated meanwhile: the next list no longer has it runnable.
    mocks.list.mockResolvedValue({
      workflows: [workflow('w1', 'Shows Cleanup', { active: null }), ...WORKFLOWS.slice(1)],
    });
    expect(await screen.findByText(ACTIVATE_TO_RUN)).toBeTruthy();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    const button = await screen.findByRole('button', { name: /Workflow/ });
    await waitFor(() => expect(button.textContent).toContain('Episode Tidy v5'));
    await waitFor(() =>
      expect(mocks.preview).toHaveBeenLastCalledWith(
        expect.objectContaining({ workflowId: 'w3', dryRun: false }),
      ),
    );
    expect(location()).toBe('/libraries/shows');
    expect(screen.getByRole('dialog', { name: 'Run a workflow on 3 files' })).toBeTruthy();
  });

  it('a real run the preview answers as a dry run is not offered: both buttons off, activate first', async () => {
    mocks.preview.mockResolvedValue(answer({ dryRun: true, workflowVersion: 3 }));
    mount();
    expect(await screen.findByText(ACTIVATE_TO_RUN)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(ACTIVATE_TO_RUN);
    const now = screen.getByRole('button', { name: 'Run 3 files now' }) as HTMLButtonElement;
    const queue = screen.getByRole('button', { name: 'Add 3 files to queue' }) as HTMLButtonElement;
    expect(now.disabled).toBe(true);
    expect(queue.disabled).toBe(true);
    fireEvent.click(now);
    fireEvent.click(queue);
    expect(mocks.queueFiles).not.toHaveBeenCalled();
    // A dry run asked for and answered as one is fine.
    fireEvent.click(screen.getByRole('radio', { name: /Dry run/ }));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Run 3 files now' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.queryByText(ACTIVATE_TO_RUN)).toBeNull();
  });

  it('names the version the server checked in the already handled box', async () => {
    // The list still says v2 is active; the server checked the files against v4.
    mocks.preview.mockResolvedValue(answer({ workflowVersion: 4 }));
    mount();
    expect(
      await screen.findByRole('checkbox', {
        name: 'Also run the 9 files Shows Cleanup v4 already handled',
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/Shows Cleanup v2 already handled/)).toBeNull();
  });

  it('no button is enabled while nothing would run', async () => {
    mocks.preview.mockResolvedValue(answer({ willRun: 0, alreadyHandled: 0 }));
    mount();
    const now = await screen.findByRole('button', { name: 'Run 0 files now' });
    expect((now as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Add 0 files to queue' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('keeps the buttons off while a request is out', async () => {
    mocks.preview.mockReturnValue(new Promise(() => {}));
    mount();
    await waitFor(() => expect(mocks.preview).toHaveBeenCalled());
    const buttons = screen.getAllByRole('button', { name: /files? (now|to queue)$/ });
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it('says what is held by another run and what could not be found', async () => {
    mocks.preview.mockResolvedValue(answer({ heldByAnotherRun: 4, notFound: 1, skipped: 1 }));
    mount();
    expect(
      await screen.findByText('4 files are already queued in another run and will be skipped'),
    ).toBeTruthy();
    expect(screen.getByText("1 file can't be found and will be skipped")).toBeTruthy();
    expect(screen.getByText('1 file will be skipped')).toBeTruthy();
  });

  it('words not found and skipped apart, in the plural too', async () => {
    mocks.preview.mockResolvedValue(answer({ notFound: 2, skipped: 3 }));
    mount();
    expect(await screen.findByText("2 files can't be found and will be skipped")).toBeTruthy();
    expect(screen.getByText('3 files will be skipped')).toBeTruthy();
  });

  it('reads the workflows again when it opens', async () => {
    renderAt('/libraries/shows', <OpenOnClick />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'show dialog' }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  });

  it('shows a server error as an alert in the dialog', async () => {
    mocks.queueFiles.mockRejectedValue(
      new ORPCError('PATH_REJECTED', { defined: true, status: 400, message: 'Path not allowed' }),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Run 3 files now' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Path not allowed');
  });

  it('an unreachable library folder says so with its path, and Try again checks again', async () => {
    mocks.preview.mockRejectedValueOnce(
      new ORPCError('LIBRARY_UNREACHABLE', {
        defined: true,
        status: 412,
        message: "The library folder can't be reached",
        data: { path: '/media/shows' },
      }),
    );
    mount();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("The library folder can't be reached: /media/shows");
    expect(alert.textContent).not.toContain('Not found');
    const calls = mocks.preview.mock.calls.length;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(calls + 1));
    expect(await screen.findByRole('button', { name: 'Run 3 files now' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('Cancel closes the dialog', async () => {
    const { onClose } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('runHoursWindow', () => {
  const rh = (over: object) => ({
    enabled: true,
    perDay: false,
    every: NIGHT,
    days: [[], [], [], [], [], [], []] as number[][],
    ...over,
  });
  it('gives the time window alone for one strip', () => {
    expect(runHoursWindow(rh({}))).toBe('22:00–06:00');
  });
  it('joins separate windows', () => {
    expect(runHoursWindow(rh({ every: [1, 2, 13, 14] }))).toBe('01:00–03:00, 13:00–15:00');
  });
  it('says all day', () => {
    expect(runHoursWindow(rh({ every: Array.from({ length: 24 }, (_, i) => i) }))).toBe('all day');
  });
  it('groups the days when each day has its own hours', () => {
    const night = [22, 23];
    expect(
      runHoursWindow(rh({ perDay: true, days: [night, night, night, night, night, [], [10, 11]] })),
    ).toBe('Mon–Fri 22:00–24:00; Sun 10:00–12:00');
  });
});
