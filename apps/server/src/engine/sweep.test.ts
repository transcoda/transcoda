import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { emptyGraph, type JobState, RUNNING_JOB_STATES } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/open.ts';
import {
  deleteRecycled,
  findJob,
  insertJob,
  insertRecycled,
  type JobRow,
  listRecycled,
  type ReplaceJournal,
  updateJob,
} from '../db/repos/jobs.ts';
import { insertLibrary } from '../db/repos/libraries.ts';
import { insertRun } from '../db/repos/runs.ts';
import { insertWorkflow } from '../db/repos/workflows.ts';
import { createTestDb } from '../db/test-db.ts';
import type { Logger } from '../logger.ts';
import { fingerprintOf } from './fingerprint.ts';
import { tempDir, toolPaths } from './fixtures.ts';
import { type FsOps, failingAt, nodeFsOps } from './fs-ops.ts';
import { origPathFor, recyclePathFor, tmpPathFor } from './replace.ts';
import { killStaleFfmpeg, requeueOnce, type SweepDeps, startupSweep } from './sweep.ts';

const now = new Date('2026-03-01T12:00:00.000Z');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const ORIG = randomBytes(32 * 1024);
const NEW = randomBytes(12 * 1024);

let root: string;
let lib: string;
let tc: string;
let db: Database;
let logged: unknown[];
let log: Logger;

async function setup(): Promise<void> {
  root = await tempDir('sweep-');
  lib = join(root, 'lib');
  tc = join(root, 'transcode');
  await mkdir(join(lib, 'Show'), { recursive: true });
  await mkdir(tc, { recursive: true });
  db = createTestDb();
  insertWorkflow(
    db,
    { id: 'w1', kind: 'workflow', name: 'Shrink', graph: emptyGraph('workflow'), createdBy: 'u' },
    now,
  );
  insertLibrary(
    db,
    {
      id: 'l1',
      name: 'TV',
      path: lib,
      recycleFolder: null,
      processHardlinked: false,
    },
    now,
  );
  insertRun(
    db,
    {
      id: 'r1',
      libraryId: 'l1',
      workflowId: 'w1',
      workflowVersion: 1,
      requestedPath: lib,
      dryRun: false,
      testEncode: false,
      force: false,
      createdBy: 'u',
    },
    now,
  );
  logged = [];
  log = { info: () => {}, warn: (e) => logged.push(e), error: (e) => logged.push(e) };
}

beforeEach(setup);
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

function job(id: string, state: JobState, path = join(lib, 'Show', `${id}.mkv`)): JobRow {
  return insertJob(
    db,
    {
      id,
      runId: 'r1',
      libraryId: 'l1',
      fileId: null,
      path,
      workflowId: 'w1',
      workflowVersion: 1,
      dryRun: false,
      testEncode: false,
      state,
      priority: 0,
    },
    now,
  );
}

function sweepDeps(extra: Partial<SweepDeps> = {}): SweepDeps {
  return {
    fs: nodeFsOps,
    transcodeDir: tc,
    libraryRoots: [lib],
    now: () => now,
    log,
    killStaleGroup: async () => {},
    ...extra,
  };
}

describe('requeueOnce', () => {
  it('first call → queued with requeues 1 and attempt unchanged; second call → failed', () => {
    const j = job('a', 'encoding');
    updateJob(
      db,
      'a',
      {
        attempt: 2,
        lane: 'encode',
        progress: {
          percent: 50,
          outTimeSeconds: 1,
          speed: 1,
          fps: 1,
          sizeBytes: 1,
          etaSeconds: 1,
        },
      },
      now,
    );
    const first = requeueOnce(db, { ...j, attempt: 2 }, 'interrupted', now);
    expect(first).toMatchObject({
      state: 'queued',
      requeues: 1,
      attempt: 2,
      reason: 'interrupted',
      lane: null,
      progress: null,
      finishedAt: null,
    });
    const second = requeueOnce(db, first, 'file changed during processing', now);
    expect(second).toMatchObject({
      state: 'failed',
      requeues: 1,
      reason: 'file changed during processing',
    });
    expect(second.finishedAt).not.toBeNull();
  });

  it('clears paused, and refuses while the job has a replace journal', () => {
    const j = job('a', 'encoding');
    updateJob(db, 'a', { paused: true }, now);
    expect(requeueOnce(db, j, 'interrupted', now)).toMatchObject({
      state: 'queued',
      paused: false,
    });
    const k = job('b', 'replacing');
    const journal = { step: 'moving_original' } as unknown as ReplaceJournal;
    updateJob(db, 'b', { replaceJournal: journal }, now);
    expect(() => requeueOnce(db, k, 'file changed during processing', now)).toThrow(
      /replace in flight/,
    );
    expect(findJob(db, 'b')?.state).toBe('replacing');
  });
});

