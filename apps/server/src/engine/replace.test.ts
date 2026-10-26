import { createHash, randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { emptyGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/open.ts';
import {
  findJob,
  insertJob,
  insertRecycled,
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
import { tempDir } from './fixtures.ts';
import { type FsOps, failingAt, nodeFsOps, renameNoClobber } from './fs-ops.ts';
import { defaultRecycleFolder } from './recycle.ts';
import {
  durableReplaceWrites,
  FREE_SPACE_MARGIN_BYTES,
  origPathFor,
  pollForSpace,
  type ReplaceDeps,
  type ReplaceInput,
  type ReplaceResult,
  recyclePathFor,
  replaceOriginal,
  type SpaceWait,
  spaceWaitText,
  tmpPathFor,
} from './replace.ts';
import { startupSweep } from './sweep.ts';

const JOB = 'job-1';
const now = new Date('2026-03-01T12:00:00.000Z');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const ORIG = randomBytes(64 * 1024);
const NEW = randomBytes(24 * 1024);

/** Real disk, but statfs always reports plenty of space (tests must not depend on the temp disk). */
const roomy: FsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 2 ** 40, bsize: 1 }) };

let root: string;
let lib: string;
let tc: string;
let original: string;
let output: string;
let db: Database;
let warnings: unknown[];
let log: Logger;

async function seed(): Promise<void> {
  root = await tempDir('replace-');
  lib = join(root, 'lib');
  tc = join(root, 'transcode');
  original = join(lib, 'Show', 'ep 1.mkv');
  output = join(tc, JOB, 'out.mkv');
  await mkdir(dirname(original), { recursive: true });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(original, ORIG);
  await chmod(original, 0o640);
  const past = new Date('2025-01-02T03:04:05.000Z');
  await utimes(original, past, past);
  await writeFile(output, NEW);
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
  insertJob(
    db,
    {
      id: JOB,
      runId: 'r1',
      libraryId: 'l1',
      fileId: null,
      path: original,
      workflowId: 'w1',
      workflowVersion: 1,
      dryRun: false,
      testEncode: false,
      state: 'replacing',
      priority: 0,
    },
    now,
  );
  warnings = [];
  log = { info: () => {}, warn: (e) => warnings.push(e), error: (e) => warnings.push(e) };
}

beforeEach(seed);
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

async function input(recycle: boolean, extra: Partial<ReplaceInput> = {}): Promise<ReplaceInput> {
  return {
    jobId: JOB,
    originalPath: original,
    outputPath: output,
    expected: await fingerprintOf(original),
    recycleFolder: recycle ? defaultRecycleFolder(lib) : null,
    owner: null,
    libraryId: 'l1',
    libraryRoot: lib,
    ...extra,
  };
}

interface Recorded {
  deps: ReplaceDeps;
  journals: (ReplaceJournal | null)[];
  waits: [number, number][];
}

/** Deps writing the journal to the job row, as the pipeline does. */
function deps(fs: FsOps = roomy, extra: Partial<ReplaceDeps> = {}): Recorded {
  const journals: (ReplaceJournal | null)[] = [];
  const waits: [number, number][] = [];
  return {
    journals,
    waits,
    deps: {
      fs,
      journal: (j) => {
        updateJob(db, JOB, { replaceJournal: j }, now);
        journals.push(j);
      },
      recordRecycled: (row) => insertRecycled(db, row),
      waitForSpace: async (needed, available) => {
        waits.push([needed, available]);
      },
      now: () => now,
      log,
      ...extra,
    },
  };
}

const recyclePath = (): string => join(lib, '.transcoda-recycle', 'Show', 'ep 1.mkv');
const tmpPath = (): string => join(lib, 'Show', `.transcoda-${JOB}.tmp`);

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(join(e.parentPath, e.name));
  }
  return out.sort();
}

describe('paths', () => {
  it('tmp beside the file, .orig beside the file, recycle mirrors the library layout', () => {
    expect(tmpPathFor('/m/tv/a.mkv', 'j')).toBe('/m/tv/.transcoda-j.tmp');
    expect(origPathFor('/m/tv/a.mkv', 'j')).toBe('/m/tv/a.mkv.transcoda-j.orig');
    expect(recyclePathFor('/m/tv/.transcoda-recycle', '/m/tv', '/m/tv/S1/a.mkv')).toBe(
      '/m/tv/.transcoda-recycle/S1/a.mkv',
    );
    expect(recyclePathFor('/r', '/m/tv', '/m/tv/S1/a.mkv', 2)).toBe('/r/S1/a.mkv.2');
    expect(FREE_SPACE_MARGIN_BYTES).toBe(5 * 1024 ** 3);
  });
});

