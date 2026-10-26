import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { Group } from '@transcoda/shared';
import type { NodeProps } from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderFlow } from '../../test/flow.tsx';
import type { GroupProblem } from '../model/group-state.ts';
import {
  DEFAULT_EDITOR_ACTIONS,
  type EditorActions,
  EditorActionsContext,
} from './actions-context.ts';
import { TcGroup } from './TcGroup.tsx';
import type { TcGroupNode } from './types.ts';

afterEach(cleanup);

function groupNode(
  extra: Partial<Group> = {},
  opts: { count?: number; selected?: boolean; problem?: GroupProblem } = {},
): TcGroupNode {
  const group: Group = {
    id: 'g1',
    name: 'Audio rules',
    collapsed: false,
    position: { x: 0, y: 0 },
    size: { width: 480, height: 240 },
    ...extra,
  };
  const size = group.collapsed ? { width: 210, height: 60 } : group.size;
  return {
    id: group.id,
    type: 'tc-group',
    position: group.position,
    style: { ...size },
    selected: opts.selected ?? false,
    data: { group, count: opts.count ?? 2, problem: opts.problem ?? null },
  };
}

async function show(node: TcGroupNode, actions: EditorActions = DEFAULT_EDITOR_ACTIONS) {
  const nodeTypes = {
    'tc-group': (props: NodeProps<TcGroupNode>) => (
      <EditorActionsContext.Provider value={actions}>
        <TcGroup {...props} />
      </EditorActionsContext.Provider>
    ),
  };
  return renderFlow([node], [], { nodeTypes });
}

const editable = (extra: Partial<EditorActions> = {}): EditorActions => ({
  ...DEFAULT_EDITOR_ACTIONS,
  readOnly: false,
  ...extra,
});

describe('TcGroup', () => {
  it('draws the note as Markdown inside an expanded frame, and hides it when collapsed', async () => {
    await show(groupNode({ note: '**Change** the languages' }));
    const box = screen.getByRole('group', { name: 'Group Audio rules' });
    expect(within(box).getByText('Change').tagName).toBe('STRONG');
    cleanup();
    await show(groupNode({ note: '**Change** the languages', collapsed: true }));
    expect(screen.queryByText('Change')).toBeNull();
  });

  it('a frame with a note and no nodes says "Note" instead of a node count', async () => {
    await show(groupNode({ note: 'Read me' }, { count: 0 }));
    expect(screen.getByText('Note')).toBeTruthy();
    expect(screen.queryByText(/Group ·/)).toBeNull();
  });

  it('TcGroup shows the name and "Group · 2 nodes" and toggles the collapse action', async () => {
    const setGroupCollapsed = vi.fn();
    await show(groupNode(), editable({ setGroupCollapsed }));
    const box = screen.getByRole('group', { name: 'Group Audio rules' });
    expect(within(box).getByText('Audio rules')).toBeTruthy();
    expect(within(box).getByText('Group · 2 nodes')).toBeTruthy();
    expect(box.classList.contains('is-collapsed')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse group Audio rules' }));
    expect(setGroupCollapsed).toHaveBeenCalledWith('g1', true);
  });

  it('collapsed: a tile with the name and count, a group handle each side and "Expand group"', async () => {
    const setGroupCollapsed = vi.fn();
    await show(groupNode({ collapsed: true }, { count: 1 }), editable({ setGroupCollapsed }));
    const tile = screen.getByRole('group', { name: 'Group Audio rules' });
    expect(tile.classList.contains('is-collapsed')).toBe(true);
    expect(within(tile).getByText('Group · 1 node')).toBeTruthy();
    const target = tile.querySelector('.react-flow__handle.target[data-handleid="group"]');
    const source = tile.querySelector('.react-flow__handle.source[data-handleid="group"]');
    expect(target).not.toBeNull();
    expect(source).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand group Audio rules' }));
    expect(setGroupCollapsed).toHaveBeenCalledWith('g1', false);
  });

  it("collapsed with a problem: the members' badge, word and border on the tile", async () => {
    const problem: GroupProblem = {
      border: 'red',
      badge: 'plugin-missing',
      count: 1,
      word: 'plugin missing',
    };
    await show(groupNode({ collapsed: true }, { problem }), editable());
    const tile = screen.getByRole('group', { name: 'Group Audio rules, plugin missing' });
    expect(tile.classList.contains('border-red')).toBe(true);
    const badge = tile.querySelector('.tc-badge.tone-red');
    expect(badge?.textContent).toContain('plugin missing');
    expect(badge?.querySelector('svg')).not.toBeNull();
  });

  it('collapsed with an amber problem: the "!" glyph and the count word', async () => {
    const problem: GroupProblem = {
      border: 'amber',
      badge: 'needs-setting',
      count: 2,
      word: '2 nodes need attention',
    };
    await show(groupNode({ collapsed: true }, { problem }), editable());
    const tile = screen.getByRole('group', { name: 'Group Audio rules, 2 nodes need attention' });
    expect(tile.classList.contains('border-amber')).toBe(true);
    const badge = tile.querySelector('.tc-badge.tone-amber');
    expect(badge?.querySelector('.tc-badge-bang')?.textContent).toBe('!');
    expect(badge?.textContent).toContain('2 nodes need attention');
  });

  it('expanded: no badge or border even if a problem were passed (the members show theirs)', async () => {
    const problem: GroupProblem = {
      border: 'red',
      badge: 'plugin-missing',
      count: 1,
      word: 'plugin missing',
    };
    await show(groupNode({}, { problem }), editable());
    const box = screen.getByRole('group', { name: 'Group Audio rules' });
    expect(box.querySelector('.tc-badge')).toBeNull();
    expect(box.classList.contains('border-red')).toBe(false);
  });

  it('has no group handles while expanded', async () => {
    await show(groupNode(), editable());
    const box = screen.getByRole('group', { name: 'Group Audio rules' });
    expect(box.querySelector('.react-flow__handle')).toBeNull();
  });

  it('shows the resizer only when selected, editable and expanded', async () => {
    const resizer = () => document.querySelector('.react-flow__resize-control');
    await show(groupNode({}, { selected: true }), editable());
    expect(resizer()).not.toBeNull();
    cleanup();
    await show(groupNode({}, { selected: false }), editable());
    expect(resizer()).toBeNull();
    cleanup();
    await show(groupNode({}, { selected: true }));
    expect(resizer()).toBeNull();
    cleanup();
    await show(groupNode({ collapsed: true }, { selected: true }), editable());
    expect(resizer()).toBeNull();
  });

  it('keeps the collapse button on a read-only canvas (the page makes it view-only there)', async () => {
    const setGroupCollapsed = vi.fn();
    await show(groupNode({ collapsed: true }), { ...DEFAULT_EDITOR_ACTIONS, setGroupCollapsed });
    fireEvent.click(screen.getByRole('button', { name: 'Expand group Audio rules' }));
    expect(setGroupCollapsed).toHaveBeenCalledWith('g1', false);
  });
});
