import { ORPCError } from '@orpc/client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chainMainReplace, otterFinchSub } from '../../testing/fixtures/graphs.ts';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  validate: vi.fn(),
  save: vi.fn(),
  rename: vi.fn(),
  versions: vi.fn(),
  activate: vi.fn(),
  deactivate: vi.fn(),
  jobsList: vi.fn(),
  nodesList: vi.fn(),
  queue: vi.fn(),
  librariesList: vi.fn(),
  browse: vi.fn(),
}));
vi.mock('../../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return {
    api: {
      workflows: {
        get: mocks.get,
        list: mocks.list,
        validate: mocks.validate,
        save: mocks.save,
        rename: mocks.rename,
        versions: mocks.versions,
        activate: mocks.activate,
        deactivate: mocks.deactivate,
      },
      nodes: { list: mocks.nodesList },
      jobs: { queue: mocks.queue, list: mocks.jobsList },
      libraries: { list: mocks.librariesList, browse: mocks.browse },
    },
    isDefinedError: orpc.isDefinedError,
    safe: orpc.safe,
  };
});

import {
  deferred,
  detail,
  flowNode,
  loadedEditor,
  menuItem,
  minutesAgo,
  paletteButton,
  pill,
  renderEditor,
  saveOk,
  setupEditorPageMocks,
} from './testing.tsx';

setupEditorPageMocks(mocks);
afterEach(cleanup);

