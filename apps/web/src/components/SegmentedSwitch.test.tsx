import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SegmentedSwitch } from './SegmentedSwitch.tsx';

const options = [
  { id: 'cards', label: 'Cards' },
  { id: 'table', label: 'Table', count: 3 },
] as const;

describe('SegmentedSwitch', () => {
  afterEach(cleanup);
  it('moves the choice and focus with ArrowRight', () => {
    const onChange = vi.fn();
    render(<SegmentedSwitch label="View" value="cards" options={options} onChange={onChange} />);
    const [cards, table] = screen.getAllByRole('radio');
    cards?.focus();
    fireEvent.keyDown(cards as HTMLElement, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('table');
    expect(document.activeElement).toBe(table);
  });
  it('keeps one tab stop on the checked option', () => {
    render(<SegmentedSwitch label="View" value="table" options={options} onChange={() => {}} />);
    const [cards, table] = screen.getAllByRole('radio');
    expect(table?.getAttribute('aria-checked')).toBe('true');
    expect(table?.tabIndex).toBe(0);
    expect(cards?.getAttribute('aria-checked')).toBe('false');
    expect(cards?.tabIndex).toBe(-1);
  });
  it('names the group and shows a count only when given', () => {
    render(
      <SegmentedSwitch
        label="View"
        className="x"
        value="cards"
        options={options}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('radiogroup', { name: 'View' }).className).toBe('x');
    expect(screen.getByRole('radio', { name: 'Table 3' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Cards' })).toBeTruthy();
  });
});
