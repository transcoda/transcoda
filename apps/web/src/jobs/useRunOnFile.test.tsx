import { ORPCError } from '@orpc/client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { WorkflowSummary } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '../test/render.tsx';

const mocks = vi.hoisted(() => ({ list: vi.fn(), browse: vi.fn(), queue: vi.fn() }));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return {
    api: {
      libraries: { list: mocks.list, browse: mocks.browse },
      jobs: { queue: mocks.queue },
    },
    isDefinedError: orpc.isDefinedError,
    safe: orpc.safe,
  };
});

import { FILE_ONLY, runBlocked, useRunOnFile } from './useRunOnFile.tsx';

const library = (id: string, name: string, path: string, recycleFolder: string | null) => ({
  id,
  name,
  path,
  recycleFolder,
  processHardlinked: false,
  verifyFullDecode: false,
  feeds: null,
  createdAt: '2026-10-16T18:00:00.000Z',
  updatedAt: '2026-10-16T18:00:00.000Z',
});

const file = (name: string) => ({ name, sizeBytes: 1000, mtime: '2026-10-16T18:00:00.000Z' });

const active = {
  version: 3,
  runnable: true,
  activatedAt: '2026-10-16T18:00:00.000Z',
  activatedBy: 'u1',
};

function summary(over: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    id: 'w1',
    name: 'Downsize',
    kind: 'workflow',
    active,
    currentVersion: 4,
    feedsLibrary: { id: 'shows', name: 'Shows' },
    ...over,
  } as unknown as WorkflowSummary;
}

function Harness({ workflow, onStale }: { workflow: WorkflowSummary; onStale?: () => void }) {
  const run = useRunOnFile(workflow, onStale);
  return (
    <>
      <button type="button" onClick={run.open}>
        open
      </button>
      {run.element}
    </>
  );
}

beforeEach(() => {
  mocks.list.mockReset().mockResolvedValue({
    libraries: [
      library('shows', 'Shows', '/media/shows', null),
      library('movies', 'Movies', '/media/movies', '/media/movies/.bin'),
    ],
    notices: [],
  });
  mocks.browse.mockReset().mockImplementation(async ({ id }) => {
    if (id === 'shows') return { dirs: [], files: [file('s.mkv')] };
    return { dirs: [], files: [file('a.mkv')] };
  });
  mocks.queue.mockReset().mockResolvedValue({
    runId: 'r1',
    jobIds: ['j1'],
    dryRun: false,
    note: null,
    workflowVersion: 3,
  });
});
afterEach(cleanup);

async function pickFrom(libraryName: string, fileName: RegExp) {
  const picker = await screen.findByRole('dialog', { name: 'Run Downsize v3 on a file' });
  expect(within(picker).queryByText(/This is a dry run/)).toBeNull();
  fireEvent.click(within(picker).getByRole('button', { name: /^Library/ }));
  fireEvent.click(within(picker).getByRole('option', { name: libraryName }));
  fireEvent.click(await within(picker).findByRole('button', { name: fileName }));
  return picker;
}

describe('runBlocked', () => {
  it('says why a workflow cannot run for real', () => {
    expect(runBlocked(summary({ active: null }))).toEqual({
      reason: 'Activate a version to run for real',
    });
    expect(runBlocked(summary({ active: { ...active, runnable: false } }))).toEqual({
      reason: "v3 can't run. Activate a version that runs",
    });
    expect(runBlocked(summary())).toBeNull();
  });
});

