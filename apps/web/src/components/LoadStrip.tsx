// Percent lines over the last hour: the Jobs page's encoder strip. Moving the pointer over it shows
// a cursor line and each series' reading at that moment.
import { useState } from 'react';

const W = 1000;
const H = 100;
const LABELS = ['-60 min', '-45', '-30', '-15', 'now'];

type Point = { at: string; value: number };

/** Runs of points without a gap longer than `maxGapMs` (a restart, a stalled nvidia-smi). */
function runs(points: Point[], maxGapMs: number): Point[][] {
  const out: Point[][] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    const t = Date.parse(p.at);
    if (t - last > maxGapMs || out.length === 0) out.push([]);
    out[out.length - 1]?.push(p);
    last = t;
  }
  return out;
}

/** The point nearest `t`, if one is within `maxMs` of it (else the line has a gap there). */
function nearest(points: Point[], t: number, maxMs: number): Point | undefined {
  let best: Point | undefined;
  let bestD = maxMs;
  for (const p of points) {
    const d = Math.abs(Date.parse(p.at) - t);
    if (d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

const ago = (ms: number) => {
  const min = Math.round(ms / 60_000);
  return min < 1 ? 'now' : `${min} min ago`;
};

export function LoadStrip({
  series,
  windowMs,
  intervalMs,
  now,
}: {
  series: Array<{ name: string; color: string; points: Point[] }>;
  windowMs: number;
  intervalMs: number;
  now: Date;
}) {
  /** The pointer's position across the strip, 0 (an hour ago) to 1 (now). */
  const [at, setAt] = useState<number | null>(null);
  const start = now.getTime() - windowMs;
  const x = (iso: string) => ((Date.parse(iso) - start) / windowMs) * W;
  const y = (v: number) => H - Math.min(100, Math.max(0, v));
  const path = (pts: Point[]) =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.value)}`).join('');
  const t = at === null ? null : start + at * windowMs;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a pointer readout; the numbers are also in the heading
    <div
      className="load-strip"
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        if (r.width > 0) setAt(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
      }}
      onMouseLeave={() => setAt(null)}
    >
      <svg
        className="load-strip-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {series.map((s, k) =>
          runs(s.points, intervalMs * 3).map((pts, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
            <g key={`${s.name}-${j}`}>
              {k === 0 && pts.length > 1 && (
                <path
                  className="load-area"
                  d={`${path(pts)}L${x(pts.at(-1)?.at ?? '').toFixed(1)},${H}L${x(pts[0]?.at ?? '').toFixed(1)},${H}Z`}
                  fill={s.color}
                />
              )}
              <path className="load-line" d={path(pts)} stroke={s.color} fill="none" />
            </g>
          )),
        )}
        {at !== null ? (
          <line className="load-cursor" x1={at * W} x2={at * W} y1={0} y2={H} />
        ) : null}
      </svg>
      {t !== null && at !== null ? (
        <div
          className={`chart-tip${at < 0.2 ? ' is-start' : at > 0.8 ? ' is-end' : ''}`}
          role="tooltip"
          style={{ left: `${at * 100}%` }}
        >
          <strong>{ago(now.getTime() - t)}</strong>
          {series.map((s) => {
            const p = nearest(s.points, t, intervalMs * 1.5);
            return (
              <span key={s.name}>
                <i style={{ background: s.color }} />
                {p ? `${s.name} ${Math.round(p.value)}%` : `${s.name}: no reading`}
              </span>
            );
          })}
        </div>
      ) : null}
      <div className="load-strip-axis">
        {LABELS.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
    </div>
  );
}
