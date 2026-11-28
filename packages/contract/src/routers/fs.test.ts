import { describe, expect, it } from 'vitest';
import { contract } from '../index.ts';

describe('fs router', () => {
  it('exposes the fs router with one session-only browse procedure', () => {
    expect(Object.keys(contract.fs)).toEqual(['browseDirs']);
  });
});
