import { describe, expect, it } from 'vitest';
import { parseRange } from './range.ts';

describe('parseRange', () => {
  it('reads one bytes range in each form, clamped to the size', () => {
    expect(parseRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange('bytes=7-', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=0-99', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=-99', 10)).toEqual({ start: 0, end: 9 });
  });

  it('is unsatisfiable past the end or for an empty file', () => {
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=12-20', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1', 0)).toBe('unsatisfiable');
    expect(parseRange('bytes=-3', 0)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 10)).toBe('unsatisfiable');
  });

  it('is null (serve in full) without a header, for several ranges or a malformed one', () => {
    expect(parseRange(null, 10)).toBeNull();
    expect(parseRange('', 10)).toBeNull();
    expect(parseRange('bytes=1-2,4-5', 10)).toBeNull();
    expect(parseRange('items=0-1', 10)).toBeNull();
    expect(parseRange('bytes=5-2', 10)).toBeNull();
    expect(parseRange('bytes=-', 10)).toBeNull();
    expect(parseRange('bytes=a-b', 10)).toBeNull();
    expect(parseRange('bytes=1.5-2', 10)).toBeNull();
  });
});