describe('replaceOriginal', () => {
  it('replaces: tmp beside the file, original in recycle, mode and mtime kept, journal intents written in order checking…cleaning then null', async () => {
    const copies: string[] = [];
    const fs: FsOps = {
      ...roomy,
      copyFile: async (a, b) => {
        copies.push(b);
        await roomy.copyFile(a, b);
      },
    };
    const before = await stat(original);
    const r = deps(fs);
    const result = await replaceOriginal(await input(true), r.deps);

    expect(result).toEqual({
      kind: 'replaced',
      recyclePath: recyclePath(),
      afterBytes: NEW.length,
    });
    expect(copies).toEqual([tmpPath()]);
    expect(sha(await readFile(original))).toBe(sha(NEW));
    expect(sha(await readFile(recyclePath()))).toBe(sha(ORIG));
    const after = await stat(original);
    expect(after.mode & 0o7777).toBe(0o640);
    expect(Math.floor(after.mtimeMs)).toBe(Math.floor(before.mtimeMs));
    expect(r.journals.map((j) => j?.step ?? null)).toEqual([
      'checking',
      'writing_tmp',
      'moving_original',
      'installing_tmp',
      'cleaning',
      null,
    ]);
    expect(r.journals[0]).toMatchObject({
      originalPath: original,
      tmpPath: tmpPath(),
      outputPath: output,
      copyPath: recyclePath(),
      libraryRoot: lib,
      recycling: true,
      outputBytes: NEW.length,
    });
    expect(findJob(db, JOB)?.replaceJournal).toBeNull();
    expect(listRecycled(db)).toEqual([
      {
        path: recyclePath(),
        libraryId: 'l1',
        jobId: JOB,
        sizeBytes: ORIG.length,
        recycledAt: now.toISOString(),
      },
    ]);
    expect(await filesUnder(lib)).toEqual([recyclePath(), original].sort());
  });

  it('no recycle folder: original renamed to .orig and removed after the replace', async () => {
    const r = deps();
    const result = await replaceOriginal(await input(false), r.deps);
    expect(result).toEqual({ kind: 'replaced', recyclePath: null, afterBytes: NEW.length });
    expect(r.journals[0]?.copyPath).toBe(origPathFor(original, JOB));
    expect(r.journals[0]?.recycling).toBe(false);
    expect(sha(await readFile(original))).toBe(sha(NEW));
    expect(await filesUnder(lib)).toEqual([original]);
    expect(listRecycled(db)).toEqual([]);
  });

  it('a taken recycle path gets a numeric suffix', async () => {
    await mkdir(dirname(recyclePath()), { recursive: true });
    await writeFile(recyclePath(), 'older recycled copy');
    const result = await replaceOriginal(await input(true), deps().deps);
    expect(result).toMatchObject({ kind: 'replaced', recyclePath: `${recyclePath()}.1` });
    expect(await readFile(recyclePath(), 'utf8')).toBe('older recycled copy');
    expect(sha(await readFile(`${recyclePath()}.1`))).toBe(sha(ORIG));
  });

  it('fingerprint changed → output discarded, original untouched, kind fingerprint-changed', async () => {
    const inp = await input(true);
    const changed = Buffer.concat([ORIG, Buffer.from('more')]);
    await writeFile(original, changed);
    const r = deps();
    expect(await replaceOriginal(inp, r.deps)).toEqual({ kind: 'fingerprint-changed' });
    expect(sha(await readFile(original))).toBe(sha(changed));
    await expect(stat(output)).rejects.toThrow(/ENOENT/);
    expect(r.journals.at(-1)).toBeNull();
    expect(await filesUnder(lib)).toEqual([original]);
  });

  it('the original changing during the copy → tmp and output discarded, fingerprint-changed', async () => {
    const changed = Buffer.concat([ORIG, Buffer.from('written meanwhile')]);
    const fs: FsOps = {
      ...roomy,
      copyFile: async (a, b) => {
        await roomy.copyFile(a, b);
        await writeFile(original, changed);
      },
    };
    const r = deps(fs);
    expect(await replaceOriginal(await input(true), r.deps)).toEqual({
      kind: 'fingerprint-changed',
    });
    expect(sha(await readFile(original))).toBe(sha(changed));
    expect(await filesUnder(lib)).toEqual([original]);
    await expect(stat(output)).rejects.toThrow(/ENOENT/);
    expect(r.journals.map((j) => j?.step ?? null)).toEqual(['checking', 'writing_tmp', null]);
  });

  it('recycle folder on another filesystem → failed at checking with the "different filesystem" message, nothing touched', async () => {
    const recycleDir = dirname(recyclePath());
    const fs: FsOps = {
      ...roomy,
      stat: async (p) => {
        const st = await roomy.stat(p);
        if (p !== recycleDir) return st;
        return Object.assign(Object.create(Object.getPrototypeOf(st)) as Stats, st, {
          dev: st.dev + 1,
        });
      },
    };
    const r = deps(fs);
    const result = await replaceOriginal(await input(true), r.deps);
    expect(result).toEqual({
      kind: 'failed',
      step: 'checking',
      message: `recycle folder ${defaultRecycleFolder(lib)} is on a different filesystem than ${original}`,
    });
    expect(sha(await readFile(original))).toBe(sha(ORIG));
    expect(sha(await readFile(output))).toBe(sha(NEW));
    expect(await filesUnder(lib)).toEqual([original]);
    expect(r.journals.at(-1)).toBeNull();
  });

  it('never renames over an existing path: a pre-existing tmp or copyPath → failed at checking; renameNoClobber refuses', async () => {
    await writeFile(tmpPath(), 'someone else');
    let result = await replaceOriginal(await input(true), deps().deps);
    expect(result).toEqual({
      kind: 'failed',
      step: 'checking',
      message: `${tmpPath()} already exists`,
    });
    await rm(tmpPath());

    const orig = origPathFor(original, JOB);
    await writeFile(orig, 'a user file');
    result = await replaceOriginal(await input(false), deps().deps);
    expect(result).toEqual({ kind: 'failed', step: 'checking', message: `${orig} already exists` });
    expect(await readFile(orig, 'utf8')).toBe('a user file');
    expect(sha(await readFile(original))).toBe(sha(ORIG));
    expect(findJob(db, JOB)?.replaceJournal).toBeNull();

    await expect(renameNoClobber(nodeFsOps, output, orig)).rejects.toThrow(
      `refusing to rename over an existing path: ${orig}`,
    );
    expect(await readFile(orig, 'utf8')).toBe('a user file');
    expect(sha(await readFile(output))).toBe(sha(NEW));
  });

  it('an original outside the library root cannot be recycled → failed at checking', async () => {
    const result = await replaceOriginal(
      await input(true, { libraryRoot: join(root, 'elsewhere') }),
      deps().deps,
    );
    expect(result).toMatchObject({ kind: 'failed', step: 'checking' });
    expect(sha(await readFile(original))).toBe(sha(ORIG));
  });

  it('not enough free space → waitForSpace called with needed and available, then proceeds', async () => {
    let calls = 0;
    const fs: FsOps = {
      ...nodeFsOps,
      statfs: async () => {
        calls += 1;
        return calls === 1 ? { bavail: 10, bsize: 4096 } : { bavail: 2 ** 40, bsize: 1 };
      },
    };
    const r = deps(fs);
    const result = await replaceOriginal(await input(true), r.deps);
    expect(r.waits).toEqual([[NEW.length + FREE_SPACE_MARGIN_BYTES, 40_960]]);
    expect(result).toMatchObject({ kind: 'replaced' });
  });

  it('a wait for space is told (path, needed, free) on every check, logged once when it starts and once when it ends (C4)', async () => {
    let calls = 0;
    const fs: FsOps = {
      ...nodeFsOps,
      statfs: async () => {
        calls += 1;
        return calls <= 2 ? { bavail: 10 + calls, bsize: 4096 } : { bavail: 2 ** 40, bsize: 1 };
      },
    };
    const told: (SpaceWait | null)[] = [];
    const infos: unknown[] = [];
    const r = deps(fs, {
      onSpaceWait: (w) => told.push(w),
      log: { ...log, info: (e) => infos.push(e) },
    });
    expect(await replaceOriginal(await input(true), r.deps)).toMatchObject({ kind: 'replaced' });
    const needed = NEW.length + FREE_SPACE_MARGIN_BYTES;
    const path = lib;
    expect(told).toEqual([
      { path, neededBytes: needed, availableBytes: 11 * 4096 },
      { path, neededBytes: needed, availableBytes: 12 * 4096 },
      null,
    ]);
    expect(infos).toEqual([
      expect.objectContaining({
        msg: 'replace waits for free space',
        job: JOB,
        wait: spaceWaitText({ path, neededBytes: needed, availableBytes: 11 * 4096 }),
      }),
      expect.objectContaining({
        msg: 'replace stopped waiting for free space',
        job: JOB,
        outcome: 'space free',
      }),
    ]);
  });

  it('a wait for space that is cancelled ends with one log line too, and is told as over', {
    timeout: 2000,
  }, async () => {
    const ac = new AbortController();
    const fs: FsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 1, bsize: 1 }) };
    const told: (SpaceWait | null)[] = [];
    const infos: { msg?: string; outcome?: string }[] = [];
    const r = deps(fs, {
      signal: ac.signal,
      onSpaceWait: (w) => told.push(w),
      log: { ...log, info: (e) => infos.push(e as { msg?: string }) },
      waitForSpace: () => {
        setTimeout(() => ac.abort('cancel'), 5);
        return new Promise(() => {});
      },
    });
    expect(await replaceOriginal(await input(true), r.deps)).toEqual({ kind: 'cancelled' });
    expect(told.at(-1)).toBeNull();
    expect(infos.map((e) => [e.msg, e.outcome])).toEqual([
      ['replace waits for free space', undefined],
      ['replace stopped waiting for free space', 'stopped'],
    ]);
  });

  it('a wait for space is worded with the free space in GB', () => {
    expect(
      spaceWaitText({ path: '/media', neededBytes: 5_400_000_000, availableBytes: 5_100_000_000 }),
    ).toBe('waiting for 5.4 GB free on /media (5.1 GB free)');
    expect(spaceWaitText({ path: '/m', neededBytes: 5_368_733_184, availableBytes: 40_960 })).toBe(
      'waiting for 5.4 GB free on /m (41 KB free)',
    );
    expect(spaceWaitText({ path: '/m', neededBytes: 2_500_000, availableBytes: 0 })).toBe(
      'waiting for 2.5 MB free on /m (0 B free)',
    );
  });

  it('EPERM on chown is a warning, not a failure', async () => {
    const chowns: [string, number, number][] = [];
    const fs: FsOps = {
      ...roomy,
      chown: async (p, uid, gid) => {
        chowns.push([p, uid, gid]);
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      },
    };
    const result = await replaceOriginal(
      await input(true, { owner: { uid: 4242, gid: 4343 } }),
      deps(fs).deps,
    );
    expect(result).toMatchObject({ kind: 'replaced' });
    expect(chowns).toEqual([[tmpPath(), 4242, 4343]]);
    expect(warnings).toEqual([
      expect.objectContaining({ msg: 'could not set the owner of the replacement' }),
    ]);
  });

  it('chown is skipped when the owner already matches', async () => {
    const st = await stat(output);
    const fs: FsOps = {
      ...roomy,
      chown: async () => {
        throw new Error('should not be called');
      },
    };
    const result = await replaceOriginal(
      await input(true, { owner: { uid: st.uid, gid: st.gid } }),
      deps(fs).deps,
    );
    expect(result).toMatchObject({ kind: 'replaced' });
  });

  it('an abort before the replace starts → cancelled, nothing written; once the tmp is being written the replace completes', async () => {
    const ac = new AbortController();
    ac.abort('cancel');
    const r1 = deps(roomy, { signal: ac.signal });
    expect(await replaceOriginal(await input(true), r1.deps)).toEqual({ kind: 'cancelled' });
    expect(r1.journals).toEqual([]);
    expect(sha(await readFile(original))).toBe(sha(ORIG));

    const late = new AbortController();
    const r2 = deps(roomy, { signal: late.signal });
    const journal = r2.deps.journal;
    r2.deps.journal = (j) => {
      journal(j);
      if (j?.step === 'writing_tmp') late.abort('cancel');
    };
    expect(await replaceOriginal(await input(true), r2.deps)).toMatchObject({ kind: 'replaced' });
    expect(sha(await readFile(original))).toBe(sha(NEW));
  });

  it('cancel while waiting for free space is honoured: cancelled, journal cleared, nothing on disk changed', {
    timeout: 2000,
  }, async () => {
    const ac = new AbortController();
    const fs: FsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 1, bsize: 1 }) };
    const signals: (AbortSignal | undefined)[] = [];
    const r = deps(fs, {
      signal: ac.signal,
      waitForSpace: (_needed, _available, signal) => {
        signals.push(signal);
        setTimeout(() => ac.abort('cancel'), 5);
        return new Promise(() => {}); // a wait that never ends by itself
      },
    });
    expect(await replaceOriginal(await input(true), r.deps)).toEqual({ kind: 'cancelled' });
    expect(signals).toEqual([ac.signal]);
    expect(r.journals.map((j) => j?.step ?? null)).toEqual(['checking', null]);
    expect(findJob(db, JOB)?.replaceJournal).toBeNull();
    expect(sha(await readFile(original))).toBe(sha(ORIG));
    expect(await filesUnder(lib)).toEqual([original]);
  });

  it('cancel after the space check but before the tmp is written is honoured too', async () => {
    const ac = new AbortController();
    const r = deps(roomy, { signal: ac.signal });
    const exists = roomy.exists;
    // The last check of `checking` (is the tmp path free?) is where the cancel lands.
    r.deps.fs = {
      ...roomy,
      exists: async (p) => {
        if (p === tmpPath()) ac.abort('cancel');
        return exists(p);
      },
    };
    expect(await replaceOriginal(await input(true), r.deps)).toEqual({ kind: 'cancelled' });
    expect(r.journals.map((j) => j?.step ?? null)).toEqual(['checking', null]);
    expect(await filesUnder(lib)).toEqual([original]);
  });

  it('pollForSpace re-checks after 30 s but returns at once on abort', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const waiting = pollForSpace(1, 0, ac.signal);
    setTimeout(() => ac.abort('cancel'), 10);
    await waiting;
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('a throw while checking clears the journal (nothing has moved yet)', async () => {
    for (const fs of [
      {
        ...roomy,
        statfs: async () => {
          throw Object.assign(new Error('ENOSYS: statfs'), { code: 'ENOSYS' });
        },
      },
      {
        ...roomy,
        mkdir: async () => {
          throw Object.assign(new Error('EACCES: recycle folder'), { code: 'EACCES' });
        },
      },
    ] satisfies FsOps[]) {
      const r = deps(fs);
      const result = await replaceOriginal(await input(true), r.deps);
      expect(result).toMatchObject({ kind: 'failed', step: 'checking' });
      expect(r.journals.map((j) => j?.step ?? null)).toEqual(['checking', null]);
      expect(findJob(db, JOB)?.replaceJournal).toBeNull();
      expect(sha(await readFile(original))).toBe(sha(ORIG));
    }
  });

  it('EXDEV from moving the original (bind mounts share st_dev) → failed at checking with the different-filesystem message, tmp removed, journal cleared', async () => {
    const exdev = (): Error =>
      Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' });
    const fs: FsOps = {
      ...roomy,
      link: async () => {
        throw exdev();
      },
      rename: async () => {
        throw exdev();
      },
    };
    const r = deps(fs);
    expect(await replaceOriginal(await input(true), r.deps)).toEqual({
      kind: 'failed',
      step: 'checking',
      message: `recycle folder ${defaultRecycleFolder(lib)} is on a different filesystem than ${original}`,
    });
    expect(r.journals.map((j) => j?.step ?? null)).toEqual([
      'checking',
      'writing_tmp',
      'moving_original',
      null,
    ]);
    expect(sha(await readFile(original))).toBe(sha(ORIG));
    expect(await filesUnder(lib)).toEqual([original]);
    expect(listRecycled(db)).toEqual([]);
  });

  it('after the original moves, both its old and its new directory are fsynced', async () => {
    for (const recycle of [true, false]) {
      const synced: string[] = [];
      const fs: FsOps = {
        ...roomy,
        fsyncDir: async (p) => {
          synced.push(p);
          await roomy.fsyncDir(p);
        },
      };
      await rm(root, { recursive: true, force: true });
      db.close();
      await seed();
      expect(await replaceOriginal(await input(recycle), deps(fs).deps)).toMatchObject({
        kind: 'replaced',
      });
      const show = join(lib, 'Show');
      // recycle: the recycle dir and the library dir after the move, the library dir after the
      // install; .orig: one directory, synced after each rename.
      expect(synced).toEqual(recycle ? [dirname(recyclePath()), show, show] : [show, show]);
    }
  });

  it('a mount without fsync support (EINVAL/ENOTSUP) is a warning, not a failure', async () => {
    const unsupported = (code: string) => async () => {
      throw Object.assign(new Error(code), { code });
    };
    const fs: FsOps = {
      ...roomy,
      fsyncDir: unsupported('EINVAL'),
      fsyncFile: unsupported('ENOTSUP'),
    };
    expect(await replaceOriginal(await input(true), deps(fs).deps)).toMatchObject({
      kind: 'replaced',
    });
    expect(sha(await readFile(original))).toBe(sha(NEW));
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ msg: 'fsync is not supported here; continuing', code: 'EINVAL' }),
        expect.objectContaining({
          msg: 'fsync is not supported here; continuing',
          code: 'ENOTSUP',
        }),
      ]),
    );
  });
});

