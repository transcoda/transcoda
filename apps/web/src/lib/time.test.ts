import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fmtAgo, fmtAgoLong } from './time.ts';

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
});
