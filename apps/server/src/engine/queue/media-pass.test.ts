import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyGraph, type StoredJobMedia } from '@transcoda/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/open.ts';
import { upsertFile } from '../../db/repos/files.ts';
import { insertJob, parseMedia } from '../../db/repos/jobs/jobs.ts';
import { insertLibrary, softDeleteLibrary } from '../../db/repos/libraries.ts';
import {
  episodesWithoutShowPoster,
  latestJobsWithoutMedia,
  setJobMedia,
  setShowPosterPath,
} from '../../db/repos/library-files.ts';
import { insertRun } from '../../db/repos/runs.ts';
import { insertWorkflow } from '../../db/repos/workflows.ts';
import { createTestDb } from '../../db/testing.ts';
import { type FsOps, nodeFsOps } from '../../platform/fs-ops.ts';
import type { Logger } from '../../platform/logger.ts';
import type { EngineEvent } from '../events.ts';
import {
  createMediaResolver,
  type MediaResolver,
  type ShowPosterLookup,
} from '../media/media-info.ts';
import { tempDir } from '../testing/fixtures.ts';
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
const M = media('Nocturne of the Quiet Moon');
const M2 = media('Shepherd Jr.');

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
  showPoster: vi.fn(async (): Promise<ShowPosterLookup> => ({ path: null })),
});
const pass = (resolver: MediaResolver = fake(), fs: FsOps = nodeFsOps, batch?: number) =>
  new MediaPass({
    db,
    fs,
    log,
    resolver: () => resolver,
    kickDelayMs: 0,
    ...(batch ? { batch } : {}),
  });

/** Counts the to-do listing queries (`latestJobsWithoutMedia`) prepared on `db`. */
function countListings(): () => number {
  const prepare = db.prepare.bind(db);
  let n = 0;
  vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    if (sql.includes('lt.latest_media IS NULL')) n++;
    return prepare(sql);
  }) as typeof db.prepare);
  return () => n;
}

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
      { jobId: 'a-latest', libraryId: 'l1', path: '/media/tv/a.mkv', libraryRoot: '/media/tv' },
      { jobId: 'b-latest', libraryId: 'l1', path: '/media/tv/b.mkv', libraryRoot: '/media/tv' },
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

