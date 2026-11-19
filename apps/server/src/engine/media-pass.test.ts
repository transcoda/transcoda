import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyGraph, type StoredJobMedia } from '@transcoda/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/open.ts';
import { insertJob, parseMedia, upsertFile } from '../db/repos/jobs.ts';
import { insertLibrary, softDeleteLibrary } from '../db/repos/libraries.ts';
import { latestJobsWithoutMedia, setJobMedia } from '../db/repos/library-files.ts';
import { insertRun } from '../db/repos/runs.ts';
import { insertWorkflow } from '../db/repos/workflows.ts';
import { createTestDb } from '../db/test-db.ts';
import type { Logger } from '../logger.ts';
import { tempDir } from './fixtures.ts';
import { type FsOps, nodeFsOps } from './fs-ops.ts';
import { createMediaResolver, type MediaResolver } from './media-info.ts';
import { MediaPass } from './media-pass.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const at = (min: number) => new Date(now.getTime() + min * 60_000);

const media = (title: string, posterPath: string | null = null): StoredJobMedia => ({
  kind: 'movie',
  title,
  year: 1978,
  season: null,
  episode: null,
  episodeTitle: null,
  source: 'sidecar',
  posterPath,
});
const M = media('Night of the Living Dead');
const M2 = media('Sherlock Jr.');

let db: Database;
let logs: Array<Record<string, unknown> | string>;
const log: Logger = {
  info: (e) => logs.push(e),
  warn: (e) => logs.push(e),
  error: (e) => logs.push(e),
};

function library(id: string, path: string): void {
  insertLibrary(db, { id, name: id, path, recycleFolder: null, processHardlinked: false }, now);
  insertRun(
    db,
    {
      id: `run-${id}`,
      libraryId: id,
      workflowId: 'w1',
      workflowVersion: 1,
      requestedPath: path,
      dryRun: false,
      testEncode: false,
      force: false,
      createdBy: 'u',
    },
    now,
  );
}

function file(id: string, libraryId: string, path: string): void {
  const row = upsertFile(
    db,
    {
      libraryId,
      path,
      fingerprint: { sizeBytes: 10, mtimeMs: 1, ino: 1, dev: 1, nlink: 1 },
      lastProbe: null,
    },
    now,
  );
  db.prepare('UPDATE files SET id = ? WHERE id = ?').run(id, row.id);
}

function job(id: string, fileId: string, queuedAt: number, m: StoredJobMedia | null = null): void {
  const f = db.prepare('SELECT path, library_id FROM files WHERE id = ?').get(fileId) as {
    path: string;
    library_id: string;
  };
  insertJob(
    db,
    {
      id,
      runId: `run-${f.library_id}`,
      libraryId: f.library_id,
      fileId,
      path: f.path,
      workflowId: 'w1',
      workflowVersion: 1,
      dryRun: false,
      testEncode: false,
      state: 'done',
      priority: 0,
      media: m,
    },
    at(queuedAt),
  );
}

const mediaOf = (id: string): StoredJobMedia | null =>
  parseMedia(
    (db.prepare('SELECT media FROM jobs WHERE id = ?').get(id) as { media: string | null }).media,
  );

const fake = (fn: (p: string) => Promise<StoredJobMedia> = async (p) => media(p)) => ({
  resolve: vi.fn(fn),
});
const pass = (resolver: MediaResolver = fake(), fs: FsOps = nodeFsOps, batch?: number) =>
  new MediaPass({ db, fs, log, resolver: () => resolver, ...(batch ? { batch } : {}) });

beforeEach(() => {
  logs = [];
  db = createTestDb();
  insertWorkflow(
    db,
    { id: 'w1', kind: 'workflow', name: 'Shrink', graph: emptyGraph('workflow'), createdBy: 'u' },
    now,
  );
  library('l1', '/media/tv');
});

describe('latestJobsWithoutMedia', () => {
  it('lists latest jobs lacking media, oldest first, with the library root', () => {
    file('f1', 'l1', '/media/tv/a.mkv');
    file('f2', 'l1', '/media/tv/b.mkv');
    job('b-latest', 'f2', 5);
    job('a-latest', 'f1', 2);
    expect(latestJobsWithoutMedia(db, 10)).toEqual([
      { jobId: 'a-latest', path: '/media/tv/a.mkv', libraryRoot: '/media/tv' },
      { jobId: 'b-latest', path: '/media/tv/b.mkv', libraryRoot: '/media/tv' },
    ]);
    expect(latestJobsWithoutMedia(db, 1).map((j) => j.jobId)).toEqual(['a-latest']);
  });

  it('lists a latest job lacking media even when an older job of the file has some', () => {
    file('f1', 'l1', '/media/tv/a.mkv');
    job('older', 'f1', 1, M);
    job('latest', 'f1', 2);
    expect(latestJobsWithoutMedia(db, 10).map((j) => j.jobId)).toEqual(['latest']);
  });

  it('leaves out files that are gone', () => {
    file('f1', 'l1', '/media/tv/a.mkv');
    job('j1', 'f1', 1);
    db.prepare("UPDATE files SET gone_at = '2026-01-02T00:00:00.000Z' WHERE id = 'f1'").run();
    expect(latestJobsWithoutMedia(db, 10)).toEqual([]);
  });
});