describe('EditorPage try on a file (Task 24)', () => {
  const shows = {
    id: 'l1',
    name: 'Shows',
    path: '/media/Shows',
    recycleFolder: null,
    processHardlinked: false,
    verifyFullDecode: false,
    feeds: null,
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(60),
  };

  beforeEach(() => {
    mocks.queue.mockReset().mockResolvedValue({ runId: 'r1', jobIds: ['j1'] });
    mocks.librariesList.mockReset().mockResolvedValue({ libraries: [shows], notices: [] });
    mocks.browse.mockReset().mockResolvedValue({
      dirs: [],
      files: [{ name: 'otter-finch.mp4', sizeBytes: 2_410_000_000, mtime: minutesAgo(60) }],
    });
  });

  async function pickOtter(title = 'Dry run Smoke on a file') {
    const dialog = await screen.findByRole('dialog', { name: title });
    fireEvent.click(await within(dialog).findByRole('button', { name: /otter-finch\.mp4/ }));
  }

  it('EditorPage "Dry run on a file" queues a dry run for the saved version and navigates to the job; with a dirty draft the button reads "Save, then try" and saves first', async () => {
    const view = await loadedEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Dry run on a file' }));
    await pickOtter();
    await waitFor(() => expect(view.location()).toBe('/jobs/j1'));
    expect(mocks.queue).toHaveBeenCalledWith({
      path: '/media/Shows/otter-finch.mp4',
      workflowId: 'wf1',
      dryRun: true,
    });
    expect(mocks.save).not.toHaveBeenCalled();

    view.navigate('/workflows/wf1');
    await screen.findByRole('group', { name: /Action Keep languages/ });
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    expect(screen.queryByRole('button', { name: 'Dry run on a file' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save, then try' }));
    await pickOtter();
    await waitFor(() => expect(view.location()).toBe('/jobs/j1'));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0]?.[0]).toMatchObject({ id: 'wf1', baseVersion: 3 });
    // The save came first: the run is of the version just saved.
    expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.queue.mock.invocationCallOrder[1] ?? 0,
    );
    // Nothing asked to leave: the draft was saved.
    expect(screen.queryByRole('dialog', { name: 'Leave without saving?' })).toBeNull();
  });

  it('"Run on a file" is disabled until a version is active, then runs the active version for real', async () => {
    await loadedEditor();
    const off = menuItem('Run on a file') as HTMLElement;
    expect(off.getAttribute('aria-disabled')).toBe('true');
    expect(off.title).toBe('Activate a version to run for real');
    cleanup();

    mocks.get.mockResolvedValue({
      ...detail(),
      active: {
        version: 2,
        runnable: true,
        activatedAt: minutesAgo(30),
        activatedBy: 'u1',
      },
    });
    const live = await loadedEditor();
    fireEvent.click(menuItem('Run on a file') as HTMLElement);
    const picker = await screen.findByRole('dialog', { name: 'Run Smoke v2 on a file' });
    fireEvent.click(await within(picker).findByRole('button', { name: /otter-finch\.mp4/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Run Smoke on this file?' });
    expect(confirm.textContent).toContain(
      'Applies Smoke v2 (active) to /media/Shows/otter-finch.mp4. The original moves to /media/Shows/.transcoda-recycle.',
    );
    fireEvent.click(within(confirm).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(live.location()).toBe('/jobs/j1'));
    expect(mocks.queue).toHaveBeenCalledWith({
      path: '/media/Shows/otter-finch.mp4',
      workflowId: 'wf1',
      dryRun: false,
      fileOnly: true,
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('"Dry run on a file" on a past version queues jobs.queue with workflowVersion: 2', async () => {
    mocks.get.mockResolvedValue({ ...detail(chainMainReplace(), 2), currentVersion: 3 });
    const view = await loadedEditor('/workflows/wf1?version=2');
    fireEvent.click(screen.getByRole('button', { name: 'Dry run on a file' }));
    await pickOtter();
    await waitFor(() => expect(view.location()).toBe('/jobs/j1'));
    expect(mocks.queue).toHaveBeenCalledWith({
      path: '/media/Shows/otter-finch.mp4',
      workflowId: 'wf1',
      dryRun: true,
      workflowVersion: 2,
    });
  });

  it('"Save, then try" waits for a save already running, then queues (final review M8)', async () => {
    const pending = deferred<ReturnType<typeof saveOk>>();
    mocks.save.mockReturnValueOnce(pending.promise);
    const view = await loadedEditor();
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.click(screen.getByRole('button', { name: 'Save, then try' }));
    await screen.findByRole('dialog', { name: 'Dry run Smoke on a file' });
    // A save starts (header) while the picker is open.
    fireEvent.click(screen.getByRole('button', { name: 'Save v4' }));
    await pickOtter();
    expect(mocks.queue).not.toHaveBeenCalled();
    await act(async () => pending.resolve(saveOk(4)));
    await waitFor(() => expect(view.location()).toBe('/jobs/j1'));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.queue).toHaveBeenCalledTimes(1);
  });

  it('a folder pick that queues several files navigates to the run summary', async () => {
    mocks.queue.mockResolvedValueOnce({ runId: 'r9', jobIds: ['j1', 'j2'] });
    const view = await loadedEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Dry run on a file' }));
    await pickOtter();
    await waitFor(() => expect(view.location()).toBe('/runs/r9'));
  });

  it('a failed save stays in the editor without queueing; WORKFLOW_INVALID is a toast', async () => {
    mocks.save.mockRejectedValueOnce(new ORPCError('PAYLOAD_TOO_LARGE', { status: 413 }));
    const view = await loadedEditor();
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.click(screen.getByRole('button', { name: 'Save, then try' }));
    await pickOtter();
    expect(await screen.findByText('The workflow is too large to save (2 MB limit)')).toBeTruthy();
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(view.location()).toBe('/workflows/wf1');
    expect(pill().textContent).toBe('v3 · Not active · unsaved changes');

    mocks.queue.mockRejectedValueOnce(
      new ORPCError('WORKFLOW_INVALID', { defined: true, status: 422, data: { issues: [] } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save, then try' }));
    await pickOtter();
    expect(await screen.findByText('Fix the errors first')).toBeTruthy();
    expect(view.location()).toBe('/workflows/wf1');
  });

  it('toolbar "Try this node" navigates with ?node=<id> and JobPage preselects it', async () => {
    const view = await loadedEditor();
    const { container } = view;
    fireEvent.click(flowNode(container, 'keep'));
    await waitFor(() => expect(flowNode(container, 'keep').classList).toContain('selected'));
    fireEvent.click(await screen.findByRole('button', { name: 'Try this node' }));
    await pickOtter();
    await waitFor(() => expect(view.location()).toBe('/jobs/j1?node=keep'));
  });

  it('a sub-workflow cannot be tried on a file', async () => {
    mocks.get.mockResolvedValue({
      ...detail(otterFinchSub()),
      kind: 'subworkflow',
    });
    renderEditor();
    const tryIt = (await screen.findByRole('button', {
      name: 'Dry run on a file',
    })) as HTMLButtonElement;
    expect(tryIt.disabled).toBe(true);
    expect(tryIt.title).toBe('A sub-workflow is tried from a workflow that runs it');
  });
});
