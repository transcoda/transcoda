import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Group } from '@transcoda/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroupInspector } from './GroupInspector.tsx';

afterEach(cleanup);

const group: Group = {
  id: 'g1',
  name: 'Audio',
  collapsed: false,
  position: { x: 0, y: 0 },
  size: { width: 300, height: 200 },
};

function show(props: Partial<Parameters<typeof GroupInspector>[0]> = {}) {
  const handlers = {
    onRename: vi.fn(),
    onCollapse: vi.fn(),
    onUngroup: vi.fn(),
    onNote: vi.fn(),
  };
  render(<GroupInspector group={group} count={2} readOnly={false} {...handlers} {...props} />);
  return handlers;
}

describe('GroupInspector', () => {
  it('edits the note as Markdown text', () => {
    const h = show({ group: { ...group, note: 'Old' } });
    const note = screen.getByRole('textbox', { name: 'Note' }) as HTMLTextAreaElement;
    expect(note.value).toBe('Old');
    fireEvent.change(note, { target: { value: '**New**' } });
    expect(h.onNote).toHaveBeenLastCalledWith('**New**');
  });

  it('a frame that only holds a note is a Note, and its button deletes it', () => {
    const h = show({ group: { ...group, note: 'Read me' }, count: 0 });
    expect(screen.getByText('Note', { selector: '.inspector-eyebrow' })).toBeTruthy();
    expect(screen.queryByText('0 nodes')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
    expect(h.onUngroup).toHaveBeenCalled();
  });

  it('shows the name, the node count, the Collapsed switch and Ungroup', () => {
    const h = show();
    expect(screen.getByRole('heading', { name: 'Audio' })).toBeTruthy();
    expect(screen.getByText('2 nodes')).toBeTruthy();
    const name = screen.getByRole('textbox', { name: 'Group name' }) as HTMLInputElement;
    expect(name.value).toBe('Audio');
    fireEvent.change(name, { target: { value: 'Audio rules' } });
    expect(h.onRename).toHaveBeenLastCalledWith('Audio rules');

    const sw = screen.getByRole('switch', { name: 'Collapsed' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(h.onCollapse).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Ungroup' }));
    expect(h.onUngroup).toHaveBeenCalled();
  });

  it('an emptied name never reaches the graph and goes back to "Group" when the field is left', () => {
    const h = show();
    const name = screen.getByRole('textbox', { name: 'Group name' }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: '' } });
    fireEvent.change(name, { target: { value: '   ' } });
    // The field shows what was typed, but no blank name is sent.
    expect(name.value).toBe('   ');
    expect(h.onRename).not.toHaveBeenCalled();
    fireEvent.blur(name);
    expect(h.onRename).toHaveBeenLastCalledWith('Group');
    expect(h.onRename).toHaveBeenCalledTimes(1);
    expect(name.value).toBe('Group');
  });

  it('a name changed from outside (undo) replaces the field text', () => {
    const h = show();
    cleanup();
    const { rerender } = render(<GroupInspector group={group} count={2} readOnly={false} {...h} />);
    rerender(
      <GroupInspector group={{ ...group, name: 'Video' }} count={2} readOnly={false} {...h} />,
    );
    expect((screen.getByRole('textbox', { name: 'Group name' }) as HTMLInputElement).value).toBe(
      'Video',
    );
  });

  it('focuses the name field when asked', () => {
    const onFocused = vi.fn();
    show({ focusName: true, onFocused });
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Group name' }));
    expect(onFocused).toHaveBeenCalled();
  });

  it('read-only: nothing can change', () => {
    const h = show({ readOnly: true, count: 1 });
    expect(screen.getByText('1 node')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Group name' }) as HTMLInputElement).readOnly).toBe(
      true,
    );
    expect((screen.getByRole('switch', { name: 'Collapsed' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Ungroup' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(h.onRename).not.toHaveBeenCalled();
  });
});