describe('startupSweep without journals', () => {
  it('a job in encoding goes back to queued (interrupted) and its temp dir is removed; a second sweep fails it', async () => {
    job('enc', 'encoding');
    await mkdir(join(tc, 'enc'));
    await writeFile(join(tc, 'enc', 'out.mkv'), 'partial');
    const first = await startupSweep(db, sweepDeps());
    expect(first).toEqual({
      completed: [],
      rolledBack: [],
      interrupted: ['enc'],
      cleared: [],
      conflicts: [],
      tempRemoved: 1,
    });
    expect(findJob(db, 'enc')).toMatchObject({
      state: 'queued',
      reason: 'interrupted',
      requeues: 1,
    });
    expect(await readdir(tc)).toEqual([]);

    updateJob(db, 'enc', { state: 'encoding' }, now);
    const second = await startupSweep(db, sweepDeps());
    expect(second.interrupted).toEqual(['enc']);
    expect(findJob(db, 'enc')).toMatchObject({
      state: 'failed',
      reason: 'interrupted',
      requeues: 1,
    });
  });

  it('kills a leftover ffmpeg group before touching temp', async () => {
    job('enc', 'encoding');
    await mkdir(join(tc, 'enc'));
    await writeFile(join(tc, 'enc', 'ffmpeg.pid'), '4242\n');
    const seen: { pidFile: string; tempStillThere: boolean; state: JobState | undefined }[] = [];
    await startupSweep(
      db,
      sweepDeps({
        killStaleGroup: async (pidFile) => {
          seen.push({
            pidFile,
            tempStillThere: await nodeFsOps.exists(pidFile),
            state: findJob(db, 'enc')?.state,
          });
        },
      }),
    );
    expect(seen).toEqual([
      { pidFile: join(tc, 'enc', 'ffmpeg.pid'), tempStillThere: true, state: 'encoding' },
    ]);
    expect(await readdir(tc)).toEqual([]);
  });

  it('removes everything under the transcode dir and stray library tmps, never anything else', async () => {
    const outside = join(root, 'next-to-transcode.txt');
    await writeFile(outside, 'keep');
    await mkdir(join(tc, 'old-job', 'sub'), { recursive: true });
    await writeFile(join(tc, 'old-job', 'sub', 'x'), 'x');
    await writeFile(join(tc, 'loose-file'), 'x');
    const userMkv = join(lib, 'Show', 'user.mkv');
    const userOrig = join(lib, 'Show', 'user.mkv.transcoda-gone.orig');
    const userTmpLookalike = join(lib, 'Show', 'transcoda-gone.tmp');
    const stray = join(lib, 'Show', '.transcoda-gone.tmp');
    for (const p of [userMkv, userOrig, userTmpLookalike, stray]) await writeFile(p, 'x');
    const result = await startupSweep(db, sweepDeps());
    expect(result.tempRemoved).toBe(3);
    expect(await readdir(tc)).toEqual([]);
    expect(await readFile(outside, 'utf8')).toBe('keep');
    expect((await readdir(join(lib, 'Show'))).sort()).toEqual(
      ['transcoda-gone.tmp', 'user.mkv', 'user.mkv.transcoda-gone.orig'].sort(),
    );
  });

  it('the startup sweep keeps test-outputs and removes job temp dirs', async () => {
    const jobDir = join(tc, '0b9a7c1e-4b9e-4c41-9d55-1f4c2f0a7e11');
    await mkdir(join(tc, 'test-outputs'), { recursive: true });
    await writeFile(join(tc, 'test-outputs', 'a.mkv'), 'kept');
    await mkdir(jobDir);
    await writeFile(join(jobDir, 'out.mkv'), 'partial');
    const pidFiles: string[] = [];
    const result = await startupSweep(
      db,
      sweepDeps({
        killStaleGroup: async (pidFile) => {
          pidFiles.push(pidFile);
        },
      }),
    );
    expect(result.tempRemoved).toBe(1);
    expect(await readdir(tc)).toEqual(['test-outputs']);
    expect(await readdir(join(tc, 'test-outputs'))).toEqual(['a.mkv']);
    expect(pidFiles).toEqual([join(jobDir, 'ffmpeg.pid')]);
  });

  it('a missing transcode dir or library root is not an error; a missing root is not walked', async () => {
    const result = await startupSweep(
      db,
      sweepDeps({ transcodeDir: join(root, 'nope'), libraryRoots: [join(root, 'gone')] }),
    );
    expect(result.tempRemoved).toBe(0);
    expect(logged).toEqual([
      expect.objectContaining({
        msg: 'library root unavailable; its stray tmp files are left for the next start',
        path: join(root, 'gone'),
      }),
    ]);
  });

  it('loads only the jobs with a journal, never every job ever written', async () => {
    const sqls: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      sqls.push(sql);
      return prepare(sql);
    }) as typeof db.prepare;
    await startupSweep(db, sweepDeps());
    expect(sqls).toContainEqual(expect.stringContaining('replace_journal IS NOT NULL'));
    for (const sql of sqls.filter((q) => q.includes('state IN ('))) {
      expect(sql.match(/\?/g)?.length).toBe(RUNNING_JOB_STATES.length);
    }
  });
});

