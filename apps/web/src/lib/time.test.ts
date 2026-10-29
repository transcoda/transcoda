import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fmtAgo, fmtAgoLong, fmtAgoShort } from './time.ts';

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
