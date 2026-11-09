import { describe, expect, it } from 'vitest';
import { versionLink } from './versionLink.ts';

const REPO = 'https://github.com/transcoda/transcoda';

describe('versionLink', () => {
  it('a release links to its GitHub release, pre-releases too', () => {
    expect(versionLink('0.3.0')).toBe(`${REPO}/releases/tag/v0.3.0`);
    expect(versionLink('0.4.0-rc.1')).toBe(`${REPO}/releases/tag/v0.4.0-rc.1`);
  });

  it('a -dev build with a commit links to that commit', () => {
    expect(versionLink('0.3.0-dev+16ce86f')).toBe(`${REPO}/commit/16ce86f`);
  });

  it('a -dev build without a commit, or no version yet, has no link', () => {
    expect(versionLink('0.3.0-dev')).toBeNull();
    expect(versionLink('0.0.0-dev')).toBeNull();
    expect(versionLink('…')).toBeNull();
    expect(versionLink("Couldn't read it")).toBeNull();
  });
});
