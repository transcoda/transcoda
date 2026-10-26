import nodeFs from 'node:fs';
import { mkdir, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/open.ts';
import { insertJob } from '../db/repos/jobs.ts';
import { insertLibrary } from '../db/repos/libraries.ts';
import { insertRun } from '../db/repos/runs.ts';
import { setSetting } from '../db/repos/settings.ts';
import { insertWorkflow } from '../db/repos/workflows.ts';
import { createTestDb } from '../db/test-db.ts';
import type { Logger } from '../logger.ts';
import { tempDir } from './fixtures.ts';
import { type FsOps, nodeFsOps } from './fs-ops.ts';
import { buildPreview } from './preview.ts';
import {
  scratchMinFreeBytes,
  TEST_OUTPUT_DIR,
  TEST_OUTPUT_NOTES,
  TestOutputStore,
} from './test-outputs.ts';

vi.mock('./preview.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./preview.ts')>();
  return { ...real, buildPreview: vi.fn(real.buildPreview) };
});
const build = vi.mocked(buildPreview);

const GIB = 1024 ** 3;
const HOUR = 3_600_000;
const start = new Date('2026-03-01T12:00:00.000Z');

let base: string;
let tc: string;
let dir: string;
let db: Database;
let now: Date;
/** What the fake statfs reports free; a function so a test can change it per call. */
let free: () => number;
let logged: unknown[];
let minFreeGiB: number;

const log: Logger = {
  info: (e) => logged.push(e),
  warn: (e) => logged.push(e),
  error: (e) => logged.push(e),
};
const fs: FsOps = {
  ...nodeFsOps,
  statfs: async () => ({ bavail: free(), bsize: 1 }),
};

function store(): TestOutputStore {
  return new TestOutputStore({
    db,
    fs,
    config: { transcodeDir: tc, healthMinFreeGiB: minFreeGiB },
    now: () => now,
    log,
  });
}

function job(id: string): void {
  insertJob(
    db,
    {
      id,
      runId: 'r1',
      libraryId: 'l1',
      fileId: null,
      path: join(base, 'lib', `${id}.mkv`),
      workflowId: 'w1',
      workflowVersion: 1,
      dryRun: true,
      testEncode: true,
      state: 'verifying',
      priority: 0,
    },
    start,
  );
}

const note = (id: string): string | null =>
  (
    db.prepare('SELECT test_output_note FROM jobs WHERE id = ?').get(id) as {
      test_output_note: string | null;
    }
  ).test_output_note;

/** A verified output in the job's temp dir, as the pipeline leaves it. */
async function output(id: string, bytes = 600): Promise<string> {
  const p = join(tc, id, 'out.mkv');
  await mkdir(join(tc, id), { recursive: true });
  await writeFile(p, Buffer.alloc(bytes, 1));
  return p;
}

const exists = (p: string): boolean => nodeFs.existsSync(p);

beforeEach(async () => {
  base = await tempDir('test-outputs-');
  tc = join(base, 'transcode');
  dir = join(tc, TEST_OUTPUT_DIR);
  await mkdir(tc, { recursive: true });
  db = createTestDb();
  insertWorkflow(
    db,
    { id: 'w1', kind: 'workflow', name: 'Shrink', graph: emptyGraph('workflow'), createdBy: 'u' },
    start,
  );
  insertLibrary(
    db,
    {
      id: 'l1',
      name: 'TV',
      path: join(base, 'lib'),
      recycleFolder: null,
      processHardlinked: false,
    },
    start,
  );
  insertRun(
    db,
    {
      id: 'r1',
      libraryId: 'l1',
      workflowId: 'w1',
      workflowVersion: 1,
      requestedPath: join(base, 'lib'),
      dryRun: true,
      testEncode: true,
      force: false,
      createdBy: 'u',
    },
    start,
  );
  for (const id of ['a', 'b', 'c']) job(id);
  now = start;
  free = () => 100 * GIB;
  logged = [];
  minFreeGiB = 5;
});

afterEach(async () => {
  vi.restoreAllMocks();
  build.mockReset();
  db.close();
  await rm(base, { recursive: true, force: true });
});

describe('scratchMinFreeBytes', () => {
  it('is the health minimum, never below 5 GiB', () => {
    expect(scratchMinFreeBytes({ healthMinFreeGiB: 1 })).toBe(5 * GIB);
    expect(scratchMinFreeBytes({ healthMinFreeGiB: 8 })).toBe(8 * GIB);
  });
});