describe('useRunOnFile', () => {
  it("names the picked file's library's recycle folder (not the Library input's) and runs the active version for real", async () => {
    const view = renderAt('/workflows/w1', <Harness workflow={summary()} />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    await pickFrom('Movies', /a\.mkv/);
    const confirm = await screen.findByRole('dialog', { name: 'Run Downsize on this file?' });
    expect(confirm.textContent).toContain(
      'Applies Downsize v3 (active) to /media/movies/a.mkv. The original moves to /media/movies/.bin.',
    );
    expect(mocks.queue).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(view.location()).toBe('/jobs/j1'));
    expect(mocks.queue).toHaveBeenCalledTimes(1);
    expect(mocks.queue).toHaveBeenCalledWith({
      path: '/media/movies/a.mkv',
      workflowId: 'w1',
      dryRun: false,
      fileOnly: true,
    });
  });

  it('a library without a recycle folder names <root>/.transcoda-recycle', async () => {
    renderAt('/workflows/w1', <Harness workflow={summary()} />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    await pickFrom('Shows', /s\.mkv/);
    const confirm = await screen.findByRole('dialog', { name: 'Run Downsize on this file?' });
    expect(confirm.textContent).toContain('The original moves to /media/shows/.transcoda-recycle.');
  });

  it('a typed path outside every library names the library recycle folder in words', async () => {
    renderAt('/workflows/w1', <Harness workflow={summary()} />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    const picker = await screen.findByRole('dialog', { name: 'Run Downsize v3 on a file' });
    await within(picker).findByRole('button', { name: /s\.mkv/ });
    fireEvent.change(within(picker).getByLabelText('Or type a path'), {
      target: { value: '/elsewhere/x.mkv' },
    });
    fireEvent.click(within(picker).getByRole('button', { name: 'Choose file' }));
    const confirm = await screen.findByRole('dialog', { name: 'Run Downsize on this file?' });
    expect(confirm.textContent).toContain("The original moves to the library's recycle folder.");
  });

  it('Cancel queues nothing', async () => {
    renderAt('/workflows/w1', <Harness workflow={summary()} />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    await pickFrom('Movies', /a\.mkv/);
    const confirm = await screen.findByRole('dialog', { name: 'Run Downsize on this file?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Run Downsize on this file?' })).toBeNull(),
    );
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it('PATH_REJECTED returns to the picker with its reason', async () => {
    mocks.queue.mockRejectedValue(
      new ORPCError('PATH_REJECTED', {
        defined: true,
        status: 400,
        data: { path: '/media/movies/a.mkv', reason: 'still growing' },
      }),
    );
    renderAt('/workflows/w1', <Harness workflow={summary()} />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    const picker = await pickFrom('Movies', /a\.mkv/);
    const confirm = await screen.findByRole('dialog', { name: 'Run Downsize on this file?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Run' }));
    expect(await within(picker).findByText("Can't use a.mkv: still growing")).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Run Downsize on this file?' })).toBeNull();
  });

  it('WORKFLOW_INVALID closes with a toast; another error stays in the confirm', async () => {
    mocks.queue.mockRejectedValueOnce(new Error('disk on fire'));
    mocks.queue.mockRejectedValueOnce(
      new ORPCError('WORKFLOW_INVALID', { defined: true, status: 400, data: { issues: [] } }),
    );
    renderAt('/workflows/w1', <Harness workflow={summary()} />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    await pickFrom('Movies', /a\.mkv/);
    const confirm = await screen.findByRole('dialog', { name: 'Run Downsize on this file?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Run' }));
    expect((await within(confirm).findByRole('alert')).textContent).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Run' }));
    expect(await screen.findByText("v3 can't run. Activate a version that runs")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('the server answering with a dry run (nothing active any more) does not open the job: "activate to run", dialogs closed, the summary refreshed', async () => {
    mocks.queue.mockResolvedValue({
      runId: 'r1',
      jobIds: ['j1'],
      dryRun: true,
      note: 'no active version',
      workflowVersion: 4,
    });
    const onStale = vi.fn();
    const view = renderAt('/workflows/w1', <Harness workflow={summary()} onStale={onStale} />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    await pickFrom('Movies', /a\.mkv/);
    const confirm = await screen.findByRole('dialog', { name: 'Run Downsize on this file?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('Activate a version to run for real')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(view.location()).toBe('/workflows/w1');
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a folder', '/media/movies'],
    ['a folder with a slash', '/media/movies/'],
    ['a file that is not media', '/media/movies/notes.txt'],
  ])('a typed path to %s is refused in the picker; nothing is queued', async (_what, typed) => {
    renderAt('/workflows/w1', <Harness workflow={summary()} />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    const picker = await screen.findByRole('dialog', { name: 'Run Downsize v3 on a file' });
    await within(picker).findByRole('button', { name: /s\.mkv/ });
    fireEvent.change(within(picker).getByLabelText('Or type a path'), {
      target: { value: typed },
    });
    fireEvent.click(within(picker).getByRole('button', { name: 'Choose file' }));
    expect(await within(picker).findByText(FILE_ONLY)).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Run Downsize on this file?' })).toBeNull();
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it('a folder named like a media file is refused by the server as not a file, in the same words', async () => {
    mocks.queue.mockRejectedValue(
      new ORPCError('PATH_REJECTED', {
        defined: true,
        status: 400,
        data: { path: '/media/movies/Extras.mkv', reason: 'not a file' },
      }),
    );
    renderAt('/workflows/w1', <Harness workflow={summary()} />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    const picker = await screen.findByRole('dialog', { name: 'Run Downsize v3 on a file' });
    await within(picker).findByRole('button', { name: /s\.mkv/ });
    fireEvent.change(within(picker).getByLabelText('Or type a path'), {
      target: { value: '/media/movies/Extras.mkv' },
    });
    fireEvent.click(within(picker).getByRole('button', { name: 'Choose file' }));
    const confirm = await screen.findByRole('dialog', { name: 'Run Downsize on this file?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Run' }));
    expect(await within(picker).findByText(FILE_ONLY)).toBeTruthy();
    expect(mocks.queue).toHaveBeenCalledWith(expect.objectContaining({ fileOnly: true }));
  });

  it('open() does nothing for a workflow that cannot run for real', async () => {
    renderAt('/workflows/w1', <Harness workflow={summary({ active: null })} />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    await Promise.resolve();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled();
  });
});
