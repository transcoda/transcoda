// Property tests (fast-check) for how long a job took and has left: any number of seconds reads as
// a person would write it, with seconds and minutes always under 60.
import { fcRuns } from '@transcoda/shared/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fmtDuration } from '../lib/time.ts';
import { fmtTimeLeft } from './job-text.ts';

const RUNS = fcRuns();

/** "40 s", "3 min", "1 h", "1 h 23 min", "2 min 5 s", each part in range. */
function expectReadable(text: string): void {
  const m = /^(?:(\d+) h(?: (\d+) min)?|(\d+) min(?: (\d+) s)?|(\d+) s)$/.exec(text);
  expect(m, text).not.toBeNull();
  const [, h, hMin, min, minS, s] = m ?? [];
  if (h !== undefined) expect(Number(h)).toBeGreaterThan(0);
  for (const under60 of [hMin, min, minS, s]) {
    if (under60 !== undefined) expect(Number(under60), text).toBeLessThan(60);
  }
  for (const nonZero of [hMin, minS]) {
    if (nonZero !== undefined) expect(Number(nonZero), text).toBeGreaterThan(0);
  }
  if (min !== undefined) expect(Number(min), text).toBeGreaterThan(0);
}

// Whole seconds, the edges just below a minute and an hour, and fractions around them.
const seconds = fc.oneof(
  fc.double({ min: -10, max: 1_000_000, noNaN: true }),
  fc.double({ min: 59, max: 60, noNaN: true }),
  fc.double({ min: 3569, max: 3601, noNaN: true }),
  fc.nat(1_000_000),
);

describe('fmtTimeLeft (property)', () => {
  it('reads as seconds, minutes or hours and minutes, never "60 s" or "60 min"', () => {
    fc.assert(
      fc.property(seconds, (n) => expectReadable(fmtTimeLeft(n))),
      RUNS,
    );
  });
});

describe('fmtDuration (property)', () => {
  it('reads as seconds, minutes and seconds, or hours and minutes', () => {
    fc.assert(
      fc.property(seconds, (n) => expectReadable(fmtDuration(n * 1000))),
      RUNS,
    );
  });
});