describe('TestOutputStore', () => {
  it('keep moves the output under test-outputs and keeps it 2 hours by default', async () => {
    const src = await output('a');
    const row = await store().keep('a', src, 'mkv');
    const kept = join(dir, 'a.mkv');
    expect(exists(kept)).toBe(true);
    expect(exists(src)).toBe(false);
    expect(row).toEqual({
      jobId: 'a',
      fileName: 'a.mkv',
      container: 'mkv',
      sizeBytes: 600,
      createdAt: start.toISOString(),
      keptUntil: new Date(start.getTime() + 2 * HOUR).toISOString(),
    });
    expect(store().find('a')).toEqual(row);
    expect(note('a')).toBeNull();
    expect(logged).toContainEqual({
      msg: 'test output kept',
      job: 'a',
      keptUntil: row?.keptUntil,
    });
  });

  it('keep honours the setting', async () => {
    setSetting(db, 'engine.testEncodeKeepHours', 5, start);
    expect((await store().keep('a', await output('a'), 'mkv'))?.keptUntil).toBe(
      new Date(start.getTime() + 5 * HOUR).toISOString(),
    );

    setSetting(db, 'engine.testEncodeKeepHours', 0, start);
    const src = await output('b');
    expect(await store().keep('b', src, 'mp4')).toBeNull();
    expect(exists(src)).toBe(false);
    expect(exists(join(dir, 'b.mp4'))).toBe(false);
    expect(store().find('b')).toBeNull();
    expect(note('b')).toBe('not kept: test encodes are kept for 0 hours');

    // A value out of range reads as the default.
    setSetting(db, 'engine.testEncodeKeepHours', 500, start);
    expect((await store().keep('c', await output('c'), 'mkv'))?.keptUntil).toBe(
      new Date(start.getTime() + 2 * HOUR).toISOString(),
    );
  });

  it('keep deletes the output when scratch space would fall below the margin', async () => {
    free = () => 5 * GIB - 1;
    expect(await store().keep('a', await output('a'), 'mkv')).toBeNull();
    expect(exists(join(dir, 'a.mkv'))).toBe(false);
    expect(store().find('a')).toBeNull();
    expect(note('a')).toBe(TEST_OUTPUT_NOTES.scratchLow);
    expect(note('a')).toBe('not kept: scratch space low');

    minFreeGiB = 8;
    free = () => 7 * GIB;
    expect(await store().keep('b', await output('b'), 'mkv')).toBeNull();
    expect(exists(join(dir, 'b.mkv'))).toBe(false);
    expect(store().find('b')).toBeNull();
    expect(note('b')).toBe('not kept: scratch space low');
  });

  it('sweep removes expired outputs and strays and logs each', async () => {
    setSetting(db, 'engine.testEncodeKeepHours', 1, start);
    await store().keep('a', await output('a'), 'mkv');
    setSetting(db, 'engine.testEncodeKeepHours', 3, start);
    await store().keep('b', await output('b'), 'mkv');
    await store().keep('c', await output('c'), 'mp4');
    await writeFile(join(dir, 'x.mkv'), 'stray');
    await mkdir(join(dir, 'folder'));
    await symlink(join(dir, 'b.mkv'), join(dir, 'link.mkv'));
    await unlink(join(dir, 'c.mp4'));
    logged = [];

    now = new Date(start.getTime() + HOUR);
    const removed = await store().sweep();
    expect(removed).toBe(5);
    expect((await readdir(dir)).sort()).toEqual(['b.mkv']);
    expect(store().find('a')).toBeNull();
    expect(store().find('b')).not.toBeNull();
    expect(store().find('c')).toBeNull();
    expect(note('a')).toBe('expired');
    expect(note('c')).toBe('deleted: file missing');
    expect(note('b')).toBeNull();
    expect(logged).toContainEqual({ msg: 'test output deleted', job: 'a', why: 'expired' });
    expect(logged).toContainEqual({ msg: 'test output deleted', job: 'c', why: 'missing' });
    for (const name of ['x.mkv', 'folder', 'link.mkv']) {
      expect(logged).toContainEqual({ msg: 'stray test output removed', name });
    }
  });

  it('sweep removes a registered name that is not a regular file', async () => {
    await store().keep('a', await output('a'), 'mkv');
    await unlink(join(dir, 'a.mkv'));
    await writeFile(join(base, 'elsewhere'), 'x');
    await symlink(join(base, 'elsewhere'), join(dir, 'a.mkv'));
    expect(await store().sweep()).toBe(2);
    expect(await readdir(dir)).toEqual([]);
    expect(store().find('a')).toBeNull();
    expect(exists(join(base, 'elsewhere'))).toBe(true);
  });

  it('sweep without a test-output dir does nothing and never throws', async () => {
    expect(await store().sweep()).toBe(0);
    expect(exists(dir)).toBe(false);
    const broken = new TestOutputStore({
      db,
      fs: {
        ...fs,
        exists: async () => {
          throw new Error('EIO');
        },
      },
      config: { transcodeDir: tc, healthMinFreeGiB: 5 },
      now: () => now,
      log,
    });
    expect(await broken.sweep()).toBe(0);
    expect(logged).toContainEqual(
      expect.objectContaining({ msg: 'test output sweep failed', error: 'EIO' }),
    );
  });

  it('keep notes why when the output could not be kept', async () => {
    const src = await output('a');
    const failing = new TestOutputStore({
      db,
      fs: {
        ...fs,
        rename: async () => {
          throw new Error('EXDEV: cross-device link not permitted');
        },
      },
      config: { transcodeDir: tc, healthMinFreeGiB: 5 },
      now: () => now,
      log,
    });
    expect(await failing.keep('a', src, 'mkv')).toBeNull();
    expect(store().find('a')).toBeNull();
    expect(note('a')).toBe('not kept: EXDEV: cross-device link not permitted');
  });

  it('makeRoom evicts oldest first until the margin is met', async () => {
    for (const [i, id] of ['b', 'a', 'c'].entries()) {
      now = new Date(start.getTime() + i * 60_000);
      await store().keep(id, await output(id), 'mkv');
    }
    // Enough room once two outputs are gone.
    free = () => (nodeFs.readdirSync(dir).length <= 1 ? 6 * GIB : 4 * GIB);
    logged = [];
    expect(await store().makeRoom()).toBe(2);
    expect(store().find('b')).toBeNull();
    expect(store().find('a')).toBeNull();
    expect(store().find('c')).not.toBeNull();
    expect(await readdir(dir)).toEqual(['c.mkv']);
    expect(note('b')).toBe('deleted: scratch space was needed');
    expect(note('a')).toBe('deleted: scratch space was needed');
    expect(note('c')).toBeNull();
    expect(logged).toEqual([
      { msg: 'test output deleted', job: 'b', why: 'evicted' },
      { msg: 'test output deleted', job: 'a', why: 'evicted' },
    ]);
  });

  it('makeRoom with no kept outputs does not ask for free space', async () => {
    free = () => {
      throw new Error('statfs called');
    };
    expect(await store().makeRoom()).toBe(0);
  });

  it('remove deletes row and file and notes why; false without a row', async () => {
    await store().keep('a', await output('a'), 'mkv');
    expect(await store().remove('a', 'deleted')).toBe(true);
    expect(exists(join(dir, 'a.mkv'))).toBe(false);
    expect(store().find('a')).toBeNull();
    expect(note('a')).toBe('deleted');
    expect(await store().remove('a', 'deleted')).toBe(false);
  });

  it('open returns a readable fd of the kept file', async () => {
    await store().keep('a', await output('a', 1234), 'mkv');
    const opened = store().open('a');
    expect(opened).not.toBeNull();
    if (!opened) return;
    try {
      expect(opened.size).toBe(1234);
      expect(opened.row.jobId).toBe('a');
      expect(nodeFs.fstatSync(opened.fd).size).toBe(1234);
    } finally {
      nodeFs.closeSync(opened.fd);
    }
    expect(store().open('b')).toBeNull();
  });

  it('open after kept_until returns null and removes the output as expired', async () => {
    await store().keep('a', await output('a'), 'mkv');
    now = new Date(start.getTime() + 2 * HOUR - 1);
    const opened = store().open('a');
    expect(opened).not.toBeNull();
    if (opened) nodeFs.closeSync(opened.fd);

    now = new Date(start.getTime() + 2 * HOUR);
    logged = [];
    expect(store().open('a')).toBeNull();
    expect(store().find('a')).toBeNull();
    expect(note('a')).toBe('expired');
    expect(logged).toContainEqual({ msg: 'test output deleted', job: 'a', why: 'expired' });
    await vi.waitFor(() => expect(exists(join(dir, 'a.mkv'))).toBe(false));
  });

  it('open refuses a symlink at the kept path', async () => {
    await store().keep('a', await output('a'), 'mkv');
    await writeFile(join(base, 'target.mkv'), 'x');
    await unlink(join(dir, 'a.mkv'));
    await symlink(join(base, 'target.mkv'), join(dir, 'a.mkv'));
    expect(store().open('a')).toBeNull();

    await unlink(join(dir, 'a.mkv'));
    await mkdir(join(dir, 'a.mkv'));
    const close = vi.spyOn(nodeFs, 'closeSync');
    expect(store().open('a')).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
  });

  describe('previews', () => {
    const preview = (id: string) => join(dir, `${id}.preview.mp4`);
    const part = (id: string) => `${preview(id)}.part`;
    async function withPreview(id: string): Promise<void> {
      await writeFile(preview(id), 'mp4');
      await writeFile(part(id), 'partial');
    }

    it('remove deletes the preview and a leftover .part', async () => {
      await store().keep('a', await output('a'), 'mkv');
      await withPreview('a');
      expect(await store().remove('a', 'deleted')).toBe(true);
      expect(exists(preview('a'))).toBe(false);
      expect(exists(part('a'))).toBe(false);
    });

    it('expiring on open deletes the preview', async () => {
      await store().keep('a', await output('a'), 'mkv');
      await withPreview('a');
      now = new Date(start.getTime() + 2 * HOUR);
      expect(store().open('a')).toBeNull();
      await vi.waitFor(() => {
        expect(exists(preview('a'))).toBe(false);
        expect(exists(part('a'))).toBe(false);
      });
    });

    it('a new output for the same job deletes the earlier preview', async () => {
      await store().keep('a', await output('a'), 'mkv');
      await withPreview('a');
      expect(await store().keep('a', await output('a', 700), 'mkv')).not.toBeNull();
      expect(exists(preview('a'))).toBe(false);
      expect(exists(part('a'))).toBe(false);
      expect(exists(join(dir, 'a.mkv'))).toBe(true);
    });

    it('sweep keeps a registered preview and removes an orphan one and a stale .part', async () => {
      await store().keep('a', await output('a'), 'mkv');
      await writeFile(preview('a'), 'mp4');
      await writeFile(preview('z'), 'orphan');
      await writeFile(part('a'), 'stale');
      expect(await store().sweep()).toBe(2);
      expect((await readdir(dir)).sort()).toEqual(['a.mkv', 'a.preview.mp4']);
    });

    it('sweep leaves the .part of a build in flight', async () => {
      await store().keep('a', await output('a'), 'mkv');
      let finish: () => void = () => {};
      build.mockImplementationOnce(async ({ outPath, input }) => {
        await writeFile(outPath, 'partial');
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        input.destroy();
        await writeFile(outPath, 'mp4');
      });
      const s = store();
      const opened = s.open('a');
      if (!opened) throw new Error('not opened');
      const pending = s.preview('a', opened, { ffmpegPath: 'ffmpeg', plan: null });
      await vi.waitFor(() => expect(exists(part('a'))).toBe(true));
      expect(await s.sweep()).toBe(0);
      expect(exists(part('a'))).toBe(true);
      finish();
      const result = await pending;
      expect(result.kind).toBe('ready');
      if (result.kind === 'ready') nodeFs.closeSync(result.fd);
      expect((await readdir(dir)).sort()).toEqual(['a.mkv', 'a.preview.mp4']);
    });

    it('a preview finished after its output expired is deleted', async () => {
      await store().keep('a', await output('a'), 'mkv');
      let finish: () => void = () => {};
      build.mockImplementationOnce(async ({ outPath, input }) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        input.destroy();
        await writeFile(outPath, 'mp4');
      });
      const s = store();
      const opened = s.open('a');
      if (!opened) throw new Error('not opened');
      const pending = s.preview('a', opened, { ffmpegPath: 'ffmpeg', plan: null });
      await vi.waitFor(() => expect(build).toHaveBeenCalled());
      now = new Date(start.getTime() + 2 * HOUR);
      finish();
      expect((await pending).kind).toBe('missing');
      expect(exists(preview('a'))).toBe(false);
      expect(exists(part('a'))).toBe(false);
    });

    it('sweep deletes the preview of a row whose file is gone', async () => {
      await store().keep('a', await output('a'), 'mkv');
      await writeFile(preview('a'), 'mp4');
      await unlink(join(dir, 'a.mkv'));
      await store().sweep();
      expect(store().find('a')).toBeNull();
      expect(await readdir(dir)).toEqual([]);
    });

    it('previewState says where the preview stands without building it', async () => {
      await store().keep('a', await output('a'), 'mkv');
      const s = store();
      expect(await s.previewState('a', 600)).toBe('none');
      free = () => 5 * GIB + 599;
      expect(await s.previewState('a', 600)).toBe('scratchLow');
      free = () => 100 * GIB;
      await writeFile(preview('a'), 'mp4');
      expect(await s.previewState('a', 600)).toBe('ready');
      expect(build).not.toHaveBeenCalled();
    });

    it('a preview finished after its output was removed is deleted', async () => {
      await store().keep('a', await output('a'), 'mkv');
      let finish: () => void = () => {};
      build.mockImplementationOnce(async ({ outPath, input }) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        input.destroy();
        await writeFile(outPath, 'mp4');
      });
      const s = store();
      const opened = s.open('a');
      if (!opened) throw new Error('not opened');
      const pending = s.preview('a', opened, { ffmpegPath: 'ffmpeg', plan: null });
      await vi.waitFor(() => expect(build).toHaveBeenCalled());
      await s.remove('a', 'deleted');
      finish();
      expect((await pending).kind).toBe('missing');
      expect(await readdir(dir)).toEqual([]);
    });
  });
});