describe('show posters of episode media resolved before show posters', () => {
  /** Episode media as 0.6.0 stored it: a season poster and no `showPosterPath` key. */
  const oldEpisode = (posterPath: string | null): StoredJobMedia => ({
    kind: 'episode',
    title: 'The Bramblewood Family',
    year: 1962,
    season: 1,
    episode: 1,
    episodeTitle: null,
    source: 'filename',
    posterPath,
  });

  it('episodesWithoutShowPoster lists the media job of present episode files lacking the key', () => {
    file('f1', 'l1', '/media/tv/a.mkv');
    job('a-media', 'f1', 1, oldEpisode(null));
    job('a-latest', 'f1', 2); // no media: the listing shows the older job's
    file('f2', 'l1', '/media/tv/b.mkv');
    job('b', 'f2', 3, { ...oldEpisode(null), showPosterPath: null }); // looked up: none
    file('f3', 'l1', '/media/tv/c.mkv');
    job('c', 'f3', 4, M); // a movie
    file('f4', 'l1', '/media/tv/d.mkv');
    job('d', 'f4', 5, oldEpisode(null));
    db.prepare("UPDATE files SET gone_at = '2026-01-02T00:00:00.000Z' WHERE id = 'f4'").run();
    expect(episodesWithoutShowPoster(db)).toEqual([
      { jobId: 'a-media', libraryId: 'l1', path: '/media/tv/a.mkv', libraryRoot: '/media/tv' },
    ]);
  });

  it('setShowPosterPath only adds the key, keeping the rest, and never overwrites it', () => {
    file('f1', 'l1', '/media/tv/a.mkv');
    job('j', 'f1', 1, oldEpisode('/media/tv/season01-poster.jpg'));
    job('none', 'f1', 2);
    expect(setShowPosterPath(db, 'j', '/media/tv/poster.jpg')).toBe(true);
    expect(mediaOf('j')).toEqual({
      ...oldEpisode('/media/tv/season01-poster.jpg'),
      showPosterPath: '/media/tv/poster.jpg',
    });
    expect(setShowPosterPath(db, 'j', null)).toBe(false);
    expect(mediaOf('j')?.showPosterPath).toBe('/media/tv/poster.jpg');
    expect(setShowPosterPath(db, 'none', null)).toBe(false);
    expect(mediaOf('none')).toBeNull();
  });

  it('a pass looks each one up once from the folders (a show with none gets null), and the next pass has nothing to do', async () => {
    const root = await realpath(await tempDir('media-pass-show-'));
    const withPoster = join(root, 'The Bramblewood Family (1962)');
    const without = join(root, 'Popeye (1933)');
    for (const dir of [join(withPoster, 'Season 01'), join(without, 'Season 01')]) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(join(withPoster, 'poster.jpg'), 'img');
    await writeFile(join(withPoster, 'season01-poster.jpg'), 'img');
    library('l2', root);
    const eps = [
      ['e1', join(withPoster, 'Season 01', 'S01E01.mkv')],
      ['e2', join(withPoster, 'Season 01', 'S01E02.mkv')],
      ['p1', join(without, 'Season 01', 'S01E01.mkv')],
    ] as const;
    for (const [id, path] of eps) {
      await writeFile(path, 'x');
      file(id, 'l2', path);
      job(`j-${id}`, id, 1, oldEpisode(join(withPoster, 'season01-poster.jpg')));
    }
    const real = createMediaResolver({ fs: nodeFsOps, log });
    const resolver = { resolve: vi.fn(real.resolve), showPoster: vi.fn(real.showPoster) };
    expect(await pass(resolver).run()).toEqual({ filled: 0 });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(resolver.showPoster).toHaveBeenCalledTimes(3);
    expect(mediaOf('j-e1')).toMatchObject({
      posterPath: join(withPoster, 'season01-poster.jpg'),
      showPosterPath: join(withPoster, 'poster.jpg'),
    });
    expect(mediaOf('j-e2')?.showPosterPath).toBe(join(withPoster, 'poster.jpg'));
    expect(mediaOf('j-p1')?.showPosterPath).toBeNull();
    expect(logs).toContainEqual({ msg: 'media pass: looked up show posters', jobs: 3 });
    resolver.showPoster.mockClear();
    await pass(resolver).run();
    expect(resolver.showPoster).not.toHaveBeenCalled();
  });

  it('a show folder that cannot be read keeps the key missing; the next pass with it readable writes the path', async () => {
    const root = await realpath(await tempDir('media-pass-share-'));
    const show = join(root, 'The Bramblewood Family (1962)');
    await mkdir(join(show, 'Season 01'), { recursive: true });
    await writeFile(join(show, 'poster.jpg'), 'img');
    const path = join(show, 'Season 01', 'S01E01.mkv');
    await writeFile(path, 'x');
    library('l2', root);
    file('e1', 'l2', path);
    job('j-e1', 'e1', 1, oldEpisode(null));
    const eio = (p: string) =>
      Object.assign(new Error(`EIO: i/o error, scandir '${p}'`), { code: 'EIO' });
    const showDown: FsOps = {
      ...nodeFsOps,
      readdir: async (p) => {
        if (p === show) throw eio(p);
        return nodeFsOps.readdir(p);
      },
    };
    const make = (fs: FsOps) =>
      new MediaPass({ db, fs, log, resolver: () => createMediaResolver({ fs, log }) });
    await make(showDown).run();
    expect(mediaOf('j-e1')).not.toHaveProperty('showPosterPath');
    expect(episodesWithoutShowPoster(db).map((j) => j.jobId)).toEqual(['j-e1']);
    const warns = logs.filter(
      (l) => typeof l === 'object' && String(l.msg).includes('could not be read'),
    );
    expect(warns).toEqual([expect.objectContaining({ jobs: 1, unreachableLibraries: 0 })]);

    await make(nodeFsOps).run();
    expect(mediaOf('j-e1')?.showPosterPath).toBe(join(show, 'poster.jpg'));
  });

  it('a library root that cannot be listed skips its episodes this pass, logging once', async () => {
    const root = await realpath(await tempDir('media-pass-unmounted-'));
    library('l2', root);
    for (const n of [1, 2, 3]) {
      file(`e${n}`, 'l2', join(root, 'Show', 'Season 01', `S01E0${n}.mkv`));
      job(`j-e${n}`, `e${n}`, n, oldEpisode(null));
    }
    const unmounted: FsOps = {
      ...nodeFsOps,
      readdir: async (p) => {
        if (p === root || p.startsWith(`${root}/`)) {
          throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        }
        return nodeFsOps.readdir(p);
      },
    };
    const resolver = fake();
    await new MediaPass({ db, fs: unmounted, log, resolver: () => resolver }).run();
    expect(resolver.showPoster).not.toHaveBeenCalled();
    for (const n of [1, 2, 3]) expect(mediaOf(`j-e${n}`)).not.toHaveProperty('showPosterPath');
    const warns = logs.filter(
      (l) => typeof l === 'object' && String(l.msg).includes('could not be read'),
    );
    expect(warns).toEqual([expect.objectContaining({ jobs: 0, unreachableLibraries: 1 })]);
  });

  it('media the pass fills already carries the show poster, so it is not looked up again', async () => {
    file('f1', 'l1', '/media/tv/a.mkv');
    job('j', 'f1', 1);
    const resolver = fake(async () => ({ ...oldEpisode(null), showPosterPath: null }));
    expect(await pass(resolver).run()).toEqual({ filled: 1 });
    expect(resolver.showPoster).not.toHaveBeenCalled();
  });
});

