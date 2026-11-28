import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { stylesCss } from '../../styles/testing/css-source.ts';
import { CanvasLegend } from './CanvasLegend.tsx';

afterEach(cleanup);

const css = stylesCss;
const labelsOf = (c: HTMLElement) =>
  [...c.querySelectorAll('.legend-label')].map((l) => l.textContent);

describe('CanvasLegend', () => {
  it('explains only what the canvas does not say in words: lines, ports, badges, keys', () => {
    const { container } = render(<CanvasLegend keys />);
    expect(labelsOf(container)).toEqual(['Lines', 'Ports', 'Badges', 'Keys']);
    // The cards name their kind, their Yes / No outputs and their group; those need no key.
    for (const gone of ['Node colors', 'trigger', 'Yes', 'selected', 'running', 'group']) {
      expect(screen.queryByText(new RegExp(`^${gone}`))).toBeNull();
    }
  });

  it('shows the two line styles the editor draws that say nothing in words, each with its arrowhead', () => {
    const { container } = render(<CanvasLegend keys />);
    const lines = [...container.querySelectorAll('.legend-line')];
    expect(lines.map((l) => l.nextElementSibling?.textContent)).toEqual([
      'data',
      'leads to a broken node',
    ]);
    expect(lines[0]?.classList.contains('is-data')).toBe(true);
    expect(lines[1]?.classList.contains('is-broken')).toBe(true);
    for (const line of lines) expect(line.querySelector('.legend-arrow')).not.toBeNull();
  });

  it('draws each port shape once, input and output side by side', () => {
    const { container } = render(<CanvasLegend keys />);
    for (const type of ['file', 'data']) {
      const marks = container.querySelectorAll(
        `.legend-swatch.is-${type}-in, .legend-swatch.is-${type}-out`,
      );
      expect(marks).toHaveLength(2);
      expect(marks[0]?.parentElement).toBe(marks[1]?.parentElement);
    }
  });

  it('words each badge as the card does', () => {
    const { container } = render(<CanvasLegend keys />);
    const badges = [...container.querySelectorAll('.legend-badge')];
    expect(badges.map((b) => b.closest('.legend-item')?.lastElementChild?.textContent)).toEqual([
      'plugin missing',
      'needs a setting',
      'not on this server',
      'not reachable: no path from the trigger',
    ]);
    expect(badges[3]?.classList.contains('is-unreachable')).toBe(true);
    // Grey like the card's dashed-tone badge.
    expect(css).toMatch(
      /\.legend-badge\.is-unreachable\s*\{[^}]*background:\s*var\(--line-strong\)/,
    );
  });

  it('lists the keyboard shortcuts only on an editable canvas', () => {
    const { container, unmount } = render(<CanvasLegend keys />);
    const enter = [...container.querySelectorAll('kbd')].find((k) => k.textContent === 'Enter');
    expect(enter?.closest('.legend-item')?.lastElementChild?.textContent).toBe('node actions');
    unmount();
    const readOnly = render(<CanvasLegend keys={false} />);
    expect(readOnly.container.querySelectorAll('kbd')).toHaveLength(0);
    expect(labelsOf(readOnly.container)).toEqual(['Lines', 'Ports', 'Badges']);
  });

  it('has a Close button that closes the key and returns focus to "Key"', () => {
    const { container } = render(<CanvasLegend keys />);
    const details = container.querySelector('details') as HTMLDetailsElement;
    details.open = true;
    fireEvent.click(screen.getByRole('button', { name: 'Close key' }));
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(container.querySelector('summary'));
  });

  it('fits the canvas: wraps its words, and scrolls when the canvas is short', () => {
    // The whole disclosure sits inside the canvas with a 16px gutter on every side.
    const root = css.match(/\.canvas-legend\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(root).toMatch(/inset:\s*var\(--sp-4\)/);
    const body = css.match(/\.canvas-legend-body\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(body).toMatch(/width:\s*100%/);
    expect(body).toMatch(/max-height:\s*100%/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    // No entry is held to one line: nothing is cut off at phone width.
    expect(css.match(/\.legend-item\s*\{([^}]*)\}/)?.[1] ?? '').not.toMatch(/nowrap/);
  });
});