// ---- the sweep table ----

interface Layout {
  O: boolean;
  T: boolean;
  C: boolean;
  recycling?: boolean;
  step?: ReplaceJournal['step'];
}

/** A `replacing` job whose journal names files laid out by hand. */
async function layout(id: string, l: Layout) {
  const originalPath = join(lib, 'Show', `${id}.mkv`);
  const recycling = l.recycling ?? true;
  const copyPath = recycling
    ? recyclePathFor(join(lib, '.transcoda-recycle'), lib, originalPath)
    : origPathFor(originalPath, id);
  const tmpPath = tmpPathFor(originalPath, id);
  // The journal's fingerprint is the original's identity: at O when it is there, else at C.
  await mkdir(dirname(copyPath), { recursive: true });
  if (l.O) await writeFile(originalPath, ORIG);
  if (l.C) await writeFile(copyPath, ORIG);
  const fingerprint = l.O
    ? await fingerprintOf(originalPath)
    : l.C
      ? await fingerprintOf(copyPath)
      : { sizeBytes: ORIG.length, mtimeMs: 1, ino: 1, dev: 1, nlink: 1 };
  if (l.T) await writeFile(tmpPath, NEW);
  if (l.C && recycling) {
    insertRecycled(db, {
      path: copyPath,
      libraryId: 'l1',
      jobId: id,
      sizeBytes: ORIG.length,
      recycledAt: now.toISOString(),
    });
  }
  const j: ReplaceJournal = {
    step: l.step ?? 'installing_tmp',
    originalPath,
    tmpPath,
    outputPath: join(tc, id, 'out.mkv'),
    copyPath,
    libraryRoot: lib,
    recycling,
    fingerprint,
    outputBytes: NEW.length,
  };
  job(id, 'replacing', originalPath);
  updateJob(db, id, { replaceJournal: j }, now);
  return { originalPath, copyPath, tmpPath, j };
}

