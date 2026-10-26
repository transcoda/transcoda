import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CanvasLegend } from './CanvasLegend.tsx';

afterEach(cleanup);

const css = readFileSync(join(__dirname, '../../styles.css'), 'utf8');

describe('CanvasLegend', () => {
  it('names the colour row "Node colours" (it shows node kinds, not icons)', () => {
    const { container } = render(<CanvasLegend />);
    const labels = [...container.querySelectorAll('.legend-label')].map((l) => l.textContent);
    expect(labels).toContain('Node colours');
    expect(labels).not.toContain('ICONS');
  });

  it('names the two branch outputs Yes and No', () => {
    const { container } = render(<CanvasLegend />);
    expect(container.querySelector('.legend-port.is-pass')?.textContent).toBe('Yes');
    expect(container.querySelector('.legend-port.is-else')?.textContent).toBe('No');
  });

  it('lists file flow first among the lines, each line with its arrowhead', () => {
    const { container } = render(<CanvasLegend />);
    const lines = [...container.querySelectorAll('.legend-line')];
    expect(lines[0]?.classList.contains('is-file')).toBe(true);
    expect(lines[0]?.nextElementSibling?.textContent).toBe('file flow');
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(line.querySelector('.legend-arrow')).not.toBeNull();
  });

  it('lists the running state and the Enter key for node actions', () => {
    const { container } = render(<CanvasLegend />);
    expect(container.querySelector('.legend-swatch.is-running')).not.toBeNull();
    expect(screen.getByText('running (moving border)')).toBeTruthy();
    const enter = [...container.querySelectorAll('kbd')].find((k) => k.textContent === 'Enter');
    expect(enter?.nextElementSibling?.textContent).toBe('node actions');
  });

  it('words the lock badge as the card does: "not on this server"', () => {
    render(<CanvasLegend />);
    const text = screen.getByText('not on this server');
    expect(text.previousElementSibling?.classList.contains('is-unavailable')).toBe(true);
    expect(screen.queryByText(/unavailable on this server/)).toBeNull();
  });

  it('explains the "not reachable" badge in the states row', () => {
    const { container } = render(<CanvasLegend />);
    const text = screen.getByText('not reachable — no path from the trigger');
    const badge = text.previousElementSibling;
    expect(badge?.classList.contains('legend-badge')).toBe(true);
    expect(badge?.classList.contains('is-unreachable')).toBe(true);
    expect(badge?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('.legend-badge.is-unreachable')).toHaveLength(1);
    // Grey like the card's dashed-tone badge.
    expect(css).toMatch(
      /\.legend-badge\.is-unreachable\s*\{[^}]*background:\s*var\(--line-strong\)/,
    );
  });

  it('has a Close button that closes the key and returns focus to "Key"', () => {
    const { container } = render(<CanvasLegend />);
    const details = container.querySelector('details') as HTMLDetailsElement;
    details.open = true;
    fireEvent.click(screen.getByRole('button', { name: 'Close key' }));
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(container.querySelector('summary'));
  });

  it('keeps each entry on one line and the body inside the canvas', () => {
    expect(css.match(/\.legend-item\s*\{([^}]*)\}/)?.[1] ?? '').toMatch(/white-space:\s*nowrap/);
    const body = css.match(/\.canvas-legend-body\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/max-height:/);
  });
});
