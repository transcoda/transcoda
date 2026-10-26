import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LoadStrip } from './LoadStrip.tsx';

afterEach(cleanup);

const now = new Date('2026-10-25T20:00:00.000Z');
/** `n` points 5 s apart, ending `endMinAgo` minutes before `now`. */
function run(n: number, endMinAgo: number, value: number) {
  const end = now.getTime() - endMinAgo * 60_000;
  return Array.from({ length: n }, (_, i) => ({
    at: new Date(end - (n - 1 - i) * 5000).toISOString(),
    value,
  }));
}

describe('LoadStrip', () => {
  it('breaks the line across a gap', () => {
    const points = [...run(20, 30, 95), ...run(20, 5, 90)];
    const { container } = render(
      <LoadStrip
        now={now}
        windowMs={3_600_000}
        intervalMs={5000}
        series={[{ name: 'Encoder', color: 'var(--accent-text)', points }]}
      />,
    );
    expect(container.querySelectorAll('path.load-line')).toHaveLength(2);
    expect(container.innerHTML).not.toContain('NaN');
  });

  it('clamps values to 0–100', () => {
    const { container } = render(
      <LoadStrip
        now={now}
        windowMs={3_600_000}
        intervalMs={5000}
        series={[
          {
            name: 'Encoder',
            color: 'red',
            points: run(6, 0, 0).map((p, i) => ({ ...p, value: i % 2 ? -20 : 150 })),
          },
        ]}
      />,
    );
    const ys = (container.querySelector('path.load-line')?.getAttribute('d') ?? '')
      .split(/[ML]/)
      .filter(Boolean)
      .map((p) => Number(p.split(',')[1]));
    expect(ys.length).toBe(6);
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
  });

  it('labels the last hour', () => {
    const { getByText } = render(
      <LoadStrip now={now} windowMs={3_600_000} intervalMs={5000} series={[]} />,
    );
    for (const l of ['-60 min', '-45', '-30', '-15', 'now']) expect(getByText(l)).toBeTruthy();
  });

  it('hovering shows the time and each series at the pointer; leaving hides it', () => {
    // 60 min of samples; the encoder at 90 %, the decoder at 40 %, stopped 10 minutes ago.
    const enc = run(600, 10, 90);
    const dec = run(600, 10, 40);
    const { container } = render(
      <LoadStrip
        now={now}
        windowMs={3_600_000}
        intervalMs={5000}
        series={[
          { name: 'encoder', color: 'var(--accent-text)', points: enc },
          { name: 'decoder', color: 'var(--st-kept)', points: dec },
        ]}
      />,
    );
    const strip = container.querySelector('.load-strip') as HTMLElement;
    strip.getBoundingClientRect = () =>
      ({ left: 100, width: 1000, top: 0, height: 100, right: 1100, bottom: 100 }) as DOMRect;
    // Half way: 30 minutes ago.
    fireEvent.mouseMove(strip, { clientX: 600 });
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toContain('30 min ago');
    expect(tip.textContent).toContain('encoder 90%');
    expect(tip.textContent).toContain('decoder 40%');
    expect(container.querySelector('.load-cursor')).not.toBeNull();
    // 2 minutes ago: past the last sample, so no readings.
    fireEvent.mouseMove(strip, { clientX: 1067 });
    expect(screen.getByRole('tooltip').textContent).toContain('2 min ago');
    expect(screen.getByRole('tooltip').textContent).toContain('no reading');
    fireEvent.mouseLeave(strip);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(container.querySelector('.load-cursor')).toBeNull();
  });
});