describe('MediaPass', () => {
  it('fills media on latest jobs that lack it and on nothing else', async () => {
    file('f1', 'l1', '/media/tv/a.mkv');
    file('f2', 'l1', '/media/tv/b.mkv');
    job('f1-older', 'f1', 1);
    job('f1-latest', 'f1', 2);
    job('f2-latest', 'f2', 3, M);
    const resolver = fake(async (p) => media('Skyward', p));
    expect(await pass(resolver).run()).toEqual({ filled: 1 });
    expect(mediaOf('f1-latest')?.title).toBe('Skyward');
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

  it('one pass reads the to-do list with one query, however many batches it takes', async () => {
    for (let i = 0; i < 5; i++) {
      file(`f${i}`, 'l1', `/media/tv/${i}.mkv`);
      job(`j${i}`, `f${i}`, i);
    }
    const listings = countListings();
    const resolver = fake();
    expect(await pass(resolver, nodeFsOps, 2).run()).toEqual({ filled: 5 });
    expect(listings()).toBe(1);
    expect(resolver.resolve).toHaveBeenCalledTimes(5);
  });

  it('a burst of kicks runs one pass after the delay', async () => {
    vi.useFakeTimers();
    try {
      file('f1', 'l1', '/media/tv/a.mkv');
      job('j1', 'f1', 1);
      const resolver = fake();
      const mp = new MediaPass({ db, fs: nodeFsOps, log, resolver: () => resolver });
      const run = vi.spyOn(mp, 'run');
      for (let i = 0; i < 10; i++) {
        mp.kick();
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      await mp.idle();
      expect(run).toHaveBeenCalledTimes(1);
      expect(resolver.resolve).toHaveBeenCalledTimes(1);
      expect(mediaOf('j1')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() cancels a pass that is due but not started', async () => {
    file('f1', 'l1', '/media/tv/a.mkv');
    job('j1', 'f1', 1);
    const resolver = fake();
    const mp = new MediaPass({
      db,
      fs: nodeFsOps,
      log,
      resolver: () => resolver,
      kickDelayMs: 60_000,
    });
    mp.kick();
    mp.stop();
    await mp.idle();
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(mediaOf('j1')).toBeNull();
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
    const original = mp.run.bind(mp);
    let calls = 0;
    const run = vi.spyOn(mp, 'run').mockImplementation(async () => {
      const result = await original();
      // A job arriving after the first pass's last query: only the extra pass can fill it.
      if (++calls === 1) {
        file('f2', 'l1', '/media/tv/b.mkv');
        job('j2', 'f2', 2);
      }
      return result;
    });
    mp.kick();
    await vi.waitFor(() => expect(resolver.resolve).toHaveBeenCalledTimes(1));
    mp.kick();
    mp.kick(); // several kicks during one pass still queue only one more pass
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await mp.idle();
    expect(run).toHaveBeenCalledTimes(2);
    const filled = await Promise.all(run.mock.results.map((r) => r.value));
    expect(filled).toEqual([{ filled: 1 }, { filled: 1 }]);
    expect(mediaOf('j1')).not.toBeNull();
    expect(mediaOf('j2')).not.toBeNull();
  });

  it('stop() during a pass makes idle() resolve without resolving the remaining files', async () => {
    for (let i = 0; i < 20; i++) {
      file(`f${i}`, 'l1', `/media/tv/${i}.mkv`);
      job(`j${i}`, `f${i}`, i);
    }
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const resolver = fake(async (p) => {
      await gate;
      return media(p);
    });
    const mp = pass(resolver);
    mp.kick();
    await vi.waitFor(() => expect(resolver.resolve).toHaveBeenCalledTimes(8));
    mp.stop();
    release();
    await mp.idle();
    expect(resolver.resolve.mock.calls.length).toBeLessThan(20);
    expect(latestJobsWithoutMedia(db, 100).length).toBeGreaterThan(0);
  });

  it('kick() after stop() does not start a pass', async () => {
    file('f1', 'l1', '/media/tv/a.mkv');
    job('j1', 'f1', 1);
    const resolver = fake();
    const mp = pass(resolver);
    mp.stop();
    mp.kick();
    await mp.idle();
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(mediaOf('j1')).toBeNull();
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
      kickDelayMs: 0,
      resolver: () => {
        throw new Error('no resolver');
      },
    });
    mp.kick();
    await expect(mp.idle()).resolves.toBeUndefined();
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'media pass failed' }));
  });

  it('a write that throws ends the pass only after the other files in flight finish', async () => {
    for (let i = 0; i < 3; i++) {
      file(`f${i}`, 'l1', `/media/tv/${i}.mkv`);
      job(`j${i}`, `f${i}`, i);
    }
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let done = 0;
    const resolver = fake(async (p) => {
      // JSON.stringify throws on a BigInt: the media write fails for this file.
      if (p.endsWith('/0.mkv')) return { ...media(p), year: 1n as unknown as number };
      await gate;
      done++;
      return media(p);
    });
    const mp = pass(resolver);
    mp.kick();
    await vi.waitFor(() => expect(resolver.resolve).toHaveBeenCalledTimes(3));
    let idle = false;
    const waiting = mp.idle().then(() => {
      idle = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(idle).toBe(false);
    mp.kick(); // still running: only queues one more pass
    expect(resolver.resolve).toHaveBeenCalledTimes(3);
    release();
    await waiting;
    expect(done).toBe(2);
    expect(mediaOf('j1')).not.toBeNull();
    expect(mediaOf('j2')).not.toBeNull();
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

describe('MediaPass events', () => {
  /** A pass that records its events, with a clock the resolver can move. */
  function watched(opts: { batch?: number; resolver?: MediaResolver } = {}) {
    const events: EngineEvent[] = [];
    const clock = { ms: 0 };
    const mp = new MediaPass({
      db,
      fs: nodeFsOps,
      log,
      resolver: () => opts.resolver ?? fake(),
      kickDelayMs: 0,
      events: { publish: (e) => events.push(e) },
      notifyIntervalMs: 1000,
      clock: () => clock.ms,
      ...(opts.batch ? { batch: opts.batch } : {}),
    });
    return { mp, events, clock };
  }

  it('tells each library it wrote to, once, after a one-batch pass', async () => {
    library('l2', '/media/movies');
    library('l3', '/media/other');
    file('f1', 'l1', '/media/tv/a.mkv');
    file('f2', 'l1', '/media/tv/b.mkv');
    file('f3', 'l2', '/media/movies/c.mkv');
    file('f4', 'l3', '/media/other/d.mkv');
    job('j1', 'f1', 1);
    job('j2', 'f2', 2);
    job('j3', 'f3', 3);
    job('j4', 'f4', 4, M); // has media: nothing written to l3
    const { mp, events } = watched();
    expect(await mp.run()).toEqual({ filled: 3 });
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'library.changed', libraryId: 'l1' },
        { type: 'library.changed', libraryId: 'l2' },
      ]),
    );
  });

  it('sends nothing when it wrote nothing', async () => {
    file('f1', 'l1', '/media/tv/a.mkv');
    job('j1', 'f1', 1, M);
    const { mp, events } = watched();
    expect(await mp.run()).toEqual({ filled: 0 });
    expect(events).toEqual([]);
  });

  it('a backfill of many batches tells a library at most once per interval, and at the end', async () => {
    for (let i = 0; i < 10; i++) {
      file(`f${i}`, 'l1', `/media/tv/${i}.mkv`);
      job(`j${i}`, `f${i}`, i);
    }
    const resolver = fake();
    const { mp, events, clock } = watched({ batch: 1, resolver });
    // Each file takes 300 ms of the clock: ten batches over 3 s.
    resolver.resolve.mockImplementation(async (p: string) => {
      clock.ms += 300;
      return media(p);
    });
    expect(await mp.run()).toEqual({ filled: 10 });
    // After batch 1 (300 ms), then batches 5 (1500) and 9 (2700), then the end (3000).
    expect(events).toEqual(Array(4).fill({ type: 'library.changed', libraryId: 'l1' }));
  });

  it('tells the libraries written to before a pass fails', async () => {
    for (let i = 0; i < 3; i++) {
      file(`f${i}`, 'l1', `/media/tv/${i}.mkv`);
      job(`j${i}`, `f${i}`, i);
    }
    const resolver = fake(async (p) =>
      // JSON.stringify throws on a BigInt: the first batch fails after writing 0.mkv.
      p.endsWith('/1.mkv') ? { ...media(p), year: 1n as unknown as number } : media(p),
    );
    const { mp, events } = watched({ batch: 2, resolver });
    await expect(mp.run()).rejects.toThrow();
    expect(mediaOf('j0')).not.toBeNull();
    expect(mediaOf('j2')).toBeNull();
    expect(events).toEqual([{ type: 'library.changed', libraryId: 'l1' }]);
  });

  it('tells the library a show poster was written to, and nothing for a show with none', async () => {
    const root = await realpath(await tempDir('media-pass-show-event-'));
    const other = await realpath(await tempDir('media-pass-show-event-'));
    library('l2', root);
    library('l3', other);
    const episode: StoredJobMedia = {
      kind: 'episode',
      title: 'The Bramblewood Family',
      year: 1962,
      season: 1,
      episode: 1,
      episodeTitle: null,
      source: 'filename',
      posterPath: null,
    };
    file('e1', 'l2', join(root, 'a.mkv'));
    job('j-e1', 'e1', 1, episode);
    file('e2', 'l3', join(other, 'b.mkv'));
    job('j-e2', 'e2', 2, episode);
    const resolver = {
      resolve: vi.fn(async (p: string) => media(p)),
      showPoster: vi.fn(
        async (p: string): Promise<ShowPosterLookup> => ({
          path: p.endsWith('a.mkv') ? join(root, 'poster.jpg') : null,
        }),
      ),
    };
    const { mp, events } = watched({ resolver });
    expect(await mp.run()).toEqual({ filled: 0 });
    expect(mediaOf('j-e1')?.showPosterPath).toBe(join(root, 'poster.jpg'));
    expect(mediaOf('j-e2')?.showPosterPath).toBeNull();
    // Both writes changed a row (null is a stored answer too), so both libraries hear of it.
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'library.changed', libraryId: 'l2' },
        { type: 'library.changed', libraryId: 'l3' },
      ]),
    );
    expect(events).toHaveLength(2);
  });
});
