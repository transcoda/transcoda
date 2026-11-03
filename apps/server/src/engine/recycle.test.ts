import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { emptyGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/open.ts';
import {
  insertJob,
  insertRecycled,
  listRecycled,
  type RecycledRow,
  recycledTotalsByLibrary,
  updateJob,
} from '../db/repos/jobs.ts';
import { insertLibrary, type LibraryRow } from '../db/repos/libraries.ts';
import { insertRun } from '../db/repos/runs.ts';
import { insertWorkflow } from '../db/repos/workflows.ts';
import { createTestDb } from '../db/test-db.ts';
import type { Logger } from '../logger.ts';
import { tempDir } from './fixtures.ts';
import { type FsOps, nodeFsOps } from './fs-ops.ts';
import {
  defaultRecycleFolder,
  deleteRecycledEntry,
  emptyRecycle,
  pruneRecycle,
  recycleView,
  removeRecycledRow,
} from './recycle.ts';

const now = new Date('2026-03-10T12:00:00.000Z');
const daysAgo = (d: number): string => new Date(now.getTime() - d * 86_400_000).toISOString();
const log: Logger = { info: () => {}, warn: () => {}, error: () => {} };

let root: string;
let bin: string;
let db: Database;

beforeEach(async () => {
  root = await tempDir('recycle-');
  bin = defaultRecycleFolder(root);
  await mkdir(bin, { recursive: true });
  db = createTestDb();
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

async function recycled(name: string, size: number, at: string, onDisk = true): Promise<string> {
  const path = join(bin, name);
  if (onDisk) await writeFile(path, Buffer.alloc(size));
  insertRecycled(db, { path, libraryId: 'l1', jobId: name, sizeBytes: size, recycledAt: at });
  return path;
}

const roomy: FsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 2 ** 40, bsize: 1 }) };

