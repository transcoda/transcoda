import { describe, expect, it } from 'vitest';
import { localDayStarts } from './local-days.ts';

const iso = (d: Date) => d.toISOString();

describe('localDayStarts', () => {
  it('seven New York days end with tomorrow at local midnight', () => {
    const days = localDayStarts(new Date('2026-10-26T00:04:00Z'), 'America/New_York', 7);
    expect(days).toHaveLength(8);
    expect(days[0]?.date).toBe('2026-10-19');
    expect(days[6]?.date).toBe('2026-10-25');
    expect(iso(days[6]?.start as Date)).toBe('2026-10-25T04:00:00.000Z');
    expect(days[7]?.date).toBe('2026-10-26');
  });

  it('a 25-hour day when the clocks go back', () => {
    const days = localDayStarts(new Date('2026-11-02T15:00:00Z'), 'America/New_York', 7);
    const i = days.findIndex((d) => d.date === '2026-11-01');
    expect(iso(days[i]?.start as Date)).toBe('2026-11-01T04:00:00.000Z');
    expect(iso(days[i + 1]?.start as Date)).toBe('2026-11-02T05:00:00.000Z');
  });

  it('a 23-hour day when the clocks go forward', () => {
    const days = localDayStarts(new Date('2026-03-09T15:00:00Z'), 'America/New_York', 7);
    const i = days.findIndex((d) => d.date === '2026-03-08');
    expect(iso(days[i]?.start as Date)).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(days[i + 1]?.start as Date)).toBe('2026-03-09T04:00:00.000Z');
  });

  it('UTC is plain midnights', () => {
    const days = localDayStarts(new Date('2026-10-25T23:59:59Z'), 'UTC', 7);
    expect(days[6]?.date).toBe('2026-10-25');
    expect(iso(days[6]?.start as Date)).toBe('2026-10-25T00:00:00.000Z');
  });

  it('a zone east of UTC', () => {
    const days = localDayStarts(new Date('2026-10-25T23:30:00Z'), 'Europe/Berlin', 7);
    expect(days[6]?.date).toBe('2026-10-26');
    expect(iso(days[6]?.start as Date)).toBe('2026-10-25T23:00:00.000Z');
  });
});
