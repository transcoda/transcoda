// Calendar days in a time zone, as the UTC instants they start at: the Jobs page's last 7 days
// and its "today" are the server's local days, never UTC's.

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock in `timeZone` at `ms`, read as if it were UTC (ms since the epoch). */
function wallClock(ms: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(new Date(ms));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
}

/** The zone's offset from UTC at `ms` (wall clock minus real time), in ms. */
const offsetAt = (ms: number, timeZone: string): number =>
  wallClock(ms, timeZone) - Math.floor(ms / 1000) * 1000;

/** The instant local midnight of the calendar date `midnightUtc` (that date's 00:00 UTC) falls on. */
function localMidnight(midnightUtc: number, timeZone: string): number {
  let start = midnightUtc - offsetAt(midnightUtc, timeZone);
  // Once more with the offset at the result: a clock change between the guess and midnight.
  start = midnightUtc - offsetAt(start, timeZone);
  return start;
}

/**
 * The last `days` local days in `timeZone`, oldest first, then tomorrow: `days + 1` entries.
 * Day `i` spans `[entries[i].start, entries[i + 1].start)`; `date` is `YYYY-MM-DD` in the zone.
 */
export function localDayStarts(
  now: Date,
  timeZone: string,
  days: number,
): Array<{ date: string; start: Date }> {
  const today = Math.floor(wallClock(now.getTime(), timeZone) / DAY_MS) * DAY_MS;
  const out: Array<{ date: string; start: Date }> = [];
  for (let k = days - 1; k >= -1; k -= 1) {
    const midnightUtc = today - k * DAY_MS;
    out.push({
      date: new Date(midnightUtc).toISOString().slice(0, 10),
      start: new Date(localMidnight(midnightUtc, timeZone)),
    });
  }
  return out;
}