describe('startupSweep: the replace journal, decided from the disk', () => {
  it('O yes, C no → tmp removed, requeued once as interrupted', async () => {
    const p = await layout('a', { O: true, T: true, C: false, step: 'moving_original' });
    const r = await startupSweep(db, sweepDeps());
    expect(r.interrupted).toEqual(['a']);
    expect(findJob(db, 'a')).toMatchObject({
      state: 'queued',
      reason: 'interrupted',
      requeues: 1,
      replaceJournal: null,
    });
    expect(await nodeFsOps.exists(p.tmpPath)).toBe(false);
    expect(sha(await readFile(p.originalPath))).toBe(sha(ORIG));
  });

  it('O yes, C yes (copy pre-existed) → both left, failed "replace left two copies"', async () => {
    const p = await layout('b', { O: true, T: false, C: true, step: 'checking' });
    const r = await startupSweep(db, sweepDeps());
    expect(r.conflicts).toEqual(['b']);
    expect(findJob(db, 'b')).toMatchObject({
      state: 'failed',
      reason: `replace left two copies: ${p.originalPath}, ${p.copyPath}`,
      replaceJournal: null,
    });
    expect(sha(await readFile(p.originalPath))).toBe(sha(ORIG));
    expect(sha(await readFile(p.copyPath))).toBe(sha(ORIG));
  });

  it('O no, T yes, C yes → tmp installed, journal cleaning, state stays replacing', async () => {
    const p = await layout('c', { O: false, T: true, C: true });
    const r = await startupSweep(db, sweepDeps());
    expect(r.completed).toEqual(['c']);
    expect(findJob(db, 'c')).toMatchObject({
      state: 'replacing',
      replaceJournal: { ...p.j, step: 'cleaning' },
    });
    expect(sha(await readFile(p.originalPath))).toBe(sha(NEW));
    expect(sha(await readFile(p.copyPath))).toBe(sha(ORIG));
    expect(await nodeFsOps.exists(p.tmpPath)).toBe(false);
    expect(listRecycled(db).map((x) => x.path)).toEqual([p.copyPath]);
  });

  it("O no, T yes, C yes with a stale row of an earlier job at the copy path → the row becomes this job's, logged (C5)", async () => {
    const p = await layout('c2', { O: false, T: true, C: true });
    deleteRecycled(db, p.copyPath);
    insertRecycled(db, {
      path: p.copyPath,
      libraryId: 'l1',
      jobId: 'earlier-job',
      sizeBytes: 7,
      recycledAt: now.toISOString(),
    });
    const r = await startupSweep(db, sweepDeps());
    expect(r.completed).toEqual(['c2']);
    expect(listRecycled(db)).toEqual([
      expect.objectContaining({ path: p.copyPath, jobId: 'c2', sizeBytes: ORIG.length }),
    ]);
    expect(logged).toContainEqual(
      expect.objectContaining({
        msg: 'replaced a stale recycle row; its original had left the recycle folder',
        staleJob: 'earlier-job',
      }),
    );
  });

  it('O no, T no, C yes → original restored, recycle row dropped, failed (not requeued)', async () => {
    const p = await layout('d', { O: false, T: false, C: true });
    const r = await startupSweep(db, sweepDeps());
    expect(r.rolledBack).toEqual(['d']);
    expect(findJob(db, 'd')).toMatchObject({
      state: 'failed',
      reason: 'interrupted; original restored',
      requeues: 0,
      replaceJournal: null,
    });
    expect(sha(await readFile(p.originalPath))).toBe(sha(ORIG));
    expect(await nodeFsOps.exists(p.copyPath)).toBe(false);
    expect(listRecycled(db)).toEqual([]);
  });

  it('O no, T yes, C no → tmp left, failed "original missing"', async () => {
    const p = await layout('e', { O: false, T: true, C: false });
    const r = await startupSweep(db, sweepDeps());
    expect(r.conflicts).toEqual(['e']);
    expect(findJob(db, 'e')).toMatchObject({
      state: 'failed',
      reason: 'original missing',
      replaceJournal: null,
    });
    expect(await readFile(p.tmpPath)).toEqual(NEW);
  });

  it('O no, T no, C no → failed "original missing"', async () => {
    await layout('f', { O: false, T: false, C: false });
    const r = await startupSweep(db, sweepDeps());
    expect(r.conflicts).toEqual(['f']);
    expect(findJob(db, 'f')).toMatchObject({ state: 'failed', reason: 'original missing' });
  });

  it('O = the replacement and C = the original (crash before the cleaning intent) → completed', async () => {
    const p = await layout('g', { O: false, T: true, C: true, step: 'installing_tmp' });
    await rename(p.tmpPath, p.originalPath);
    const r = await startupSweep(db, sweepDeps());
    expect(r.completed).toEqual(['g']);
    expect(findJob(db, 'g')).toMatchObject({
      state: 'replacing',
      replaceJournal: { step: 'cleaning' },
    });
    expect(sha(await readFile(p.originalPath))).toBe(sha(NEW));
    expect(sha(await readFile(p.copyPath))).toBe(sha(ORIG));
  });

  it('O = the replacement and the .orig already removed (crash before the null journal) → completed', async () => {
    const p = await layout('h', { O: false, T: true, C: true, recycling: false, step: 'cleaning' });
    await rename(p.tmpPath, p.originalPath);
    await rm(p.copyPath);
    const r = await startupSweep(db, sweepDeps());
    expect(r.completed).toEqual(['h']);
    expect(sha(await readFile(p.originalPath))).toBe(sha(NEW));
  });

  it('a tmp that is not the full replacement is never installed: the original is restored', async () => {
    const p = await layout('i', { O: false, T: true, C: true });
    await writeFile(p.tmpPath, NEW.subarray(0, 100));
    const r = await startupSweep(db, sweepDeps());
    expect(r.rolledBack).toEqual(['i']);
    expect(sha(await readFile(p.originalPath))).toBe(sha(ORIG));
    expect(await nodeFsOps.exists(p.tmpPath)).toBe(false);
  });

  it('the restore refuses when originalPath is occupied (renameNoClobber throws → conflict)', async () => {
    const p = await layout('k', { O: false, T: false, C: true });
    let first = true;
    // Something appears at the original path between the sweep's look and its rename.
    const fs: FsOps = {
      ...nodeFsOps,
      exists: async (q) => {
        if (q === p.originalPath && first) {
          first = false;
          await writeFile(q, 'appeared');
          return false;
        }
        return nodeFsOps.exists(q);
      },
    };
    const r = await startupSweep(db, sweepDeps({ fs }));
    expect(r.conflicts).toEqual(['k']);
    expect(findJob(db, 'k')).toMatchObject({
      state: 'failed',
      reason: `could not restore the original: refusing to rename over an existing path: ${p.originalPath}; the original is at ${p.copyPath}`,
    });
    expect(await readFile(p.originalPath, 'utf8')).toBe('appeared');
    expect(sha(await readFile(p.copyPath))).toBe(sha(ORIG));
  });

  it('a journaled job keeps its tmp out of the stray removal', async () => {
    const p = await layout('e2', { O: false, T: true, C: false });
    await startupSweep(db, sweepDeps());
    expect(await nodeFsOps.exists(p.tmpPath)).toBe(true);
  });

  it('an unreachable library root decides nothing: journal kept, failed "library root unavailable", and the next start settles it', async () => {
    const p = await layout('u', { O: false, T: true, C: true, step: 'moving_original' });
    const offline = join(root, 'lib-offline');
    await rename(lib, offline); // the share is not mounted yet
    const r = await startupSweep(db, sweepDeps());
    expect(r).toMatchObject({ conflicts: ['u'], completed: [], rolledBack: [], tempRemoved: 0 });
    expect(findJob(db, 'u')).toMatchObject({
      state: 'failed',
      reason: `library root unavailable: ${lib}`,
      replaceJournal: p.j,
    });
    expect(listRecycled(db).map((x) => x.path)).toEqual([p.copyPath]);

    await rename(offline, lib); // mounted
    const again = await startupSweep(db, sweepDeps());
    expect(again.completed).toEqual(['u']);
    expect(sha(await readFile(p.originalPath))).toBe(sha(NEW));
    expect(sha(await readFile(p.copyPath))).toBe(sha(ORIG));
    expect(await nodeFsOps.exists(p.tmpPath)).toBe(false);
  });

  it('a missing folder of the file (a sub-mount not up) decides nothing either', async () => {
    const p = await layout('v', { O: false, T: true, C: true, recycling: false });
    const show = join(lib, 'Show');
    await rename(show, join(root, 'Show-away'));
    const r = await startupSweep(db, sweepDeps());
    expect(r.conflicts).toEqual(['v']);
    expect(findJob(db, 'v')).toMatchObject({
      reason: `library root unavailable: ${show}`,
      replaceJournal: p.j,
    });
    await rename(join(root, 'Show-away'), show);
    expect((await startupSweep(db, sweepDeps())).completed).toEqual(['v']);
    expect(sha(await readFile(p.originalPath))).toBe(sha(NEW));
  });

  it('the original gone and its recycle folder missing too → kept for the next start, not "original missing"', async () => {
    const p = await layout('w', { O: false, T: false, C: false });
    await rm(join(lib, '.transcoda-recycle'), { recursive: true });
    const r = await startupSweep(db, sweepDeps());
    expect(r.conflicts).toEqual(['w']);
    expect(findJob(db, 'w')).toMatchObject({
      reason: `library root unavailable: ${dirname(p.copyPath)}`,
      replaceJournal: p.j,
    });
  });

  for (const state of ['failed', 'cancelled', 'queued'] as const) {
    it(`a ${state} job (settled by the pipeline) is never requeued: tmp removed, journal cleared, state kept`, async () => {
      const p = await layout(`x-${state}`, { O: true, T: true, C: false, step: 'writing_tmp' });
      updateJob(db, `x-${state}`, { state, reason: 'set by the pipeline' }, now);
      const r = await startupSweep(db, sweepDeps());
      expect(r).toMatchObject({ cleared: [`x-${state}`], interrupted: [] });
      expect(findJob(db, `x-${state}`)).toMatchObject({
        state,
        reason: 'set by the pipeline',
        requeues: 0,
        replaceJournal: null,
      });
      expect(await nodeFsOps.exists(p.tmpPath)).toBe(false);
      expect(sha(await readFile(p.originalPath))).toBe(sha(ORIG));
    });
  }

  it('O and C are one file (crash inside the no-clobber move) → the extra name is removed, not "two copies"', async () => {
    const p = await layout('y', { O: true, T: true, C: false, step: 'moving_original' });
    await link(p.originalPath, p.copyPath);
    const r = await startupSweep(db, sweepDeps());
    expect(r).toMatchObject({ interrupted: ['y'], conflicts: [] });
    expect(sha(await readFile(p.originalPath))).toBe(sha(ORIG));
    expect(await nodeFsOps.exists(p.copyPath)).toBe(false);
    expect(await nodeFsOps.exists(p.tmpPath)).toBe(false);
    expect(listRecycled(db)).toEqual([]);
  });

  it('O and T are one file (crash inside the install move) → the extra name is removed and the install completed', async () => {
    const p = await layout('z', { O: false, T: true, C: true, step: 'installing_tmp' });
    await link(p.tmpPath, p.originalPath);
    const r = await startupSweep(db, sweepDeps());
    expect(r).toMatchObject({ completed: ['z'], conflicts: [] });
    expect(sha(await readFile(p.originalPath))).toBe(sha(NEW));
    expect(sha(await readFile(p.copyPath))).toBe(sha(ORIG));
    expect(await nodeFsOps.exists(p.tmpPath)).toBe(false);
  });

  it('the original back at its path after the install intent (an earlier sweep restored it, then crashed) → rolledBack', async () => {
    await layout('r2', { O: true, T: false, C: false, step: 'installing_tmp' });
    const r = await startupSweep(db, sweepDeps());
    expect(r.rolledBack).toEqual(['r2']);
    expect(findJob(db, 'r2')).toMatchObject({
      state: 'failed',
      reason: 'interrupted; original restored',
      requeues: 0,
      replaceJournal: null,
    });
  });

  it('a restore fsyncs both directories; an install fsyncs the library directory', async () => {
    const synced: string[] = [];
    const fs: FsOps = {
      ...nodeFsOps,
      fsyncDir: async (q) => {
        synced.push(q);
        await nodeFsOps.fsyncDir(q);
      },
    };
    const d = await layout('d2', { O: false, T: false, C: true });
    await startupSweep(db, sweepDeps({ fs }));
    expect(synced).toEqual([dirname(d.originalPath), dirname(d.copyPath)]);
    synced.length = 0;
    const c = await layout('c2', { O: false, T: true, C: true });
    await startupSweep(db, sweepDeps({ fs }));
    expect(synced).toEqual([dirname(c.originalPath)]);
  });

  it('a mount without fsync support does not block the install (warning)', async () => {
    const p = await layout('c3', { O: false, T: true, C: true });
    const fs: FsOps = {
      ...nodeFsOps,
      fsyncDir: async () => {
        throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
      },
    };
    const r = await startupSweep(db, sweepDeps({ fs }));
    expect(r.completed).toEqual(['c3']);
    expect(sha(await readFile(p.originalPath))).toBe(sha(NEW));
    expect(logged).toContainEqual(
      expect.objectContaining({ msg: 'fsync is not supported here; continuing' }),
    );
  });
});