describe('setJobMedia', () => {
  it('never overwrites existing media', () => {
    file('f1', 'l1', '/media/tv/a.mkv');
    job('has', 'f1', 1, M);
    job('none', 'f1', 2);
    expect(setJobMedia(db, 'has', M2)).toBe(false);
    expect(mediaOf('has')).toEqual(M);
    expect(setJobMedia(db, 'none', M2)).toBe(true);
    expect(mediaOf('none')).toEqual(M2);
    expect(setJobMedia(db, 'none', M)).toBe(false);
    expect(mediaOf('none')).toEqual(M2);
  });
});

describe('MediaPass', () => {
  it('fills media on latest jobs that lack it and on nothing else', async () => {
    file('f1', 'l1', '/media/tv/a.mkv');
    file('f2', 'l1', '/media/tv/b.mkv');
    job('f1-older', 'f1', 1);
    job('f1-latest', 'f1', 2);
    job('f2-latest', 'f2', 3, M);
    const resolver = fake(async (p) => media('Superman', p));
    expect(await pass(resolver).run()).toEqual({ filled: 1 });
    expect(mediaOf('f1-latest')?.title).toBe('Superman');
    expect(mediaOf('f1-older')).toBeNull();
    expect(mediaOf('f2-latest')).toEqual(M);
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(resolver.resolve).toHaveBeenCalledWith('/media/tv/a.mkv', '/media/tv');
    expect(logs).toContainEqual({ msg: 'media pass: filled job(s)', filled: 1 });
  });

  it('logs nothing when it filled nothing', async () => {
    expect(await pass().run()).toEqual({ filled: 0 });
    expect(logs).toEqual([]);
  });

  it('works through more jobs than one batch', async () => {
    for (let i = 0; i < 5; i++) {
      file(`f${i}`, 'l1', `/media/tv/${i}.mkv`);
      job(`j${i}`, `f${i}`, i);
    }
    expect(await pass(fake(), nodeFsOps, 2).run()).toEqual({ filled: 5 });
    expect(latestJobsWithoutMedia(db, 10)).toEqual([]);
  });

  it('stores file-name media for a file whose sidecars cannot be read, so it is not retried', async () => {
    const root = await realpath(await tempDir('media-pass-'));
    await mkdir(join(root, 'Show'), { recursive: true });
    const path = join(root, 'Show', 'Show S01E01.mkv');
    await writeFile(path, 'x');
    await writeFile(join(root, 'Show', 'Show S01E01.nfo'), '<episodedetails/>');
    library('l2', root);
    file('f1', 'l2', path);
    job('j1', 'f1', 1);
    const denied: FsOps = {
      ...nodeFsOps,
      readText: async (p, max) => {
        if (p.endsWith('.nfo')) {
          throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), {
            code: 'EACCES',
          });
        }
        return nodeFsOps.readText(p, max);
      },
    };
    const make = () =>
      new MediaPass({
        db,
        fs: denied,
        log,
        resolver: () => createMediaResolver({ fs: denied, log }),
      });
    expect(await make().run()).toEqual({ filled: 1 });
    expect(mediaOf('j1')).toMatchObject({ source: 'filename' });
    expect(await make().run()).toEqual({ filled: 0 });
  });

  it('never resolves more than 8 at once', async () => {
    for (let i = 0; i < 20; i++) {
      file(`f${i}`, 'l1', `/media/tv/${i}.mkv`);
      job(`j${i}`, `f${i}`, i);
    }
    let active = 0;
    let peak = 0;
    const resolver = fake(async (p) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      return media(p);
    });
    expect(await pass(resolver).run()).toEqual({ filled: 20 });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it('a kick during a pass runs once more after it; idle resolves after both', async () => {
    file('f1', 'l1', '/media/tv/a.mkv');
    job('j1', 'f1', 1);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const resolver = fake(async (p) => {
      await gate;
      return media(p);
    });
    const mp = pass(resolver);
    const run = vi.spyOn(mp, 'run');
    mp.kick();
    mp.kick();
    mp.kick(); // several kicks during one pass still queue only one more pass
    await vi.waitFor(() => expect(resolver.resolve).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledTimes(1);
    // The second pass finds work: a new job arrives while the first pass runs.
    file('f2', 'l1', '/media/tv/b.mkv');
    job('j2', 'f2', 2);
    release();
    await mp.idle();
    expect(run).toHaveBeenCalledTimes(2);
    expect(mediaOf('j1')).not.toBeNull();
    expect(mediaOf('j2')).not.toBeNull();
  });

  it('idle resolves at once when nothing runs', async () => {
    await expect(pass().idle()).resolves.toBeUndefined();
  });

  it('never rejects: a pass that throws is logged', async () => {
    file('f1', 'l1', '/media/tv/a.mkv');
    job('j1', 'f1', 1);
    const mp = new MediaPass({
      db,
      fs: nodeFsOps,
      log,
      resolver: () => {
        throw new Error('no resolver');
      },
    });
    mp.kick();
    await expect(mp.idle()).resolves.toBeUndefined();
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'media pass failed' }));
  });

  it('skips files of a deleted library', async () => {
    library('l2', '/media/movies');
    file('f1', 'l1', '/media/tv/a.mkv');
    file('f2', 'l2', '/media/movies/b.mkv');
    job('j1', 'f1', 1);
    job('j2', 'f2', 2);
    softDeleteLibrary(db, 'l2', now);
    const resolver = fake();
    expect(await pass(resolver).run()).toEqual({ filled: 1 });
    expect(mediaOf('j1')).not.toBeNull();
    expect(mediaOf('j2')).toBeNull();
  });
});
