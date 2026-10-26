import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WeekBars } from './WeekBars.tsx';

afterEach(cleanup);

const dates = [
  '2026-10-19',
  '2026-10-20',
  '2026-10-21',
  '2026-10-22',
  '2026-10-23',
  '2026-10-24',
  '2026-10-25',
];
const num = (v: number) => v.toLocaleString('en-US');
const BAR = 'rect:not(.week-bars-hit)';

describe('WeekBars', () => {
  it('stacks values and labels each day', () => {
    const values = [
      [0, 0],
      [0, 0],
      [0, 0],
      [18, 13],
      [93, 120],
      [429, 690],
      [96, 407],
    ];
    const { container } = render(
      <WeekBars
        label="Files done"
        days={dates.map((date, i) => ({ date, values: values[i] ?? [] }))}
        colors={['var(--st-replaced)', 'var(--st-kept)']}
        parts={['replaced', 'kept']}
        format={num}
      />,
    );
    expect(screen.getByRole('figure', { name: 'Files done' })).toBeTruthy();
    for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
      expect(screen.getByText(d)).toBeTruthy();
    }
    const sat = screen.getByRole('img', { name: 'Sat 24 Oct: 429 replaced · 690 kept' });
    expect(sat.querySelectorAll(BAR)).toHaveLength(2);
    expect(sat.querySelector(BAR)?.getAttribute('fill')).toBe('var(--st-replaced)');
    expect(screen.getByText('1,119')).toBeTruthy();
    // Empty days have no bar and no total.
    expect(
      screen.getByRole('img', { name: 'Mon 19 Oct: 0 replaced · 0 kept' }).querySelector(BAR),
    ).toBeNull();
    expect(container.innerHTML).not.toContain('NaN');
  });

  it('all-zero week renders seven empty slots and no NaN', () => {
    const { container } = render(
      <WeekBars
        label="Data saved"
        days={dates.map((date) => ({ date, values: [0] }))}
        colors={['var(--st-replaced)']}
        parts={['saved']}
        format={num}
      />,
    );
    expect(screen.getAllByRole('img')).toHaveLength(7);
    expect(container.querySelectorAll(BAR)).toHaveLength(0);
    expect(container.innerHTML).not.toContain('NaN');
  });

  it('hovering a day shows a tooltip with each part; leaving hides it', () => {
    const values = [
      [0, 0],
      [0, 0],
      [0, 0],
      [18, 13],
      [93, 120],
      [429, 690],
      [96, 407],
    ];
    const { container } = render(
      <WeekBars
        label="Files done"
        days={dates.map((date, i) => ({ date, values: values[i] ?? [] }))}
        colors={['var(--st-replaced)', 'var(--st-kept)']}
        parts={['replaced', 'kept']}
        format={num}
      />,
    );
    expect(screen.getByRole('img', { name: 'Sat 24 Oct: 429 replaced · 690 kept' })).toBeTruthy();
    expect(screen.queryByRole('tooltip')).toBeNull();
    const hits = container.querySelectorAll('.week-bars-hit');
    expect(hits).toHaveLength(7);
    fireEvent.mouseEnter(hits[5] as Element);
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toContain('Sat 24 Oct');
    expect(tip.textContent).toContain('429 replaced');
    expect(tip.textContent).toContain('690 kept');
    expect(tip.textContent).toContain('1,119 total');
    fireEvent.mouseLeave(hits[5] as Element);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a one-part chart shows the day and its value without a total', () => {
    const { container } = render(
      <WeekBars
        label="Data saved"
        days={dates.map((date, i) => ({ date, values: [i * 10] }))}
        colors={['var(--st-replaced)']}
        parts={['saved']}
        format={num}
      />,
    );
    fireEvent.mouseEnter(container.querySelectorAll('.week-bars-hit')[6] as Element);
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toContain('Sun 25 Oct');
    expect(tip.textContent).toContain('60 saved');
    expect(tip.textContent).not.toContain('total');
  });
});
