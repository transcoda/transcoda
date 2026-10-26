import { describe, expect, it } from 'vitest';
import { fmtBytes, fmtPercent, fmtSaving } from './bytes.ts';

describe('bytes', () => {
  it('fmtBytes/fmtSaving/fmtPercent format the screen examples: 2.41 GB → 1.62 GB, saved 790 MB, −33%', () => {
    const before = 2_410_000_000;
    const after = 1_620_000_000;
    expect(`${fmtBytes(before)} → ${fmtBytes(after)}`).toBe('2.41 GB → 1.62 GB');
    expect(fmtSaving(before, after)).toBe('saved 790 MB');
    expect(fmtPercent(before, after)).toBe('−33%');
  });

  it('fmtBytes uses SI units with three significant digits in every unit, whole bytes', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(999)).toBe('999 B');
    expect(fmtBytes(612_000)).toBe('612 kB');
    expect(fmtBytes(612_499)).toBe('612 kB');
    expect(fmtBytes(790_000_000)).toBe('790 MB');
    // Below 100 a unit keeps its third digit, so a percentage beside it adds up (polish review).
    expect(fmtBytes(1_252_833)).toBe('1.25 MB');
    expect(fmtBytes(2_670_000)).toBe('2.67 MB');
    expect(fmtBytes(12_340_000)).toBe('12.3 MB');
    expect(fmtBytes(1_000_000_000)).toBe('1.00 GB');
    expect(fmtBytes(1_234_000_000_000)).toBe('1.23 TB');
    // Rounding that reaches 1000 moves to the next unit.
    expect(fmtBytes(999_600)).toBe('1.00 MB');
    expect(fmtBytes(999_700_000)).toBe('1.00 GB');
    expect(fmtBytes(999_996_000_000)).toBe('1.00 TB');
  });

  it('fmtSaving says how much a file grew', () => {
    expect(fmtSaving(100_000_000, 112_000_000)).toBe('grew by 12.0 MB');
    expect(fmtSaving(100_000_000, 100_000_000)).toBe('saved 0 B');
  });

  it('fmtPercent uses a real minus sign and a plus for growth', () => {
    expect(fmtPercent(100, 104)).toBe('+4%');
    expect(fmtPercent(100, 100)).toBe('0%');
    expect(fmtPercent(1000, 994)).toBe('−1%');
    expect(fmtPercent(1000, 999)).toBe('0%');
    expect(fmtPercent(0, 10)).toBe('—');
  });
});