describe('pruneRecycle', () => {
  it('defaultRecycleFolder is .transcoda-recycle in the library root', () => {
    expect(defaultRecycleFolder('/media/tv')).toBe('/media/tv/.transcoda-recycle');
  });

  it('retention removes an 8-day-old row and file', async () => {
    const old = await recycled('old.mkv', 100, daysAgo(8));
    const fresh = await recycled('fresh.mkv', 100, daysAgo(1));
    const r = await pruneRecycle(db, roomy, { retentionDays: 7, maxFreePercent: 25, now, log });
    expect(r).toEqual({ removed: 1, bytes: 100 });
    expect(await nodeFsOps.exists(old)).toBe(false);
    expect(await nodeFsOps.exists(fresh)).toBe(true);
    expect(listRecycled(db).map((x) => x.path)).toEqual([fresh]);
  });

  it('cap removes oldest until under 25%', async () => {
    // Inserted out of age order, with names that do not sort by age: only `recycled_at` decides.
    const c = await recycled('a-newest.mkv', 100, daysAgo(1));
    const b = await recycled('c-middle.mkv', 100, daysAgo(2));
    const a = await recycled('b-oldest.mkv', 100, daysAgo(3));
    // 600 free + 300 recycled: 33 % > 25 %; after removing a: 200 of 900 = 22 %.
    const fs: FsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 600, bsize: 1 }) };
    const r = await pruneRecycle(db, fs, { retentionDays: 7, maxFreePercent: 25, now, log });
    expect(r).toEqual({ removed: 1, bytes: 100 });
    expect(await nodeFsOps.exists(a)).toBe(false);
    expect(await nodeFsOps.exists(b)).toBe(true);
    expect(await nodeFsOps.exists(c)).toBe(true);
    expect(listRecycled(db).map((x) => x.path)).toEqual([b, c]);
  });

  it('missing file drops the row', async () => {
    await recycled('gone.mkv', 100, daysAgo(9), false);
    const r = await pruneRecycle(db, roomy, { retentionDays: 7, maxFreePercent: 25, now, log });
    expect(r).toEqual({ removed: 1, bytes: 0 });
    expect(listRecycled(db)).toEqual([]);
  });

  it('a file that cannot be removed keeps its row', async () => {
    const old = await recycled('stuck.mkv', 100, daysAgo(9));
    const fs: FsOps = {
      ...roomy,
      unlink: async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    };
    const r = await pruneRecycle(db, fs, { retentionDays: 7, maxFreePercent: 25, now, log });
    expect(r).toEqual({ removed: 0, bytes: 0 });
    expect(listRecycled(db).map((x) => x.path)).toEqual([old]);
  });

  /** A job whose replace is in flight (or awaiting the sweep): it has a replace journal. */
  function inFlight(jobId: string, journaled = true): void {
    const now0 = new Date(daysAgo(30));
    if (db.prepare("SELECT 1 FROM workflows WHERE id = 'w1'").get() === undefined) {
      insertWorkflow(
        db,
        { id: 'w1', kind: 'workflow', name: 'W', graph: emptyGraph('workflow'), createdBy: 'u' },
        now0,
      );
      insertLibrary(
        db,
        {
          id: 'l1',
          name: 'TV',
          path: root,
          recycleFolder: null,
          processHardlinked: false,
        },
        now0,
      );
      insertRun(
        db,
        {
          id: 'r1',
          libraryId: 'l1',
          workflowId: 'w1',
          workflowVersion: 1,
          requestedPath: root,
          dryRun: false,
          testEncode: false,
          force: false,
          createdBy: 'u',
        },
        now0,
      );
    }
    insertJob(
      db,
      {
        id: jobId,
        runId: 'r1',
        libraryId: 'l1',
        fileId: null,
        path: join(root, jobId),
        workflowId: 'w1',
        workflowVersion: 1,
        dryRun: false,
        testEncode: false,
        state: 'replacing',
        priority: 0,
      },
      now0,
    );
    if (journaled) setJournal(jobId);
  }
  function setJournal(jobId: string): void {
    updateJob(
      db,
      jobId,
      {
        replaceJournal: {
          step: 'installing_tmp',
          originalPath: join(root, jobId),
          tmpPath: join(root, `.transcoda-${jobId}.tmp`),
          outputPath: '/transcode/out.mkv',
          copyPath: join(bin, `${jobId}`),
          libraryRoot: root,
          recycling: true,
          fingerprint: { sizeBytes: 100, mtimeMs: 1, ino: 1, dev: 1, nlink: 1 },
          outputBytes: 50,
        },
      },
      now,
    );
  }

  it('a row whose job has a restore journal is never pruned', async () => {
    inFlight('restoring.mkv', false);
    updateJob(
      db,
      'restoring.mkv',
      {
        restoreJournal: {
          direction: 'restore',
          restoreId: 's1',
          libraryRoot: root,
          moves: [{ from: join(root, 'restoring.mkv'), to: join(bin, 'x'), role: 'output' }],
          next: 0,
        },
      },
      now,
    );
    const kept = await recycled('restoring.mkv', 500, daysAgo(30));
    const r = await pruneRecycle(db, roomy, { retentionDays: 7, maxFreePercent: 25, now, log });
    expect(r).toEqual({ removed: 0, bytes: 0 });
    expect(listRecycled(db).map((x) => x.path)).toEqual([kept]);
  });

  it('never removes the recycled original of a job whose replace is in flight (retention or cap)', async () => {
    inFlight('old-inflight.mkv');
    const kept = await recycled('old-inflight.mkv', 500, daysAgo(30));
    inFlight('done.mkv', false);
    const done = await recycled('done.mkv', 100, daysAgo(30));
    // Way over the cap too: 600 recycled vs 10 free.
    const fs: FsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 10, bsize: 1 }) };
    const r = await pruneRecycle(db, fs, { retentionDays: 7, maxFreePercent: 25, now, log });
    expect(r).toEqual({ removed: 1, bytes: 100 });
    expect(await nodeFsOps.exists(kept)).toBe(true);
    expect(await nodeFsOps.exists(done)).toBe(false);
    expect(listRecycled(db).map((x) => x.path)).toEqual([kept]);
  });

  it('re-checks right before each unlink: a replace that starts meanwhile keeps its original', async () => {
    inFlight('first.mkv', false);
    inFlight('second.mkv', false);
    const first = await recycled('first.mkv', 100, daysAgo(20));
    const second = await recycled('second.mkv', 100, daysAgo(10));
    const fs: FsOps = {
      ...roomy,
      unlink: async (p) => {
        // While the first is removed, the second's job starts a replace (journal written).
        if (p === first) setJournal('second.mkv');
        await roomy.unlink(p);
      },
    };
    const r = await pruneRecycle(db, fs, { retentionDays: 7, maxFreePercent: 25, now, log });
    expect(r).toEqual({ removed: 1, bytes: 100 });
    expect(await nodeFsOps.exists(second)).toBe(true);
    expect(listRecycled(db).map((x) => x.path)).toEqual([second]);
  });
});

