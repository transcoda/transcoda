// Seven bars, one per day, each a stack of values; the Jobs page's "Last 7 days" cards. Half-height
// cards: the bars stretch to the card's width (the SVG keeps no aspect ratio), and the day names sit
// under it as text so they stay crisp. Hovering (or tapping) a day shows a tooltip with each part
// of its stack and the day's total.
import { useState } from 'react';

const viewW = 280;
const viewH = 100;
const topPad = 4;
const slot = viewW / 7;

const dayName = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' });
const dayLong = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
/** `2026-10-24` is a calendar date, read as such (the server already chose the zone). */
const asDate = (date: string) => new Date(`${date}T12:00:00.000Z`);
const dayText = (date: string) => dayLong.format(asDate(date)).replace(',', '');

export function WeekBars({
  days,
  colors,
  parts,
  format,
  label,
}: {
  days: Array<{ date: string; values: number[] }>;
  /** One per stacked value, bottom first: CSS colours such as `var(--st-replaced)`. */
  colors: string[];
  /** One name per stacked value, bottom first, for the tooltip: `replaced`, `kept`. */
  parts: string[];
  format: (v: number) => string;
  label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = days.map((d) => d.values.reduce((s, v) => s + Math.max(0, v), 0));
  const max = Math.max(1, ...totals);
  const scale = (viewH - topPad) / max;
  const partText = (v: number, k: number) => `${format(Math.max(0, v))} ${parts[k] ?? ''}`.trim();
  const hovered = hover === null ? undefined : days[hover];
  return (
    <figure className="week-bars" aria-label={label}>
      <svg className="week-bars-svg" viewBox={`0 0 ${viewW} ${viewH}`} preserveAspectRatio="none">
        <title>{label}</title>
        <line className="week-bars-axis" x1={0} x2={viewW} y1={viewH - 0.5} y2={viewH - 0.5} />
        {days.map((d, i) => {
          const x = i * slot;
          const total = totals[i] ?? 0;
          let y = viewH;
          const bars = d.values.map((v, k) => {
            const h = Math.max(0, v) * scale;
            if (h <= 0) return null;
            y -= h;
            return (
              <rect
                // biome-ignore lint/suspicious/noArrayIndexKey: a stack's layers are its positions
                key={k}
                x={x + slot * 0.2}
                y={y}
                width={slot * 0.6}
                height={h}
                rx={3}
                fill={colors[k]}
              />
            );
          });
          const value = d.values.length > 1 ? d.values.map(partText).join(' · ') : format(total);
          const text = `${dayText(d.date)}: ${value}`;
          return (
            // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: a <g> is not interactive; each day is one labelled image
            <g
              key={d.date}
              role="img"
              aria-label={text}
              className={hover === i ? 'week-bars-day is-hover' : 'week-bars-day'}
            >
              {bars}
              {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer readout; the day's numbers are also in its label. The whole column is the target, so a short bar is as easy to hit as a tall one. */}
              <rect
                className="week-bars-hit"
                x={x}
                y={0}
                width={slot}
                height={viewH}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              />
            </g>
          );
        })}
      </svg>
      <div className="week-days" aria-hidden="true">
        {days.map((d) => (
          <span key={d.date}>{dayName.format(asDate(d.date))}</span>
        ))}
      </div>
      {hovered && hover !== null ? (
        <div
          className={`chart-tip${hover < 2 ? ' is-start' : hover > 4 ? ' is-end' : ''}`}
          role="tooltip"
          style={{ left: `${((hover + 0.5) / 7) * 100}%` }}
        >
          <strong>{dayText(hovered.date)}</strong>
          {hovered.values.map((v, k) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a stack's layers are its positions
            <span key={k}>
              <i style={{ background: colors[k] }} />
              {partText(v, k)}
            </span>
          ))}
          {hovered.values.length > 1 ? (
            <span className="chart-tip-total">{`${format(totals[hover] ?? 0)} total`}</span>
          ) : null}
        </div>
      ) : null}
    </figure>
  );
}
