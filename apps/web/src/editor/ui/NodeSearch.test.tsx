import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { NodeInfo, WorkflowSummary } from '@transcoda/contract';
import type { WorkflowKind } from '@transcoda/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PortType } from '../../hooks/useCatalog.ts';
import { catalogFixture } from '../../test/fixtures/catalog.ts';
import { compatibleTargets, type NextRule } from '../model/connection.ts';
import { filterHint, NodeSearch } from './NodeSearch.tsx';

afterEach(cleanup);

function sub(id: string, name: string, kind: WorkflowSummary['kind'] = 'subworkflow') {
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
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  } satisfies WorkflowSummary;
}

function renderSearch(props: {
  graphKind?: WorkflowKind;
  filter?: { portType: PortType; rule?: NextRule } | null;
  title: string;
  subworkflows?: WorkflowSummary[];
  selfId?: string;
}) {
  const onPick = vi.fn<(def: NodeInfo, workflow?: WorkflowSummary) => void>();
  const onClose = vi.fn();
  render(
    <NodeSearch
      open
      catalog={catalogFixture}
      graphKind={props.graphKind ?? 'workflow'}
      filter={props.filter ?? null}
      title={props.title}
      {...(props.subworkflows && { subworkflows: props.subworkflows })}
      {...(props.selfId && { selfId: props.selfId })}
      onPick={onPick}
      onClose={onClose}
    />,
  );
  return { onPick, onClose };
}

function optionNames(): string[] {
  return screen.getAllByRole('option').map((o) => o.getAttribute('aria-label') ?? '');
}