describe('durableReplaceWrites', () => {
  it('writes the journal and the recycled row with synchronous = FULL, then restores the setting', () => {
    const seen: number[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (!sql.startsWith('PRAGMA') && !sql.startsWith('SELECT')) {
        seen.push(db.pragma('synchronous', { simple: true }) as number);
      }
      return prepare(sql);
    }) as typeof db.prepare;
    const before = db.pragma('synchronous', { simple: true });
    const w = durableReplaceWrites(db, JOB, () => now, log);
    const j: ReplaceJournal = {
      step: 'checking',
      originalPath: original,
      tmpPath: tmpPath(),
      outputPath: output,
      copyPath: recyclePath(),
      libraryRoot: lib,
      recycling: true,
      fingerprint: { sizeBytes: 1, mtimeMs: 1, ino: 1, dev: 1, nlink: 1 },
      outputBytes: 1,
    };
    w.journal(j);
    expect(findJob(db, JOB)?.replaceJournal).toEqual(j);
    w.recordRecycled({
      path: recyclePath(),
      libraryId: 'l1',
      jobId: JOB,
      sizeBytes: 1,
      recycledAt: now.toISOString(),
    });
    w.journal(null);
    expect(findJob(db, JOB)?.replaceJournal).toBeNull();
    expect(listRecycled(db).map((x) => x.path)).toEqual([recyclePath()]);
    // FULL = 2 for each write (journal, recycled, journal null); the setting is back afterwards.
    expect(seen).toEqual([2, 2, 2]);
    expect(db.pragma('synchronous', { simple: true })).toBe(before);
  });

  it('a stale row at the same recycle path (its original was moved back by hand) is replaced and logged, not a failure (C5)', () => {
    const stale = {
      path: recyclePath(),
      libraryId: 'l1',
      jobId: 'earlier-job',
      sizeBytes: 7,
      recycledAt: new Date(now.getTime() - 86_400_000).toISOString(),
    };
    insertRecycled(db, stale);
    const w = durableReplaceWrites(db, JOB, () => now, log);
    const row = {
      path: recyclePath(),
      libraryId: 'l1',
      jobId: JOB,
      sizeBytes: 1,
      recycledAt: now.toISOString(),
    };
    expect(() => w.recordRecycled(row)).not.toThrow();
    expect(listRecycled(db)).toEqual([row]);
    expect(warnings).toEqual([
      {
        msg: 'replaced a stale recycle row; its original had left the recycle folder',
        path: recyclePath(),
        job: JOB,
        staleJob: 'earlier-job',
        staleRecycledAt: stale.recycledAt,
      },
    ]);
  });

  it('a journal write for a job that no longer exists throws (the replace must not proceed)', () => {
    const w = durableReplaceWrites(db, 'nope', () => now, log);
    expect(() => w.journal(null)).toThrow(/nope/);
  });
});

