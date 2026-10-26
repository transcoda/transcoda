import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/open.ts';
import { insertJob, insertRecycled, listRecycled, updateJob } from '../db/repos/jobs.ts';
import { insertLibrary } from '../db/repos/libraries.ts';
import { insertRun } from '../db/repos/runs.ts';
import { insertWorkflow } from '../db/repos/workflows.ts';
import { createTestDb } from '../db/test-db.ts';
import type { Logger } from '../logger.ts';
import { tempDir } from './fixtures.ts';
import { type FsOps, nodeFsOps } from './fs-ops.ts';
import { defaultRecycleFolder, pruneRecycle } from './recycle.ts';

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
