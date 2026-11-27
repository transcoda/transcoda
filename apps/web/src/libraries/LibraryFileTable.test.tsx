import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { LibraryFile } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../jobs/use-queue.ts', () => ({
  useQueue: () => ({ status: { paused: false, lanes: {}, encodeSlots: 1 }, set: vi.fn() }),
}));

import { fx } from '../testing/fixtures/jobs.ts';
import { renderAt } from '../testing/render.tsx';
import { LibraryFileTable } from './LibraryFileTable.tsx';

const realMatchMedia = window.matchMedia;
function stubPhone(phone: boolean) {
  window.matchMedia = (query: string) =>
    ({
      matches: phone && query === '(max-width: 639px)',
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

const FILE: LibraryFile = {
  id: 'f1',
  path: '/media/classic-tv/The Bramblewood Family S01E02.mp4',
  fileName: 'The Bramblewood Family S01E02.mp4',
  sizeBytes: 1_620_000_000,
  originalBytes: 2_410_000_000,
  mtime: '2026-10-16T18:00:00.000Z',
  gone: false,
  poster: null,
  latest: {
    ...fx.replaced,
    media: {
      ...fx.replaced.media,
      title: 'The Bramblewood Family',
      season: 1,
      episode: 2,
      episodeTitle: 'Ada Buys Stock',
    },
  },
};
const OTHER: LibraryFile = {
  ...FILE,
  id: 'f2',
  fileName: 'Nocturne of the Quiet Moon.mkv',
  latest: {
    ...fx.kept,
    media: { ...fx.kept.media, title: 'Nocturne of the Quiet Moon', year: 1968 },
  },
};

const onSort = vi.fn();
const onPage = vi.fn();

function table(over: Partial<Parameters<typeof LibraryFileTable>[0]> = {}) {
  return renderAt(
    '/libraries/l1',
    <LibraryFileTable
      libraryId="l1"
      files={[FILE, OTHER]}
      total={2}
      sort="title"
      desc={false}
      onSort={onSort}
      offset={0}
      limit={100}
      onPage={onPage}
      {...over}
    />,
  );
}

beforeEach(() => {
  onSort.mockReset();
  onPage.mockReset();
  stubPhone(false);
});
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

describe('LibraryFileTable', () => {
  it('a row shows title, episode code, size, status and result, and links to the file page', () => {
    table();
    const grid = screen.getByRole('table', { name: 'Files' });
    const row = within(grid)
      .getByRole('link', { name: /The Bramblewood Family/ })
      .closest('tr');
    expect(row).toBeTruthy();
    const r = within(row as HTMLElement);
    expect(r.getByRole('link', { name: /The Bramblewood Family/ }).getAttribute('href')).toBe(
      '/libraries/l1/files/f1',
    );
    expect(r.getByText('S01E02')).toBeTruthy();
    expect(r.getByText('1.62 GB')).toBeTruthy();
    expect(r.getByText(/Replaced|Done/i)).toBeTruthy();
    expect(r.getByText('2.41 GB → 1.62 GB')).toBeTruthy();
    expect(r.getByText(/saved \d/)).toBeTruthy();
  });

  it('the file id is encoded in the link', () => {
    table({ files: [{ ...FILE, id: 'a b' }], total: 1 });
    expect(screen.getByRole('link', { name: /The Bramblewood Family/ }).getAttribute('href')).toBe(
      '/libraries/l1/files/a%20b',
    );
  });

  it('clicking Size sorts by size; clicking it again sorts descending', () => {
    const view = table();
    fireEvent.click(screen.getByRole('button', { name: 'Size' }));
    expect(onSort).toHaveBeenLastCalledWith('size', false);
    view.unmount();
    table({ sort: 'size', desc: false });
    fireEvent.click(screen.getByRole('button', { name: 'Size' }));
    expect(onSort).toHaveBeenLastCalledWith('size', true);
  });

  it('the headers say which column is sorted and which way', () => {
    table({ sort: 'size', desc: true });
    const th = (name: string) => screen.getByRole('columnheader', { name });
    expect(th('Size').getAttribute('aria-sort')).toBe('descending');
    expect(th('Title').getAttribute('aria-sort')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Status' }));
    expect(onSort).toHaveBeenLastCalledWith('result', false);
    fireEvent.click(screen.getByRole('button', { name: 'Last run' }));
    expect(onSort).toHaveBeenLastCalledWith('lastRun', false);
  });

  it('the pager says 101–200 of 4,214 and Next asks for offset 200', () => {
    table({
      files: Array.from({ length: 100 }, (_, i) => ({ ...FILE, id: `f${i}` })),
      total: 4214,
      offset: 100,
    });
    expect(screen.getByText('101–200 of 4,214')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPage).toHaveBeenLastCalledWith(200);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onPage).toHaveBeenLastCalledWith(0);
  });

  it('Previous is off on the first page and Next on the last', () => {
    table({ total: 250, offset: 0 });
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    cleanup();
    table({ total: 250, offset: 200 });
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the pager keeps its range but has no buttons when everything fits on one page', () => {
    table({ total: 2 });
    expect(screen.getByText('1–2 of 2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it('past the first page Previous stays when the list shrank to one page', () => {
    // A live refresh took the list from 201 files to 100 while the second page was shown.
    table({ files: [], total: 100, offset: 100 });
    const previous = screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement;
    expect(previous.disabled).toBe(false);
    fireEvent.click(previous);
    expect(onPage).toHaveBeenLastCalledWith(0);
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('on a phone it renders cards, not a table', () => {
    stubPhone(true);
    table();
    expect(screen.queryByRole('table')).toBeNull();
    const link = screen.getByRole('link', { name: /The Bramblewood Family/ });
    expect(link.getAttribute('href')).toBe('/libraries/l1/files/f1');
    const card = link.closest('.phone-card') as HTMLElement;
    expect(card).toBeTruthy();
    expect(within(card).getByText('S01E02')).toBeTruthy();
    expect(card.textContent).toContain('1.62 GB · ');
    expect(within(card).queryByRole('checkbox')).toBeNull();
    expect(screen.getByText('1–2 of 2')).toBeTruthy();
  });

  it('on a phone an empty list says no files match', () => {
    stubPhone(true);
    table({ files: [], total: 0 });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('No files match.')).toBeTruthy();
    expect(document.querySelector('.phone-card')).toBeNull();
  });
});
