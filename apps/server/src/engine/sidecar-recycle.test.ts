import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuildModel } from '@transcoda/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecycledRow } from '../db/repos/jobs.ts';
import type { Logger } from '../logger.ts';
import { modelFromProbe } from './build-model.ts';
import { tempDir } from './fixtures.ts';
import { type FsOps, nodeFsOps } from './fs-ops.ts';
import { recycleSidecars } from './sidecar-recycle.ts';
import { probeOf, withSidecar } from './test-helpers.ts';

let base: string;
let root: string;
let recycle: string;
let rows: RecycledRow[];
let fs: FsOps;
const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const NOW = new Date('2026-10-18T20:00:00.000Z');

beforeEach(async () => {
  base = await realpath(await tempDir('sidecar-recycle-'));
  root = join(base, 'lib');
  recycle = join(root, '.transcoda-recycle');
  await mkdir(join(root, 'Show'), { recursive: true });
  rows = [];
  fs = { ...nodeFsOps, unlink: vi.fn(nodeFsOps.unlink) };
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const probe = probeOf([{ type: 'video', default: true }]);

/** A model with the given sidecars (files under `root/Show`). */
function model(
  sidecars: { file: string; afterReplace?: 'keep' | 'recycle'; keep?: boolean }[],
): BuildModel {
  let m = modelFromProbe(probe);
  sidecars.forEach((s, i) => {
    m = withSidecar(m, i + 1, s.file, {
      afterReplace: s.afterReplace ?? 'recycle',
      keep: s.keep ?? true,
    });
    (m.extraInputs?.[i] as { path: string }).path = join(root, 'Show', s.file);
  });
  return m;
}

const run = (m: BuildModel, deps: Partial<{ fs: FsOps }> = {}) =>
  recycleSidecars(
    { model: m, jobId: 'job1', libraryId: 'lib1', libraryRoot: root, recycleFolder: recycle },
    {
      fs: deps.fs ?? fs,
      recordRecycled: (r) => rows.push(r),
      now: () => NOW,
      log,
    },
  );

describe('recycleSidecars', () => {
  it('moves a kept sidecar to the recycle folder under its relative path and records it', async () => {
    await writeFile(join(root, 'Show', 'a.de.srt'), 'hallo');
    expect(await run(model([{ file: 'a.de.srt' }]))).toEqual([]);
    expect(await readFile(join(recycle, 'Show', 'a.de.srt'), 'utf8')).toBe('hallo');
    expect(await nodeFsOps.exists(join(root, 'Show', 'a.de.srt'))).toBe(false);
    expect(rows).toEqual([
      {
        path: join(recycle, 'Show', 'a.de.srt'),
        libraryId: 'lib1',
        jobId: 'job1',
        sizeBytes: 5,
        recycledAt: NOW.toISOString(),
      },
    ]);
  });

  it('an existing destination gets the first free .n suffix', async () => {
    await mkdir(join(recycle, 'Show'), { recursive: true });
    await writeFile(join(recycle, 'Show', 'a.de.srt'), 'older');
    await writeFile(join(root, 'Show', 'a.de.srt'), 'newer');
    expect(await run(model([{ file: 'a.de.srt' }]))).toEqual([]);
    expect(await readFile(join(recycle, 'Show', 'a.de.srt'), 'utf8')).toBe('older');
    expect(await readFile(join(recycle, 'Show', 'a.de.srt.1'), 'utf8')).toBe('newer');
    expect(rows.map((r) => r.path)).toEqual([join(recycle, 'Show', 'a.de.srt.1')]);
  });

  it("leaves afterReplace 'keep' files and files whose stream was dropped", async () => {
    await writeFile(join(root, 'Show', 'a.de.srt'), 'x');
    await writeFile(join(root, 'Show', 'a.fr.sup'), 'y');
    const m = model([
      { file: 'a.de.srt', afterReplace: 'keep' },
      { file: 'a.fr.sup', keep: false },
    ]);
    expect(await run(m)).toEqual([]);
    expect(await nodeFsOps.exists(join(root, 'Show', 'a.de.srt'))).toBe(true);
    expect(await nodeFsOps.exists(join(root, 'Show', 'a.fr.sup'))).toBe(true);
    expect(rows).toEqual([]);
  });

  it('a symlinked parent directory at recycle time: the file stays, a problem is reported', async () => {
    await mkdir(join(base, 'outside'));
    await writeFile(join(base, 'outside', 'a.de.srt'), 'x');
    await symlink(join(base, 'outside'), join(root, 'Show', 'subs'));
    const m = model([{ file: 'subs/a.de.srt' }]);
    expect(await run(m)).toEqual([
      'subtitle file a.de.srt could not be recycled: its path is not a real path in the library',
    ]);
    expect(await readFile(join(base, 'outside', 'a.de.srt'), 'utf8')).toBe('x');
    expect(rows).toEqual([]);
  });

  it('a file outside the library root is never moved', async () => {
    await mkdir(join(base, 'outside'));
    await writeFile(join(base, 'outside', 'a.de.srt'), 'x');
    const m = model([{ file: '../../outside/a.de.srt' }]);
    expect(await run(m)).toEqual([
      'subtitle file a.de.srt could not be recycled: its path is not a real path in the library',
    ]);
    expect(rows).toEqual([]);
  });

  it('a file at the library root whose name starts with two dots is recycled', async () => {
    await writeFile(join(root, '..a.de.srt'), 'x');
    expect(await run(model([{ file: '../..a.de.srt' }]))).toEqual([]);
    expect(await readFile(join(recycle, '..a.de.srt'), 'utf8')).toBe('x');
  });

  it('a folder sync failing after the move: recorded, and the problem says it moved', async () => {
    await writeFile(join(root, 'Show', 'a.de.srt'), 'x');
    const failingSync: FsOps = {
      ...fs,
      fsyncDir: async () => {
        throw Object.assign(new Error('io'), { code: 'EIO' });
      },
    };
    expect(await run(model([{ file: 'a.de.srt' }]), { fs: failingSync })).toEqual([
      'subtitle file a.de.srt was moved to the recycle folder but the folder sync failed: EIO',
    ]);
    expect(rows.map((r) => r.path)).toEqual([join(recycle, 'Show', 'a.de.srt')]);
    expect(await readFile(join(recycle, 'Show', 'a.de.srt'), 'utf8')).toBe('x');
  });

  it('a sidecar gone meanwhile is a problem, not a throw; the others still move', async () => {
    await writeFile(join(root, 'Show', 'a.en.srt'), 'x');
    const problems = await run(model([{ file: 'a.de.srt' }, { file: 'a.en.srt' }]));
    expect(problems).toEqual([
      expect.stringMatching(/^subtitle file a\.de\.srt could not be recycled: .*ENOENT/),
    ]);
    expect(rows.map((r) => r.path)).toEqual([join(recycle, 'Show', 'a.en.srt')]);
  });

  it('a sidecar that is no longer a regular file is left alone', async () => {
    await mkdir(join(root, 'Show', 'a.de.srt'));
    expect(await run(model([{ file: 'a.de.srt' }]))).toEqual([
      'subtitle file a.de.srt could not be recycled: it is no longer a regular file',
    ]);
    expect(await nodeFsOps.exists(join(root, 'Show', 'a.de.srt'))).toBe(true);
  });

  it('unlinks only the old name of a file already linked into the recycle folder', async () => {
    const src = join(root, 'Show', 'a.de.srt');
    await writeFile(src, 'x');
    const unlinked: { path: string; destThere: boolean }[] = [];
    const watching: FsOps = {
      ...nodeFsOps,
      unlink: async (p) => {
        unlinked.push({
          path: p,
          destThere: await nodeFsOps.exists(join(recycle, 'Show', 'a.de.srt')),
        });
        return nodeFsOps.unlink(p);
      },
    };
    expect(await run(model([{ file: 'a.de.srt' }]), { fs: watching })).toEqual([]);
    expect(unlinked.every((u) => u.path === src && u.destThere)).toBe(true);
    expect(await readFile(join(recycle, 'Show', 'a.de.srt'), 'utf8')).toBe('x');
  });

  it('never calls unlink where hard links are not possible (plain no-clobber rename)', async () => {
    await writeFile(join(root, 'Show', 'a.de.srt'), 'x');
    const noLinks: FsOps = {
      ...fs,
      link: async () => {
        throw Object.assign(new Error('no links'), { code: 'EPERM' });
      },
    };
    expect(await run(model([{ file: 'a.de.srt' }]), { fs: noLinks })).toEqual([]);
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(await readFile(join(recycle, 'Show', 'a.de.srt'), 'utf8')).toBe('x');
  });
});
