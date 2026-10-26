import { link, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type Fingerprint, fingerprintKey, fingerprintOf, sameFingerprint } from './fingerprint.ts';
import { tempDir } from './fixtures.ts';

const base: Fingerprint = { sizeBytes: 1234, mtimeMs: 1700000000123, ino: 42, dev: 7, nlink: 1 };

describe('fingerprintKey', () => {
  it('is dev:ino:size:mtime', () => {
    expect(fingerprintKey(base)).toBe('7:42:1234:1700000000123');
  });
});

describe('sameFingerprint', () => {
  it('ignores nlink', () => {
    expect(sameFingerprint(base, { ...base, nlink: 3 })).toBe(true);
  });

  it.each([
    ['sizeBytes', { sizeBytes: 1235 }],
    ['mtimeMs', { mtimeMs: 1700000000124 }],
    ['ino', { ino: 43 }],
    ['dev', { dev: 8 }],
  ])('differs on %s', (_name, change) => {
    expect(sameFingerprint(base, { ...base, ...change })).toBe(false);
  });
});

describe('fingerprintOf', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('reads size, mtime, inode, device and link count', async () => {
    const dir = await tempDir('fingerprint-');
    dirs.push(dir);
    const file = join(dir, 'a.mkv');
    await writeFile(file, 'hello');
    const st = await stat(file);
    const before = await fingerprintOf(file);
    expect(before).toEqual({
      sizeBytes: 5,
      mtimeMs: st.mtimeMs,
      ino: st.ino,
      dev: st.dev,
      nlink: 1,
    });
    await link(file, join(dir, 'b.mkv'));
    const after = await fingerprintOf(file);
    expect(after.nlink).toBe(2);
    expect(sameFingerprint(before, after)).toBe(true);
  });

  it('uses the given fs', async () => {
    const fake = {
      stat: async () => ({ size: 9, mtimeMs: 5, ino: 1, dev: 2, nlink: 1 }),
    } as unknown as Pick<typeof import('node:fs/promises'), 'stat'>;
    expect(await fingerprintOf('/nowhere', fake)).toEqual({
      sizeBytes: 9,
      mtimeMs: 5,
      ino: 1,
      dev: 2,
      nlink: 1,
    });
  });
});
