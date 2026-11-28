import { ORPCError } from '@orpc/client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chainMainReplace } from '../../testing/fixtures/graphs.ts';

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
  conflictError,
  detail,
  loadedEditor,
  minutesAgo,
  paletteButton,
  pill,
  saveOk,
  setupEditorPageMocks,
} from './testing.tsx';

setupEditorPageMocks(mocks);
afterEach(cleanup);

describe('EditorPage leave guard, undo/redo and save shortcut (Task 19)', () => {
  const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
  const keepCount = () => screen.getAllByRole('group', { name: /Action Keep languages/ }).length;
  const leaveDialog = () => screen.getByRole('dialog', { name: 'Leave without saving?' });
  const crumbLink = () =>
    within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', {
      name: 'Workflows',
    });

  it('navigating away with a dirty draft opens "Leave without saving?"; Stay keeps the route; Leave navigates; Save and leave saves first', async () => {
    mocks.save
      .mockRejectedValueOnce(new ORPCError('PAYLOAD_TOO_LARGE', { status: 413 }))
      .mockResolvedValueOnce(saveOk(4));
    const view = await loadedEditor();
    fireEvent.click(crumbLink());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(view.location()).toBe('/');

    view.navigate('/workflows/wf1');
    await screen.findByRole('group', { name: /Action Keep languages/ });
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.click(crumbLink());
    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Stay' }));
    expect(view.location()).toBe('/workflows/wf1');
    expect(pill().textContent).toBe('v3 · Not active · unsaved changes');

    // A failed save stays inside the dialog; the draft and the route are kept.
    fireEvent.click(crumbLink());
    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Save and leave' }));
    const alert = await within(leaveDialog()).findByRole('alert');
    expect(alert.textContent).toContain('The workflow is too large to save (2 MB limit)');
    expect(view.location()).toBe('/workflows/wf1');
    expect(pill().textContent).toBe('v3 · Not active · unsaved changes');

    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Save and leave' }));
    await waitFor(() => expect(view.location()).toBe('/'));
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.calls[1]?.[0]).toMatchObject({ baseVersion: 3 });
  });

  it('"Leave" from the versions panel drops the draft and opens that version', async () => {
    mocks.versions.mockResolvedValue({
      versions: [
        { version: 3, note: null, createdBy: 'u1', createdAt: minutesAgo(2) },
        { version: 2, note: null, createdBy: 'u1', createdAt: minutesAgo(60) },
      ],
    });
    const view = await loadedEditor();
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.click(pill());
    fireEvent.click(
      await within(screen.getByRole('dialog', { name: 'Versions' })).findByRole('link', {
        name: /^v2 · /,
      }),
    );
    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Leave' }));
    expect(view.location()).toBe('/workflows/wf1?version=2');
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith({ id: 'wf1', version: 2 }));
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('a conflict on "Save and leave" closes it and opens the conflict dialog', async () => {
    mocks.save.mockRejectedValueOnce(conflictError(5));
    const view = await loadedEditor();
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.click(crumbLink());
    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Save and leave' }));
    expect(
      await screen.findByRole('dialog', { name: 'Someone saved v5 while you were editing' }),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Leave without saving?' })).toBeNull();
    expect(view.location()).toBe('/workflows/wf1');
  });

  it('"Save and leave" stays when the draft changed while it saved', async () => {
    let answer: (v: unknown) => void = () => {};
    mocks.save.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const view = await loadedEditor();
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.click(crumbLink());
    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Save and leave' }));
    // An edit lands while the save is in flight.
    fireEvent.click(paletteButton('Action', 'Remux'));
    await act(async () => answer(saveOk(4)));
    const alert = await within(leaveDialog()).findByRole('alert');
    expect(alert.textContent).toBe('It changed while saving. Save again to keep the new changes.');
    expect(view.location()).toBe('/workflows/wf1');
    expect(pill().textContent).toBe('v4 · Not active · unsaved changes');
  });

  it('undo/redo header buttons reflect the stacks and loading a version clears them', async () => {
    mocks.versions.mockResolvedValue({
      versions: [
        { version: 4, note: null, createdBy: 'u1', createdAt: minutesAgo(0) },
        { version: 3, note: null, createdBy: 'u1', createdAt: minutesAgo(2) },
      ],
    });
    const view = await loadedEditor();
    expect(button('Undo').title).toBe('Undo (⌘Z)');
    expect(button('Redo').title).toBe('Redo (⇧⌘Z)');
    expect(button('Undo').disabled).toBe(true);
    expect(button('Redo').disabled).toBe(true);

    fireEvent.click(paletteButton('Action', 'Keep languages'));
    expect(keepCount()).toBe(2);
    expect(button('Undo').disabled).toBe(false);
    expect(button('Redo').disabled).toBe(true);

    fireEvent.click(button('Undo'));
    await waitFor(() => expect(keepCount()).toBe(1));
    expect(button('Undo').disabled).toBe(true);
    expect(button('Redo').disabled).toBe(false);
    expect(pill().textContent).toBe('v3 · Not active · saved 2 min ago');

    fireEvent.click(button('Redo'));
    await waitFor(() => expect(keepCount()).toBe(2));
    expect(button('Undo').disabled).toBe(false);
    expect(button('Redo').disabled).toBe(true);

    // Saving keeps the history; loading a version clears it.
    fireEvent.click(button('Save v4'));
    expect(await screen.findByText('Saved v4')).toBeTruthy();
    expect(button('Undo').disabled).toBe(false);
    mocks.get.mockResolvedValue({ ...detail(chainMainReplace(), 3), currentVersion: 4 });
    fireEvent.click(pill());
    fireEvent.click(
      await within(screen.getByRole('dialog', { name: 'Versions' })).findByRole('link', {
        name: /^v3 · /,
      }),
    );
    expect(view.location()).toBe('/workflows/wf1?version=3');
    await screen.findByText('Viewing v3 — current is v4');
    expect(button('Undo').disabled).toBe(true);
    expect(button('Redo').disabled).toBe(true);

    // Back on the current version: a fresh load, nothing to undo.
    mocks.get.mockResolvedValue(detail(chainMainReplace(), 4));
    view.navigate('/workflows/wf1');
    await waitFor(() => expect(pill().textContent).toMatch(/^v4 · /));
    expect(button('Undo').disabled).toBe(true);
    expect(button('Redo').disabled).toBe(true);
  });

  it('a reload after a conflict clears the undo history', async () => {
    mocks.save.mockRejectedValueOnce(conflictError(5));
    await loadedEditor();
    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.click(button('Save v4'));
    const dialog = await screen.findByRole('dialog');
    mocks.get.mockResolvedValueOnce(detail(chainMainReplace(), 5));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload the latest version' }));
    await waitFor(() => expect(pill().textContent).toMatch(/^v5 · Not active · saved/));
    expect(button('Undo').disabled).toBe(true);
  });

  it('Mod+S saves when dirty and does nothing when clean or read-only', async () => {
    await loadedEditor();
    // Clean: nothing is sent, and the browser's own save dialog is still held off.
    expect(fireEvent.keyDown(document.body, { key: 's', metaKey: true })).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();

    fireEvent.click(paletteButton('Action', 'Keep languages'));
    fireEvent.keyDown(document.body, { key: 's', metaKey: true });
    expect(await screen.findByText('Saved v4')).toBeTruthy();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(pill().textContent).toMatch(/^v4 · /);
    fireEvent.keyDown(document.body, { key: 's', ctrlKey: true });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    cleanup();

    mocks.get.mockResolvedValue({ ...detail(chainMainReplace(), 3), currentVersion: 7 });
    await loadedEditor('/workflows/wf1?version=3');
    fireEvent.keyDown(document.body, { key: 's', metaKey: true });
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
});
