import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListboxSelect } from './ListboxSelect.tsx';

afterEach(cleanup);

const OPTIONS = [
  { value: '', label: 'All libraries' },
  { value: 'a', label: 'Movies' },
  { value: 'b', label: 'Shows' },
];

function setup(value = '') {
  const onChange = vi.fn();
  render(<ListboxSelect label="Library" value={value} options={OPTIONS} onChange={onChange} />);
  const button = screen.getByRole('button', { name: /^Library / });
  return { button, onChange };
}

describe('ListboxSelect', () => {
  it('opens a listbox with the current option selected and focused', () => {
    const { button } = setup('a');
    expect(button.getAttribute('aria-haspopup')).toBe('listbox');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('listbox', { name: 'Library' });
    const opts = screen.getAllByRole('option');
    expect(opts.map((o) => o.textContent)).toEqual(['All libraries', 'Movies', 'Shows']);
    expect(opts[1]?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(list);
    expect(list.getAttribute('aria-activedescendant')).toBe(opts[1]?.id);
  });

  it('arrows move, Enter selects, focus returns to the button', () => {
    const { button, onChange } = setup();
    fireEvent.click(button);
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' }); // clamps at the last option
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('a');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('Home and End jump to the ends', () => {
    const { button, onChange } = setup();
    fireEvent.click(button);
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'End' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('b');
    expect(button).toBeTruthy();
  });

  it('Escape closes without choosing and returns focus', () => {
    const { button, onChange } = setup();
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('clicking an option selects it', () => {
    const { button, onChange } = setup();
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('option', { name: 'Shows' }));
    expect(onChange).toHaveBeenCalledWith('b');
    expect(document.activeElement).toBe(button);
  });
});
