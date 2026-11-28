import { describe, expect, it } from 'vitest';
import { TokenCreateInputSchema } from '../index.ts';

describe('tokens router', () => {
  it('validates token creation input', () => {
    expect(
      TokenCreateInputSchema.safeParse({ name: 'diskmap', scopes: ['plan', 'jobs:create'] })
        .success,
    ).toBe(true);
    expect(TokenCreateInputSchema.safeParse({ name: 'diskmap', scopes: [] }).success).toBe(false);
    expect(TokenCreateInputSchema.safeParse({ name: 'diskmap', scopes: ['admin'] }).success).toBe(
      false,
    );
  });
});
