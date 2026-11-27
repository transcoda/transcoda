import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFileName } from '@transcoda/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprintKey } from '../../db/repos/files.ts';
import { updateJob } from '../../db/repos/jobs/jobs.ts';
import { findLibrary } from '../../db/repos/libraries.ts';
import { type FsOps, nodeFsOps } from '../../platform/fs-ops.ts';
import { fingerprintOf } from '../files/fingerprint.ts';
import type { MediaResolver } from '../media/media-info.ts';
import { QueueService } from './queue-service.ts';
import {
  base,
  cancelQueued,
  db,
  doneResult,
  events,
  input,
  lib,
  onQueued,
  outside,
  queued,
  root,
  settled,
  svc,
  useQueueService,
  workflows,
} from './testing/queue-service.ts';

useQueueService();

describe('QueueService folder listings and files.gone_at', () => {
  const goneAt = (path: string): string | null | undefined =>
    (
      db.prepare('SELECT gone_at FROM files WHERE path = ?').get(path) as
        | { gone_at: string | null }
        | undefined
    )?.gone_at;

  it('a second listing marks the file deleted from disk; the other stays present', async () => {
    const season = join(root, 'Show', 'Season 1');
    const e1 = await settled(join(season, 'e1.mkv'));
    const e2 = await settled(join(season, 'e2.mkv'));
    await queued(root);
    cancelQueued();
    expect([goneAt(e1), goneAt(e2)]).toEqual([null, null]);
    await rm(e1);
    await queued(root, { force: true });
    expect(goneAt(e1)).not.toBeNull();
    expect(goneAt(e2)).toBeNull();
  });

  it('queuing a single file never marks files outside it', async () => {
    const season = join(root, 'Show', 'Season 1');
    const e1 = await settled(join(season, 'e1.mkv'));
    const e2 = await settled(join(season, 'e2.mkv'));
    await queued(root);
    cancelQueued();
    await rm(e1);
    await queued(e2, { force: true });
    expect(goneAt(e1)).toBeNull();
  });

  it('a symlinked file is matched by its real path, so a listing clears its gone mark', async () => {
    const target = await settled(join(root, 'Show', 'Season 1', 'e1.mkv'));
    await mkdir(join(root, 'Links'));
    await symlink(target, join(root, 'Links', 'alias.mkv'));
    await queued(target);
    cancelQueued();
    db.prepare("UPDATE files SET gone_at = '2026-01-01T00:00:00.000Z' WHERE path = ?").run(target);
    await queued(join(root, 'Links'), { force: true });
    expect(goneAt(target)).toBeNull();
    expect(goneAt(join(root, 'Links', 'alias.mkv'))).toBeUndefined();
  });

  it('a file queued while a folder listing resolves its names is not marked gone by it', async () => {
    const season = join(root, 'Show', 'Season 1');
    const e1 = await settled(join(season, 'e1.mkv'));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const resolving = vi.fn();
    const fs: FsOps = {
      ...nodeFsOps,
      realpath: async (p) => {
        if (p === e1) {
          resolving();
          await gate;
        }
        return nodeFsOps.realpath(p);
      },
    };
    const slow = new QueueService({
      db,
      workflows,
      events,
      now: () => new Date(),
      fs,
      onQueued: () => {},
    });
    const listing = slow.queue(input(season));
    await vi.waitFor(() => expect(resolving).toHaveBeenCalled());
    // Arrives after the listing read the folder, before it marks: another request queues it.
    const e2 = await settled(join(season, 'e2.mkv'));
    await queued(e2);
    expect(goneAt(e2)).toBeNull();
    release();
    expect((await listing).kind).toBe('queued');
    expect(goneAt(e2)).toBeNull();
    expect(goneAt(e1)).toBeNull();
  });

  it('a queue request paused across a listing’s start still counts as seen after it', async () => {
    const season = join(root, 'Show', 'Season 1');
    const e1 = await settled(join(season, 'e1.mkv'));
    const e2 = await settled(join(season, 'e2.mkv'));
    await queued(season);
    cancelQueued();
    // The request for e2 samples its time, then waits on its media lookup.
    let resume: () => void = () => {};
    const resumed = new Promise<void>((r) => {
      resume = r;
    });
    const looking = vi.fn();
    const paused = new QueueService({
      db,
      workflows,
      events,
      now: () => new Date(),
      mediaResolver: () => ({
        resolve: async (p) => {
          looking();
          await resumed;
          return parseFileName(p, root);
        },
        showPoster: async () => ({ path: null }),
      }),
      onQueued: () => {},
    });
    const request = paused.queue(input(e2));
    await vi.waitFor(() => expect(looking).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 5));
    // A listing starts later and briefly misses e2; it waits before marking.
    let mark: () => void = () => {};
    const marking = new Promise<void>((r) => {
      mark = r;
    });
    const resolving = vi.fn();
    const lister = new QueueService({
      db,
      workflows,
      events,
      now: () => new Date(),
      fs: {
        ...nodeFsOps,
        readdir: async (p) => (await nodeFsOps.readdir(p)).filter((d) => d.name !== 'e2.mkv'),
        realpath: async (p) => {
          if (p === e1) {
            resolving();
            await marking;
          }
          return nodeFsOps.realpath(p);
        },
      },
      onQueued: () => {},
    });
    const listing = lister.queue(input(season, { force: true }));
    await vi.waitFor(() => expect(resolving).toHaveBeenCalled());
    // The request writes e2's row before the listing marks.
    resume();
    expect((await request).kind).toBe('queued');
    mark();
    expect((await listing).kind).toBe('queued');
    expect(goneAt(e2)).toBeNull();
  });

  it('files under a sub-folder whose listing failed are not marked gone', async () => {
    const season = join(root, 'Show', 'Season 1');
    const e1 = await settled(join(season, 'e1.mkv'));
    const top = await settled(join(root, 'Show', 'top.mkv'));
    await queued(root);
    cancelQueued();
    await rm(top);
    const fs: FsOps = {
      ...nodeFsOps,
      readdir: async (p) => {
        if (p === season) throw Object.assign(new Error('injected'), { code: 'EACCES' });
        return nodeFsOps.readdir(p);
      },
    };
    const faulty = new QueueService({
      db,
      workflows,
      events,
      now: () => new Date(),
      fs,
      onQueued: () => {},
    });
    const r = await faulty.queue(input(root, { force: true }));
    expect(r.kind).toBe('queued');
    expect(goneAt(e1)).toBeNull();
    expect(goneAt(top)).not.toBeNull();
  });
});

