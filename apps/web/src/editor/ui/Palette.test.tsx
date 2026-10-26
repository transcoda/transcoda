import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { WorkflowSummary } from '@transcoda/contract';
import type { WorkflowKind } from '@transcoda/shared';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KIND_WORD } from '../../components/Chips.tsx';
import { catalogFixture, nodesFixture } from '../../test/fixtures/catalog.ts';
import { Palette, type PaletteItem } from './Palette.tsx';

afterEach(cleanup);

function summary(id: string, name: string, kind: WorkflowKind): WorkflowSummary {
  return {
    id,
    name,
    kind,
    active: null,
    currentVersion: 3,
    valid: true,
    errorCount: 0,
    usesOutdatedSubworkflow: false,
    feedsLibrary: null,
    libraryInput: null,
    usedBy: [],
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
  };
}

const workflows = [
  summary('main', 'TV cleanup', 'workflow'),
  summary('sub-lang', 'Language cleanup', 'subworkflow'),
  summary('sub-audio', 'Audio fixes', 'subworkflow'),
];

function renderPalette(
  overrides: Partial<{
    graphKind: WorkflowKind;
    selfId: string;
    readOnly: boolean;
    hasValues: boolean;
  }> = {},
) {
  const onAdd = vi.fn<(item: PaletteItem) => void>();
  const onDragStart = vi.fn();
  const searchRef = createRef<HTMLInputElement>();
  render(
    <Palette
      catalog={catalogFixture}
      graphKind={overrides.graphKind ?? 'workflow'}
      selfId={overrides.selfId ?? 'main'}
      subworkflows={workflows}
      readOnly={overrides.readOnly ?? false}
      hasValues={overrides.hasValues ?? false}
      onAdd={onAdd}
      onDragStart={onDragStart}
      searchRef={searchRef}
    />,
  );
  return { onAdd, onDragStart, searchRef };
}

function section(name: string): HTMLElement {
  return screen.getByRole('group', { name });
}

function isDisabled(button: HTMLElement): boolean {
  return button.getAttribute('aria-disabled') === 'true';
}