// ---- fault injection ----

const coded = (code: string): Error => Object.assign(new Error(code), { code });
const CHANGED = Buffer.concat([ORIG, Buffer.from('written meanwhile')]);

/** Real disk; chown always succeeds (the test runs unprivileged) so the owner path is exercised. */
const faultBase: FsOps = { ...roomy, chown: async () => {} };
/** A filesystem without hard links (SMB, FAT): renameNoClobber falls back to check-then-rename. */
const noLinks: FsOps = {
  ...faultBase,
  link: async () => {
    throw coded('EPERM');
  },
};
const OWNER = { uid: 99_999, gid: 99_999 };

interface Scenario {
  name: string;
  recycle: boolean;
  /** A fresh base FsOps for one run. */
  fs(): FsOps;
  /** Extra deps for one run (signal, waitForSpace). */
  deps?(): Partial<ReplaceDeps>;
  /** Runs after the input (with the probed fingerprint) is taken. */
  prepare?(): Promise<void>;
  /** The original's possible contents (a scenario may change it while the job runs). */
  originals: Buffer[];
  /** The result without a fault. */
  kind: ReplaceResult['kind'];
  /**
   * Every disk touch, journal write and recycle record of a fault-free run, in order. The first
   * test pins these to the implementation, so a new fs op or branch cannot escape the fault loop.
   */
  calls: string[];
}