const noLinks: FsOps = {
  ...nodeFsOps,
  link: async () => {
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  },
};

/** nodeFsOps-like `base` recording every call as `op#n`. */
function counting(base: FsOps, calls: string[]): FsOps {
  const counts = new Map<string, number>();
  const out = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(base) as (keyof FsOps)[]) {
    const fn = base[key] as (...a: unknown[]) => Promise<unknown>;
    out[key] = (...args: unknown[]) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      calls.push(`${key}#${n}`);
      return fn.apply(base, args);
    };
  }
  return out as unknown as FsOps;
}

describe('startupSweep: a fault at every disk touch of the sweep itself never loses the original', () => {
  interface Row {
    name: string;
    l: Layout;
    /** Extra setup after the layout (hard links, a settled state). */
    arrange?: (p: Awaited<ReturnType<typeof layout>>) => Promise<void>;
  }
  const rows: Row[] = [
    { name: 'install', l: { O: false, T: true, C: true } },
    { name: 'restore', l: { O: false, T: false, C: true } },
    { name: 'install .orig', l: { O: false, T: true, C: true, recycling: false } },
    { name: 'requeue', l: { O: true, T: true, C: false, step: 'writing_tmp' } },
    {
      name: 'cleared (a failed job)',
      l: { O: true, T: true, C: false, step: 'writing_tmp' },
      arrange: async () => {
        updateJob(db, 's', { state: 'failed', reason: 'set by the pipeline' }, now);
      },
    },
    {
      name: 'O and C one file',
      l: { O: true, T: true, C: false, step: 'moving_original' },
      arrange: async (p) => link(p.originalPath, p.copyPath),
    },
    {
      name: 'O and T one file',
      l: { O: false, T: true, C: true, step: 'installing_tmp' },
      arrange: async (p) => link(p.tmpPath, p.originalPath),
    },
    {
      name: 'completed (cleaning intent lost)',
      l: { O: false, T: true, C: true, step: 'installing_tmp' },
      arrange: async (p) => rename(p.tmpPath, p.originalPath),
    },
  ];
  for (const row of rows) {
    for (const [variant, base] of [
      ['hard links', nodeFsOps],
      ['no hard links', noLinks],
    ] as const) {
      it(`${row.name} (${variant}): each call fails once, then a clean sweep`, async () => {
        const fresh = async () => {
          db.close();
          await rm(root, { recursive: true, force: true });
          await setup();
          const p = await layout('s', row.l);
          await row.arrange?.(p);
          return p;
        };
        // A clean run lists every call this row makes.
        await fresh();
        const calls: string[] = [];
        await startupSweep(db, sweepDeps({ fs: counting(base, calls) }));
        const touched = calls.filter((c) => !c.startsWith('readdir') && !c.startsWith('exists'));
        expect(touched.length).toBeGreaterThan(0);
        for (const call of calls) {
          const [op, n] = call.split('#') as [keyof FsOps, string];
          const p = await fresh();
          // The faulty sweep may throw (the server would not start); the next start sweeps clean.
          await startupSweep(db, sweepDeps({ fs: failingAt(base, op, Number(n)) })).catch(() => {});
          await startupSweep(db, sweepDeps({ fs: base }));
          const atO = (await nodeFsOps.exists(p.originalPath))
            ? sha(await readFile(p.originalPath))
            : null;
          const atC = (await nodeFsOps.exists(p.copyPath)) ? sha(await readFile(p.copyPath)) : null;
          const where = `${row.name} (${variant}), fault at ${call}`;
          expect({ where, original: [atO, atC].includes(sha(ORIG)) }).toEqual({
            where,
            original: true,
          });
          expect({ where, atO: atO !== null }).toEqual({ where, atO: true });
          if (atO === sha(NEW)) expect({ where, atC }).toEqual({ where, atC: sha(ORIG) });
          expect({ where, tmp: await nodeFsOps.exists(p.tmpPath) }).toEqual({ where, tmp: false });
          const j = findJob(db, 's');
          // A settled job is never resurrected; nothing is ever requeued twice.
          if (row.name.startsWith('cleared'))
            expect({ where, state: j?.state }).toEqual({ where, state: 'failed' });
          expect(j?.requeues ?? 0).toBeLessThanOrEqual(1);
          // The journal is gone unless the replacement is installed and only cleaning remains.
          if (atO !== sha(NEW))
            expect({ where, journal: j?.replaceJournal ?? null }).toEqual({ where, journal: null });
        }
      });
    }
  }
});