describe('Palette', () => {
  it('offers a Note and the Shared values card; the card only once', () => {
    const { onAdd } = renderPalette();
    fireEvent.click(screen.getByRole('button', { name: /^Note/ }));
    expect(onAdd).toHaveBeenLastCalledWith({ kind: 'note' });
    fireEvent.click(screen.getByRole('button', { name: /^Shared values/ }));
    expect(onAdd).toHaveBeenLastCalledWith({ kind: 'values' });
    cleanup();
    renderPalette({ hasValues: true });
    const card = screen.getByRole('button', { name: /^Shared values/ });
    expect(card.getAttribute('aria-disabled')).toBe('true');
    expect(card.textContent).toContain('already on the canvas');
  });

  it('lists sections in design order with every available core node as a button', () => {
    const { searchRef } = renderPalette();
    expect(screen.getByRole('complementary', { name: 'Node palette' })).toBeTruthy();
    const search = screen.getByRole('searchbox', { name: 'Search nodes' });
    expect(search.getAttribute('placeholder')).toBe('Search nodes');
    expect(searchRef.current).toBe(search);

    const headings = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'));
    expect(headings).toEqual([
      'Trigger',
      'Condition',
      'Action',
      'Finish',
      'Sub-workflows',
      'Notes & values',
    ]);
    expect(screen.queryByRole('group', { name: 'Sub-workflow' })).toBeNull();

    for (const def of nodesFixture) {
      if (def.kind === 'subworkflow-io' || !def.availability.available) continue;
      const button = within(section(KIND_WORD[def.kind])).getByRole('button', {
        name: def.title,
      });
      expect(isDisabled(button)).toBe(false);
      expect(button.querySelector('svg[data-icon]')).not.toBeNull();
    }
    // Start and End are sub-workflow only: a main workflow never offers them.
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'End' })).toBeNull();
  });

  it('renders unavailable nodes disabled with the reason "Needs the Whisper plugin"', () => {
    const { onAdd } = renderPalette();
    const button = within(section('Action')).getByRole('button', {
      name: 'Generate subtitles, plugin',
    });
    expect(isDisabled(button)).toBe(true);
    expect(button.getAttribute('draggable')).toBe('false');
    expect(button.textContent).toContain('Needs the Whisper plugin');
    expect(screen.getByRole('button', { description: 'Needs the Whisper plugin' })).toBe(button);
    // Plugin nodes carry the plug icon after the title.
    expect(within(button).getByRole('img', { name: 'plugin' })).toBeTruthy();
    fireEvent.click(button);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('in a sub-workflow, triggers and finishes are disabled with "main workflow only" and an End item is offered', () => {
    const { onAdd } = renderPalette({ graphKind: 'subworkflow', selfId: 'sub-lang' });
    for (const name of ['Trigger', 'Finish']) {
      const buttons = within(section(name)).getAllByRole('button');
      expect(buttons.length).toBeGreaterThan(0);
      for (const b of buttons) {
        expect(isDisabled(b)).toBe(true);
        expect(b.textContent).toContain('main workflow only');
      }
    }
    fireEvent.click(within(section('Trigger')).getByRole('button', { name: 'Library input' }));
    expect(onAdd).not.toHaveBeenCalled();
    expect(isDisabled(within(section('Action')).getByRole('button', { name: 'Remux' }))).toBe(
      false,
    );

    const end = within(section('Sub-workflows')).getByRole('button', { name: 'End' });
    expect(isDisabled(end)).toBe(false);
    fireEvent.click(end);
    expect(onAdd).toHaveBeenCalledWith({ kind: 'end' });
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  });

  it('filters by search text and calls onAdd on click', () => {
    const { onAdd, onDragStart } = renderPalette();
    const search = screen.getByRole('searchbox', { name: 'Search nodes' });
    // Case-insensitive; "Keep languages" and "Embed subtitle files" match on their descriptions
    // ("… subtitle tracks …").
    fireEvent.change(search, { target: { value: 'TRACKS' } });
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual([
      'Action',
    ]);
    expect(
      within(section('Action'))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Keep languages', 'Set default track', 'Reorder tracks', 'Embed subtitle files']);

    fireEvent.change(search, { target: { value: 'encode vid' } });
    const encode = screen.getByRole('button', { name: 'Encode video' });
    fireEvent.click(encode);
    const def = catalogFixture.byType.get('core:encode-video');
    expect(onAdd).toHaveBeenCalledWith({ kind: 'node', def });

    const setData = vi.fn();
    fireEvent.dragStart(encode, { dataTransfer: { setData, effectAllowed: 'none' } });
    expect(setData).toHaveBeenCalledWith(
      'application/x-transcoda-node',
      JSON.stringify({ kind: 'node', def }),
    );
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragStart.mock.calls[0]?.[0]).toEqual({ kind: 'node', def });

    fireEvent.change(search, { target: { value: 'zzz nothing' } });
    expect(screen.queryAllByRole('group')).toEqual([]);
    expect(screen.getByText('No nodes match “zzz nothing”')).toBeTruthy();
  });

  it('Sub-workflows section lists other sub-workflows and never the one being edited', () => {
    const { onAdd } = renderPalette({ graphKind: 'subworkflow', selfId: 'sub-lang' });
    const names = within(section('Sub-workflows'))
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names).toEqual(['End', 'Audio fixes']);
    fireEvent.click(screen.getByRole('button', { name: 'Audio fixes' }));
    expect(onAdd).toHaveBeenCalledWith({ kind: 'subworkflow', workflow: workflows[2] });

    cleanup();
    renderPalette({ graphKind: 'workflow', selfId: 'main' });
    expect(
      within(section('Sub-workflows'))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Language cleanup', 'Audio fixes']);
  });

  it('disables every item when read-only', () => {
    const { onAdd, onDragStart } = renderPalette({ readOnly: true });
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(10);
    for (const b of buttons) {
      expect(isDisabled(b)).toBe(true);
      expect(b.getAttribute('draggable')).toBe('false');
    }
    fireEvent.click(screen.getByRole('button', { name: 'Remux' }));
    fireEvent.dragStart(screen.getByRole('button', { name: 'Remux' }), {
      dataTransfer: { setData: vi.fn() },
    });
    expect(onAdd).not.toHaveBeenCalled();
    expect(onDragStart).not.toHaveBeenCalled();
  });
});
