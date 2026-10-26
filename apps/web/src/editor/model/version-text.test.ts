import { describe, expect, it } from 'vitest';
import { activatedByText, SYSTEM_UPGRADE, versionAuthor } from './version-text.ts';

const me = { id: 'u1', username: 'jan' };

describe('version-text', () => {
  it('versionAuthor: my id gives my username, system:upgrade "automatic update", another user is "another user", never the raw id', () => {
    expect(versionAuthor('u1', me)).toBe('jan');
    expect(versionAuthor(SYSTEM_UPGRADE, me)).toBe('automatic update');
    expect(versionAuthor('u2', me)).toBe('another user');
    expect(versionAuthor('u1', null)).toBe('another user');
  });

  it('activatedByText follows versionAuthor and maps system:migration to "the upgrade"', () => {
    expect(activatedByText('u1', me)).toBe('jan');
    expect(activatedByText('u2', me)).toBe('another user');
    expect(activatedByText('system:migration', me)).toBe('the upgrade');
  });
});
