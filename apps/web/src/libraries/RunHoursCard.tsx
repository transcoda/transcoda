import type { LibrariesListOutput, Library } from '@transcoda/contract';
import {
  isOpenAt,
  localClock,
  nextClosing,
  nextOpening,
  type RunHours,
  runHoursSummary,
  WEEKDAYS,
} from '@transcoda/shared';
import { type KeyboardEvent, type PointerEvent, useEffect, useId, useRef, useState } from 'react';

export type ServerClock = LibrariesListOutput['clock'];

/** What a library without run hours starts from when Restrict is ticked: 22:00–07:00. */
const NIGHT = [22, 23, 0, 1, 2, 3, 4, 5, 6];
export const DEFAULT_RUN_HOURS: RunHours = {
  enabled: false,
  perDay: false,
  every: NIGHT,
  days: WEEKDAYS.map(() => NIGHT),
};

const HOURS = [...Array(24).keys()];
const TICKS = [0, 3, 6, 9, 12, 15, 18, 21];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** The server's clock now: the list's reading moved on by the time since it arrived, every 15 s. */
function useServerNow(clock: ServerClock | null): Date {
  const offset = useRef(0);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    offset.current = clock ? Date.parse(clock.now) - Date.now() : 0;
    setNow(new Date(Date.now() + offset.current));
    const timer = setInterval(() => setNow(new Date(Date.now() + offset.current)), 15_000);
    return () => clearInterval(timer);
  }, [clock]);
  return now;
}