describe('QueueService libraries', () => {
  it('stores the realpath without a trailing slash', async () => {
    const other = join(base, 'movies');
    await mkdir(other);
    const alias = join(base, 'movies-alias');
    await symlink(other, alias);
    const created = await svc.createLibrary({ name: 'Movies', path: `${alias}/` });
    expect(created).toMatchObject({
      name: 'Movies',
      path: other,
      recycleFolder: null,
      processHardlinked: false,
      verifyFullDecode: false,
    });
  });

  it('verifyFullDecode defaults to false, is set on create and patched on update', async () => {
    expect(lib.verifyFullDecode).toBe(false);
    const other = join(base, 'movies');
    await mkdir(other);
    const created = await svc.createLibrary({ name: 'M', path: other, verifyFullDecode: true });
    expect(created).toMatchObject({ verifyFullDecode: true });
    expect(svc.updateLibrary(lib.id, { verifyFullDecode: true })).toMatchObject({
      verifyFullDecode: true,
    });
    expect(findLibrary(db, lib.id)?.verifyFullDecode).toBe(true);
    expect(svc.updateLibrary(lib.id, { verifyFullDecode: false })).toMatchObject({
      verifyFullDecode: false,
    });
  });

  it('watchFolder defaults to true, is set on create and patched on update; changes tell the watchers', async () => {
    const changed = vi.fn<() => void>();
    const watched = new QueueService({
      db,
      workflows,
      events,
      now: () => new Date(),
      fs: nodeFsOps,
      onQueued,
      onLibrariesChanged: changed,
    });
    expect(lib.watchFolder).toBe(true);
    const other = join(base, 'movies');
    await mkdir(other);
    const created = await watched.createLibrary({ name: 'M', path: other, watchFolder: false });
    expect(created).toMatchObject({ watchFolder: false });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(watched.updateLibrary(lib.id, { watchFolder: false })).toMatchObject({
      watchFolder: false,
    });
    expect(findLibrary(db, lib.id)?.watchFolder).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    if (!('id' in created)) throw new Error('library not created');
    expect(watched.deleteLibrary(created.id)).toBe('ok');
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('run hours: none by default, set on create, patched on update and cleared; a change ticks the scheduler', async () => {
    const night = {
      enabled: true,
      perDay: false,
      every: [0, 1, 22, 23],
      days: [[], [], [], [], [], [], []],
    };
    expect(lib.runHours).toBeNull();
    const other = join(base, 'movies');
    await mkdir(other);
    expect(await svc.createLibrary({ name: 'M', path: other, runHours: night })).toMatchObject({
      runHours: night,
    });
    onQueued.mockClear();
    expect(svc.updateLibrary(lib.id, { name: 'Renamed' })).toMatchObject({ runHours: null });
    expect(onQueued).not.toHaveBeenCalled();
    expect(svc.updateLibrary(lib.id, { runHours: night })).toMatchObject({ runHours: night });
    expect(findLibrary(db, lib.id)?.runHours).toEqual(night);
    expect(onQueued).toHaveBeenCalledTimes(1);
    expect(svc.updateLibrary(lib.id, { runHours: null })).toMatchObject({ runHours: null });
  });

  it('rejects a recycle folder equal to, containing or outside the root (final review M6)', async () => {
    const other = join(base, 'movies');
    await mkdir(other);
    const problem = {
      kind: 'path-invalid',
      reason: 'the recycle folder must be a folder inside the library root',
    };
    for (const recycleFolder of ['.', other, base, '..', join(base, 'elsewhere'), '/tmp']) {
      expect(
        await svc.createLibrary({ name: 'M', path: other, recycleFolder }),
        recycleFolder,
      ).toEqual(problem);
      expect(svc.updateLibrary(lib.id, { recycleFolder }), recycleFolder).toEqual(problem);
    }
    expect(findLibrary(db, lib.id)?.recycleFolder).toBeNull();
    expect(
      await svc.createLibrary({ name: 'M', path: other, recycleFolder: '.bin' }),
    ).toMatchObject({ recycleFolder: join(other, '.bin') });
    expect(svc.updateLibrary(lib.id, { recycleFolder: join(root, 'bin') })).toMatchObject({
      recycleFolder: join(root, 'bin'),
    });
  });

  it('rejects a missing path, a file, and nested roots', async () => {
    const file = await settled(join(base, 'file.mkv'));
    expect(await svc.createLibrary({ name: 'X', path: join(base, 'nope') })).toEqual({
      kind: 'path-invalid',
      reason: 'not found',
    });
    expect(await svc.createLibrary({ name: 'X', path: file })).toEqual({
      kind: 'path-invalid',
      reason: 'not a directory',
    });
    expect(await svc.createLibrary({ name: 'X', path: join(root, 'Show') })).toMatchObject({
      kind: 'overlaps',
      other: { id: lib.id },
    });
    expect(await svc.createLibrary({ name: 'X', path: base })).toMatchObject({
      kind: 'overlaps',
      other: { id: lib.id },
    });
    expect(await svc.createLibrary({ name: 'X', path: root })).toMatchObject({
      kind: 'overlaps',
      other: { id: lib.id },
    });
  });

  it('updates a library; unknown ids are null', () => {
    expect(svc.updateLibrary(lib.id, { name: 'Shows', processHardlinked: true })).toMatchObject({
      id: lib.id,
      name: 'Shows',
      processHardlinked: true,
    });
    expect(svc.updateLibrary('nope', { name: 'x' })).toBeNull();
  });

  it('delete is busy while a job is active, then soft-deletes', async () => {
    await settled(join(root, 'Show', 'a.mkv'));
    const r = await queued(join(root, 'Show'));
    expect(svc.deleteLibrary(lib.id)).toBe('busy');
    for (const j of r.jobs) updateJob(db, j.id, { state: 'cancelled' }, new Date());
    expect(svc.deleteLibrary(lib.id)).toBe('ok');
    expect(findLibrary(db, lib.id)?.deletedAt).not.toBeNull();
    expect(svc.deleteLibrary(lib.id)).toBe('not-found');
    expect(svc.deleteLibrary('nope')).toBe('not-found');
  });
});

describe('QueueService.browse', () => {
  beforeEach(async () => {
    await mkdir(join(root, '.transcoda-recycle'));
    await mkdir(join(root, 'Movies'));
    await settled(join(root, 'b.mkv'));
    await settled(join(root, 'a.mp4'));
    await settled(join(root, 'notes.txt'));
    await settled(join(root, 'x.mkv.transcoda-1.tmp'));
    await settled(join(root, '.transcoda-2.tmp'));
    await settled(join(outside, 'secret.mkv'));
    await symlink(outside, join(root, 'escape'));
    await symlink(join(outside, 'secret.mkv'), join(root, 'leak.mkv'));
  });

  it('lists dirs and media files at the root, hiding recycle, temp and escaping symlinks', async () => {
    const r = await svc.browse(lib.id, '');
    if (typeof r === 'string' || 'kind' in r) throw new Error('browse failed');
    expect(r.dirs).toEqual(['Movies', 'Show']);
    expect(r.files.map((f) => f.name)).toEqual(['a.mp4', 'b.mkv']);
    expect(r.files[0]).toEqual({ name: 'a.mp4', sizeBytes: 1, mtime: expect.any(String) });
  });

  it('lists a subfolder', async () => {
    await settled(join(root, 'Show', 'Season 1', 'e1.mkv'));
    expect(await svc.browse(lib.id, 'Show/Season 1')).toEqual({
      dirs: [],
      files: [{ name: 'e1.mkv', sizeBytes: 1, mtime: expect.any(String) }],
    });
    expect(await svc.browse(lib.id, 'Show/')).toEqual({ dirs: ['Season 1'], files: [] });
  });

  it('rejects paths that leave the root and the recycle folder; unknown is not-found', async () => {
    expect(await svc.browse(lib.id, '../outside')).toEqual({
      kind: 'path-rejected',
      reason: 'outside library root',
    });
    expect(await svc.browse(lib.id, '../../../../../etc')).toEqual({
      kind: 'path-rejected',
      reason: 'outside library root',
    });
    expect(await svc.browse(lib.id, '/etc')).toEqual({
      kind: 'path-rejected',
      reason: 'outside library root',
    });
    expect(await svc.browse(lib.id, 'escape')).toEqual({
      kind: 'path-rejected',
      reason: 'symlink escapes root',
    });
    expect(await svc.browse(lib.id, '.transcoda-recycle')).toEqual({
      kind: 'path-rejected',
      reason: 'in recycle folder',
    });
    expect(await svc.browse(lib.id, 'nope')).toBe('not-found');
    expect(await svc.browse(lib.id, 'b.mkv')).toBe('not-found');
    expect(await svc.browse('nope', '')).toBe('not-found');
  });

  it('a root that cannot be reached is library-unreachable, not not-found', async () => {
    await rename(root, `${root}-unmounted`);
    try {
      const unreachable = { kind: 'library-unreachable', path: lib.path };
      expect(await svc.browse(lib.id, '')).toEqual(unreachable);
      expect(await svc.browse(lib.id, 'Movies')).toEqual(unreachable);
      expect(await svc.browse('nope', '')).toBe('not-found');
    } finally {
      await rename(`${root}-unmounted`, root);
    }
  });

  it('a root that goes away after it resolved is library-unreachable; a missing subfolder of a present root stays not-found', async () => {
    let detach = false;
    const detaching = new QueueService({
      db,
      workflows,
      events,
      now: () => new Date(),
      fs: {
        ...nodeFsOps,
        realpath: async (p) => {
          const real = await nodeFsOps.realpath(p);
          // Unmounted between the root resolving and the folder being checked.
          if (detach && p === lib.path) {
            detach = false;
            await rename(root, `${root}-unmounted`);
          }
          return real;
        },
      },
      onQueued: () => {},
    });
    expect(await detaching.browse(lib.id, 'nope')).toBe('not-found');
    detach = true;
    try {
      expect(await detaching.browse(lib.id, 'Movies')).toEqual({
        kind: 'library-unreachable',
        path: lib.path,
      });
    } finally {
      await rename(`${root}-unmounted`, root);
    }
    expect(await detaching.browse(lib.id, 'Movies')).toEqual({ dirs: [], files: [] });
  });

  it('a root it may not list is library-unreachable; a subfolder it may not list stays unreadable', async () => {
    const denied = (p: string) => p === root || p === join(root, 'Movies');
    const locked = new QueueService({
      db,
      workflows,
      events,
      now: () => new Date(),
      fs: {
        ...nodeFsOps,
        readdir: async (p) => {
          if (denied(p)) throw Object.assign(new Error('injected'), { code: 'EACCES' });
          return nodeFsOps.readdir(p);
        },
      },
      onQueued: () => {},
    });
    expect(await locked.browse(lib.id, '')).toEqual({
      kind: 'library-unreachable',
      path: lib.path,
    });
    expect(await locked.browse(lib.id, 'Movies')).toEqual({
      kind: 'path-rejected',
      reason: 'unreadable',
    });
  });
});

describe('QueueService media info', () => {
  const MOVIE_NFO = '<movie><title>Shepherd Jr.</title><year>1924</year></movie>';

  /** A second service over the same db and library, with the given resolver. */
  function withResolver(mediaResolver: () => MediaResolver): QueueService {
    return new QueueService({
      db,
      workflows,
      events,
      now: () => new Date(),
      settleMinutes: 3,
      onQueued,
      mediaResolver,
    });
  }

  it('a folder with movie.nfo and poster.jpg: the job carries the nfo title and the poster', async () => {
    const dir = join(root, 'Shepherd Jr. (1924)');
    await mkdir(dir);
    await writeFile(join(dir, 'movie.nfo'), MOVIE_NFO);
    await writeFile(join(dir, 'poster.jpg'), 'img');
    const file = await settled(join(dir, 'Shepherd Jr. (1924).mkv'));
    const r = await queued(dir);
    expect(r.jobs[0]?.media).toMatchObject({
      title: 'Shepherd Jr.',
      year: 1924,
      source: 'sidecar',
      posterPath: join(dir, 'poster.jpg'),
    });
    expect(r.jobs[0]?.path).toBe(file);
  });

  it('a file with no sidecars: the media is what the file name says', async () => {
    const file = await settled(join(root, 'Show', 'The Gardener (1926).mkv'));
    const r = await queued(file);
    expect(r.jobs[0]?.media).toEqual(parseFileName(file, lib.path));
  });

  it('a skipped candidate still has media', async () => {
    const growing = join(root, 'Show', 'Season 1', 'e3.mkv');
    await writeFile(growing, 'x');
    const r = await queued(growing);
    expect(r.jobs[0]?.state).toBe('skipped');
    expect(r.jobs[0]?.media).toEqual(parseFileName(growing, lib.path));
  });

  it('a resolver that throws still queues the job, with the file-name media', async () => {
    const file = await settled(join(root, 'Show', 'The Gardener (1926).mkv'));
    const failing = withResolver(() => ({
      resolve: () => Promise.reject(new Error('boom')),
      showPoster: async () => ({ path: null }),
    }));
    const r = await failing.queue(input(file));
    if (r.kind !== 'queued') throw new Error('expected queued');
    expect(r.jobs[0]?.state).toBe('queued');
    expect(r.jobs[0]?.media).toEqual(parseFileName(file, lib.path));
  });

  it('a resolver factory that throws still queues the job, with the file-name media', async () => {
    const file = await settled(join(root, 'Show', 'The Gardener (1926).mkv'));
    const broken = withResolver(() => {
      throw new Error('x');
    });
    const r = await broken.queue(input(file));
    if (r.kind !== 'queued') throw new Error('expected queued');
    expect(r.jobs[0]?.state).toBe('queued');
    expect(r.jobs[0]?.media).toEqual(parseFileName(file, lib.path));
  });

  it('processAgain jobs get media', async () => {
    const a = await settled(join(root, 'Show', 'a.mkv'));
    const first = await queued(a);
    const job = first.jobs[0];
    if (!job) throw new Error('no job');
    updateJob(db, job.id, { state: 'done' }, new Date());
    doneResult(job.id, fingerprintKey(await fingerprintOf(a)));
    cancelQueued();
    const scan = await queued(a);
    expect(scan.jobs[0]?.state).toBe('already_processed');
    const r = await svc.processAgain(scan.run.id, { dryRun: false, createdBy: 'u2' });
    if (r.kind !== 'queued') throw new Error(`expected queued, got ${JSON.stringify(r)}`);
    expect(r.jobs[0]?.media).toEqual(parseFileName(a, lib.path));
  });

  it('resolves at most 8 files at a time', async () => {
    for (let i = 0; i < 20; i++) await settled(join(root, 'Show', `f${i}.mkv`));
    let running = 0;
    let peak = 0;
    const slow = withResolver(() => ({
      resolve: async (path, libraryRoot) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return parseFileName(path, libraryRoot);
      },
      showPoster: async () => ({ path: null }),
    }));
    const r = await slow.queue(input(join(root, 'Show')));
    if (r.kind !== 'queued') throw new Error('expected queued');
    expect(r.jobs).toHaveLength(20);
    expect(peak).toBe(8);
  });
});
