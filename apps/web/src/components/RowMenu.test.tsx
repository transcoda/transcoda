import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RowMenu } from './RowMenu.tsx';

afterEach(cleanup);

describe('RowMenu', () => {
  it('opens with the first item focused, marks the danger item, and passes the menu button on select', () => {
    const edit = vi.fn();
    const del = vi.fn();
    render(
      <RowMenu
        name="Shows"
        items={[
          { label: 'Edit', icon: 'pencil', onSelect: edit },
          { label: 'Delete', icon: 'trash', danger: true, onSelect: del },
        ]}
      />,
    );
    const button = screen.getByRole('button', { name: 'Actions for Shows' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(screen.getByRole('menuitem', { name: 'Delete' }).className).toContain('row-menu-danger');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(del).toHaveBeenCalledWith(button);
    expect(edit).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Escape closes it and returns focus to the button', () => {
    render(
      <RowMenu name="Shows" items={[{ label: 'Edit', icon: 'pencil', onSelect: () => {} }]} />,
    );
    const button = screen.getByRole('button', { name: 'Actions for Shows' });
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Edit' }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('a disabled item is announced as disabled with its hint and does nothing when picked', () => {
    const pick = vi.fn();
    render(
      <RowMenu
        name="Shows"
        items={[
          {
            label: 'Dry run…',
            icon: 'play',
            disabled: true,
            hint: 'Add a Library input to a workflow',
            onSelect: pick,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Shows' }));
    const item = screen.getByRole('menuitem', { name: 'Dry run…' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.getAttribute('title')).toBe('Add a Library input to a workflow');
    const hint = document.getElementById(item.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe('Add a Library input to a workflow');
    fireEvent.click(item);
    expect(pick).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();
  });
});
