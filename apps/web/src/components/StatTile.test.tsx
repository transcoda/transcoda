import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatTile } from './StatTile.tsx';

afterEach(cleanup);

describe('StatTile', () => {
  it('shows label, value and detail; dims a zero only when asked', () => {
    render(
      <ul>
        <StatTile label="Saved" value="554 GB" sub="1.19 TB → 636 GB" />
        <StatTile label="Queued" value="0" zero />
      </ul>,
    );
    const saved = screen.getByText('554 GB').closest('li') as HTMLElement;
    expect(saved.className).toBe('stat-tile');
    expect(saved.querySelector('.stat-sub')?.textContent).toBe('1.19 TB → 636 GB');
    expect(screen.getByText('0').closest('li')?.className).toBe('stat-tile is-zero');
  });

  it('with onClick the tile is a toggle with a check when pressed', () => {
    const onClick = vi.fn();
    render(
      <ul>
        <StatTile label="Failed" value="2" onClick={onClick} pressed buttonLabel="Show Failed: 2" />
      </ul>,
    );
    const button = screen.getByRole('button', { name: 'Show Failed: 2' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.querySelector('svg')).not.toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalled();
  });
});
