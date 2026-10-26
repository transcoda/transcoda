import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { RunHours } from '@transcoda/shared';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RUN_HOURS, nowText, RunHoursCard } from './RunHoursCard.tsx';

// Thursday 2026-10-22 14:32 in Berlin.
const clock = { now: '2026-10-22T12:32:00.000Z', timeZone: 'Europe/Berlin' };
let last: RunHours | null = null;

function Harness({ start = DEFAULT_RUN_HOURS }: { start?: RunHours }) {
  const [value, setValue] = useState(start);
  return (
    <RunHoursCard
      value={value}
      onChange={(next) => {
        last = next;
        setValue(next);
      }}
      clock={clock}
    />
  );
}

const cell = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const summary = () => document.querySelector('.rh-summary')?.textContent;

afterEach(() => {
  cleanup();
  last = null;
  vi.restoreAllMocks();
});

describe('RunHoursCard', () => {
  it('is off by default; Restrict shows the strip, starting at 22:00–07:00', () => {
    render(<Harness />);
    expect(screen.queryByRole('group', { name: 'Every day hours' })).toBeNull();
    expect(
      screen.getByText('Automatic runs only start in these hours.', { exact: false }),
    ).toBeTruthy();
    expect(screen.getByText('Now 14:32 (Europe/Berlin)')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Restrict' }));
    const strip = screen.getByRole('group', { name: 'Every day hours' });
    expect(within(strip).getAllByRole('button')).toHaveLength(24);
    expect(cell('Every day 22:00–23:00').getAttribute('aria-pressed')).toBe('true');
    expect(cell('Every day 07:00–08:00').getAttribute('aria-pressed')).toBe('false');
    expect(summary()).toBe('Runs every day, 22:00–07:00 (9 h)');
    expect(screen.getByText('Now 14:32 (Europe/Berlin), closed until 22:00')).toBeTruthy();
  });

  it('marks the current hour on the strip', () => {
    render(<Harness start={{ ...DEFAULT_RUN_HOURS, enabled: true }} />);
    const now = cell('Every day 14:00–15:00, now');
    expect(now.classList.contains('is-now')).toBe(true);
    expect(document.querySelectorAll('.rh-cell.is-now')).toHaveLength(1);
  });

  it('a drag paints every hour it passes with what the first one became', () => {
    render(<Harness start={{ ...DEFAULT_RUN_HOURS, enabled: true }} />);
    const grid = document.querySelector('.rh-grid') as HTMLElement;
    const target = { current: cell('Every day 10:00–11:00') };
    document.elementFromPoint = () => target.current;
    fireEvent.pointerDown(grid, { button: 0, pointerId: 1 });
    for (const h of ['11', '12', '13']) {
      target.current = cell(`Every day ${h}:00`);
      fireEvent.pointerMove(grid, { pointerId: 1 });
    }
    fireEvent.pointerUp(grid, { pointerId: 1 });
    target.current = cell('Every day 15:00');
    fireEvent.pointerMove(grid, { pointerId: 1 });
    expect(last?.every).toEqual([0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 22, 23]);

    // Starting on a painted hour erases.
    target.current = cell('Every day 22:00');
    fireEvent.pointerDown(grid, { button: 0, pointerId: 2 });
    target.current = cell('Every day 23:00');
    fireEvent.pointerMove(grid, { pointerId: 2 });
    fireEvent.pointerUp(grid, { pointerId: 2 });
    expect(last?.every).toEqual([0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 13]);
  });

  it('a drag whose pointer jumps over hours still paints the hours between', () => {
    render(<Harness start={{ ...DEFAULT_RUN_HOURS, enabled: true }} />);
    const grid = document.querySelector('.rh-grid') as HTMLElement;
    const target = { current: cell('Every day 09:00') };
    document.elementFromPoint = () => target.current;
    fireEvent.pointerDown(grid, { button: 0, pointerId: 1 });
    target.current = cell('Every day 13:00');
    fireEvent.pointerMove(grid, { pointerId: 1 });
    fireEvent.pointerUp(grid, { pointerId: 1 });
    expect(last?.every).toEqual([0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 22, 23]);
  });

  it('Enter or Space (a click without a pointer) toggles one hour', () => {
    render(<Harness start={{ ...DEFAULT_RUN_HOURS, enabled: true }} />);
    fireEvent.click(cell('Every day 08:00'), { detail: 0 });
    expect(cell('Every day 08:00').getAttribute('aria-pressed')).toBe('true');
    expect(summary()).toBe('Runs every day, 22:00–07:00, 08:00–09:00 (10 h)');
  });

  it('Per day copies the every-day strip into each of seven labelled rows', () => {
    render(<Harness start={{ ...DEFAULT_RUN_HOURS, enabled: true, every: [1, 2] }} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Per day' }));
    expect(last?.perDay).toBe(true);
    expect(last?.days).toEqual([
      [1, 2],
      [1, 2],
      [1, 2],
      [1, 2],
      [1, 2],
      [1, 2],
      [1, 2],
    ]);
    for (const day of ['Monday', 'Sunday']) {
      expect(screen.getByRole('group', { name: `${day} hours` })).toBeTruthy();
    }
    expect(summary()).toBe('Mon–Sun 01:00–03:00 (2 h)');
    // Only today's row (Thursday) carries the now marker.
    expect(cell('Thursday 14:00–15:00, now')).toBeTruthy();
    expect(document.querySelectorAll('.rh-cell.is-now')).toHaveLength(1);
    fireEvent.click(cell('Saturday 09:00'), { detail: 0 });
    expect(summary()).toBe(
      'Mon–Fri 01:00–03:00 (2 h); Sat 01:00–03:00, 09:00–10:00 (3 h); Sun 01:00–03:00 (2 h)',
    );
  });
});

describe('nowText', () => {
  const at = new Date(clock.now);
  const rh = (every: number[]): RunHours => ({ ...DEFAULT_RUN_HOURS, enabled: true, every });
  it('says whether the window is open now and until when', () => {
    expect(nowText(rh([14, 15]), at, clock.timeZone)).toBe(
      'Now 14:32 (Europe/Berlin), open until 16:00',
    );
    expect(nowText(rh([9]), at, clock.timeZone)).toBe(
      'Now 14:32 (Europe/Berlin), closed until Fri 09:00',
    );
    expect(nowText(rh([]), at, clock.timeZone)).toBe(
      'Now 14:32 (Europe/Berlin), closed: no hours chosen',
    );
    expect(nowText(rh([...Array(24).keys()]), at, clock.timeZone)).toBe(
      'Now 14:32 (Europe/Berlin), open',
    );
  });
});
