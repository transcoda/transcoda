import { describe, expect, it } from 'vitest';
import { isTokenScope, TOKEN_SCOPES } from './scopes.ts';

describe('token scopes', () => {
  it('accepts a known scope', () => {
    expect(isTokenScope('read')).toBe(true);
  });

  it('rejects unknown values', () => {
    expect(isTokenScope('admin')).toBe(false);
    expect(isTokenScope(undefined)).toBe(false);
  });

  it('has exactly five scopes', () => {
    expect(TOKEN_SCOPES.length).toBe(5);
  });
});
