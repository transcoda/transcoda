import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../logger.ts';
import { tempDir } from './fixtures.ts';
import { ClobberRefused, type FsOps, nodeFsOps, renameNoClobber, syncDir } from './fs-ops.ts';

const hasMkfifo = (() => {
  try {
    execFileSync('which', ['mkfifo'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let root: string;
let a: string;
let b: string;

beforeEach(async () => {
  root = await tempDir('fs-ops-');
  await mkdir(join(root, 'x'), { recursive: true });
  a = join(root, 'a.mkv');
  b = join(root, 'x', 'b.mkv');
  await writeFile(a, 'original');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const coded = (code: string): Error => Object.assign(new Error(code), { code });

/** nodeFsOps recording every call as `op`. */
function recording(base: FsOps, calls: string[]): FsOps {
  const out = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(base) as (keyof FsOps)[]) {
    const fn = base[key] as (...args: unknown[]) => Promise<unknown>;
    out[key] = (...args: unknown[]) => {
      calls.push(key);
      return fn.apply(base, args);
    };
  }
  return out as unknown as FsOps;
}

describe('renameNoClobber', () => {
  it('moves with link + unlink (same inode, no rename) when hard links work', async () => {
    const ino = (await stat(a)).ino;
    const calls: string[] = [];
    await renameNoClobber(recording(nodeFsOps, calls), a, b);
    expect(calls).toEqual(['link', 'unlink']);
    expect(await nodeFsOps.exists(a)).toBe(false);
    expect((await stat(b)).ino).toBe(ino);
    expect((await stat(b)).nlink).toBe(1);
  });

  it('refuses atomically: something appearing at the destination after any check is never clobbered', async () => {
    await writeFile(b, 'appeared');
    // An existence check would say "free" here (the race); link() itself must refuse.
    const fs: FsOps = { ...nodeFsOps, exists: async () => false };
    await expect(renameNoClobber(fs, a, b)).rejects.toBeInstanceOf(ClobberRefused);
    await expect(renameNoClobber(fs, a, b)).rejects.toThrow(
      `refusing to rename over an existing path: ${b}`,
    );
    expect(await readFile(b, 'utf8')).toBe('appeared');
    expect(await readFile(a, 'utf8')).toBe('original');
  });

  for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'ENOSYS']) {
    it(`falls back to check-then-rename when link fails ${code}`, async () => {
      const calls: string[] = [];
      const fs = recording(
        {
          ...nodeFsOps,
          link: async () => {
            throw coded(code);
          },
        },
        calls,
      );
      await renameNoClobber(fs, a, b);
      expect(calls).toEqual(['link', 'exists', 'rename']);
      expect(await readFile(b, 'utf8')).toBe('original');
      expect(await nodeFsOps.exists(a)).toBe(false);
    });
  }

  it('the fallback still refuses a taken destination', async () => {
    await writeFile(b, 'taken');
    const fs: FsOps = {
      ...nodeFsOps,
      link: async () => {
        throw coded('EPERM');
      },
    };
    await expect(renameNoClobber(fs, a, b)).rejects.toBeInstanceOf(ClobberRefused);
    expect(await readFile(b, 'utf8')).toBe('taken');
    expect(await readFile(a, 'utf8')).toBe('original');
  });

  it('any other link error is rethrown and nothing is renamed', async () => {
    const calls: string[] = [];
    const fs = recording(
      {
        ...nodeFsOps,
        link: async () => {
          throw coded('EACCES');
        },
      },
      calls,
    );
    await expect(renameNoClobber(fs, a, b)).rejects.toThrow('EACCES');
    expect(calls).toEqual(['link']);
    expect(await readFile(a, 'utf8')).toBe('original');
    expect(await nodeFsOps.exists(b)).toBe(false);
  });

  it('a failing unlink after the link leaves both names on one inode (the sweep resolves it)', async () => {
    const fs: FsOps = {
      ...nodeFsOps,
      unlink: async () => {
        throw coded('EIO');
      },
    };
    await expect(renameNoClobber(fs, a, b)).rejects.toThrow('EIO');
    expect((await stat(a)).ino).toBe((await stat(b)).ino);
  });
});

describe('syncDir', () => {
  let warnings: unknown[];
  let log: Logger;
  beforeEach(() => {
    warnings = [];
    log = { info: () => {}, warn: (e) => warnings.push(e), error: () => {} };
  });

  it('fsyncs the directory', async () => {
    const calls: string[] = [];
    await syncDir(recording(nodeFsOps, calls), root, log);
    expect(calls).toEqual(['fsyncDir']);
    expect(warnings).toEqual([]);
  });

  for (const code of ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']) {
    it(`a mount that does not support fsync (${code}) is a warning, not a failure`, async () => {
      const fs: FsOps = {
        ...nodeFsOps,
        fsyncDir: async () => {
          throw coded(code);
        },
      };
      await syncDir(fs, root, log);
      expect(warnings).toEqual([
        expect.objectContaining({ msg: 'fsync is not supported here; continuing', code }),
      ]);
    });
  }

  it('EIO stays fatal', async () => {
    const fs: FsOps = {
      ...nodeFsOps,
      fsyncDir: async () => {
        throw coded('EIO');
      },
    };
    await expect(syncDir(fs, root, log)).rejects.toThrow('EIO');
  });
});

describe('copyRegular', () => {
  it('copies a regular file exclusively', async () => {
    const dst = join(root, 'copy.srt');
    await nodeFsOps.copyRegular(a, dst, 100);
    expect(await readFile(dst, 'utf8')).toBe('original');
    await expect(nodeFsOps.copyRegular(a, dst, 100)).rejects.toThrow();
  });

  it('refuses a symlink, a directory and a file over the limit, leaving no copy', async () => {
    const link = join(root, 'link.srt');
    await symlink(a, link);
    await expect(nodeFsOps.copyRegular(link, join(root, 'l.srt'), 100)).rejects.toThrow(
      'it is a symbolic link',
    );
    await expect(nodeFsOps.copyRegular(join(root, 'x'), join(root, 'd.srt'), 100)).rejects.toThrow(
      'it is not a regular file',
    );
    await expect(nodeFsOps.copyRegular(a, join(root, 'big.srt'), 3)).rejects.toThrow(
      'it is larger than 3 bytes',
    );
    for (const name of ['l.srt', 'd.srt', 'big.srt']) {
      await expect(stat(join(root, name))).rejects.toThrow();
    }
  });

  it.skipIf(!hasMkfifo)(
    'refuses a FIFO without blocking on open',
    async () => {
      const fifo = join(root, 'fifo.srt');
      execFileSync('mkfifo', [fifo]);
      await expect(nodeFsOps.copyRegular(fifo, join(root, 'f.srt'), 100)).rejects.toThrow(
        'it is not a regular file',
      );
      await expect(stat(join(root, 'f.srt'))).rejects.toThrow();
    },
    5_000,
  );
});