const RECYCLE_CHECKING = [
  'stat#1', // output size
  'exists#1', // recycle path candidate (suffix when taken)
  'journal#1', // checking
  'mkdir#1', // recycle folder
  'stat#2', // recycle folder dev
  'statfs#1', // free space
  'stat#3', // original: fingerprint, dev, mode, times
];
const RECYCLE_TO_MOVE = [
  ...RECYCLE_CHECKING,
  'exists#2', // copyPath taken?
  'exists#3', // tmp taken?
  'journal#2', // writing_tmp
  'copyFile#1',
  'stat#4', // tmp owner
  'chown#1',
  'chmod#1',
  'utimes#1',
  'fsyncFile#1',
  'stat#5', // original unchanged during the copy?
  'journal#3', // moving_original
];
const ORIG_TO_MOVE = [
  'stat#1',
  'journal#1', // checking
  'statfs#1',
  'stat#2',
  'exists#1',
  'exists#2',
  'journal#2', // writing_tmp
  'copyFile#1',
  'stat#3',
  'chown#1',
  'chmod#1',
  'utimes#1',
  'fsyncFile#1',
  'stat#4',
  'journal#3', // moving_original
];

const SCENARIOS: Scenario[] = [
  {
    name: 'recycle',
    recycle: true,
    fs: () => faultBase,
    originals: [ORIG],
    kind: 'replaced',
    calls: [
      ...RECYCLE_TO_MOVE,
      'link#1', // renameNoClobber(original → copyPath)
      'unlink#1',
      'fsyncDir#1', // recycle dir
      'fsyncDir#2', // library dir
      'recordRecycled#1',
      'journal#4', // installing_tmp
      'link#2', // renameNoClobber(tmp → original)
      'unlink#2',
      'fsyncDir#3',
      'journal#5', // cleaning
      'journal#6', // null
    ],
  },
  {
    name: 'recycle, no hard links',
    recycle: true,
    fs: () => noLinks,
    originals: [ORIG],
    kind: 'replaced',
    calls: [
      ...RECYCLE_TO_MOVE,
      'link#1', // EPERM → fallback
      'exists#4',
      'rename#1',
      'fsyncDir#1',
      'fsyncDir#2',
      'recordRecycled#1',
      'journal#4',
      'link#2',
      'exists#5',
      'rename#2',
      'fsyncDir#3',
      'journal#5',
      'journal#6',
    ],
  },
  {
    name: '.orig',
    recycle: false,
    fs: () => faultBase,
    originals: [ORIG],
    kind: 'replaced',
    calls: [
      ...ORIG_TO_MOVE,
      'link#1',
      'unlink#1',
      'fsyncDir#1', // one directory for both names
      'journal#4', // installing_tmp
      'link#2',
      'unlink#2',
      'fsyncDir#2',
      'journal#5', // cleaning
      'unlink#3', // the .orig
      'journal#6', // null
    ],
  },
  {
    name: '.orig, no hard links',
    recycle: false,
    fs: () => noLinks,
    originals: [ORIG],
    kind: 'replaced',
    calls: [
      ...ORIG_TO_MOVE,
      'link#1',
      'exists#3',
      'rename#1',
      'fsyncDir#1',
      'journal#4',
      'link#2',
      'exists#4',
      'rename#2',
      'fsyncDir#2',
      'journal#5',
      'unlink#1',
      'journal#6',
    ],
  },
  {
    name: 'cancel while waiting for space',
    recycle: true,
    fs: () => ({ ...faultBase, statfs: async () => ({ bavail: 1, bsize: 1 }) }),
    deps: () => {
      const ac = new AbortController();
      return {
        signal: ac.signal,
        waitForSpace: () => {
          setTimeout(() => ac.abort('cancel'), 1);
          return new Promise(() => {});
        },
      };
    },
    originals: [ORIG],
    kind: 'cancelled',
    calls: [...RECYCLE_CHECKING.slice(0, -1), 'journal#2' /* null */],
  },
  {
    name: 'EXDEV on the move',
    recycle: true,
    fs: () => ({
      ...faultBase,
      link: async () => {
        throw coded('EXDEV');
      },
      rename: async () => {
        throw coded('EXDEV');
      },
    }),
    originals: [ORIG],
    kind: 'failed',
    calls: [
      ...RECYCLE_TO_MOVE,
      'link#1',
      'exists#4',
      'rename#1', // EXDEV: nothing moved
      'unlink#1', // the tmp
      'journal#4', // null
    ],
  },
  {
    name: 'original changed during the copy',
    recycle: true,
    fs: () => ({
      ...faultBase,
      copyFile: async (a, b) => {
        await faultBase.copyFile(a, b);
        await writeFile(original, CHANGED);
      },
    }),
    originals: [ORIG, CHANGED],
    kind: 'fingerprint-changed',
    calls: [
      ...RECYCLE_TO_MOVE.slice(0, -1),
      'unlink#1' /* tmp */,
      'unlink#2' /* output */,
      'journal#3',
    ],
  },
  {
    name: 'original changed before the check',
    recycle: true,
    fs: () => faultBase,
    prepare: () => writeFile(original, CHANGED),
    originals: [CHANGED],
    kind: 'fingerprint-changed',
    calls: [...RECYCLE_CHECKING, 'unlink#1' /* output */, 'journal#2' /* null */],
  },
];

