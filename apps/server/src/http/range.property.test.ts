// Property tests (fast-check) for the Range header reader: whatever a client sends, a range it
// returns lies inside the file, so a read never goes past either end.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseRange } from './range.ts';

const RUNS = { numRuns: 300, seed: 0x7c0da };

const digits = fc.oneof(fc.nat().map(String), fc.constant(''), fc.stringMatching(/^\d{1,25}$/));
const header = fc.oneof(
  fc.tuple(digits, digits).map(([a, b]) => `bytes=${a}-${b}`),
  fc.string(),
  fc.constant(null),
);
const size = fc.oneof(fc.nat(10_000), fc.constant(0), fc.nat());

describe('parseRange (property)', () => {
  it('returns a range inside the file, unsatisfiable or null, for any header', () => {
    fc.assert(
      fc.property(header, size, (h, n) => {
        const r = parseRange(h, n);
        if (r === null || r === 'unsatisfiable') return;
        expect(Number.isSafeInteger(r.start) && Number.isSafeInteger(r.end)).toBe(true);
        expect(r.start).toBeGreaterThanOrEqual(0);
        expect(r.start).toBeLessThanOrEqual(r.end);
        expect(r.end).toBeLessThan(n);
      }),
      RUNS,
    );
  });

  it('serves exactly the bytes a well-formed range asks for, clamped to the end', () => {
    fc.assert(
      fc.property(fc.nat(10_000), fc.nat(10_000), fc.nat(10_000), (n, a, len) => {
        fc.pre(a < n);
        expect(parseRange(`bytes=${a}-${a + len}`, n)).toEqual({
          start: a,
          end: Math.min(a + len, n - 1),
        });
        expect(parseRange(`bytes=${a}-`, n)).toEqual({ start: a, end: n - 1 });
        expect(parseRange(`bytes=-${len + 1}`, n)).toEqual({
          start: Math.max(0, n - len - 1),
          end: n - 1,
        });
      }),
      RUNS,
    );
  });
});
