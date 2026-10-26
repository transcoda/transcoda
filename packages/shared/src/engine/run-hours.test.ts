import { describe, expect, it } from 'vitest';
import {
  hourRanges,
  isOpenAt,
  localClock,
  nextClosing,
  nextOpening,
  type RunHours,
  RunHoursSchema,
  runHoursSummary,
} from '../index.ts';

const BERLIN = 'Europe/Berlin';
const range = (from: number, to: number): number[] => {
  const out: number[] = [];
  for (let h = from; h !== to; h = (h + 1) % 24) out.push(h);
  return out;
};
const NIGHT = range(22, 7); // 22:00–07:00
const daily = (every: number[], enabled = true): RunHours => ({
  enabled,
  perDay: false,
  every,
  days: [[], [], [], [], [], [], []],
});
const perDay = (days: number[][]): RunHours => ({ enabled: true, perDay: true, every: [], days });
/** A Berlin wall-clock time in October 2026 (CEST, UTC+2, until the 25th 03:00). */
const berlin = (iso: string): Date => new Date(`${iso}+02:00`);

describe('localClock', () => {
  it('reads weekday (Mon = 0), hour and minute in the given zone', () => {
    // Thursday 2026-10-22 14:32 in Berlin is 12:32 UTC.
    expect(localClock(new Date('2026-10-22T12:32:10Z'), BERLIN)).toEqual({
      weekday: 3,
      hour: 14,
      minute: 32,
    });
    expect(localClock(new Date('2026-10-25T23:30:00Z'), 'UTC')).toEqual({
      weekday: 6,
      hour: 23,
      minute: 30,
    });
  });
});

describe('isOpenAt', () => {
  it('is always open while the restriction is off', () => {
    expect(isOpenAt(daily([], false), berlin('2026-10-22T14:00:00'), BERLIN)).toBe(true);
  });

  it('wraps past midnight on an every-day strip', () => {
    const rh = daily(NIGHT);
    expect(isOpenAt(rh, berlin('2026-10-22T21:59:59'), BERLIN)).toBe(false);
    expect(isOpenAt(rh, berlin('2026-10-22T22:00:00'), BERLIN)).toBe(true);
    expect(isOpenAt(rh, berlin('2026-10-23T03:15:00'), BERLIN)).toBe(true);
    expect(isOpenAt(rh, berlin('2026-10-23T06:59:59'), BERLIN)).toBe(true);
    expect(isOpenAt(rh, berlin('2026-10-23T07:00:00'), BERLIN)).toBe(false);
  });

  it('uses the strip of the local weekday on a per-day window', () => {
    // Thursday only from 10:00, Friday never.
    const days: number[][] = [[], [], [], range(10, 12), [], [], []];
    const rh = perDay(days);
    expect(isOpenAt(rh, berlin('2026-10-22T10:30:00'), BERLIN)).toBe(true); // Thu
    expect(isOpenAt(rh, berlin('2026-10-23T10:30:00'), BERLIN)).toBe(false); // Fri
  });

  it('never opens with no hours and is open all day with every hour', () => {
    expect(isOpenAt(daily([]), berlin('2026-10-22T12:00:00'), BERLIN)).toBe(false);
    const all = daily([...Array(24).keys()]);
    expect(isOpenAt(all, berlin('2026-10-22T12:00:00'), BERLIN)).toBe(true);
  });
});