/** `base` recording every call as `op#n` into `calls`. */
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

/** Deps for one run of `sc`, recording into `calls` and throwing at `fault` (`op#n`). */
function instrumented(sc: Scenario, fault: string | null, calls: string[]): ReplaceDeps {
  const [faultOp, faultN] = (fault?.split('#') ?? []) as [string?, string?];
  const nth = Number(faultN);
  let fs = sc.fs();
  if (faultOp !== undefined && faultOp in fs) fs = failingAt(fs, faultOp as keyof FsOps, nth);
  const r = deps(counting(fs, calls), sc.deps?.() ?? {});
  let journals = 0;
  const write = r.deps.journal;
  r.deps.journal = (j) => {
    journals += 1;
    calls.push(`journal#${journals}`);
    if (faultOp === 'journal' && journals === nth) throw new Error('injected');
    write(j);
  };
  let records = 0;
  const record = r.deps.recordRecycled;
  r.deps.recordRecycled = (row) => {
    records += 1;
    calls.push(`recordRecycled#${records}`);
    if (faultOp === 'recordRecycled' && records === nth) throw new Error('injected');
    record(row);
  };
  return r.deps;
}

/** The job state the pipeline records for a replace result that is not `replaced`. */
const pipelineState = (kind: ReplaceResult['kind']) =>
  kind === 'cancelled' ? 'cancelled' : kind === 'fingerprint-changed' ? 'queued' : 'failed';

