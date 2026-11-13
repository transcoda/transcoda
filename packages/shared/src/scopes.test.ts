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

  it('has exactly six scopes, metrics last', () => {
    expect(TOKEN_SCOPES).toEqual([
      'read',
      'plan',
      'jobs:create',
      'jobs:manage',
      'workflows:write',
      'metrics',
    ]);
  });
});