// ---- stale ffmpeg groups ----

const ffmpegAvailable =
  spawnSync(toolPaths().ffmpegPath, ['-version'], { stdio: 'ignore' }).status === 0;

function exited(child: ChildProcess): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.signalCode);
    else child.once('exit', (_code, signal) => resolve(signal));
  });
}

describe('killStaleFfmpeg', () => {
  it('does nothing without a pid file, and ignores a malformed one', async () => {
    await killStaleFfmpeg(join(tc, 'none', 'ffmpeg.pid'), log);
    await writeFile(join(tc, 'ffmpeg.pid'), 'not a pid');
    await killStaleFfmpeg(join(tc, 'ffmpeg.pid'), log);
    expect(logged).toEqual([expect.objectContaining({ msg: 'ignoring a malformed ffmpeg.pid' })]);
  });

  it('never kills a process that is not ffmpeg (a reused pid)', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    try {
      const pidFile = join(tc, 'ffmpeg.pid');
      await writeFile(pidFile, `${child.pid}\n`);
      await killStaleFfmpeg(pidFile, log);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(logged).toEqual([
        expect.objectContaining({
          msg: 'stale ffmpeg.pid names a process that is not ffmpeg; not killed',
        }),
      ]);
    } finally {
      // Only the process group this test started.
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      await exited(child);
    }
  });

  it.skipIf(!ffmpegAvailable)('SIGKILLs the process group of a leftover ffmpeg', async () => {
    const child = spawn(
      toolPaths().ffmpegPath,
      ['-nostdin', '-v', 'quiet', '-re', '-f', 'lavfi', '-i', 'anullsrc', '-f', 'null', '-'],
      { detached: true, stdio: 'ignore' },
    );
    const done = exited(child);
    try {
      await new Promise((r) => setTimeout(r, 200));
      const pidFile = join(tc, 'ffmpeg.pid');
      await writeFile(pidFile, `${child.pid}\n`);
      await killStaleFfmpeg(pidFile, log);
      expect(await done).toBe('SIGKILL');
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        process.kill(-child.pid, 'SIGKILL');
      }
      await done;
    }
  });
});