describe('fault injection: a fault at every disk touch, journal write and recycle record keeps the original bytes in the library path or the copy path', () => {
  it('the scenarios pin every call of the replace', async () => {
    for (const sc of SCENARIOS) {
      await rm(root, { recursive: true, force: true });
      db.close();
      await seed();
      const inp = await input(sc.recycle, { owner: OWNER });
      await sc.prepare?.();
      const calls: string[] = [];
      const result = await replaceOriginal(inp, instrumented(sc, null, calls));
      expect({ scenario: sc.name, kind: result.kind }).toEqual({
        scenario: sc.name,
        kind: sc.kind,
      });
      expect({ scenario: sc.name, calls }).toEqual({ scenario: sc.name, calls: sc.calls });
    }
    // Every FsOps the replace may touch appears in some scenario, and each kind of result.
    const ops = new Set(SCENARIOS.flatMap((sc) => sc.calls.map((c) => c.split('#')[0])));
    for (const op of ['copyFile', 'fsyncFile', 'fsyncDir', 'link', 'unlink', 'rename', 'exists']) {
      expect(ops).toContain(op);
    }
    expect(new Set(SCENARIOS.map((sc) => sc.kind))).toEqual(
      new Set(['replaced', 'cancelled', 'failed', 'fingerprint-changed']),
    );
  });

  for (const sc of SCENARIOS) {
    for (const fault of sc.calls) {
      for (const mode of ['crash', 'failed'] as const) {
        it(`${sc.name}: fault at ${fault}, then ${mode === 'crash' ? 'a crash' : 'the pipeline records the result'}`, async () => {
          const inp = await input(sc.recycle, { owner: OWNER });
          await sc.prepare?.();
          const copyPath = sc.recycle ? recyclePath() : origPathFor(original, JOB);
          const result = await replaceOriginal(inp, instrumented(sc, fault, []));
          expect(result.kind).not.toBe('replaced');
          const originalExistedBefore = await nodeFsOps.exists(original);
          const settled = pipelineState(result.kind);
          if (mode === 'failed') {
            updateJob(db, JOB, { state: settled, reason: 'replace did not complete' }, now);
          }

          const sweep = await startupSweep(db, {
            fs: nodeFsOps,
            transcodeDir: tc,
            libraryRoots: [lib],
            now: () => now,
            log,
            killStaleGroup: async () => {},
          });

          const origShas = sc.originals.map(sha);
          // (a) the original's bytes are at the library path or at the copy path, never neither —
          // except after a finished .orig replace, whose last step removes the original on purpose.
          const cleanedUp = !sc.recycle && fault === 'journal#6';
          const atOriginal = (await nodeFsOps.exists(original))
            ? sha(await readFile(original))
            : null;
          const atCopy = (await nodeFsOps.exists(copyPath)) ? sha(await readFile(copyPath)) : null;
          if (!cleanedUp) {
            expect(origShas.some((h) => h === atOriginal || h === atCopy)).toBe(true);
          }
          // The library path is never left empty after the sweep.
          expect(atOriginal).not.toBeNull();
          // (b) a replacement at the library path is complete and the original is at the copy path.
          if (atOriginal === sha(NEW)) {
            expect((await stat(original)).size).toBe(NEW.length);
            if (cleanedUp) expect(atCopy).toBeNull();
            else expect(origShas).toContain(atCopy);
          } else {
            expect(origShas).toContain(atOriginal);
          }
          // (c) no stray tmp remains anywhere in the library; temp is gone.
          expect((await filesUnder(lib)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
          expect(await readdir(tc)).toEqual([]);
          // (d) the job matches the sweep table row; a job the pipeline already settled is never
          // requeued by the sweep.
          const job = findJob(db, JOB);
          expect(sweep.conflicts).toEqual([]);
          expect(job?.replaceJournal ?? null).toEqual(
            atOriginal === sha(NEW)
              ? expect.objectContaining({ step: 'cleaning', copyPath })
              : null,
          );
          if (atOriginal === sha(NEW)) {
            expect(sweep.completed).toEqual([JOB]);
            expect(job).toMatchObject({ state: 'replacing' });
            if (sc.recycle) expect(listRecycled(db).map((x) => x.path)).toEqual([copyPath]);
          } else if (!originalExistedBefore) {
            expect(sweep.rolledBack).toEqual([JOB]);
            expect(job).toMatchObject({
              state: 'failed',
              reason: 'interrupted; original restored',
            });
            expect(listRecycled(db)).toEqual([]);
          } else {
            expect(atCopy).toBeNull();
            expect(listRecycled(db)).toEqual([]);
            if (mode === 'crash') {
              expect(sweep.interrupted).toEqual([JOB]);
              expect(job).toMatchObject({ state: 'queued', reason: 'interrupted', requeues: 1 });
            } else {
              expect(sweep.interrupted).toEqual([]);
              expect(job).toMatchObject({
                state: settled,
                reason: 'replace did not complete',
                requeues: 0,
              });
            }
          }
        });
      }
    }
  }
});
