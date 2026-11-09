import { describe, expect, it } from 'vitest';
import { buildVersion } from './build-version.ts';

describe('buildVersion', () => {
  it('a release build is the package version', () => {
    expect(buildVersion('0.4.0', { release: true, commit: '16ce86fea6154d20' })).toBe('0.4.0');
  });

  it('any other build is the package version, -dev and the short commit', () => {
    expect(
      buildVersion('0.3.0', { release: false, commit: '16ce86fea6154d20726039d6969a85fad2259913' }),
    ).toBe('0.3.0-dev+16ce86f');
  });

  it('without a commit it is just -dev', () => {
    expect(buildVersion('0.3.0', { release: false, commit: null })).toBe('0.3.0-dev');
    expect(buildVersion('0.3.0', { release: false, commit: '' })).toBe('0.3.0-dev');
  });

  it('ignores a commit that is not a hex hash', () => {
    expect(buildVersion('0.3.0', { release: false, commit: 'main; rm -rf' })).toBe('0.3.0-dev');
  });
});
