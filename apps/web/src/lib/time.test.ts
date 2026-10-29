import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fmtAgo, fmtAgoLong, fmtAgoShort, fmtStamp } from './time.ts';

const now = new Date('2026-10-16T12:00:00.000Z');
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('time', () => {
  it('fmtAgoLong says "saved just now" under a minute and "saved 2 min ago" after', () => {
    expect(fmtAgoLong(ago(59))).toBe('saved just now');
    expect(fmtAgoLong(ago(120))).toBe('saved 2 min ago');
    expect(fmtAgoLong(ago(3 * 3600))).toBe('saved 3 h ago');
    const old = ago(4 * 86400);
    const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
    expect(fmtAgoLong(old)).toBe(`saved ${day.format(new Date(old))}`);
  });

  it('fmtAgo keeps the short form used by the tokens page', () => {
    expect(fmtAgo(ago(10))).toBe('just now');
    expect(fmtAgo(ago(300))).toBe('5 min ago');
  });

  it('fmtAgoShort drops the year only for a date in this year', () => {
    expect(fmtAgoShort(ago(300), now)).toBe('5 min ago');
    expect(fmtAgoShort(ago(3 * 3600), now)).toBe('3 h ago');
    const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
    const full = new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    const thisYear = '2026-03-02T12:00:00.000Z';
    expect(fmtAgoShort(thisYear, now)).toBe(day.format(new Date(thisYear)));
    expect(fmtAgoShort(thisYear, now)).not.toContain('2026');
    const lastYear = '2025-10-27T12:00:00.000Z';
    expect(fmtAgoShort(lastYear, now)).toBe(full.format(new Date(lastYear)));
    expect(fmtAgoShort(lastYear, now)).toContain('2025');
  });
});

describe('fmtStamp (convention 13)', () => {
  const at = (iso: string) => new Date(iso).toISOString();
  const opts = { now, timeZone: 'UTC' };

  it('is relative under a day', () => {
    expect(fmtStamp(ago(10), opts)).toBe('just now');
    expect(fmtStamp(ago(8 * 60), opts)).toBe('8 min ago');
    expect(fmtStamp(ago(5 * 3600), opts)).toBe('5 h ago');
  });

  it('is "Oct 25" this year and "Oct 25, 2025" in another year', () => {
    expect(fmtStamp(at('2026-10-02T06:28:00Z'), opts)).toBe('Oct 2');
    expect(fmtStamp(at('2025-10-25T06:28:00Z'), opts)).toBe('Oct 25, 2025');
  });

  it('adds a 24 h time only when asked', () => {
    expect(fmtStamp(at('2026-10-02T18:05:00Z'), { ...opts, time: true })).toBe('Oct 2, 18:05');
    expect(fmtStamp(at('2025-10-25T06:28:00Z'), { ...opts, time: true })).toBe(
      'Oct 25, 2025, 06:28',
    );
    // Under a day the relative form already says when.
    expect(fmtStamp(ago(120), { ...opts, time: true })).toBe('2 min ago');
  });

  it('relative: false always gives the date', () => {
    expect(fmtStamp(ago(3600), { ...opts, relative: false })).toBe('Oct 16');
  });

  it('reads the date in the given time zone', () => {
    // 02:00 UTC on Oct 3 is still Oct 2 in New York.
    expect(fmtStamp(at('2026-10-03T02:00:00Z'), { ...opts, timeZone: 'America/New_York' })).toBe(
      'Oct 2',
    );
  });

  it('a future time (clock skew) is a date, never "-3 min ago"', () => {
    expect(fmtStamp(at('2026-10-20T12:00:00Z'), opts)).toBe('Oct 20');
  });
});