describe('nextOpening / nextClosing', () => {
  it('is now while open, else the start of the next open hour', () => {
    const rh = daily(NIGHT);
    const at = berlin('2026-10-22T14:32:10');
    expect(nextOpening(rh, at, BERLIN)).toEqual(berlin('2026-10-22T22:00:00'));
    const open = berlin('2026-10-22T23:10:00');
    expect(nextOpening(rh, open, BERLIN)).toEqual(open);
    expect(nextClosing(rh, open, BERLIN)).toEqual(berlin('2026-10-23T07:00:00'));
    expect(nextClosing(rh, at, BERLIN)).toBeNull();
  });

  it('finds the next day that has hours on a per-day window', () => {
    // Saturday and Sunday from 09:00 to 12:00 only.
    const weekend = range(9, 12);
    const rh = perDay([[], [], [], [], [], weekend, weekend]);
    // Thursday afternoon → Saturday 09:00.
    expect(nextOpening(rh, berlin('2026-10-22T14:00:00'), BERLIN)).toEqual(
      berlin('2026-10-24T09:00:00'),
    );
  });

  it('is null when the window never opens, and never closes when it is open all day', () => {
    expect(nextOpening(daily([]), berlin('2026-10-22T14:00:00'), BERLIN)).toBeNull();
    const all = daily([...Array(24).keys()]);
    expect(nextClosing(all, berlin('2026-10-22T14:00:00'), BERLIN)).toBeNull();
    expect(nextOpening(daily([], false), berlin('2026-10-22T14:00:00'), BERLIN)).toEqual(
      berlin('2026-10-22T14:00:00'),
    );
  });

  it('counts wall-clock hours across the autumn change (03:00 CEST → 02:00 CET)', () => {
    // Sunday 2026-10-25: the clock goes back an hour at 03:00 CEST (01:00 UTC).
    const rh = daily(range(4, 6));
    // Saturday 23:00 CEST is 21:00 UTC; 04:00 CET on Sunday is 03:00 UTC (7 hours later, not 5).
    expect(nextOpening(rh, new Date('2026-10-24T21:00:00Z'), BERLIN)).toEqual(
      new Date('2026-10-25T03:00:00Z'),
    );
    // The repeated 02:00 hour is open twice when 02 is painted.
    const two = daily([2]);
    expect(isOpenAt(two, new Date('2026-10-25T00:30:00Z'), BERLIN)).toBe(true); // 02:30 CEST
    expect(isOpenAt(two, new Date('2026-10-25T01:30:00Z'), BERLIN)).toBe(true); // 02:30 CET
    expect(nextClosing(two, new Date('2026-10-25T00:30:00Z'), BERLIN)).toEqual(
      new Date('2026-10-25T02:00:00Z'),
    );
  });

  it('skips the hour the spring change removes (02:00 → 03:00 CEST)', () => {
    // Sunday 2026-03-29: 02:00 CET jumps to 03:00 CEST (01:00 UTC); 02:xx never happens.
    const rh = daily([2]);
    // Saturday 2026-03-28 03:00 CET (02:00 UTC) → the next 02:00 is Monday's (00:00 UTC, CEST).
    expect(nextOpening(rh, new Date('2026-03-28T02:00:00Z'), BERLIN)).toEqual(
      new Date('2026-03-30T00:00:00Z'),
    );
    const three = daily([3]);
    expect(nextOpening(three, new Date('2026-03-28T23:30:00Z'), BERLIN)).toEqual(
      new Date('2026-03-29T01:00:00Z'),
    );
  });
});

describe('hourRanges', () => {
  it('joins painted hours into ranges, wrapping past midnight when asked', () => {
    expect(hourRanges(NIGHT, true)).toEqual([[22, 7]]);
    expect(hourRanges(NIGHT, false)).toEqual([
      [0, 7],
      [22, 24],
    ]);
    expect(hourRanges([1, 2, 5, 9, 10], true)).toEqual([
      [1, 3],
      [5, 6],
      [9, 11],
    ]);
    expect(hourRanges([], true)).toEqual([]);
    expect(hourRanges([...Array(24).keys()], true)).toEqual([[0, 24]]);
  });
});

describe('runHoursSummary', () => {
  it('describes an every-day window', () => {
    expect(runHoursSummary(daily(NIGHT))).toBe('Runs every day, 22:00–07:00 (9 h)');
    expect(runHoursSummary(daily([1, 2, 9]))).toBe(
      'Runs every day, 01:00–03:00, 09:00–10:00 (3 h)',
    );
    expect(runHoursSummary(daily([...Array(24).keys()]))).toBe('Runs all day, every day');
    expect(runHoursSummary(daily([]))).toBe('Never runs: no hours chosen');
    expect(runHoursSummary(daily(NIGHT, false))).toBe('Runs any time');
  });

  it('lists days with the same hours together on a per-day window', () => {
    const night = range(0, 7);
    expect(runHoursSummary(perDay([night, night, night, night, night, range(9, 18), []]))).toBe(
      'Mon–Fri 00:00–07:00 (7 h); Sat 09:00–18:00 (9 h); Sun never',
    );
    const all = [...Array(24).keys()];
    expect(runHoursSummary(perDay([[], all, [], [], [], [], all]))).toBe(
      'Mon never; Tue all day; Wed–Sat never; Sun all day',
    );
    expect(runHoursSummary(perDay([[], [], [], [], [], [], []]))).toBe(
      'Never runs: no hours chosen',
    );
  });
});

describe('RunHoursSchema', () => {
  it('takes whole hours 0–23 and seven day strips, sorted and without repeats', () => {
    expect(
      RunHoursSchema.parse({
        enabled: true,
        perDay: false,
        every: [23, 22, 22, 0],
        days: [[], [], [], [], [], [], []],
      }).every,
    ).toEqual([0, 22, 23]);
    expect(() => RunHoursSchema.parse({ ...daily([24]) })).toThrow();
    expect(() => RunHoursSchema.parse({ ...daily([1.5]) })).toThrow();
    expect(() => RunHoursSchema.parse({ ...daily([]), days: [[]] })).toThrow();
  });
});
