import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recycle: { list: vi.fn(), restore: vi.fn(), delete: vi.fn(), empty: vi.fn() },
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import type { RecycledEntry, RecycleListOutput } from '@transcoda/contract';
import { fmtDate } from '../lib/time.ts';
import { renderAt } from '../test/render.tsx';
import { RecyclePage } from './RecyclePage.tsx';

const BIN = '/media/Shows/.transcoda-recycle';
const realMatchMedia = window.matchMedia;

const entry = (over: Partial<RecycledEntry>): RecycledEntry => ({
  path: `${BIN}/Show/a.mkv`,
  relativePath: 'Show/a.mkv',
  kind: 'original',
  sizeBytes: 1000,
  jobId: 'j1',
  recycledAt: '2026-11-01T10:00:00.000Z',
  deletesAt: '2026-11-08T10:00:00.000Z',
  ...over,
});

function listing(
  entries: RecycledEntry[],
  over: Partial<RecycleListOutput> = {},
): RecycleListOutput {
  return {
    libraries: [
      { id: 'l1', name: 'Shows', files: entries.length, bytes: 1000 },
      { id: 'l2', name: 'Films', files: 0, bytes: 0 },
    ],
    library: {
      id: 'l1',
      name: 'Shows',
      folder: BIN,
      totalBytes: entries.reduce((n, e) => n + e.sizeBytes, 0),
      freeBytes: 2_000_000_000,
      retentionDays: 7,
      entries,
    },
    ...over,
  };
}

const ENTRIES = [
  entry({}),
  entry({
    path: `${BIN}/Show/a.de.srt`,
    relativePath: 'Show/a.de.srt',
    kind: 'sidecar',
    sizeBytes: 20,
  }),
  entry({
    path: `${BIN}/Show/b.mkv.1`,
    relativePath: 'Show/b.mkv',
    kind: 'restored-output',
    sizeBytes: 300,
    jobId: 'j2',
  }),
];

beforeEach(() => {
  mocks.recycle.list.mockReset().mockResolvedValue(listing(ENTRIES));
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  cleanup();
});

async function open(path = '/recycle') {
  const view = renderAt(path, <RecyclePage />);
  await screen.findByRole('heading', { level: 1, name: 'Recycle folder' });
  await act(async () => {});
  return view;
}

