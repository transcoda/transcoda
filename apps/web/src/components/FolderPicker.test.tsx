import { ORPCError } from '@orpc/client';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ browseDirs: vi.fn() }));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return {
    api: { fs: { browseDirs: mocks.browseDirs } },
    isDefinedError: orpc.isDefinedError,
    safe: orpc.safe,
  };
});

import { FolderPicker } from './FolderPicker.tsx';

const dir = (path: string, writable = true) => ({
  name: path.split('/').pop() ?? '',
  path,
  writable,
});

const TREE: Record<string, { entries: ReturnType<typeof dir>[]; truncated?: boolean }> = {
  '/': { entries: [dir('/data'), dir('/media'), dir('/movies', false)] },
  '/media': { entries: [dir('/media/Shows'), dir('/media/Films')] },
  '/media/Shows': { entries: [] },
  '/movies': { entries: [dir('/movies/Old')] },
  '/data': { entries: [], truncated: true },
};

const parentOf = (p: string) => (p === '/' ? null : p.slice(0, p.lastIndexOf('/')) || '/');

beforeEach(() => {
  mocks.browseDirs.mockReset().mockImplementation(async ({ path }: { path: string }) => {
    const hit = TREE[path];
    if (!hit) {
      throw new ORPCError('FORBIDDEN', {
        defined: true,
        status: 403,
        message: "This folder can't be opened",
      });
    }
    return {
      path,
      writable: path !== '/movies',
      parent: parentOf(path),
      entries: hit.entries,
      truncated: hit.truncated ?? false,
    };
  });
});
afterEach(cleanup);

function show(start = '/') {
  const onChoose = vi.fn();
  const onClose = vi.fn();
  render(<FolderPicker open start={start} onChoose={onChoose} onClose={onClose} />);
  return { onChoose, onClose };
}

const dialog = () => screen.findByRole('dialog', { name: 'Choose a folder' });

describe('FolderPicker', () => {
  it('opens at the start folder, lists folders, opens one by click and shows breadcrumbs', async () => {
    show('/');
    const d = await dialog();
    expect(await within(d).findByRole('button', { name: 'media' })).toBeTruthy();
    fireEvent.click(within(d).getByRole('button', { name: 'media' }));
    expect(await within(d).findByRole('button', { name: 'Shows' })).toBeTruthy();
    const crumbs = within(d).getByRole('navigation', { name: 'Folder' });
    expect(within(crumbs).getByRole('button', { name: '/' })).toBeTruthy();
    expect(within(crumbs).getByText('media').getAttribute('aria-current')).toBe('location');
    fireEvent.click(within(crumbs).getByRole('button', { name: '/' }));
    expect(await within(d).findByRole('button', { name: /^movies/ })).toBeTruthy();
  });

  it('is keyboard navigable: arrows move between folders, Enter opens one, Up goes to the parent', async () => {
    show('/');
    const d = await dialog();
    const data = await within(d).findByRole('button', { name: 'data' });
    await waitFor(() => expect(document.activeElement).toBe(data));
    fireEvent.keyDown(data, { key: 'ArrowDown' });
    const media = within(d).getByRole('button', { name: 'media' });
    expect(document.activeElement).toBe(media);
    fireEvent.keyDown(media, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(d).getByRole('button', { name: /^movies/ }));
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    // Stays on the last folder.
    expect(document.activeElement).toBe(within(d).getByRole('button', { name: /^movies/ }));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(document.activeElement).toBe(data);
    fireEvent.keyDown(data, { key: 'End' });
    expect(document.activeElement).toBe(within(d).getByRole('button', { name: /^movies/ }));
    // Enter on a button is a click.
    fireEvent.click(media);
    expect(await within(d).findByRole('button', { name: 'Films' })).toBeTruthy();
    fireEvent.click(within(d).getByRole('button', { name: 'Up' }));
    expect(await within(d).findByRole('button', { name: 'media' })).toBeTruthy();
  });

  it('chooses the folder being shown and returns its path', async () => {
    const { onChoose } = show('/media');
    const d = await dialog();
    await within(d).findByRole('button', { name: 'Shows' });
    fireEvent.click(within(d).getByRole('button', { name: 'Shows' }));
    await within(d).findByText('No folders here');
    fireEvent.click(within(d).getByRole('button', { name: 'Choose this folder' }));
    expect(onChoose).toHaveBeenCalledWith('/media/Shows');
  });

  it('greys a read-only folder with a reason; it can be opened but is not chosen as a root', async () => {
    const { onChoose } = show('/');
    const d = await dialog();
    const ro = await within(d).findByRole('button', { name: /^movies/ });
    expect(ro.className).toContain('is-readonly');
    expect(within(d).getByText("Transcoda can't write here")).toBeTruthy();
    expect(
      within(d).getByRole('button', { name: 'Choose this folder' }).hasAttribute('disabled'),
    ).toBe(false);
    fireEvent.click(ro);
    await within(d).findByRole('button', { name: 'Old' });
    // /movies itself is not writable: nothing to choose until a writable folder is open.
    fireEvent.click(within(d).getByRole('button', { name: 'Up' }));
    await within(d).findByRole('button', { name: /^movies/ });
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('disables Choose when the open folder is read-only and says why', async () => {
    const { onChoose } = show('/movies');
    const d = await dialog();
    await within(d).findByRole('button', { name: 'Old' });
    expect(within(d).getByText("Transcoda can't write here")).toBeTruthy();
    const choose = within(d).getByRole('button', { name: 'Choose this folder' });
    expect(choose.hasAttribute('disabled')).toBe(true);
    fireEvent.click(choose);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('falls back to / when the start folder cannot be opened', async () => {
    show('/nope/deeper');
    const d = await dialog();
    expect(await within(d).findByRole('button', { name: 'media' })).toBeTruthy();
    expect(mocks.browseDirs).toHaveBeenLastCalledWith({ path: '/' });
  });

  it('describes the arrow-key use on the list', async () => {
    show('/');
    const d = await dialog();
    const list = await within(d).findByRole('list', { name: 'Folders' });
    const hint = document.getElementById(list.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toMatch(/arrow keys/i);
    expect(hint?.className).toContain('sr-only');
  });

  it('stays on the current folder with a message when a folder cannot be opened', async () => {
    show('/media');
    const d = await dialog();
    await within(d).findByRole('button', { name: 'Shows' });
    // /media/Films is not in the tree: the server refuses it.
    fireEvent.click(within(d).getByRole('button', { name: 'Films' }));
    expect((await within(d).findByRole('alert')).textContent).toMatch(/Films/);
    expect(within(d).getByRole('button', { name: 'Shows' })).toBeTruthy();
    const crumbs = within(d).getByRole('navigation', { name: 'Folder' });
    expect(within(crumbs).getByText('media').getAttribute('aria-current')).toBe('location');
    expect(mocks.browseDirs).not.toHaveBeenLastCalledWith({ path: '/' });
    // A later successful move clears the message.
    fireEvent.click(within(d).getByRole('button', { name: 'Shows' }));
    await within(d).findByText('No folders here');
    expect(within(d).queryByRole('alert')).toBeNull();
  });

  it('says when the list is cut off', async () => {
    show('/data');
    const d = await dialog();
    expect(await within(d).findByText(/Only the first 500 folders are shown/)).toBeTruthy();
  });

  it('shows an error when even / cannot be listed, and Cancel closes', async () => {
    mocks.browseDirs.mockReset().mockRejectedValue(new Error('network down'));
    const { onClose } = show('/');
    const d = await dialog();
    expect((await within(d).findByRole('alert')).textContent).toBeTruthy();
    fireEvent.click(within(d).getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});
