import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  allowedUrl,
  checkLockfiles,
  checkNpmrc,
  checkPackageLock,
  checkPnpmLock,
  checkWorkspace,
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
      'line 4: https://evil.example.invalid/pkg-1.0.0.tgz is not on an allowed host',
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
      "line 6: a resolution or tarball key not in pnpm's one-line form",
    ]);
  });

  it('fails quoted or escaped keys and block-style resolutions, which pnpm does not write', () => {
    const quoted = [
      '  pkg@1.0.0:',
      '    "resolution": {integrity: sha512-abc==, "tarball": https://registry.npmjs.org/x.tgz}',
      "    'resolution': {integrity: sha512-abc==}",
      '    resolution: {integrity: sha512-abc==, "tar\\u0062all": https://registry.npmjs.org/x.tgz}',
      '    resolution:',
      '      tarball: https://registry.npmjs.org/x.tgz',
    ].join('\n');
    expect(checkPnpmLock(quoted)).toEqual([
      'line 2: double quote or backslash, which pnpm does not write',
      "line 3: a resolution or tarball key not in pnpm's one-line form",
      'line 4: double quote or backslash, which pnpm does not write',
      "line 5: a resolution or tarball key not in pnpm's one-line form",
      "line 6: a resolution or tarball key not in pnpm's one-line form",
    ]);
  });

  it('fails a URL on another host anywhere but a deprecation message', () => {
    const text = [
      "  'pkg@https://evil.example.invalid/pkg.tgz':",
      '    resolution: {integrity: sha512-abc==}',
      '    deprecated: moved, see https://example.invalid/notes',
    ].join('\n');
    expect(checkPnpmLock(text)).toEqual([
      'line 1: https://evil.example.invalid/pkg.tgz is not on an allowed host',
    ]);
  });
});

describe('checkPackageLock', () => {
  it('passes registry URLs and fails anything else', () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
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

  it('fails a version 1 lockfile, and checks the old dependencies tree of a version 2 one', () => {
    const evil = { resolved: 'https://evil.example.invalid/b-1.0.0.tgz' };
    expect(
      checkPackageLock(JSON.stringify({ lockfileVersion: 1, dependencies: { b: evil } })),
    ).toEqual(['not a version 2 or 3 lockfile with a packages object']);
    expect(
      checkPackageLock(
        JSON.stringify({
          lockfileVersion: 2,
          packages: {},
          dependencies: { a: { dependencies: { b: evil } } },
        }),
      ),
    ).toEqual([
      'dependencies > a > b: resolved https://evil.example.invalid/b-1.0.0.tgz is not on an allowed host',
    ]);
  });
});

describe('checkNpmrc', () => {
  it('passes no registry or the npm registry, and fails another one or one it cannot read', () => {
    expect(checkNpmrc('save-exact=true\nregistry=https://registry.npmjs.org\n')).toEqual([]);
    expect(checkNpmrc('@transcoda:registry=https://npm.example.invalid/')).toEqual([
      'line 1: @transcoda:registry=https://npm.example.invalid/ is not registry=https://registry.npmjs.org/',
    ]);
    expect(checkNpmrc('"registry"=https://npm.example.invalid/')).toHaveLength(1);
    expect(checkNpmrc('registry = https://registry.npmjs.org/')).toHaveLength(1);
  });
});

describe('checkWorkspace', () => {
  it('fails registries and pnpmfiles in pnpm-workspace.yaml', () => {
    expect(checkWorkspace("packages:\n  - 'apps/*'\n")).toEqual([]);
    expect(
      checkWorkspace('registries:\n  default: https://npm.example.invalid/\npnpmfile: x.cjs\n'),
    ).toHaveLength(2);
  });
});
