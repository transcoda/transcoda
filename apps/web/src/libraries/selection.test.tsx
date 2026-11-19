import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, renderHook, screen, within } from '@testing-library/react';
import type { LibraryFile } from '@transcoda/contract';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../jobs/useQueue.ts', () => ({
  useQueue: () => ({ status: { paused: false, lanes: {}, encodeSlots: 1 }, set: vi.fn() }),
}));

import { fx } from '../test/fixtures/jobs.ts';
import { renderAt } from '../test/render.tsx';
import { LibraryFileTable } from './LibraryFileTable.tsx';
import { SelectionBar } from './SelectionBar.tsx';
import { useSelection } from './useSelection.ts';

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

const file = (id: string, title: string): LibraryFile => ({
  id,
  path: `/media/classic/${title}.mkv`,
  fileName: `${title}.mkv`,
  sizeBytes: 1000,
  originalBytes: null,
  mtime: '2026-10-16T18:00:00.000Z',
  gone: false,
  poster: null,
  latest: { ...fx.kept, media: { ...fx.kept.media, title } },
});
const A = file('f1', 'Night of the Living Dead');
const B = file('f2', 'Sherlock Jr.');
const C = file('f3', 'The General');

const onRun = vi.fn();

/** A table with the selection wired the way the Library page wires it. */
function Harness({ pages = [[A, B]] }: { pages?: LibraryFile[][] }) {
  const [page, setPage] = useState(0);
  const [resetKey, setResetKey] = useState('a');
  const files = pages[page] ?? [];
  const selection = useSelection(resetKey);
  return (
    <>
      <button type="button" onClick={() => setPage((p) => p + 1)}>
        next page
      </button>
      <button type="button" onClick={() => setResetKey('b')}>
        new search
      </button>
      {selection.selected.size > 0 ? (
        <SelectionBar count={selection.selected.size} onRun={onRun} onClear={selection.clear} />
      ) : null}
      <LibraryFileTable
        libraryId="l1"
        files={files}
        total={files.length}
        sort="title"
        desc={false}
        onSort={vi.fn()}
        offset={0}
        limit={100}
        onPage={vi.fn()}
        selection={selection}
      />
    </>
  );
}

const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;

beforeEach(() => {
  onRun.mockReset();
  stubPhone(false);
});
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

describe('selection', () => {
  it('checking two rows shows the bar with 2 selected; Clear empties it', () => {
    renderAt('/libraries/l1', <Harness />);
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
    fireEvent.click(box('Select Night of the Living Dead.mkv'));
    fireEvent.click(box('Select Sherlock Jr..mkv'));
    const bar = screen.getByRole('region', { name: 'Selection' });
    expect(within(bar).getByText('2 selected')).toBeTruthy();
    expect(bar.querySelector('[aria-live="polite"]')?.textContent).toBe('2 selected');
    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
    expect(box('Select Night of the Living Dead.mkv').checked).toBe(false);
  });

  it('the bar offers Run a workflow… and calls onRun', () => {
    renderAt('/libraries/l1', <Harness />);
    fireEvent.click(box('Select Sherlock Jr..mkv'));
    fireEvent.click(screen.getByRole('button', { name: 'Run a workflow…' }));
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('Select this page selects only the rows on this page', () => {
    renderAt('/libraries/l1', <Harness pages={[[A, B], [C]]} />);
    fireEvent.click(box('Select this page'));
    expect(box('Select Night of the Living Dead.mkv').checked).toBe(true);
    expect(box('Select Sherlock Jr..mkv').checked).toBe(true);
    expect(screen.getByText('2 selected')).toBeTruthy();
    // Another page: its row is not selected, and the first page's rows still count.
    fireEvent.click(screen.getByRole('button', { name: 'next page' }));
    expect(box('Select The General.mkv').checked).toBe(false);
    expect(box('Select this page').checked).toBe(false);
    fireEvent.click(box('Select this page'));
    expect(screen.getByText('3 selected')).toBeTruthy();
    // Unticking it clears this page's rows only.
    fireEvent.click(box('Select this page'));
    expect(screen.getByText('2 selected')).toBeTruthy();
  });

  it('the header checkbox is indeterminate when only some rows are selected', () => {
    renderAt('/libraries/l1', <Harness />);
    const head = box('Select this page');
    expect(head.indeterminate).toBe(false);
    fireEvent.click(box('Select Sherlock Jr..mkv'));
    expect(head.indeterminate).toBe(true);
    expect(head.checked).toBe(false);
    fireEvent.click(box('Select Night of the Living Dead.mkv'));
    expect(head.indeterminate).toBe(false);
    expect(head.checked).toBe(true);
  });

  it('a row checkbox does not open the file', () => {
    const view = renderAt('/libraries/l1', <Harness />);
    fireEvent.click(box('Select Sherlock Jr..mkv'));
    expect(view.location()).toBe('/libraries/l1');
    // The row's link overlay covers the row; the checkbox is lifted above it.
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.row-link input\[type="checkbox"\][^{]*\{[^}]*z-index:\s*1/);
  });

  it('the selection resets when the reset key changes', () => {
    renderAt('/libraries/l1', <Harness />);
    fireEvent.click(box('Select Sherlock Jr..mkv'));
    expect(screen.getByText('1 selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'new search' }));
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
    expect(box('Select Sherlock Jr..mkv').checked).toBe(false);
  });

  it('phones show no checkboxes', () => {
    stubPhone(true);
    renderAt('/libraries/l1', <Harness />);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});

describe('useSelection', () => {
  it('keeps the selection across renders with the same key', () => {
    const { result, rerender } = renderHook(({ k }) => useSelection(k), {
      initialProps: { k: 'x' },
    });
    act(() => result.current.toggle('a'));
    rerender({ k: 'x' });
    expect([...result.current.selected]).toEqual(['a']);
    act(() => result.current.setPage(['b', 'c'], true));
    expect([...result.current.selected].sort()).toEqual(['a', 'b', 'c']);
    act(() => result.current.setPage(['a', 'b'], false));
    expect([...result.current.selected]).toEqual(['c']);
    rerender({ k: 'y' });
    expect(result.current.selected.size).toBe(0);
  });
});
