import { ORPCError } from '@orpc/client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '../test/render.tsx';

const mocks = vi.hoisted(() => ({ list: vi.fn(), browse: vi.fn() }));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return {
    api: { libraries: { list: mocks.list, browse: mocks.browse } },
    isDefinedError: orpc.isDefinedError,
    safe: orpc.safe,
  };
});

import { FilePicker } from './FilePicker.tsx';

const library = (id: string, name: string, path: string) => ({
  id,
  name,
  path,
  recycleFolder: null,
  processHardlinked: false,
  verifyFullDecode: false,
  feeds: null,
  createdAt: '2026-10-16T18:00:00.000Z',
  updatedAt: '2026-10-16T18:00:00.000Z',
});

const file = (name: string, sizeBytes: number) => ({
  name,
  sizeBytes,
  mtime: '2026-10-16T18:00:00.000Z',
});

const rejected = (path: string, reason: string) =>
  new ORPCError('PATH_REJECTED', { defined: true, status: 400, data: { path, reason } });

beforeEach(() => {
  mocks.list.mockReset().mockResolvedValue({
    libraries: [library('l1', 'Shows', '/media/Shows'), library('l2', 'Films', '/media/Films')],
  });
  mocks.browse.mockReset().mockImplementation(async ({ id, path }) => {
    if (id === 'l1' && path === '') return { dirs: ['Bluey'], files: [] };
    if (id === 'l1' && path === 'Bluey') {
      return { dirs: ['Season 01'], files: [file('tigger-pooh.mp4', 2_410_000_000)] };
    }
    if (id === 'l2' && path === '') return { dirs: [], files: [file('film.mkv', 790_000_000)] };
    return { dirs: [], files: [] };
  });
});
afterEach(cleanup);

function show(
  onPick: (path: string, library: unknown) => Promise<string | null> | undefined = vi.fn(),
) {
  const onClose = vi.fn();
  renderAt(
    '/',
    <FilePicker open title="Dry run TV cleanup on a file" onPick={onPick} onClose={onClose} />,
  );
  return { onPick, onClose };
}