describe('NodeSearch', () => {
  it('filterHint says which nodes a filtered search lists', () => {
    expect(filterHint('file')).toBe('Only nodes that accept a file are listed');
    expect(filterHint('data:language')).toBe('Only nodes with a language input are listed');
    expect(filterHint('data:track')).toBe('Only nodes with a track input are listed');
  });

  it("filterHint names a compound data type by the port's label, else its id, with a or an", () => {
    expect(filterHint('data:audio-track')).toBe('Only nodes with an audio-track input are listed');
    expect(filterHint('data:audio-track', 'Audio track')).toBe(
      'Only nodes with an audio track input are listed',
    );
    expect(filterHint('data:audio-track', '')).toBe(
      'Only nodes with an audio-track input are listed',
    );
    expect(filterHint('data:language', 'Language')).toBe(
      'Only nodes with a language input are listed',
    );
    expect(filterHint('data:codec', 'HDR format')).toBe(
      'Only nodes with a HDR format input are listed',
    );
  });

  it('filterHint after a finish node says only later finish steps are listed, and why', () => {
    const after: NextRule = {
      kind: 'finish-after',
      minRank: 1,
      noWrite: false,
      afterTitle: 'Replace original',
    };
    expect(filterHint('file', 'File', after)).toBe(
      'After Replace original, only later finish steps are listed',
    );
    expect(filterHint('file', 'No', { ...after, minRank: 2, noWrite: true })).toBe(
      "After the size gate's No, only notifications and other non-writing steps are listed",
    );
    expect(filterHint('file', 'File', { kind: 'any' })).toBe(
      'Only nodes that accept a file are listed',
    );
  });

  it('with a finish-after rule lists only those finish nodes and says why under the list', () => {
    const rule: NextRule = {
      kind: 'finish-after',
      minRank: 1,
      noWrite: false,
      afterTitle: 'Replace original',
    };
    renderSearch({ filter: { portType: 'file', rule }, title: 'Add the next node' });
    expect(optionNames()).toEqual(['Replace original', 'Move or copy', 'Notify webhook']);
    expect(screen.getByRole('dialog', { name: 'Add the next node · 3 matches' })).toBeTruthy();
    expect(
      screen.getByRole('combobox', {
        description: 'After Replace original, only later finish steps are listed',
      }),
    ).toBeTruthy();
  });

  it('NodeSearch with a file filter shows "Add the next node · N matches" and only compatible nodes', () => {
    renderSearch({ filter: { portType: 'file' }, title: 'Add the next node' });
    const expected = compatibleTargets(catalogFixture, 'file', 'workflow');
    const dialog = screen.getByRole('dialog', {
      name: `Add the next node · ${expected.length} matches`,
    });
    expect(dialog).toBeTruthy();
    expect(optionNames()).toEqual(
      expected.map((n) => (n.source.kind === 'plugin' ? `${n.title}, plugin` : n.title)),
    );
    expect(optionNames()).not.toContain('Library input');
    expect(optionNames()).not.toContain('End');
    // Unavailable nodes are listed, disabled, with the reason.
    const subtitles = screen.getByRole('option', { name: 'Generate subtitles, plugin' });
    expect(subtitles.getAttribute('aria-disabled')).toBe('true');
    expect(subtitles.textContent).toContain('Needs the Whisper plugin');
  });

  it('with a filter, says under the list which nodes are listed and describes the combobox with it', () => {
    renderSearch({ filter: { portType: 'file' }, title: 'Add the next node' });
    const hint = screen.getByText('Only nodes that accept a file are listed');
    expect(hint.classList).toContain('node-search-hint');
    // Spec N4: the line sits under the list.
    const list = screen.getByRole('listbox');
    expect(list.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const input = screen.getByRole('combobox', { name: 'Search nodes' });
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);
    expect(
      screen.getByRole('combobox', { description: 'Only nodes that accept a file are listed' }),
    ).toBe(input);
  });

  it('names the data type in the hint for a data filter', () => {
    renderSearch({ filter: { portType: 'data:language' }, title: 'Add the next node' });
    expect(
      screen.getByRole('combobox', { description: 'Only nodes with a language input are listed' }),
    ).toBeTruthy();
  });

  it('shows no hint and no description without a filter', () => {
    renderSearch({ title: 'Add a node' });
    expect(screen.queryByText(/^Only nodes/)).toBeNull();
    expect(screen.getByRole('combobox').hasAttribute('aria-describedby')).toBe(false);
  });

  it('counts one match in the singular and narrows by the typed text', () => {
    renderSearch({ filter: { portType: 'data:language' }, title: 'Add the next node' });
    const input = screen.getByRole('combobox', { name: 'Search nodes' });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'default' } });
    expect(screen.getByRole('dialog', { name: 'Add the next node · 1 match' })).toBeTruthy();
    expect(optionNames()).toEqual(['Set default track']);
  });

  it('without a filter lists the nodes the graph allows, under the plain title', () => {
    renderSearch({ graphKind: 'subworkflow', title: 'Add a node' });
    expect(screen.getByRole('dialog', { name: 'Add a node' })).toBeTruthy();
    const names = optionNames();
    expect(names).toContain('End');
    expect(names).toContain('Remux');
    expect(names).not.toContain('Start');
    expect(names).not.toContain('Library input');
    expect(names).not.toContain('Size gate');
  });

  it('picks with arrow keys and Enter, skipping disabled nodes, and closes on Escape', () => {
    const { onPick, onClose } = renderSearch({
      filter: { portType: 'file' },
      title: 'Add the next node',
    });
    const input = screen.getByRole('combobox', { name: 'Search nodes' });
    fireEvent.change(input, { target: { value: 'encod' } });
    // "Encode video", "Encode audio", "Remux" (re-encoding) and the unavailable "Generate subtitles".
    expect(optionNames()).toEqual([
      'Encode video',
      'Encode audio',
      'Remux',
      'Generate subtitles, plugin',
    ]);
    const active = () => document.getElementById(input.getAttribute('aria-activedescendant') ?? '');
    expect(active()?.getAttribute('aria-label')).toBe('Encode video');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(active()?.getAttribute('aria-label')).toBe('Remux');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(active()?.getAttribute('aria-label')).toBe('Encode audio');
    // Enter that confirms an IME composition is not a pick (final review M15).
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith(catalogFixture.byType.get('core:encode-audio'));

    fireEvent.click(screen.getByRole('option', { name: 'Generate subtitles, plugin' }));
    expect(onPick).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('option', { name: 'Remux' }));
    expect(onPick).toHaveBeenLastCalledWith(catalogFixture.byType.get('core:remux'));

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers named sub-workflows (not itself, not workflows); picking one adds a Run node for it', () => {
    const language = sub('s1', 'Language cleanup');
    const { onPick } = renderSearch({
      filter: { portType: 'file' },
      title: 'Add the next node',
      subworkflows: [language, sub('s2', 'Audio tidy'), sub('w1', 'TV cleanup', 'workflow')],
      selfId: 's2',
    });
    expect(optionNames()).toContain('Language cleanup, sub-workflow');
    expect(optionNames()).not.toContain('Audio tidy, sub-workflow');
    expect(optionNames()).not.toContain('TV cleanup, sub-workflow');
    const input = screen.getByRole('combobox', { name: 'Search nodes' });
    fireEvent.change(input, { target: { value: 'language cl' } });
    expect(optionNames()).toEqual(['Language cleanup, sub-workflow']);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'core:run-subworkflow' }),
      language,
    );
  });

  it('renders nothing while closed', () => {
    render(
      <NodeSearch
        open={false}
        catalog={catalogFixture}
        graphKind="workflow"
        title="Add a node"
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('option')).toBeNull();
  });
});
