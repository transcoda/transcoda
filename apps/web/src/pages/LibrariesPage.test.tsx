import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORPCError } from '@orpc/client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Library, WorkflowSummary } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '../test/render.tsx';

const mocks = vi.hoisted(() => ({
  libraries: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    dismissNotices: vi.fn(),
  },
  workflows: { list: vi.fn(), get: vi.fn(), versions: vi.fn(), activate: vi.fn() },
  jobs: { queue: vi.fn(), list: vi.fn() },
  nodes: { list: vi.fn() },
  fs: { browseDirs: vi.fn() },
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { LibrariesPage } from './LibrariesPage.tsx';

const at = '2026-10-16T18:00:00.000Z';

function library(over: Partial<Library>): Library {
  return {
    id: 'l',
    name: 'l',
    path: '/media/l',
    recycleFolder: null,
    processHardlinked: false,
    verifyFullDecode: false,
    runHours: null,
    feeds: null,
    namedByInactive: [],
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

function workflow(over: Partial<WorkflowSummary>): WorkflowSummary {
  return {
    id: 'w',
    name: 'w',
    kind: 'workflow',
    active: null,
    currentVersion: 1,
    valid: true,
    errorCount: 0,
    usesOutdatedSubworkflow: false,
    feedsLibrary: null,
    libraryInput: null,
    usedBy: [],
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

function activeV(version: number, runnable = true): WorkflowSummary['active'] {
  return { version, runnable, activatedAt: at, activatedBy: 'u1' };
}

const shows = library({
  id: 'l1',
  name: 'Shows',
  path: '/media/shows',
  feeds: { workflowId: 'w1', name: 'Downsize', version: 3 },
});
const movies = library({
  id: 'l2',
  name: 'Movies',
  path: '/media/movies',
  recycleFolder: '/media/movies/.trash',
  processHardlinked: true,
  namedByInactive: [{ workflowId: 'w2', name: 'Movie cleanup', version: 1 }],
});

const workflows = [
  workflow({
    id: 'w1',
    name: 'Downsize',
    active: activeV(3),
    currentVersion: 6,
    feedsLibrary: { id: 'l1', name: 'Shows' },
    libraryInput: { id: 'l1', name: 'Shows' },
  }),
  workflow({ id: 's1', name: 'Audio tidy', kind: 'subworkflow' }),
  workflow({ id: 'w2', name: 'Movie cleanup', libraryInput: { id: 'l2', name: 'Movies' } }),
  workflow({
    id: 'w3',
    name: 'Archive',
    currentVersion: 2,
    libraryInput: { id: 'l1', name: 'Shows' },
  }),
];

function defined(code: string, status: number, message: string, data?: unknown) {
  return new ORPCError(code, { defined: true, status, message, data });
}

beforeEach(() => {
  mocks.libraries.list.mockReset().mockResolvedValue({ libraries: [shows, movies], notices: [] });
  // The row as listed, unless a test says another tab changed it.
  mocks.libraries.get
    .mockReset()
    .mockImplementation(async ({ id }: { id: string }) => [shows, movies].find((l) => l.id === id));
  mocks.libraries.create.mockReset();
  mocks.libraries.update.mockReset();
  mocks.libraries.delete.mockReset();
  mocks.libraries.dismissNotices.mockReset();
  mocks.workflows.list.mockReset().mockResolvedValue({ workflows });
  mocks.workflows.get.mockReset().mockResolvedValue({ activeIssues: [] });
  mocks.workflows.versions.mockReset().mockResolvedValue({ versions: [] });
  mocks.workflows.activate.mockReset();
  mocks.jobs.queue.mockReset();
  mocks.jobs.list.mockReset().mockResolvedValue({ jobs: [] });
  mocks.nodes.list.mockReset().mockResolvedValue({ nodes: [] });
  mocks.fs.browseDirs.mockReset().mockImplementation(async ({ path }: { path: string }) => ({
    path,
    writable: path !== '/media',
    parent: path === '/' ? null : '/',
    entries:
      path === '/'
        ? [
            { name: 'data', path: '/data', writable: true },
            { name: 'media', path: '/media', writable: false },
          ]
        : [{ name: 'New', path: `${path}/New`, writable: true }],
    truncated: false,
  }));
});
afterEach(cleanup);

/** The row of a library: its name cell starts with the name (run hours may follow it). */
const rowOf = async (name: string) =>
  (await screen.findByRole('cell', { name: new RegExp(`^${name}(?![a-z0-9])`) })).closest(
    'tr',
  ) as HTMLElement;

/** Opens a row's "…" menu and picks an item. */
async function pickAction(name: string, item: string) {
  fireEvent.click(within(await rowOf(name)).getByRole('button', { name: `Actions for ${name}` }));
  fireEvent.click(screen.getByRole('menuitem', { name: item }));
}

/** The text an element's aria-describedby points at. */
const descriptionOf = (el: HTMLElement) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

describe('LibrariesPage', () => {
  it('lists libraries with path, non-default settings and the workflow that feeds each', async () => {
    renderAt('/libraries', <LibrariesPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Libraries' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New library' })).toBeTruthy();

    const first = await rowOf('Shows');
    // The count sits beside the H1 once the list is in.
    expect(screen.getByRole('heading', { level: 1, name: 'Libraries 2' })).toBeTruthy();
    // The path: one muted line cut from the left, the whole path as its title.
    const path = within(first).getByTitle('/media/shows');
    expect(path.className).toContain('mono');
    expect(path.className).toContain('lib-path');
    expect(path.textContent).toBe('\u200e/media/shows\u200e');
    // Default recycle folder and hardlink setting: nothing printed.
    expect(within(first).queryByText(/Recycles to/)).toBeNull();
    expect(within(first).queryByText('Processes hardlinked files')).toBeNull();
    // Feeds: the workflow's name and the Workflows list's activation pill.
    expect(within(first).getByRole('cell', { name: 'Downsize Active v3' })).toBeTruthy();
    expect(within(first).getByText('Active v3').className).toContain('activation-pill is-active');
    // One inline primary and the "…" menu; no other inline row buttons.
    expect(
      within(first)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Scan Shows now', 'Actions for Shows']);

    const second = await rowOf('Movies');
    // Non-default settings: a note each under the path; a recycle folder in the root is relative.
    expect(within(second).getByText(/Recycles to/)).toBeTruthy();
    expect(within(second).getByTitle('.trash').textContent).toBe('\u200e.trash\u200e');
    expect(within(second).getByText('Processes hardlinked files')).toBeTruthy();
    // Movie cleanup's newest version names Movies but was never activated.
    expect(
      within(second).getByText("Movie cleanup has a Library input but isn't active"),
    ).toBeTruthy();
    expect(within(second).getByRole('button', { name: 'Activate v1…' })).toBeTruthy();
    expect(within(second).queryByRole('link', { name: 'Add a Library input to a workflow' })).toBe(
      null,
    );
    const scanMovies = within(second).getByRole('button', { name: 'Scan Movies now' });
    expect((scanMovies as HTMLButtonElement).disabled).toBe(true);
    expect(scanMovies.getAttribute('title')).toBe(
      'No active workflow takes files from this library',
    );
    expect(descriptionOf(scanMovies)).toBe('No active workflow takes files from this library');
    // Column names in sentence case; the header class sets the capitals (L16). The recycle folder
    // and hardlink columns are gone: they only print defaults (convention 11).
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Name',
      'Path',
      'Feeds',
      'Actions',
    ]);
  });

  it('shows a recycle folder outside the root in full, and the pill says when the feeder cannot run', async () => {
    mocks.libraries.list.mockResolvedValue({
      libraries: [{ ...shows, recycleFolder: '/trash/shows' }],
      notices: [],
    });
    mocks.workflows.list.mockResolvedValue({
      workflows: [workflow({ id: 'w1', name: 'Downsize', active: activeV(3, false) })],
    });
    renderAt('/libraries', <LibrariesPage />);
    const row = await rowOf('Shows');
    expect(within(row).getByTitle('/trash/shows')).toBeTruthy();
    expect(within(row).queryByText('Processes hardlinked files')).toBeNull();
    expect(await within(row).findByText("Active v3 · can't run")).toBeTruthy();
  });

  it('Feeds says "Add a Library input to a workflow" only when no workflow names the library', async () => {
    mocks.libraries.list.mockResolvedValue({
      libraries: [shows, { ...movies, namedByInactive: [] }],
      notices: [],
    });
    renderAt('/libraries', <LibrariesPage />);
    const row = await rowOf('Movies');
    expect(within(row).getByText('—')).toBeTruthy();
    const add = within(row).getByRole('link', { name: 'Add a Library input to a workflow' });
    expect(add.getAttribute('href')).toBe('/');
    expect(within(row).queryByRole('button', { name: /^Activate/ })).toBeNull();
  });

  it('with several inactive workflows naming the library, Feeds names the most recently edited and counts the rest', async () => {
    mocks.libraries.list.mockResolvedValue({
      libraries: [
        shows,
        {
          ...movies,
          namedByInactive: [
            { workflowId: 'w2', name: 'Movie cleanup', version: 5 },
            { workflowId: 'w4', name: 'Trim', version: 2 },
            { workflowId: 'w5', name: 'Remux', version: 1 },
          ],
        },
      ],
      notices: [],
    });
    renderAt('/libraries', <LibrariesPage />);
    const row = await rowOf('Movies');
    const text = within(row).getByText(
      "Movie cleanup (+2 more) has a Library input but isn't active",
    );
    expect(text.getAttribute('title')).toBe(
      'Library inputs naming Movies: Movie cleanup v5, Trim v2, Remux v1',
    );
    expect(within(row).getByRole('button', { name: 'Activate v5…' })).toBeTruthy();
  });

  it('Activate v1… opens the activation dialog for that workflow and version; after activating the list reloads', async () => {
    const libraryGraph = {
      formatVersion: 2,
      kind: 'workflow',
      nodes: [
        {
          id: 'in',
          type: 'core:input-library',
          typeVersion: 1,
          settings: { libraryId: 'l2' },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      groups: [],
    };
    mocks.workflows.get.mockResolvedValue({ graph: libraryGraph, activeIssues: [] });
    const fed = { ...movies, feeds: { workflowId: 'w2', name: 'Movie cleanup', version: 1 } };
    mocks.workflows.activate.mockResolvedValueOnce(
      workflow({ id: 'w2', name: 'Movie cleanup', active: activeV(1) }),
    );
    renderAt('/libraries', <LibrariesPage />);
    const row = await rowOf('Movies');
    await waitFor(() => expect(mocks.workflows.list).toHaveBeenCalled());
    fireEvent.click(within(row).getByRole('button', { name: 'Activate v1…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Activate v1 of Movie cleanup?' });
    expect(mocks.workflows.activate).not.toHaveBeenCalled();
    // From here the server answers with the feeder: only the page's reload shows it.
    mocks.libraries.list.mockResolvedValue({ libraries: [shows, fed], notices: [] });
    const confirm = within(dialog).getByRole('button', { name: 'Activate v1' });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mocks.workflows.activate).toHaveBeenCalledWith({
        id: 'w2',
        version: 1,
        confirm: true,
      }),
    );
    expect(
      await within(await rowOf('Movies')).findByRole('cell', { name: 'Movie cleanup Active v1' }),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Activate v1 of Movie cleanup?' })).toBeNull();
    expect(
      (
        within(await rowOf('Movies')).getByRole('button', {
          name: 'Scan Movies now',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("Activate v1… keeps the dialog's own errors inline and the list as it was", async () => {
    mocks.workflows.get.mockResolvedValue({
      graph: { formatVersion: 2, kind: 'workflow', nodes: [], edges: [], groups: [] },
      activeIssues: [],
    });
    mocks.workflows.activate.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderAt('/libraries', <LibrariesPage />);
    const row = await rowOf('Movies');
    await waitFor(() => expect(mocks.workflows.list).toHaveBeenCalled());
    fireEvent.click(within(row).getByRole('button', { name: 'Activate v1…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Activate v1 of Movie cleanup?' });
    const confirm = within(dialog).getByRole('button', { name: 'Activate v1' });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    // The page's load and the dialog's own lookup; a failed activation reloads nothing.
    await waitFor(() => expect(mocks.libraries.list).toHaveBeenCalledTimes(2));
    fireEvent.click(confirm);
    expect(await within(dialog).findByText('Could not activate, try again')).toBeTruthy();
    expect(mocks.libraries.list).toHaveBeenCalledTimes(2);
    expect(within(row).getByRole('button', { name: 'Activate v1…' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Activate v1 of Movie cleanup?' })).toBeNull(),
    );
  });

  it('keeps a path on one line, cut from the left, with the whole path as its title', async () => {
    renderAt('/libraries', <LibrariesPage />);
    const row = await rowOf('Movies');
    const path = within(row).getByTitle('/media/movies');
    expect(path.querySelectorAll('wbr')).toHaveLength(0);
    expect(path.textContent).toBe('\u200e/media/movies\u200e');
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(
      /\.lib-path,\s*\.lib-note-path\s*\{[^}]*white-space:\s*nowrap[^}]*direction:\s*rtl/,
    );
  });

  it('Delete returns focus to the row actions button when cancelled', async () => {
    renderAt('/libraries', <LibrariesPage />);
    await pickAction('Shows', 'Delete');
    const confirm = screen.getByRole('dialog', { name: 'Delete Shows?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Actions for Shows' }),
      ),
    );
  });

  it('shows an empty state and a load failure with Try again', async () => {
    mocks.libraries.list.mockResolvedValueOnce({ libraries: [], notices: [] });
    renderAt('/libraries', <LibrariesPage />);
    expect(await screen.findByRole('heading', { name: 'Add your first library' })).toBeTruthy();
    expect(screen.getByText(/A library is a folder Transcoda watches/).textContent).toContain(
      'workflow',
    );
    // The call to action opens the same form as the header button.
    fireEvent.click(screen.getByRole('button', { name: 'Add a library' }));
    expect(await screen.findByRole('dialog', { name: 'New library' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    cleanup();

    mocks.libraries.list.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderAt('/libraries', <LibrariesPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load the libraries: Could not reach the server');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('cell', { name: 'Shows' })).toBeTruthy();
  });

  it('creates a library and shows LIBRARY_PATH_INVALID under the path field', async () => {
    renderAt('/libraries', <LibrariesPage />);
    await rowOf('Shows');
    fireEvent.click(screen.getByRole('button', { name: 'New library' }));
    const dialog = screen.getByRole('dialog', { name: 'New library' });

    // Required fields are marked before any submit: visibly (a neutral *) and for screen readers.
    for (const name of ['Name', 'Path']) {
      const input = within(dialog).getByRole('textbox', { name });
      expect(input.getAttribute('aria-required')).toBe('true');
      const label = dialog.querySelector(`label[for="${input.id}"]`);
      expect(label?.textContent).toBe(`${name}*`);
      expect(label?.querySelector('.required-mark')).not.toBeNull();
    }

    // "Create library" stays disabled until both required fields have text (blank does not count).
    const create = within(dialog).getByRole('button', { name: 'Create library' });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    // The reason sits under the disabled button and is its description.
    const reason = within(dialog).getByText('Enter a name and a path');
    expect(create.getAttribute('aria-describedby')).toBe(reason.id);
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: ' Fixtures ' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Path' }), {
      target: { value: '   ' },
    });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.libraries.create).not.toHaveBeenCalled();

    expect(within(dialog).getByText('Enter a path')).toBeTruthy();

    // A relative path keeps it disabled, with the reason.
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Path' }), {
      target: { value: 'media/x' },
    });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText('Enter an absolute path (it starts with /)')).toBeTruthy();

    const path = within(dialog).getByRole('textbox', { name: 'Path' }) as HTMLInputElement;
    expect(path.getAttribute('aria-describedby')).toContain(
      within(dialog).getByText('An absolute folder on the server').id,
    );
    fireEvent.change(path, { target: { value: '/media/shows/season-1' } });
    expect(within(dialog).queryByText(/^Enter /)).toBeNull();

    // A workflow's Library input chooses the library: the dialog has no workflow choice.
    expect(within(dialog).queryByRole('button', { name: /workflow/i })).toBeNull();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).queryByText(/workflow/i)).toBeNull();

    mocks.libraries.create.mockRejectedValueOnce(
      defined('LIBRARY_PATH_INVALID', 400, 'The library path cannot be used', {
        reason: 'overlaps library "Shows"',
      }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create library' }));
    const error = await within(dialog).findByText(
      'This path cannot be used: overlaps library "Shows"',
    );
    expect(path.getAttribute('aria-invalid')).toBe('true');
    expect(path.getAttribute('aria-describedby')).toContain(error.id);
    expect(mocks.libraries.create).toHaveBeenCalledWith({
      name: 'Fixtures',
      path: '/media/shows/season-1',
      recycleFolder: null,
      processHardlinked: false,
      verifyFullDecode: false,
    });

    // The recycle folder and the two switches sit under Advanced, closed on a new library.
    const advanced = within(dialog).getByRole('button', { name: 'Advanced' });
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    expect(within(dialog).queryByRole('radio', { name: 'Custom path' })).toBeNull();
    fireEvent.click(advanced);

    // A recycle-folder reason lands under the recycle folder input, not the path.
    fireEvent.change(path, { target: { value: '/media/fixtures' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Custom path' }));
    expect(advanced.textContent).toContain('1 changed');
    const recycle = within(dialog).getByLabelText('Custom recycle folder');
    fireEvent.change(recycle, { target: { value: '/elsewhere' } });
    mocks.libraries.create.mockRejectedValueOnce(
      defined('LIBRARY_PATH_INVALID', 400, 'The library path cannot be used', {
        reason: 'the recycle folder must be a folder inside the library root',
      }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create library' }));
    await within(dialog).findByText('The recycle folder must be a folder inside the library root');
    expect(recycle.getAttribute('aria-invalid')).toBe('true');
    expect(path.getAttribute('aria-invalid')).toBe(null);

    fireEvent.change(recycle, { target: { value: '.trash' } });
    const hardlinked = within(dialog).getByRole('switch', { name: 'Process hardlinked files' });
    // The explanation is visible text tied to the switch, not a hover-only tooltip.
    const hint = document.getElementById(hardlinked.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toMatch(/^Off: files with more than one hard link/);
    fireEvent.click(hardlinked);
    fireEvent.click(
      within(dialog).getByRole('switch', { name: 'Verify by decoding the whole file (slower)' }),
    );
    mocks.libraries.create.mockResolvedValueOnce(library({ id: 'l3', name: 'Fixtures' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create library' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.libraries.create).toHaveBeenLastCalledWith({
      name: 'Fixtures',
      path: '/media/fixtures',
      recycleFolder: '.trash',
      processHardlinked: true,
      verifyFullDecode: true,
    });
    expect(await screen.findByText('Library Fixtures created')).toBeTruthy();
    await waitFor(() => expect(mocks.libraries.list).toHaveBeenCalledTimes(2));
  });

  it('edits a library without a workflow choice and deletes with confirmation; LIBRARY_BUSY shows the message', async () => {
    renderAt('/libraries', <LibrariesPage />);
    const row = await rowOf('Shows');
    await within(row).findByRole('cell', { name: 'Downsize Active v3' });
    await pickAction('Shows', 'Edit');
    const dialog = screen.getByRole('dialog', { name: 'Edit Shows' });
    expect((within(dialog).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe(
      'Shows',
    );
    const path = within(dialog).getByRole('textbox', { name: 'Path' }) as HTMLInputElement;
    expect(path.value).toBe('/media/shows');
    expect(path.disabled).toBe(true);
    // Everything under Advanced is at its default: it stays closed until asked for.
    const advanced = within(dialog).getByRole('button', { name: 'Advanced' });
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(advanced);
    expect(
      (within(dialog).getByRole('radio', { name: 'In the library (default)' }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    // The path is read-only here, so it carries no required mark.
    expect(dialog.querySelector(`label[for="${path.id}"]`)?.textContent).toBe('Path');
    expect(path.getAttribute('aria-required')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /workflow/i })).toBeNull();

    mocks.libraries.update.mockResolvedValueOnce(shows);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.libraries.update).toHaveBeenLastCalledWith({
      id: 'l1',
      name: 'Shows',
      recycleFolder: null,
      processHardlinked: false,
      verifyFullDecode: false,
    });
    await waitFor(() => expect(mocks.libraries.list).toHaveBeenCalledTimes(2));

    // Delete: a danger dialog that starts on Cancel; LIBRARY_BUSY keeps it open with the message.
    await pickAction('Shows', 'Delete');
    const confirm = screen.getByRole('dialog', { name: 'Delete Shows?' });
    expect(within(confirm).getByText('Files on disk are not touched.')).toBeTruthy();
    // Shows is fed: the confirmation says which workflow stops receiving files.
    expect(within(confirm).getByText('Downsize v3 will stop receiving files.')).toBeTruthy();
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }));
    mocks.libraries.delete.mockRejectedValueOnce(
      defined('LIBRARY_BUSY', 409, 'The library has active jobs'),
    );
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    expect((await within(confirm).findByRole('alert')).textContent).toContain(
      'Jobs are still running in this library',
    );
    expect(mocks.libraries.delete).toHaveBeenCalledWith({ id: 'l1' });

    mocks.libraries.delete.mockResolvedValueOnce({ ok: true });
    mocks.libraries.list.mockResolvedValue({ libraries: [movies], notices: [] });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Library Shows deleted')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('cell', { name: 'Shows' })).toBeNull());
  });

  it('Run hours: Restrict sends the painted window on Save; Scan now says when held files start', async () => {
    renderAt('/libraries', <LibrariesPage />);
    await pickAction('Shows', 'Edit');
    const dialog = screen.getByRole('dialog', { name: 'Edit Shows' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Restrict' }));
    expect(within(dialog).getByText('Runs every day, 22:00–07:00 (9 h)')).toBeTruthy();
    const night = [0, 1, 2, 3, 4, 5, 6, 22, 23];
    const runHours = { enabled: true, perDay: false, every: night, days: Array(7).fill(night) };
    mocks.libraries.update.mockResolvedValueOnce({ ...shows, runHours });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.libraries.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'l1', runHours: expect.objectContaining({ enabled: true }) }),
    );
    expect(mocks.libraries.update.mock.lastCall?.[0].runHours.every.toSorted()).toEqual(
      night.toSorted(),
    );

    // A window with no hours never opens: Scan now says the files wait.
    const closed = { ...runHours, every: [] };
    mocks.libraries.list.mockResolvedValue({
      libraries: [{ ...shows, runHours: closed }, movies],
      notices: [],
    });
    cleanup();
    renderAt('/libraries', <LibrariesPage />);
    fireEvent.click(within(await rowOf('Shows')).getByRole('button', { name: 'Scan Shows now' }));
    const scan = await screen.findByRole('dialog', { name: 'Scan Shows now?' });
    expect(
      within(scan).getByText(
        'Its run hours have no hours chosen: the files are queued but do not start on their own.',
      ),
    ).toBeTruthy();
  });

  it('edits a custom recycle folder back to the default and shows an unexpected failure inline', async () => {
    renderAt('/libraries', <LibrariesPage />);
    await pickAction('Movies', 'Edit');
    const dialog = screen.getByRole('dialog', { name: 'Edit Movies' });
    expect(
      (within(dialog).getByRole('radio', { name: 'Custom path' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect((within(dialog).getByLabelText('Custom recycle folder') as HTMLInputElement).value).toBe(
      '/media/movies/.trash',
    );
    expect(
      within(dialog)
        .getByRole('switch', { name: 'Process hardlinked files' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'In the library (default)' }));
    expect(within(dialog).queryByLabelText('Custom recycle folder')).toBeNull();

    mocks.libraries.update.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'Could not reach the server',
    );
    expect(mocks.libraries.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'l2', recycleFolder: null }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('Scan now asks first (library, workflow, active version), then queues a real run over the root and navigates to the run', async () => {
    mocks.jobs.queue.mockResolvedValueOnce({ runId: 'r9', jobIds: ['j1'] });
    const view = renderAt('/libraries', <LibrariesPage />);
    fireEvent.click(within(await rowOf('Shows')).getByRole('button', { name: 'Scan Shows now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Scan Shows now?' });
    expect(dialog.textContent).toContain(
      'Applies Downsize v3 (active) to every file in /media/shows. Files that need changes are rewritten.',
    );
    // Focus starts on Cancel; nothing is queued until the dialog is confirmed.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mocks.jobs.queue).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.jobs.queue).not.toHaveBeenCalled();

    fireEvent.click(within(await rowOf('Shows')).getByRole('button', { name: 'Scan Shows now' }));
    const again = await screen.findByRole('dialog', { name: 'Scan Shows now?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Scan now' }));
    await waitFor(() => expect(view.location()).toBe('/runs/r9'));
    expect(mocks.jobs.queue).toHaveBeenCalledTimes(1);
    expect(mocks.jobs.queue).toHaveBeenCalledWith({ path: '/media/shows', dryRun: false });
  });

  it("Scan now has a force checkbox, off by default, that re-runs files the feeder's active version already finished", async () => {
    mocks.jobs.queue.mockResolvedValueOnce({ runId: 'r9', jobIds: ['j1'] });
    const view = renderAt('/libraries', <LibrariesPage />);
    fireEvent.click(within(await rowOf('Shows')).getByRole('button', { name: 'Scan Shows now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Scan Shows now?' });
    // v3 is the feeder's active version (Library.feeds), not the newest (v6).
    const force = within(dialog).getByRole('checkbox', {
      name: 'Also re-run files v3 already finished (they may be rewritten)',
    }) as HTMLInputElement;
    expect(force.checked).toBe(false);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(force);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Scan now' }));
    await waitFor(() => expect(view.location()).toBe('/runs/r9'));
    expect(mocks.jobs.queue).toHaveBeenCalledWith({
      path: '/media/shows',
      dryRun: false,
      force: true,
    });
  });

  it('Dry run… has its own force checkbox, worded as planning with the newest version, off each time it opens', async () => {
    mocks.jobs.queue.mockResolvedValueOnce({
      runId: 'r6',
      jobIds: [],
      dryRun: true,
      note: null,
      workflowVersion: 2,
    });
    const view = renderAt('/libraries', <LibrariesPage />);
    await rowOf('Shows');
    await waitFor(() => expect(mocks.workflows.list).toHaveBeenCalled());
    await pickAction('Shows', 'Dry run…');
    let dialog = await screen.findByRole('dialog', { name: 'Dry run on Shows' });
    const label = 'Also plan files the newest version already finished';
    let force = within(dialog).getByRole('checkbox', { name: label }) as HTMLInputElement;
    expect(force.checked).toBe(false);
    fireEvent.click(force);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await pickAction('Shows', 'Dry run…');
    dialog = await screen.findByRole('dialog', { name: 'Dry run on Shows' });
    force = within(dialog).getByRole('checkbox', { name: label }) as HTMLInputElement;
    expect(force.checked).toBe(false);
    fireEvent.click(force);
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Archive v2' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Start (dry run|test encode)$/ }));
    await waitFor(() => expect(view.location()).toBe('/runs/r6'));
    expect(mocks.jobs.queue).toHaveBeenCalledWith({
      path: '/media/shows',
      workflowId: 'w3',
      dryRun: true,
      testEncode: false,
      force: true,
    });
  });

  it('a blocked scan hides the force checkbox and its Dry run instead sends no force', async () => {
    mocks.workflows.list.mockResolvedValue({
      workflows: [
        workflow({ id: 'w1', name: 'Downsize', active: activeV(3, false), currentVersion: 6 }),
      ],
    });
    mocks.workflows.get.mockResolvedValue({ activeIssues: [] });
    mocks.jobs.queue.mockResolvedValueOnce({
      runId: 'r7',
      jobIds: [],
      dryRun: true,
      note: null,
      workflowVersion: 6,
    });
    const view = renderAt('/libraries', <LibrariesPage />);
    fireEvent.click(within(await rowOf('Shows')).getByRole('button', { name: 'Scan Shows now' }));
    const blocked = await screen.findByRole('dialog', { name: 'Scan Shows now?' });
    await waitFor(() => expect(blocked.textContent).toContain("can't run"));
    // No force checkbox: only Test-encode, for the dry run it offers instead.
    expect(
      within(blocked)
        .getAllByRole('checkbox')
        .map((c) => (c as HTMLInputElement).labels?.[0]?.textContent),
    ).toEqual(['Test-encode']);
    fireEvent.click(within(blocked).getByRole('button', { name: 'Dry run v6 instead' }));
    await waitFor(() => expect(view.location()).toBe('/runs/r7'));
    expect(mocks.jobs.queue).toHaveBeenCalledWith({
      path: '/media/shows',
      workflowId: 'w1',
      dryRun: true,
      testEncode: false,
    });
  });

  it('the force checkbox starts unchecked each time the scan dialog opens', async () => {
    renderAt('/libraries', <LibrariesPage />);
    fireEvent.click(within(await rowOf('Shows')).getByRole('button', { name: 'Scan Shows now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Scan Shows now?' });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(await rowOf('Shows')).getByRole('button', { name: 'Scan Shows now' }));
    const again = await screen.findByRole('dialog', { name: 'Scan Shows now?' });
    expect((within(again).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('Scan now when the feeder was deactivated in another tab toasts it and reloads the list (Review Focus 4)', async () => {
    mocks.jobs.queue.mockRejectedValueOnce(
      defined('NO_FEEDING_WORKFLOW', 400, 'No active workflow takes files from this library'),
    );
    const view = renderAt('/libraries', <LibrariesPage />);
    fireEvent.click(within(await rowOf('Shows')).getByRole('button', { name: 'Scan Shows now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Scan Shows now?' });
    mocks.libraries.list.mockResolvedValue({
      libraries: [{ ...shows, feeds: null }, movies],
      notices: [],
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Scan now' }));
    expect(
      await screen.findByText(
        "Shows isn't fed by an active workflow. Set it in a workflow's Library input and activate it.",
      ),
    ).toBeTruthy();
    expect(view.location()).toBe('/libraries');
    await waitFor(() => expect(mocks.libraries.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.workflows.list).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        (
          within(
            screen.getByRole('cell', { name: /^Shows(?![a-z0-9])/ }).closest('tr') as HTMLElement,
          ).getByRole('button', { name: 'Scan Shows now' }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
  });

  it('Dry run… lists only the workflows whose Library input names the row, by name, and queues a dry run of the picked one', async () => {
    mocks.jobs.queue.mockResolvedValueOnce({
      runId: 'r5',
      jobIds: [],
      dryRun: true,
      note: null,
      workflowVersion: 2,
    });
    const view = renderAt('/libraries', <LibrariesPage />);
    await rowOf('Shows');
    await waitFor(() => expect(mocks.workflows.list).toHaveBeenCalled());
    await pickAction('Shows', 'Dry run…');
    const dialog = await screen.findByRole('dialog', { name: 'Dry run on Shows' });
    const picks = within(dialog)
      .getAllByRole('radio')
      .map((r) => (r.closest('label') as HTMLElement).textContent);
    expect(picks).toEqual(['Archive v2', 'Downsize v6']);
    // The first workflow is picked; the primary button starts it.
    expect(
      (within(dialog).getByRole('radio', { name: 'Archive v2' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(mocks.jobs.queue).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start dry run' }));
    await waitFor(() => expect(view.location()).toBe('/runs/r5'));
    expect(mocks.jobs.queue).toHaveBeenCalledWith({
      path: '/media/shows',
      workflowId: 'w3',
      dryRun: true,
      testEncode: false,
    });
  });

  it('Dry run… is disabled with the hint when no workflow names the library', async () => {
    mocks.libraries.list.mockResolvedValue({
      libraries: [shows, { ...movies, namedByInactive: [] }],
      notices: [],
    });
    mocks.workflows.list.mockResolvedValue({ workflows: workflows.filter((w) => w.id !== 'w2') });
    renderAt('/libraries', <LibrariesPage />);
    await rowOf('Movies');
    await waitFor(() => expect(mocks.workflows.list).toHaveBeenCalled());
    fireEvent.click(
      within(await rowOf('Movies')).getByRole('button', { name: 'Actions for Movies' }),
    );
    const item = screen.getByRole('menuitem', { name: 'Dry run…' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(descriptionOf(item)).toBe('Add a Library input to a workflow');
    fireEvent.click(item);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.jobs.queue).not.toHaveBeenCalled();
  });

  it('shows the upgrade notices; Dismiss clears them, and a failed dismiss says so inline', async () => {
    mocks.libraries.list.mockResolvedValue({
      libraries: [shows, movies],
      notices: ['Movies had Movie cleanup as its default; it now has no workflow.'],
    });
    renderAt('/libraries', <LibrariesPage />);
    const region = await screen.findByRole('region', {
      name: 'Libraries changed when Transcoda was updated',
    });
    expect(region.className).toContain('alert-warning');
    expect(
      within(region).getByText('Movies had Movie cleanup as its default; it now has no workflow.'),
    ).toBeTruthy();

    mocks.libraries.dismissNotices.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.click(within(region).getByRole('button', { name: 'Dismiss' }));
    expect(await within(region).findByText('Could not dismiss, try again')).toBeTruthy();

    mocks.libraries.dismissNotices.mockResolvedValueOnce({ ok: true });
    fireEvent.click(within(region).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'Libraries changed when Transcoda was updated' }),
      ).toBeNull(),
    );
    expect(mocks.libraries.dismissNotices).toHaveBeenCalledTimes(2);
  });

  it('no notices, no region', async () => {
    renderAt('/libraries', <LibrariesPage />);
    await rowOf('Shows');
    expect(
      screen.queryByRole('region', { name: 'Libraries changed when Transcoda was updated' }),
    ).toBeNull();
  });

  it("Scan now on an active version that can't run disables Scan now, names the issue, and Dry run instead queues dryRun: true and opens the run", async () => {
    mocks.workflows.list.mockResolvedValue({
      workflows: [
        workflow({ id: 'w1', name: 'Downsize', active: activeV(3, false), currentVersion: 6 }),
      ],
    });
    mocks.workflows.get.mockResolvedValue({
      activeIssues: [
        { severity: 'error', code: 'UNKNOWN_NODE_TYPE', message: 'Node x is unknown' },
      ],
    });
    mocks.jobs.queue.mockResolvedValueOnce({
      runId: 'r3',
      jobIds: [],
      dryRun: true,
      note: null,
      workflowVersion: 6,
    });
    const view = renderAt('/libraries', <LibrariesPage />);
    fireEvent.click(within(await rowOf('Shows')).getByRole('button', { name: 'Scan Shows now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Scan Shows now?' });
    await waitFor(() =>
      expect(dialog.textContent).toContain(
        "Downsize v3 is active but can't run: Node x is unknown. Activate a version that runs first, or dry run the newest version instead.",
      ),
    );
    expect(
      (within(dialog).getByRole('button', { name: 'Scan now' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(mocks.workflows.get).toHaveBeenCalledWith({ id: 'w1' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dry run v6 instead' }));
    await waitFor(() => expect(view.location()).toBe('/runs/r3'));
    expect(mocks.jobs.queue).toHaveBeenCalledWith({
      path: '/media/shows',
      workflowId: 'w1',
      dryRun: true,
      testEncode: false,
    });
  });

  it("an active version that can't run falls back to 'it has errors' when the detail does not load", async () => {
    mocks.workflows.list.mockResolvedValue({
      workflows: [workflow({ id: 'w1', name: 'Downsize', active: activeV(3, false) })],
    });
    mocks.workflows.get.mockRejectedValue(new TypeError('Failed to fetch'));
    renderAt('/libraries', <LibrariesPage />);
    fireEvent.click(within(await rowOf('Shows')).getByRole('button', { name: 'Scan Shows now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Scan Shows now?' });
    expect(dialog.textContent).toContain("is active but can't run: it has errors.");
  });

  it("a refused scan (WORKFLOW_INVALID) toasts that the active version can't run", async () => {
    mocks.jobs.queue.mockRejectedValueOnce(defined('WORKFLOW_INVALID', 422, 'bad'));
    renderAt('/libraries', <LibrariesPage />);
    fireEvent.click(within(await rowOf('Shows')).getByRole('button', { name: 'Scan Shows now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Scan Shows now?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Scan now' }));
    expect(
      await screen.findByText(
        "The active version of Shows's workflow can't run. Activate a version that runs first.",
      ),
    ).toBeTruthy();
  });

  it("a refused dry run says the newest version can't run", async () => {
    mocks.workflows.list.mockResolvedValue({
      workflows: [workflow({ id: 'w1', name: 'Downsize', active: activeV(3, false) })],
    });
    mocks.jobs.queue.mockRejectedValueOnce(defined('WORKFLOW_INVALID', 422, 'bad'));
    renderAt('/libraries', <LibrariesPage />);
    fireEvent.click(within(await rowOf('Shows')).getByRole('button', { name: 'Scan Shows now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Scan Shows now?' });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Dry run v/ }));
    expect(
      await screen.findByText(
        "The newest version of Shows's workflow can't run. Fix it in the editor first.",
      ),
    ).toBeTruthy();
  });

  it('reopening the dialog refetches the reason and never shows a stale one', async () => {
    mocks.workflows.list.mockResolvedValue({
      workflows: [workflow({ id: 'w1', name: 'Downsize', active: activeV(3, false) })],
    });
    mocks.workflows.get
      .mockResolvedValueOnce({
        activeIssues: [{ severity: 'error', code: 'UNKNOWN_NODE_TYPE', message: 'First reason' }],
      })
      .mockResolvedValueOnce({
        activeIssues: [{ severity: 'error', code: 'UNKNOWN_NODE_TYPE', message: 'Second reason' }],
      });
    renderAt('/libraries', <LibrariesPage />);
    fireEvent.click(within(await rowOf('Shows')).getByRole('button', { name: 'Scan Shows now' }));
    let dialog = await screen.findByRole('dialog', { name: 'Scan Shows now?' });
    await waitFor(() => expect(dialog.textContent).toContain('First reason'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(await rowOf('Shows')).getByRole('button', { name: 'Scan Shows now' }));
    dialog = await screen.findByRole('dialog', { name: 'Scan Shows now?' });
    expect(dialog.textContent).not.toContain('First reason');
    await waitFor(() => expect(dialog.textContent).toContain('Second reason'));
    expect(mocks.workflows.get).toHaveBeenCalledTimes(2);
  });

  it('a failed workflow list still names the feeder from the library', async () => {
    mocks.workflows.list.mockRejectedValue(new TypeError('Failed to fetch'));
    renderAt('/libraries', <LibrariesPage />);
    fireEvent.click(within(await rowOf('Shows')).getByRole('button', { name: 'Scan Shows now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Scan Shows now?' });
    expect(dialog.textContent).toContain(
      'Applies Downsize v3 (active) to every file in /media/shows. Files that need changes are rewritten.',
    );
  });

  describe('folder picker for the path', () => {
    async function openNew() {
      renderAt('/libraries', <LibrariesPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'New library' }));
      return screen.findByRole('dialog', { name: 'New library' });
    }

    it('has a folder button after the Path input that opens the picker beside the first library, and a chosen folder fills the typable field', async () => {
      const dialog = await openNew();
      const input = within(dialog).getByLabelText(/^Path/) as HTMLInputElement;
      fireEvent.change(input, { target: { value: '/typed/by/hand' } });
      expect(input.value).toBe('/typed/by/hand');
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Browse folders' }));
      const picker = await screen.findByRole('dialog', { name: 'Choose a folder' });
      // Libraries sit at /media/shows and /media/movies: it starts in /media.
      await within(picker).findByRole('button', { name: 'New' });
      expect(mocks.fs.browseDirs).toHaveBeenCalledWith({ path: '/media' });
    });

    it('starts at the typed absolute path, picks with the keyboard-reachable list and fills the field', async () => {
      const dialog = await openNew();
      const input = within(dialog).getByLabelText(/^Path/) as HTMLInputElement;
      fireEvent.change(input, { target: { value: '/data' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Browse folders' }));
      const picker = await screen.findByRole('dialog', { name: 'Choose a folder' });
      fireEvent.click(await within(picker).findByRole('button', { name: 'New' }));
      await waitFor(() => expect(within(picker).getByText('data')).toBeTruthy());
      fireEvent.click(await within(picker).findByRole('button', { name: 'Choose this folder' }));
      await waitFor(() => expect(input.value).toBe('/data/New'));
      expect(screen.queryByRole('dialog', { name: 'Choose a folder' })).toBeNull();
      expect(screen.getByRole('dialog', { name: 'New library' })).toBeTruthy();
    });

    it('does not choose a read-only folder', async () => {
      const dialog = await openNew();
      const input = within(dialog).getByLabelText(/^Path/) as HTMLInputElement;
      fireEvent.click(within(dialog).getByRole('button', { name: 'Browse folders' }));
      const picker = await screen.findByRole('dialog', { name: 'Choose a folder' });
      await within(picker).findByRole('button', { name: 'New' });
      expect(
        within(picker).getByRole('button', { name: 'Choose this folder' }).hasAttribute('disabled'),
      ).toBe(true);
      expect(within(picker).getByText("Transcoda can't write here")).toBeTruthy();
      expect(input.value).toBe('');
    });

    it('Escape closes only the picker, and Cancel keeps the typed path', async () => {
      const dialog = await openNew();
      const input = within(dialog).getByLabelText(/^Path/) as HTMLInputElement;
      fireEvent.change(input, { target: { value: '/data' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Browse folders' }));
      const picker = await screen.findByRole('dialog', { name: 'Choose a folder' });
      fireEvent.keyDown(picker, { key: 'Escape' });
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Choose a folder' })).toBeNull(),
      );
      expect(screen.getByRole('dialog', { name: 'New library' })).toBeTruthy();
      expect(input.value).toBe('/data');
    });

    it('has no folder button when editing (the path cannot change)', async () => {
      renderAt('/libraries', <LibrariesPage />);
      await pickAction('Shows', 'Edit');
      const dialog = await screen.findByRole('dialog', { name: /^Edit Shows/ });
      expect(within(dialog).queryByRole('button', { name: 'Browse folders' })).toBeNull();
    });
  });
  describe('Test-encode', () => {
    const TE_HINT =
      'Encode, verify and measure every file for real, then stop before anything is written. Outputs are kept for playing.';
    const queued = { runId: 'r5', jobIds: [], dryRun: true, note: null, workflowVersion: 2 };
    const box = (dialog: HTMLElement) =>
      within(dialog).getByRole('checkbox', { name: 'Test-encode' }) as HTMLInputElement;
    const openDryRun = async () => {
      await rowOf('Shows');
      await waitFor(() => expect(mocks.workflows.list).toHaveBeenCalled());
      await pickAction('Shows', 'Dry run…');
      return screen.findByRole('dialog', { name: 'Dry run on Shows' });
    };

    it('Dry run… offers Test-encode, unticked, with its hint; ticked, the pick sends testEncode: true', async () => {
      mocks.jobs.queue.mockResolvedValueOnce(queued);
      const view = renderAt('/libraries', <LibrariesPage />);
      const dialog = await openDryRun();
      expect(box(dialog).checked).toBe(false);
      expect(
        document.getElementById(box(dialog).getAttribute('aria-describedby') ?? '')?.textContent,
      ).toBe(TE_HINT);
      expect(dialog.textContent).toContain('Nothing on disk changes.');
      fireEvent.click(box(dialog));
      // Ticked, the dialog says what a test encode writes and its button says what it starts.
      expect(dialog.textContent).toContain('keeps each output to compare');
      expect(dialog.textContent).not.toContain('Nothing on disk changes.');
      expect(within(dialog).getByRole('button', { name: 'Start test encode' })).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('radio', { name: 'Archive v2' }));
      fireEvent.click(
        within(dialog).getByRole('button', { name: /^Start (dry run|test encode)$/ }),
      );
      await waitFor(() => expect(view.location()).toBe('/runs/r5'));
      expect(mocks.jobs.queue).toHaveBeenCalledWith({
        path: '/media/shows',
        workflowId: 'w3',
        dryRun: true,
        testEncode: true,
      });
    });

    it('reopening Dry run… unticks Test-encode', async () => {
      renderAt('/libraries', <LibrariesPage />);
      let dialog = await openDryRun();
      fireEvent.click(box(dialog));
      expect(box(dialog).checked).toBe(true);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await pickAction('Shows', 'Dry run…');
      dialog = await screen.findByRole('dialog', { name: 'Dry run on Shows' });
      expect(box(dialog).checked).toBe(false);
      expect(mocks.jobs.queue).not.toHaveBeenCalled();
    });

    it('next to Dry run v<N> instead, ticked, sends testEncode: true', async () => {
      mocks.workflows.list.mockResolvedValue({
        workflows: [
          workflow({ id: 'w1', name: 'Downsize', active: activeV(3, false), currentVersion: 6 }),
        ],
      });
      mocks.workflows.get.mockResolvedValue({ activeIssues: [] });
      mocks.jobs.queue.mockResolvedValueOnce({ ...queued, workflowVersion: 6 });
      const view = renderAt('/libraries', <LibrariesPage />);
      fireEvent.click(within(await rowOf('Shows')).getByRole('button', { name: 'Scan Shows now' }));
      const dialog = await screen.findByRole('dialog', { name: 'Scan Shows now?' });
      await waitFor(() => expect(dialog.textContent).toContain("can't run"));
      expect(box(dialog).checked).toBe(false);
      fireEvent.click(box(dialog));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Dry run v6 instead' }));
      await waitFor(() => expect(view.location()).toBe('/runs/r5'));
      expect(mocks.jobs.queue).toHaveBeenCalledWith({
        path: '/media/shows',
        workflowId: 'w1',
        dryRun: true,
        testEncode: true,
      });
    });

    it('a real Scan now has no Test-encode and never sends the key', async () => {
      mocks.jobs.queue.mockResolvedValueOnce({ runId: 'r9', jobIds: ['j1'] });
      const view = renderAt('/libraries', <LibrariesPage />);
      fireEvent.click(within(await rowOf('Shows')).getByRole('button', { name: 'Scan Shows now' }));
      const dialog = await screen.findByRole('dialog', { name: 'Scan Shows now?' });
      expect(within(dialog).queryByRole('checkbox', { name: 'Test-encode' })).toBeNull();
      expect(dialog.textContent).not.toContain(TE_HINT);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Scan now' }));
      await waitFor(() => expect(view.location()).toBe('/runs/r9'));
      const [call] = mocks.jobs.queue.mock.calls[0] as [Record<string, unknown>];
      expect('testEncode' in call).toBe(false);
    });
  });
});
