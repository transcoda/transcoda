import { z } from 'zod';

/**
 * A library's run hours: the whole local hours (0–23) in which its automatic jobs may start.
 * Either one strip for every day (`every`) or one per weekday (`days`, Monday first). Both strips
 * are kept so switching between the two loses nothing; `perDay` says which one applies.
 */
const HoursSchema = z
  .array(z.number().int().min(0).max(23))
  .transform((hours) => [...new Set(hours)].sort((a, b) => a - b));

export const RunHoursSchema = z.object({
  /** Off: automatic jobs start at any time (the strips are kept for next time). */
  enabled: z.boolean(),
  perDay: z.boolean(),
  every: HoursSchema,
  /** Monday to Sunday. */
  days: z.array(HoursSchema).length(7),
});
export type RunHours = z.infer<typeof RunHoursSchema>;

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const HOUR_MS = 3_600_000;
/** Far enough ahead to pass every weekday and a clock change. */
const SEARCH_HOURS = 8 * 24;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock in `timeZone`: weekday (Monday = 0), hour and minute. */
export function localClock(
  at: Date,
  timeZone: string,
): { weekday: number; hour: number; minute: number } {
  const parts = formatter(timeZone).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    weekday: WEEKDAYS.indexOf(part('weekday') as (typeof WEEKDAYS)[number]),
    hour: Number(part('hour')),
    minute: Number(part('minute')),
  };
}

/** The hours that apply on `weekday` (Monday = 0). */
export const hoursOn = (rh: RunHours, weekday: number): number[] =>
  rh.perDay ? (rh.days[weekday] ?? []) : rh.every;

/** Whether automatic jobs may start at `at`; always true while the restriction is off. */
export function isOpenAt(rh: RunHours, at: Date, timeZone: string): boolean {
  if (!rh.enabled) return true;
  const { weekday, hour } = localClock(at, timeZone);
  return hoursOn(rh, weekday).includes(hour);
}

/**
 * The local hour starts after `at`, in order. Steps an hour of real time from the start of the
 * current local hour, so a repeated hour (autumn) comes twice and a skipped one (spring) never.
 */
function* hourStarts(at: Date, timeZone: string): Generator<Date> {
  const { minute } = localClock(at, timeZone);
  const start = at.getTime() - minute * 60_000 - (at.getTime() % 60_000);
  for (let i = 1; i <= SEARCH_HOURS; i += 1) yield new Date(start + i * HOUR_MS);
}

/** `at` while open, else the start of the next open hour; null when the window never opens. */
export function nextOpening(rh: RunHours, at: Date, timeZone: string): Date | null {
  if (isOpenAt(rh, at, timeZone)) return at;
  for (const t of hourStarts(at, timeZone)) if (isOpenAt(rh, t, timeZone)) return t;
  return null;
}

/** While open, when the window closes; null while closed or when it never closes. */
export function nextClosing(rh: RunHours, at: Date, timeZone: string): Date | null {
  if (!isOpenAt(rh, at, timeZone)) return null;
  for (const t of hourStarts(at, timeZone)) if (!isOpenAt(rh, t, timeZone)) return t;
  return null;
}

/**
 * Painted hours as `[start, end)` ranges (end up to 24). With `wrap`, a range that reaches
 * midnight joins the one starting at 00:00 (an every-day strip: 22–07 is one night).
 */
export function hourRanges(hours: number[], wrap: boolean): Array<[number, number]> {
  const on = new Set(hours);
  const out: Array<[number, number]> = [];
  for (let h = 0; h < 24; h += 1) {
    if (!on.has(h)) continue;
    const last = out.at(-1);
    if (last && last[1] === h) last[1] = h + 1;
    else out.push([h, h + 1]);
  }
  const first = out[0];
  const last = out.at(-1);
  if (wrap && out.length > 1 && first && last && first[0] === 0 && last[1] === 24) {
    out.pop();
    out[0] = [last[0], first[1]];
  }
  return out;
}

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** "22:00–07:00 (9 h)", "all day" or "never". */
function stripText(hours: number[], wrap: boolean): string {
  if (hours.length === 0) return 'never';
  if (hours.length === 24) return 'all day';
  const ranges = hourRanges(hours, wrap).map(([a, b]) => `${hh(a)}–${hh(b)}`);
  return `${ranges.join(', ')} (${hours.length} h)`;
}

/** One line for the card: "Runs every day, 22:00–07:00 (9 h)" or the days grouped by strip. */
export function runHoursSummary(rh: RunHours): string {
  if (!rh.enabled) return 'Runs any time';
  if (!rh.perDay) {
    if (rh.every.length === 0) return 'Never runs: no hours chosen';
    if (rh.every.length === 24) return 'Runs all day, every day';
    return `Runs every day, ${stripText(rh.every, true)}`;
  }
  if (rh.days.every((d) => d.length === 0)) return 'Never runs: no hours chosen';
  const groups: Array<{ from: number; to: number; text: string }> = [];
  rh.days.forEach((hours, day) => {
    const text = stripText(hours, false);
    const last = groups.at(-1);
    if (last && last.text === text) last.to = day;
    else groups.push({ from: day, to: day, text });
  });
  return groups
    .map(({ from, to, text }) => {
      const days = from === to ? WEEKDAYS[from] : `${WEEKDAYS[from]}–${WEEKDAYS[to]}`;
      return `${days} ${text}`;
    })
    .join('; ');
}
