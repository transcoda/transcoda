import { describe, expect, it } from 'vitest';
import { fcRuns } from './testing.ts';

describe('fcRuns', () => {
  it('reads FC_NUM_RUNS, and falls back to 100 without a positive whole number', () => {
    expect(fcRuns({ FC_NUM_RUNS: '10000' })).toEqual({ numRuns: 10000 });
    expect(fcRuns({})).toEqual({ numRuns: 100 });
    for (const bad of ['', '0', '-5', '1.5', 'lots', '1e3']) {
      expect(fcRuns({ FC_NUM_RUNS: bad })).toEqual({ numRuns: 100 });
    }
  });
});
