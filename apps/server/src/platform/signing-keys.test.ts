import { describe, expect, it } from 'vitest';
import { parseSigningKeys } from './signing-keys.ts';

describe('parseSigningKeys', () => {
  it('parses comma-separated id:hex entries', () => {
    expect(parseSigningKeys(`a:${'f'.repeat(64)},b:${'0'.repeat(64)}`)).toEqual([
      { id: 'a', publicKey: 'f'.repeat(64) },
      { id: 'b', publicKey: '0'.repeat(64) },
    ]);
  });

  it('names the bad entry', () => {
    expect(() => parseSigningKeys('a:xyz')).toThrow(new Error('a:xyz: expected <id>:<64 hex>'));
    expect(() => parseSigningKeys(`bad id:${'f'.repeat(64)}`)).toThrow('expected <id>:<64 hex>');
  });
});