describe('FilePicker', () => {
  it('FilePicker browses folders, picks a file path under the library root, and shows PATH_REJECTED inline for a typed path', async () => {
    const onPick = vi.fn(async (path: string) =>
      path.startsWith('/etc') ? 'outside library root' : null,
    );
    show(onPick);
    const dialog = await screen.findByRole('dialog', { name: 'Dry run TV cleanup on a file' });
    const select = within(dialog).getByRole('button', { name: /^Library/ });
    fireEvent.click(select);
    expect(
      within(dialog)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Shows', 'Films']);
    fireEvent.click(within(dialog).getByRole('option', { name: 'Shows' }));

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Bluey' }));
    const pick = await within(dialog).findByRole('button', { name: /tigger-pooh\.mp4/ });
    expect(pick.textContent).toContain('2.41 GB');
    const crumbs = within(dialog).getByRole('navigation', { name: 'Folder' });
    expect(crumbs.textContent).toBe('Shows/Bluey');
    expect(mocks.browse).toHaveBeenLastCalledWith({ id: 'l1', path: 'Bluey' });

    fireEvent.click(pick);
    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith(
        '/media/Shows/Bluey/tigger-pooh.mp4',
        expect.objectContaining({ id: 'l1', name: 'Shows' }),
      ),
    );

    // Up returns to the root; another library browses its own root.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Up' }));
    await within(dialog).findByRole('button', { name: 'Bluey' });
    expect(within(dialog).queryByRole('button', { name: 'Up' })).toBeNull();
    fireEvent.click(select);
    fireEvent.click(within(dialog).getByRole('option', { name: 'Films' }));
    await within(dialog).findByRole('button', { name: /film\.mkv/ });

    const typed = within(dialog).getByLabelText('Or type a path');
    fireEvent.change(typed, { target: { value: '/etc/passwd' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start dry run' }));
    await waitFor(() => expect(onPick).toHaveBeenLastCalledWith('/etc/passwd', null));
    const reason = await within(dialog).findByText('outside library root');
    expect(typed.getAttribute('aria-describedby')).toBe(reason.id);
    expect(typed.getAttribute('aria-invalid')).toBe('true');
  });

  it('onPick receives the browsed library for a list pick and the holding library for a typed path; confirmLabel and note replace the dry-run words', async () => {
    const onPick = vi.fn(async () => null);
    renderAt(
      '/',
      <FilePicker
        open
        title="Run Downsize v3 on a file"
        confirmLabel="Choose file"
        note={null}
        onPick={onPick}
        onClose={() => {}}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Run Downsize v3 on a file' });
    expect(within(dialog).queryByText(/This is a dry run/)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Start dry run' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: /^Library/ }));
    fireEvent.click(within(dialog).getByRole('option', { name: 'Films' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: /film\.mkv/ }));
    await waitFor(() =>
      expect(onPick).toHaveBeenLastCalledWith(
        '/media/Films/film.mkv',
        expect.objectContaining({ id: 'l2' }),
      ),
    );
    fireEvent.change(within(dialog).getByLabelText('Or type a path'), {
      target: { value: '/media/Shows/Bluey/x.mkv' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose file' }));
    await waitFor(() =>
      expect(onPick).toHaveBeenLastCalledWith(
        '/media/Shows/Bluey/x.mkv',
        expect.objectContaining({ id: 'l1' }),
      ),
    );
  });

  it('is a wide dialog: one-line crumbs with full names on hover, file names break at dots, a placeholder under the library', async () => {
    const long = 'Example.Movie.2001.Hybrid.BluRay.Remux.1080p.AVC.DTS-HD.MA.5.1-GROUP.mkv';
    mocks.browse.mockImplementation(async ({ path }) =>
      path === 'Bluey' ? { dirs: [], files: [file(long, 1)] } : { dirs: ['Bluey'], files: [] },
    );
    show();
    const dialog = await screen.findByRole('dialog', { name: 'Dry run TV cleanup on a file' });
    expect(dialog.classList.contains('dialog-wide')).toBe(true);
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Bluey' }));
    const pick = await within(dialog).findByRole('button', {
      name: new RegExp(long.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    });
    const name = pick.querySelector('.picker-name') as HTMLElement;
    // Same text, with break opportunities after the dots and dashes.
    expect(name.textContent).toBe(long);
    expect(name.querySelectorAll('wbr').length).toBeGreaterThan(10);
    const crumbs = within(dialog).getByRole('navigation', { name: 'Folder' });
    expect(within(crumbs).getByText('Bluey').getAttribute('title')).toBe('Bluey');
    expect(within(crumbs).getByRole('button', { name: 'Shows' }).getAttribute('title')).toBe(
      'Shows',
    );
    expect(within(dialog).getByLabelText('Or type a path').getAttribute('placeholder')).toBe(
      '/media/Shows/…/file.mkv',
    );
  });

  it('says it is a dry run, and offers no native select', async () => {
    show(vi.fn(async () => null));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/^This is a dry run: Transcoda plans what would happen to a file/),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Start dry run' })).toBeTruthy();
    expect(dialog.querySelector('select')).toBeNull();
    expect(within(dialog).queryByText('Use this path')).toBeNull();
  });

  it('shows why a file picked from the list was refused under the list, not under the typed path', async () => {
    const onPick = vi.fn(async () => 'still growing');
    show(onPick);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Bluey' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: /tigger-pooh\.mp4/ }));
    const reason = await within(dialog).findByText("Can't use tigger-pooh.mp4: still growing");
    expect(reason.previousElementSibling?.classList.contains('picker-list')).toBe(true);
    const typed = within(dialog).getByLabelText('Or type a path');
    expect(typed.getAttribute('aria-invalid')).toBeNull();
  });

  it('shows a browse refusal in the folder list with its reason', async () => {
    mocks.browse.mockImplementation(async ({ path }) => {
      if (path === '') return { dirs: ['link'], files: [] };
      throw rejected(path, 'symlink escapes root');
    });
    show();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'link' }));
    expect(
      await within(dialog).findByText("Can't open this folder: symlink escapes root"),
    ).toBeTruthy();
  });

  it('without libraries says "Create a library first" with a link', async () => {
    mocks.list.mockResolvedValue({ libraries: [], notices: [] });
    show();
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Create a library first')).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Libraries' }).getAttribute('href')).toBe(
      '/libraries',
    );
    // A typed path still works without a library to browse.
    expect(within(dialog).getByLabelText('Or type a path')).toBeTruthy();
  });
});
