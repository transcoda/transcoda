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
