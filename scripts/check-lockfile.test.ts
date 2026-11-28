import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  allowedUrl,
  checkLockfiles,
  checkNpmrc,
  checkPackageLock,
  checkPnpmLock,
} from './check-lockfile.ts';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
const SHA = '690ae52154e1b41a4cbd3b33069f1e590daa011d';
const lock = (...resolutions: string[]) =>
  [
    "lockfileVersion: '9.0'",
    'packages:',
    ...resolutions.flatMap((r, i) => [`  pkg${i}@1.0.0:`, `    resolution: ${r}`]),
  ].join('\n');

it('the real lockfiles pass', () => expect(checkLockfiles(repoRoot)).toEqual([]));

describe('allowedUrl', () => {
  it('allows the npm registry and a pinned commit of transcoda/.github', () => {
    expect(allowedUrl('https://registry.npmjs.org/corepack/-/corepack-0.36.0.tgz')).toBe(true);
    expect(allowedUrl(`https://codeload.github.com/transcoda/.github/tar.gz/${SHA}`)).toBe(true);
  });

  it('refuses other hosts, other repositories, branches and plain http', () => {
    for (const url of [
      'https://registry.example.invalid/pkg/-/pkg-1.0.0.tgz',
      'http://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz',
      'https://registry.npmjs.org.example.invalid/pkg.tgz',
      `https://codeload.github.com/someone/.github/tar.gz/${SHA}`,
      `https://codeload.github.com/transcoda/other/tar.gz/${SHA}`,
      'https://codeload.github.com/transcoda/.github/tar.gz/main',
    ]) {
      expect(allowedUrl(url), url).toBe(false);
    }
  });
});

describe('checkPnpmLock', () => {
  it('passes registry and allowed tarball resolutions', () => {
    const text = lock(
      '{integrity: sha512-abc==}',
      `{gitHosted: true, integrity: sha512-def==, tarball: https://codeload.github.com/transcoda/.github/tar.gz/${SHA}}`,
    );
    expect(checkPnpmLock(text)).toEqual([]);
  });

  it('fails a tarball on another host', () => {
    const text = lock(
      '{integrity: sha512-abc==, tarball: https://evil.example.invalid/pkg-1.0.0.tgz}',
    );
    expect(checkPnpmLock(text)).toEqual([
      'line 4: tarball https://evil.example.invalid/pkg-1.0.0.tgz is not on an allowed host',
    ]);
  });

  it('fails git, directory and file resolutions', () => {
    const text = lock(
      '{type: git, repo: https://github.com/someone/pkg.git, commit: 0123456789}',
      '{directory: ../pkg, type: directory}',
      '{integrity: sha512-abc==, tarball: file:pkg-1.0.0.tgz}',
    );
    const problems = checkPnpmLock(text).join('\n');
    expect(problems).toMatch(/line 4: resolution field type \(git\) is not allowed/);
    expect(problems).toMatch(/line 4: resolution field repo/);
    expect(problems).toMatch(/line 6: resolution field directory/);
    expect(problems).toMatch(/line 8: tarball file:pkg-1.0.0.tgz is not on an allowed host/);
  });

  it('fails a resolution without an integrity hash, or one it cannot read', () => {
    const text = lock(`{tarball: https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz}`, '');
    expect(checkPnpmLock(text)).toEqual([
      'line 4: resolution has no integrity hash',
      'line 6: resolution is not a one-line {...} map',
    ]);
  });
});

describe('checkPackageLock', () => {
  it('passes registry URLs and fails anything else', () => {
    const text = JSON.stringify({
      packages: {
        '': { name: 'x' },
        'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' },
        'node_modules/b': { resolved: 'https://evil.example.invalid/b-1.0.0.tgz' },
        'node_modules/c': {},
      },
    });
    expect(checkPackageLock(text)).toEqual([
      'node_modules/b: resolved https://evil.example.invalid/b-1.0.0.tgz is not on an allowed host',
      'node_modules/c: no resolved URL',
    ]);
  });
});

describe('checkNpmrc', () => {
  it('passes no registry or the npm registry, and fails another one', () => {
    expect(checkNpmrc('save-exact=true\nregistry=https://registry.npmjs.org\n')).toEqual([]);
    expect(checkNpmrc('@transcoda:registry=https://npm.example.invalid/')).toEqual([
      'line 1: @transcoda:registry is https://npm.example.invalid/, not https://registry.npmjs.org/',
    ]);
  });
});