describe('RecyclePage', () => {
  it("lists the chosen library's folder, size, free space, cleanup note and rows", async () => {
    await open();
    expect(await screen.findByText(BIN)).toBeTruthy();
    expect(mocks.recycle.list).toHaveBeenCalledWith({});
    expect(screen.getByText('1.32 kB in the folder · 2.00 GB free on this disk')).toBeTruthy();
    expect(
      screen.getByText('Originals are deleted after 7 days, or sooner when the disk is low', {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe(
      '/settings/recycle',
    );
    const table = screen.getByRole('table', { name: 'Recycle folder of Shows' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    const [a, srt, out] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(a).getByText('Show/a.mkv')).toBeTruthy();
    expect(within(a).getByText('1.00 kB')).toBeTruthy();
    expect(within(a).getByRole('link', { name: 'Job' }).getAttribute('href')).toBe('/jobs/j1');
    expect(within(a).getByText(fmtDate('2026-11-01T10:00:00.000Z'))).toBeTruthy();
    expect(within(a).getByText(`Deleted on ${fmtDate('2026-11-08T10:00:00.000Z')}`)).toBeTruthy();
    expect(srt.className).toContain('recycle-sidecar');
    expect(within(srt).getByText('Show/a.de.srt')).toBeTruthy();
    expect(within(srt).getByText('Subtitle file, comes back with its video')).toBeTruthy();
    expect(within(out).getByText("Transcoda's version (restored original)")).toBeTruthy();
  });

  it('the switcher loads another library', async () => {
    const view = await open();
    mocks.recycle.list.mockResolvedValue(
      listing([], {
        library: {
          id: 'l2',
          name: 'Films',
          folder: '/media/Films/.transcoda-recycle',
          totalBytes: 0,
          freeBytes: null,
          retentionDays: 7,
          entries: [],
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Library/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'Films (0 files)' }));
    await waitFor(() => expect(mocks.recycle.list).toHaveBeenLastCalledWith({ libraryId: 'l2' }));
    expect(view.location()).toBe('/recycle?library=l2');
    expect(await screen.findByText("Nothing in this library's recycle folder.")).toBeTruthy();
  });

  it('reads the library from the address', async () => {
    await open('/recycle?library=l2');
    expect(mocks.recycle.list).toHaveBeenCalledWith({ libraryId: 'l2' });
  });

  it('shows the empty state', async () => {
    mocks.recycle.list.mockResolvedValue(listing([]));
    await open();
    expect(await screen.findByText("Nothing in this library's recycle folder.")).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says so when there are no libraries', async () => {
    mocks.recycle.list.mockResolvedValue({ libraries: [], library: null });
    await open();
    expect(await screen.findByText('No libraries yet, so nothing is recycled.')).toBeTruthy();
  });

  it('uses cards on a phone', async () => {
    window.matchMedia = (query: string) =>
      ({
        matches: query === '(max-width: 639px)',
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
    const { container } = await open();
    await screen.findByText(BIN);
    expect(screen.queryByRole('table')).toBeNull();
    const cards = container.querySelectorAll('.phone-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain('Show/a.de.srt');
  });
});

describe('RecyclePage actions', () => {
  const rowOf = (name: string): HTMLElement => screen.getByText(name).closest('tr') as HTMLElement;

  it('an original row restores, a restored-output row undoes, both through RestoreButton', async () => {
    mocks.recycle.restore.mockResolvedValue({
      jobId: 'j1',
      direction: 'restored',
      notRestored: [],
    });
    await open();
    await screen.findByText(BIN);
    expect(within(rowOf('Show/a.de.srt')).queryByRole('button')).toBeNull();

    fireEvent.click(within(rowOf('Show/a.mkv')).getByRole('button', { name: 'Restore original' }));
    let dialog = await screen.findByRole('dialog', { name: 'Restore the original of a.mkv?' });
    expect(dialog.textContent).toContain('The original goes back to Show/a.mkv.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore original' }));
    await waitFor(() =>
      expect(mocks.recycle.restore).toHaveBeenCalledWith({ path: `${BIN}/Show/a.mkv` }),
    );
    await waitFor(() => expect(mocks.recycle.list).toHaveBeenCalledTimes(2));

    mocks.recycle.restore.mockResolvedValue({ jobId: 'j2', direction: 'undone', notRestored: [] });
    fireEvent.click(
      within(rowOf('Show/b.mkv')).getByRole('button', { name: "Put Transcoda's version back" }),
    );
    dialog = await screen.findByRole('dialog', { name: "Put Transcoda's version back?" });
    fireEvent.click(within(dialog).getByRole('button', { name: "Put Transcoda's version back" }));
    await waitFor(() =>
      expect(mocks.recycle.restore).toHaveBeenLastCalledWith({ path: `${BIN}/Show/b.mkv.1` }),
    );
    await waitFor(() => expect(mocks.recycle.list).toHaveBeenCalledTimes(3));
  });

  it('Delete asks first and is permanent', async () => {
    mocks.recycle.delete.mockResolvedValue({ bytes: 1000 });
    await open();
    await screen.findByText(BIN);
    fireEvent.click(within(rowOf('Show/a.mkv')).getByRole('button', { name: 'Delete' }));
    let dialog = await screen.findByRole('dialog', { name: 'Delete a.mkv for good?' });
    expect(
      within(dialog).getByText(
        "This deletes the file from the recycle folder. It can't be undone.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mocks.recycle.delete).not.toHaveBeenCalled();

    fireEvent.click(within(rowOf('Show/a.mkv')).getByRole('button', { name: 'Delete' }));
    dialog = await screen.findByRole('dialog', { name: 'Delete a.mkv for good?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(mocks.recycle.delete).toHaveBeenCalledWith({ path: `${BIN}/Show/a.mkv` }),
    );
    await waitFor(() => expect(mocks.recycle.list).toHaveBeenCalledTimes(2));
  });

  it('Empty folder states the count and size, sends the newest listed time, and reports skipped files', async () => {
    mocks.recycle.list.mockResolvedValue(
      listing([
        entry({ sizeBytes: 1_000_000_000, recycledAt: '2026-11-01T10:00:00.000Z' }),
        entry({
          path: `${BIN}/Show/c.mkv`,
          relativePath: 'Show/c.mkv',
          sizeBytes: 200_000_000,
          jobId: 'j3',
          recycledAt: '2026-11-03T10:00:00.000Z',
        }),
        entry({
          path: `${BIN}/Show/d.mkv`,
          relativePath: 'Show/d.mkv',
          sizeBytes: 100_000_000,
          jobId: 'j4',
          recycledAt: '2026-11-02T10:00:00.000Z',
        }),
      ]),
    );
    mocks.recycle.empty.mockResolvedValue({ removed: 2, bytes: 1_200_000_000, skipped: 1 });
    await open();
    await screen.findByText(BIN);
    fireEvent.click(screen.getByRole('button', { name: 'Empty folder' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Empty the recycle folder of Shows?',
    });
    expect(within(dialog).getByText('This deletes 3 files (1.30 GB) for good.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Empty folder' }));
    await waitFor(() =>
      expect(mocks.recycle.empty).toHaveBeenCalledWith({
        libraryId: 'l1',
        throughRecycledAt: '2026-11-03T10:00:00.000Z',
      }),
    );
    expect(
      await screen.findByText(
        "Deleted 2 files; 1 was skipped (its job is busy or its folder can't be reached)",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(mocks.recycle.list).toHaveBeenCalledTimes(2));
  });

  it('Empty folder is not offered when the folder is empty', async () => {
    mocks.recycle.list.mockResolvedValue(listing([]));
    await open();
    await screen.findByText("Nothing in this library's recycle folder.");
    expect(screen.queryByRole('button', { name: 'Empty folder' })).toBeNull();
  });
});
