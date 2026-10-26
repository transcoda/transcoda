import { describe, expect, it } from 'vitest';
import { fmtKbps } from './rate.ts';

describe('fmtKbps', () => {
  it('writes kb/s below 1000 and Mb/s from there, one decimal', () => {
    expect(fmtKbps(640)).toBe('640 kb/s');
    expect(fmtKbps(159.6)).toBe('160 kb/s');
    expect(fmtKbps(1000)).toBe('1.0 Mb/s');
    expect(fmtKbps(13_700)).toBe('13.7 Mb/s');
  });
});