describe('the recycle folder page (engine)', () => {
  const t0 = new Date(daysAgo(30));
  let other: string;
  let lib: LibraryRow;

  beforeEach(async () => {
    other = join(root, 'other-lib');
    await mkdir(join(bin, 'Show'), { recursive: true });
    await mkdir(join(other, '.transcoda-recycle'), { recursive: true });
    insertWorkflow(
      db,
      { id: 'w1', kind: 'workflow', name: 'W', graph: emptyGraph('workflow'), createdBy: 'u' },
      t0,
    );
    lib = insertLibrary(
      db,
      { id: 'l1', name: 'TV', path: root, recycleFolder: null, processHardlinked: false },
      t0,
    );
    insertLibrary(
      db,
      { id: 'l2', name: 'Films', path: other, recycleFolder: null, processHardlinked: false },
      t0,
    );
    for (const [run, library, path] of [
      ['r1', 'l1', root],
      ['r2', 'l2', other],
    ] as const) {
      insertRun(
        db,
        {
          id: run,
          libraryId: library,
          workflowId: 'w1',
          workflowVersion: 1,
          requestedPath: path,
          dryRun: false,
          testEncode: false,
          force: false,
          createdBy: 'u',
        },
        t0,
      );
    }
  });

  function jobAt(id: string, runId: 'r1' | 'r2', libraryId: 'l1' | 'l2', path: string): void {
    insertJob(
      db,
      {
        id,
        runId,
        libraryId,
        fileId: null,
        path,
        workflowId: 'w1',
        workflowVersion: 1,
        dryRun: false,
        testEncode: false,
        state: 'done',
        priority: 0,
      },
      t0,
    );
  }

  async function entry(
    id: string,
    size: number,
    at: string,
    opts: { library?: 'l1' | 'l2'; rel?: string } = {},
  ): Promise<string> {
    const library = opts.library ?? 'l1';
    const libRoot = library === 'l1' ? root : other;
    const folder = defaultRecycleFolder(libRoot);
    const rel = opts.rel ?? `${id}.mkv`;
    const path = join(folder, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.alloc(size));
    jobAt(id, library === 'l1' ? 'r1' : 'r2', library, join(libRoot, rel));
    insertRecycled(db, {
      path,
      libraryId: library,
      jobId: id,
      sizeBytes: size,
      recycledAt: at,
      kind: 'original',
      originalPath: join(libRoot, rel),
    });
    return path;
  }

  function journal(jobId: string): void {
    updateJob(
      db,
      jobId,
      {
        restoreJournal: {
          direction: 'restore',
          restoreId: 's1',
          libraryRoot: root,
          moves: [],
          next: 0,
        },
      },
      now,
    );
  }

  it('pruneRecycle still removes through removeRecycledRow and leaves journaled rows', async () => {
    const old = await entry('old', 100, daysAgo(9));
    const busy = await entry('busy', 100, daysAgo(9));
    journal('busy');
    const r = await pruneRecycle(db, roomy, { retentionDays: 7, maxFreePercent: 25, now, log });
    expect(r).toEqual({ removed: 1, bytes: 100 });
    expect(await nodeFsOps.exists(old)).toBe(false);
    expect(listRecycled(db).map((x) => x.path)).toEqual([busy]);
  });

  it('removeRecycledRow: bytes freed, 0 when already gone, null while journaled', async () => {
    const a = await entry('a', 100, daysAgo(1));
    const b = await entry('b', 100, daysAgo(1));
    const c = await entry('c', 100, daysAgo(1));
    await rm(b);
    journal('c');
    const row = (p: string) => listRecycled(db).find((x) => x.path === p) as RecycledRow;
    expect(await removeRecycledRow(db, nodeFsOps, row(a), log)).toBe(100);
    expect(await removeRecycledRow(db, nodeFsOps, row(b), log)).toBe(0);
    expect(await removeRecycledRow(db, nodeFsOps, row(c), log)).toBeNull();
    expect(listRecycled(db).map((x) => x.path)).toEqual([c]);
  });

  it("recycleView lists a library's entries with their place in the library and their deletion date", async () => {
    await entry('a', 300, daysAgo(1), { rel: 'Show/a.mkv' });
    await entry('f', 999, daysAgo(1), { library: 'l2' });
    const v = await recycleView(db, roomy, lib, { retentionDays: 7 });
    expect(v).toMatchObject({ libraryId: 'l1', folder: bin, totalBytes: 300, freeBytes: 2 ** 40 });
    expect(v.entries).toHaveLength(1);
    expect(v.entries[0]).toMatchObject({
      path: join(bin, 'Show', 'a.mkv'),
      relativePath: 'Show/a.mkv',
      kind: 'original',
      deletesAt: '2026-03-16T12:00:00.000Z',
    });
  });

  it('recycleView: a relative recycle folder resolves against the root; free space falls back to the root, then null', async () => {
    const custom = { ...lib, recycleFolder: 'bin' };
    const failing: FsOps = {
      ...nodeFsOps,
      statfs: async (p) => {
        if (p === join(root, 'bin')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        return { bavail: 7, bsize: 2 };
      },
    };
    expect(await recycleView(db, failing, custom, { retentionDays: 7 })).toMatchObject({
      folder: join(root, 'bin'),
      freeBytes: 14,
      entries: [],
    });
    const none: FsOps = {
      ...nodeFsOps,
      statfs: async () => {
        throw new Error('no');
      },
    };
    expect((await recycleView(db, none, lib, { retentionDays: 7 })).freeBytes).toBeNull();
  });

  it('recycledTotalsByLibrary sums each library', async () => {
    await entry('a', 100, daysAgo(1));
    await entry('b', 50, daysAgo(1));
    await entry('f', 999, daysAgo(1), { library: 'l2' });
    expect(recycledTotalsByLibrary(db)).toEqual([
      { libraryId: 'l1', files: 2, bytes: 150 },
      { libraryId: 'l2', files: 1, bytes: 999 },
    ]);
  });

  it('deleteRecycledEntry unlinks and drops the row; refuses while the job has a journal', async () => {
    const a = await entry('a', 100, daysAgo(1));
    expect(await deleteRecycledEntry(db, nodeFsOps, a, log)).toEqual({
      kind: 'deleted',
      bytes: 100,
    });
    expect(await nodeFsOps.exists(a)).toBe(false);
    expect(await deleteRecycledEntry(db, nodeFsOps, a, log)).toEqual({ kind: 'not-found' });
    const b = await entry('b', 100, daysAgo(1));
    journal('b');
    expect(await deleteRecycledEntry(db, nodeFsOps, b, log)).toEqual({
      kind: 'refused',
      reason: "A replace or restore of this file's job is in progress; try again in a moment.",
    });
    expect(await nodeFsOps.exists(b)).toBe(true);
  });

  it('emptyRecycle removes every entry of the library, skips in-flight ones and says how many', async () => {
    await entry('a', 100, daysAgo(2));
    await entry('b', 100, daysAgo(1));
    await entry('c', 300, daysAgo(1));
    journal('c');
    const f = await entry('f', 999, daysAgo(1), { library: 'l2' });
    expect(await emptyRecycle(db, roomy, 'l1', daysAgo(0), log)).toEqual({
      removed: 2,
      bytes: 200,
      skipped: 1,
    });
    expect(listRecycled(db).map((x) => x.jobId)).toEqual(['c', 'f']);
    expect(await nodeFsOps.exists(f)).toBe(true);
  });

  it('an unreachable recycle folder (share not mounted) keeps every row: Delete refuses, Empty skips, prune keeps', async () => {
    const a = await entry('a', 100, daysAgo(30));
    await rm(bin, { recursive: true, force: true });
    expect(await deleteRecycledEntry(db, nodeFsOps, a, log)).toEqual({
      kind: 'refused',
      reason: "The library's folder can't be reached (is the share mounted?).",
    });
    expect(await emptyRecycle(db, roomy, 'l1', daysAgo(0), log)).toEqual({
      removed: 0,
      bytes: 0,
      skipped: 1,
    });
    await pruneRecycle(db, roomy, { retentionDays: 7, maxFreePercent: 25, now, log });
    expect(listRecycled(db).map((x) => x.path)).toEqual([a]);
  });

  // Review Focus 5
  it('empty removes only rows recycled at or before the confirmed time', async () => {
    const older = await entry('older', 100, daysAgo(2));
    const newer = await entry('newer', 100, daysAgo(1));
    expect(await emptyRecycle(db, roomy, 'l1', daysAgo(2), log)).toEqual({
      removed: 1,
      bytes: 100,
      skipped: 0,
    });
    expect(await nodeFsOps.exists(older)).toBe(false);
    expect(listRecycled(db).map((x) => x.path)).toEqual([newer]);
  });
});
