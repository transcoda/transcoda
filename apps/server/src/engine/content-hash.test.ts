import { copyFile, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chunkOffsets, contentHash, HASH_CHUNK_BYTES, HashAborted } from './content-hash.ts';
import { tempDir } from './fixtures.ts';

const CHUNK = 16;
let dir = '';

beforeEach(async () => {
  dir = await tempDir('content-hash-');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** `n` bytes, each its index mod 251 (no repeating 16-byte chunk). */
const bytes = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => i % 251));

describe('contentHash', () => {
  it('chunks: 4 MiB each; a small file whole, a large one at start, middle and end', () => {
    expect(HASH_CHUNK_BYTES).toBe(4 * 1024 * 1024);
    expect(chunkOffsets(0, 16)).toEqual([]);
    expect(chunkOffsets(40, 16)).toEqual([
      { offset: 0, length: 16 },
      { offset: 16, length: 16 },
      { offset: 32, length: 8 },
    ]);
    expect(chunkOffsets(48, 16)).toHaveLength(3);
    expect(chunkOffsets(1000, 16)).toEqual([
      { offset: 0, length: 16 },
      { offset: 492, length: 16 },
      { offset: 984, length: 16 },
    ]);
  });

  it('is the same for a copy at another path, and names the scheme and size', async () => {
    const a = join(dir, 'a.mkv');
    await writeFile(a, bytes(1000));
    await copyFile(a, join(dir, 'b.mkv'));
    const h = await contentHash(a, { chunkBytes: CHUNK });
    expect(h).toMatch(/^v1:1000:[0-9a-f]{64}$/);
    expect(await contentHash(join(dir, 'b.mkv'), { chunkBytes: CHUNK })).toBe(h);
  });

  it('changes when a byte in a sampled chunk changes, not when a byte outside them does', async () => {
    const file = join(dir, 'a.mkv');
    const before = bytes(1000);
    await writeFile(file, before);
    const h = await contentHash(file, { chunkBytes: CHUNK });
    for (const at of [0, 500, 999]) {
      const changed = Buffer.from(before);
      changed[at] = (changed[at] ?? 0) ^ 0xff;
      await writeFile(file, changed);
      expect(await contentHash(file, { chunkBytes: CHUNK })).not.toBe(h);
    }
    const outside = Buffer.from(before);
    outside[100] = (outside[100] ?? 0) ^ 0xff;
    await writeFile(file, outside);
    expect(await contentHash(file, { chunkBytes: CHUNK })).toBe(h);
  });

  it('hashes a small file whole: any byte counts', async () => {
    const file = join(dir, 'a.srt');
    const before = bytes(40);
    await writeFile(file, before);
    const h = await contentHash(file, { chunkBytes: CHUNK });
    for (let at = 0; at < 40; at += 1) {
      const changed = Buffer.from(before);
      changed[at] = (changed[at] ?? 0) ^ 0xff;
      await writeFile(file, changed);
      expect(await contentHash(file, { chunkBytes: CHUNK })).not.toBe(h);
    }
  });

  it('reads only the sampled chunks of a large file', async () => {
    const file = join(dir, 'a.mkv');
    await writeFile(file, bytes(10_000));
    const reads: number[] = [];
    await contentHash(file, {
      chunkBytes: CHUNK,
      openFile: async (p) => {
        const fh = await open(p, 'r');
        const read = fh.read.bind(fh) as (...a: unknown[]) => ReturnType<typeof fh.read>;
        (fh as unknown as { read: unknown }).read = (...a: unknown[]) => {
          reads.push(a[2] as number);
          return read(...a);
        };
        return fh;
      },
    });
    expect(reads).toEqual([CHUNK, CHUNK, CHUNK]);
  });

  it('a missing file has no hash', async () => {
    expect(await contentHash(join(dir, 'gone.mkv'))).toBeNull();
    expect(await contentHash(join(dir, 'gone', 'a.mkv'))).toBeNull();
    expect(await contentHash(dir)).toBeNull();
  });

  it('stops on abort, before or between reads', async () => {
    const file = join(dir, 'a.mkv');
    await writeFile(file, bytes(1000));
    const ctl = new AbortController();
    ctl.abort();
    await expect(contentHash(file, { signal: ctl.signal })).rejects.toBeInstanceOf(HashAborted);
    const later = new AbortController();
    let n = 0;
    const run = contentHash(file, {
      chunkBytes: CHUNK,
      signal: later.signal,
      openFile: async (p) => {
        const fh = await open(p, 'r');
        const read = fh.read.bind(fh) as (...a: unknown[]) => ReturnType<typeof fh.read>;
        (fh as unknown as { read: unknown }).read = (...a: unknown[]) => {
          n += 1;
          if (n === 1) later.abort();
          return read(...a);
        };
        return fh;
      },
    });
    await expect(run).rejects.toBeInstanceOf(HashAborted);
    expect(n).toBe(1);
  });
});