const timeIn = (at: Date, timeZone: string) =>
  at.toLocaleTimeString('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

/** "22:00" within the next day on the same weekday, else "Fri 09:00" (the server's wall clock). */
function whenText(at: Date, now: Date, timeZone: string): string {
  const day = (d: Date) => localClock(d, timeZone).weekday;
  return day(at) === day(now) && at.getTime() - now.getTime() < 86_400_000
    ? timeIn(at, timeZone)
    : `${WEEKDAYS[day(at)]} ${timeIn(at, timeZone)}`;
}

/** "Now 14:32 (Europe/Berlin), closed until 22:00" and its variants. */
export function nowText(rh: RunHours, now: Date, timeZone: string): string {
  const head = `Now ${timeIn(now, timeZone)} (${timeZone})`;
  if (!rh.enabled) return head;
  if (isOpenAt(rh, now, timeZone)) {
    const closes = nextClosing(rh, now, timeZone);
    return closes ? `${head}, open until ${whenText(closes, now, timeZone)}` : `${head}, open`;
  }
  const opens = nextOpening(rh, now, timeZone);
  return opens
    ? `${head}, closed until ${whenText(opens, now, timeZone)}`
    : `${head}, closed: no hours chosen`;
}

/** For "Scan now": when its jobs will start while the library's run hours are closed; else null. */
export function scanWaitText(library: Library, clock: ServerClock | null): string | null {
  const rh = library.runHours;
  const timeZone = clock?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  if (!rh || isOpenAt(rh, now, timeZone)) return null;
  const opens = nextOpening(rh, now, timeZone);
  return opens
    ? `Its run hours are closed now: the files are queued and start at ${whenText(opens, now, timeZone)}.`
    : 'Its run hours have no hours chosen: the files are queued but do not start on their own.';
}

/** The hour cell under a pointer: its row (0 for the every-day strip, else the weekday) and hour. */
function cellAt(x: number, y: number): { row: number; hour: number } | null {
  const el = document.elementFromPoint(x, y);
  const cell = el instanceof HTMLElement ? el.closest<HTMLElement>('[data-hour]') : null;
  if (!cell) return null;
  return { row: Number(cell.dataset.row), hour: Number(cell.dataset.hour) };
}

/**
 * The library dialog's "Run hours" card: Restrict, Every day / Per day, a 24-hour strip (or one
 * per weekday) painted by click or drag, the summary, and the server's time with the current hour
 * marked. `clock` is the server's reading from the list (null: the browser's clock and zone).
 */
export function RunHoursCard({
  value,
  onChange,
  clock,
}: {
  value: RunHours;
  onChange(next: RunHours): void;
  clock: ServerClock | null;
}) {
  const id = useId();
  const timeZone = clock?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = useServerNow(clock);
  const current = localClock(now, timeZone);
  /** Painting: what a drag sets each touched hour to, and the last cell it reached. */
  const paint = useRef<{ on: boolean; row: number; hour: number } | null>(null);
  const latest = useRef(value);
  latest.current = value;

  const strip = (row: number) => (value.perDay ? (value.days[row] ?? []) : value.every);

  /** Sets every hour from `from` to `to` in each row between them (one hour when they match). */
  function setHours(rows: [number, number], hours: [number, number], on: boolean) {
    const rh = latest.current;
    const [r0, r1] = [Math.min(...rows), Math.max(...rows)];
    const [h0, h1] = [Math.min(...hours), Math.max(...hours)];
    const span = (hs: number[]) => {
      const set = new Set(hs);
      for (let h = h0; h <= h1; h += 1) {
        if (on) set.add(h);
        else set.delete(h);
      }
      return set.size === hs.length && hs.every((h) => set.has(h))
        ? hs
        : [...set].sort((a, b) => a - b);
    };
    const next = rh.perDay
      ? { ...rh, days: rh.days.map((d, i) => (i >= r0 && i <= r1 ? span(d) : d)) }
      : { ...rh, every: span(rh.every) };
    if (next.every === rh.every && next.days.every((d, i) => d === rh.days[i])) return;
    // Kept at once: a fast drag paints several times before the next render.
    latest.current = next;
    onChange(next);
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    const cell = cellAt(e.clientX, e.clientY);
    if (!cell || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const on = !strip(cell.row).includes(cell.hour);
    paint.current = { on, ...cell };
    setHours([cell.row, cell.row], [cell.hour, cell.hour], on);
  }
  /** Pointer moves come in steps: every hour between the last cell and this one is painted too. */
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const last = paint.current;
    if (last === null) return;
    const cell = cellAt(e.clientX, e.clientY);
    if (!cell) return;
    setHours([last.row, cell.row], [last.hour, cell.hour], last.on);
    paint.current = { on: last.on, ...cell };
  }
  const endPaint = () => {
    paint.current = null;
  };

  /** Keyboard: Enter or Space toggles (a click with no pointer); arrows move along and between rows. */
  function onCellKey(e: KeyboardEvent<HTMLButtonElement>, row: number, hour: number) {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    const rows = value.perDay ? 7 : 1;
    const r = (row + move[0] + rows) % rows;
    const h = (hour + move[1] + 24) % 24;
    const grid = e.currentTarget.closest('.rh-grid');
    grid?.querySelector<HTMLButtonElement>(`[data-row="${r}"][data-hour="${h}"]`)?.focus();
  }

  function setPerDay(perDay: boolean) {
    if (perDay === value.perDay) return;
    // Every day → Per day starts each day from the every-day strip.
    onChange(
      perDay ? { ...value, perDay, days: WEEKDAYS.map(() => value.every) } : { ...value, perDay },
    );
  }

  function row(r: number, label: string | null) {
    const hours = strip(r);
    const isToday = !value.perDay || r === current.weekday;
    const name = value.perDay ? (DAY_NAMES[r] ?? '') : 'Every day';
    return (
      <div key={r} className="rh-row">
        {label ? (
          <span className="rh-day" aria-hidden>
            {label}
          </span>
        ) : null}
        {/* biome-ignore lint/a11y/useSemanticElements: a grid row of hour buttons; a fieldset would not lay out as a grid. */}
        <div className="rh-strip" role="group" aria-label={`${name} hours`}>
          {HOURS.map((h) => {
            const on = hours.includes(h);
            const isNow = isToday && h === current.hour;
            return (
              <button
                key={h}
                type="button"
                className={`rh-cell${on ? ' is-on' : ''}${isNow ? ' is-now' : ''}`}
                data-row={r}
                data-hour={h}
                aria-pressed={on}
                aria-label={`${name} ${hh(h)}–${hh(h + 1)}${isNow ? ', now' : ''}`}
                tabIndex={h === 0 && r === 0 ? 0 : -1}
                onClick={(e) => {
                  // A pointer already painted on pointerdown; this is Enter or Space.
                  if (e.detail === 0) setHours([r, r], [h, h], !on);
                }}
                onKeyDown={(e) => onCellKey(e, r, h)}
              />
            );
          })}
        </div>
      </div>
    );
  }

  const hintId = `${id}-hint`;
  return (
    <fieldset className="rh-card" aria-describedby={hintId}>
      <legend>Run hours</legend>
      <label className="lib-check">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
        />
        <span>Restrict</span>
      </label>
      <p id={hintId} className="field-hint rh-hint">
        Automatic runs only start in these hours. Manual runs always start. A job still running when
        the window closes finishes.
      </p>
      {value.enabled ? (
        <>
          <div role="radiogroup" aria-label="Days" className="tc-segmented rh-mode">
            {(['Every day', 'Per day'] as const).map((label) => {
              const perDay = label === 'Per day';
              return (
                // biome-ignore lint/a11y/useSemanticElements: a segmented control of two buttons.
                <button
                  key={label}
                  type="button"
                  role="radio"
                  aria-checked={value.perDay === perDay}
                  tabIndex={value.perDay === perDay ? 0 : -1}
                  onClick={() => setPerDay(perDay)}
                  onKeyDown={(e) => {
                    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key))
                      return;
                    e.preventDefault();
                    setPerDay(!value.perDay);
                    const group = e.currentTarget.parentElement;
                    group?.querySelector<HTMLButtonElement>(`[aria-checked="false"]`)?.focus();
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div
            className={`rh-grid${value.perDay ? ' is-per-day' : ''}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPaint}
            onPointerCancel={endPaint}
            onLostPointerCapture={endPaint}
          >
            {value.perDay ? WEEKDAYS.map((d, i) => row(i, d)) : row(0, null)}
            <div className="rh-row rh-ticks-row" aria-hidden>
              {value.perDay ? <span className="rh-day" /> : null}
              <div className="rh-ticks">
                {TICKS.map((h) => (
                  <span key={h} style={{ gridColumn: `${h + 1} / span 3` }}>
                    {String(h).padStart(2, '0')}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <p className="rh-summary" aria-live="polite">
            {runHoursSummary(value)}
          </p>
        </>
      ) : null}
      <p className="rh-now">{nowText(value, now, timeZone)}</p>
    </fieldset>
  );
}
