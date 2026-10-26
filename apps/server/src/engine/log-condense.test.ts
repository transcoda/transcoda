import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCondensedTail } from './log-condense.ts';

const NUMA = 'set_mempolicy: Operation not permitted';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'log-condense-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function condensed(text: string, bytes = 64 * 1024): Promise<string> {
  const path = join(dir, 'job.log');
  await writeFile(path, text);
  return readCondensedTail(path, bytes);
}

describe('readCondensedTail', () => {
  it('a missing log is empty; a short one is as it is', async () => {
    expect(await readCondensedTail(join(dir, 'none.log'), 100)).toBe('');
    expect(await condensed('a\nb\n')).toBe('a\nb\n');
  });

  it('says how often a line repeats in a row, once', async () => {
    expect(await condensed('a\nb\nb\nb\nc\n')).toBe('a\nb [transcoda: 3 times]\nc\n');
  });

  it('counts every set_mempolicy line where the first one was, so the flood never buries the rest', async () => {
    const flood = Array.from({ length: 5000 }, () => NUMA);
    const text = ['start', 'pgs warning', NUMA, 'frame=1', ...flood, 'end', ''].join('\n');
    // A tail far smaller than the flood still has the lines before it.
    expect(await condensed(text, 200)).toBe(
      ['start', 'pgs warning', `${NUMA} [transcoda: 5001 times]`, 'frame=1', 'end', ''].join('\n'),
    );
  });

  it('keeps only the last bytes of what is left, from a whole line; the flood line stays in front', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const out = await condensed([NUMA, ...lines, NUMA, ''].join('\n'), 39);
    expect(out).toBe(
      [`${NUMA} [transcoda: 2 times]`, 'line 46', 'line 47', 'line 48', 'line 49', ''].join('\n'),
    );
  });

  it('reads only the last scanBytes, from a whole line; the flood count then says at least', async () => {
    const path = join(dir, 'big.log');
    const head = Array.from({ length: 1000 }, (_, i) => `early ${i}`);
    const flood = Array.from({ length: 300 }, () => NUMA);
    await writeFile(path, [...head, ...flood, 'end', ''].join('\n'));
    const out = await readCondensedTail(path, 64 * 1024, 2000);
    expect(out).not.toContain('early');
    expect(out).toMatch(
      /^set_mempolicy: Operation not permitted \[transcoda: at least \d+ times\]\nend\n$/,
    );
    const n = Number(/at least (\d+)/.exec(out)?.[1]);
    expect(n).toBeGreaterThan(40);
    expect(n).toBeLessThan(300);
  });

  it('a log that has not changed is condensed once (same size and mtime)', async () => {
    const path = join(dir, 'cached.log');
    await writeFile(path, 'a\nb\n');
    expect(await readCondensedTail(path, 100)).toBe('a\nb\n');
    expect(await readCondensedTail(path, 100)).toBe('a\nb\n');
    // A grown log is a new key: never the stale tail.
    await writeFile(path, 'a\nb\nc\n');
    expect(await readCondensedTail(path, 100)).toBe('a\nb\nc\n');
  });
});
