import type { Dirent, Stats } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { StoredJobMedia } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../logger.ts';
import type { FsOps } from './fs-ops.ts';
import { createMediaResolver, NFO_MAX_BYTES } from './media-info.ts';
import { isWithin } from './paths.ts';

type Entry = string | { symlinkTo: string } | { error: string };
type Call = { op: 'readdir' | 'realpath' | 'lstat' | 'readText'; path: string };

const enoent = (p: string): Error =>
  Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });

/** An in-memory FsOps from `{ [path]: entry }`; folders are implied. Records every call. */
function fakeFs(
  files: Record<string, Entry>,
  opts: { readdirFails?: string[] } = {},
): { fs: FsOps; calls: Call[] } {
  const calls: Call[] = [];
  const isDir = (p: string): boolean =>
    Object.keys(files).some((f) => f !== p && isWithin(f, p === '/' ? '/' : p));
  const kind = (p: string): 'file' | 'symlink' | 'dir' | null => {
    const e = files[p];
    if (e === undefined) return isDir(p) ? 'dir' : null;
    return typeof e === 'object' && 'symlinkTo' in e ? 'symlink' : 'file';
  };
  const stats = (k: 'file' | 'symlink' | 'dir'): Stats =>
    ({
      isFile: () => k === 'file',
      isDirectory: () => k === 'dir',
      isSymbolicLink: () => k === 'symlink',
    }) as Stats;
  const fs = {
    async readdir(p: string): Promise<Dirent[]> {
      calls.push({ op: 'readdir', path: p });
      if (opts.readdirFails?.includes(p)) throw new Error('EIO');
      if (kind(p) !== 'dir') throw enoent(p);
      const names = new Set<string>();
      for (const f of Object.keys(files)) {
        if (!isWithin(f, p) || f === p) continue;
        const rest = f.slice(p === '/' ? 1 : p.length + 1);
        names.add(rest.split('/')[0] as string);
      }
      return [...names].map((name) => {
        const k = kind(`${p}/${name}`) ?? 'file';
        return { name, ...stats(k) } as unknown as Dirent;
      });
    },
    async realpath(p: string): Promise<string> {
      calls.push({ op: 'realpath', path: p });
      const e = files[p];
      if (e !== undefined && typeof e === 'object' && 'symlinkTo' in e) return e.symlinkTo;
      if (kind(p) === null) throw enoent(p);
      return p;
    },
    async lstat(p: string): Promise<Stats> {
      calls.push({ op: 'lstat', path: p });
      const k = kind(p);
      if (k === null) throw enoent(p);
      return stats(k);
    },
    async readText(p: string, maxBytes: number): Promise<string> {
      calls.push({ op: 'readText', path: p });
      expect(maxBytes).toBe(NFO_MAX_BYTES);
      const e = files[p];
      if (e === undefined) throw enoent(p);
      if (typeof e === 'object' && 'symlinkTo' in e) throw new Error('it is a symbolic link');
      if (typeof e === 'object') throw new Error(e.error);
      return e;
    },
  };
  return { fs: fs as unknown as FsOps, calls };
}

const log: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const media = (m: Partial<StoredJobMedia>): StoredJobMedia => ({
  kind: 'unknown',
  title: '',
  year: null,
  season: null,
  episode: null,
  episodeTitle: null,
  source: 'filename',
  posterPath: null,
  ...m,
});

const movieNfo = (title: string, year: number): string =>
  `<movie><title>${title}</title><year>${year}</year></movie>`;

describe('createMediaResolver', () => {
  it('reads a movie folder: movie.nfo and poster.jpg', async () => {
    const dir = '/lib/Sherlock Jr (1924)';
    const { fs } = fakeFs({
      [`${dir}/Sherlock.Jr.1924.720p.mkv`]: 'video',
      [`${dir}/movie.nfo`]: movieNfo('Sherlock Jr.', 1924),
      [`${dir}/poster.jpg`]: 'img',
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(`${dir}/Sherlock.Jr.1924.720p.mkv`, '/lib')).toEqual(
      media({
        kind: 'movie',
        title: 'Sherlock Jr.',
        year: 1924,
        source: 'sidecar',
        posterPath: `${dir}/poster.jpg`,
      }),
    );
  });

  it('prefers <stem>.nfo over movie.nfo and <stem>-poster over poster', async () => {
    const dir = '/lib/The General';
    const { fs, calls } = fakeFs({
      [`${dir}/The General.mkv`]: 'video',
      [`${dir}/The General.nfo`]: movieNfo('The General', 1926),
      [`${dir}/movie.nfo`]: movieNfo('Wrong', 1999),
      [`${dir}/The General-poster.png`]: 'img',
      [`${dir}/poster.jpg`]: 'img',
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(`${dir}/The General.mkv`, '/lib')).toEqual(
      media({
        kind: 'movie',
        title: 'The General',
        year: 1926,
        source: 'sidecar',
        posterPath: `${dir}/The General-poster.png`,
      }),
    );
    // <stem>.nfo is read once (not again as a movie after the episode check); movie.nfo never.
    expect(calls.filter((c) => c.op === 'readText').map((c) => c.path)).toEqual([
      `${dir}/The General.nfo`,
    ]);
  });

  it('makes a file the parser could not place a movie when a movie .nfo says so', async () => {
    const { fs } = fakeFs({
      '/lib/Films/clip.mkv': 'video',
      '/lib/Films/movie.nfo': movieNfo('The General', 1926),
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve('/lib/Films/clip.mkv', '/lib')).toEqual(
      media({ kind: 'movie', title: 'The General', year: 1926, source: 'sidecar' }),
    );
  });

  it('makes an episode-looking file a movie when its own .nfo is a movie .nfo', async () => {
    const dir = '/lib/Films';
    const { fs } = fakeFs({
      [`${dir}/Film.S01E01.mkv`]: 'video',
      [`${dir}/Film.S01E01.nfo`]: movieNfo('The General', 1926),
      [`${dir}/tvshow.nfo`]: '<tvshow><title>Wrong Show</title></tvshow>',
      [`${dir}/poster.jpg`]: 'img',
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(`${dir}/Film.S01E01.mkv`, '/lib')).toEqual(
      media({
        kind: 'movie',
        title: 'The General',
        year: 1926,
        source: 'sidecar',
        posterPath: `${dir}/poster.jpg`,
      }),
    );
  });

  it('keeps an episode-looking file an episode beside a stray movie.nfo', async () => {
    const dir = '/lib/Films';
    const { fs } = fakeFs({
      [`${dir}/Film.S01E01.mkv`]: 'video',
      [`${dir}/movie.nfo`]: movieNfo('The General', 1926),
    });
    const r = createMediaResolver({ fs, log });
    const got = await r.resolve(`${dir}/Film.S01E01.mkv`, '/lib');
    expect(got.kind).toBe('episode');
    expect(got.title).toBe('Film');
    expect(got.source).toBe('filename');
  });

  it('reads an episode: episode .nfo, tvshow.nfo and the show poster', async () => {
    const show = '/lib/Show (1962)';
    const file = `${show}/Season 01/Show - S01E17.mkv`;
    const { fs } = fakeFs({
      [file]: 'video',
      [`${show}/Season 01/Show - S01E17.nfo`]:
        '<episodedetails><title>Jed&apos;s Dilemma</title><showtitle>Ignored</showtitle><season>1</season><episode>17</episode></episodedetails>',
      [`${show}/tvshow.nfo`]: '<tvshow><title>The Show</title><year>1962</year></tvshow>',
      [`${show}/poster.jpg`]: 'img',
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(file, '/lib')).toEqual(
      media({
        kind: 'episode',
        title: 'The Show',
        year: 1962,
        season: 1,
        episode: 17,
        episodeTitle: "Jed's Dilemma",
        source: 'sidecar',
        posterPath: `${show}/poster.jpg`,
      }),
    );
  });

  it('uses the episode .nfo showtitle when there is no tvshow.nfo', async () => {
    const file = '/lib/Hillbillies/S01E02.mkv';
    const { fs } = fakeFs({
      [file]: 'video',
      '/lib/Hillbillies/S01E02.nfo':
        '<episodedetails><title>Getting Settled</title><showtitle>The Beverly Hillbillies</showtitle><season>1</season><episode>2</episode></episodedetails>',
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(file, '/lib')).toEqual(
      media({
        kind: 'episode',
        title: 'The Beverly Hillbillies',
        season: 1,
        episode: 2,
        episodeTitle: 'Getting Settled',
        source: 'sidecar',
      }),
    );
  });

  it('finds tvshow.nfo in the file folder itself', async () => {
    const file = '/lib/Hillbillies/Hillbillies 1x03.mkv';
    const { fs } = fakeFs({
      [file]: 'video',
      '/lib/Hillbillies/tvshow.nfo':
        '<tvshow><title>The Beverly Hillbillies</title><premiered>1962-09-26</premiered></tvshow>',
      '/lib/Hillbillies/folder.png': 'img',
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(file, '/lib')).toEqual(
      media({
        kind: 'episode',
        title: 'The Beverly Hillbillies',
        year: 1962,
        season: 1,
        episode: 3,
        source: 'sidecar',
        posterPath: '/lib/Hillbillies/folder.png',
      }),
    );
  });

  it('uses folder.jpg for an episode without any .nfo, keeping the file-name values', async () => {
    const file = '/lib/The Show (1962)/Season 01/The Show (1962) - S01E04.mkv';
    const { fs } = fakeFs({
      [file]: 'video',
      '/lib/The Show (1962)/folder.jpg': 'img',
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(file, '/lib')).toEqual(
      media({
        kind: 'episode',
        title: 'The Show',
        year: 1962,
        season: 1,
        episode: 4,
        source: 'filename',
        posterPath: '/lib/The Show (1962)/folder.jpg',
      }),
    );
  });

  it('matches names case-insensitively and returns the entry real name', async () => {
    const dir = '/lib/Sherlock Jr (1924)';
    const { fs } = fakeFs({
      [`${dir}/Sherlock Jr (1924).mkv`]: 'video',
      [`${dir}/POSTER.JPG`]: 'img',
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(`${dir}/Sherlock Jr (1924).mkv`, '/lib')).toEqual(
      media({
        kind: 'movie',
        title: 'Sherlock Jr',
        year: 1924,
        source: 'filename',
        posterPath: `${dir}/POSTER.JPG`,
      }),
    );
  });

  it('prefers the exact-case sidecar when two names differ only in case', async () => {
    const dir = '/lib/Films';
    const files = {
      [`${dir}/Film.mkv`]: 'video',
      [`${dir}/film.mkv`]: 'video',
      [`${dir}/Film.nfo`]: movieNfo('The General', 1926),
      [`${dir}/film.nfo`]: movieNfo('Sherlock Jr.', 1924),
      [`${dir}/Film-poster.jpg`]: 'img',
      [`${dir}/film-poster.jpg`]: 'img',
    };
    for (const order of [files, Object.fromEntries(Object.entries(files).reverse())]) {
      const r = createMediaResolver({ fs: fakeFs(order).fs, log });
      expect(await r.resolve(`${dir}/Film.mkv`, '/lib')).toEqual(
        media({
          kind: 'movie',
          title: 'The General',
          year: 1926,
          source: 'sidecar',
          posterPath: `${dir}/Film-poster.jpg`,
        }),
      );
      expect(await r.resolve(`${dir}/film.mkv`, '/lib')).toEqual(
        media({
          kind: 'movie',
          title: 'Sherlock Jr.',
          year: 1924,
          source: 'sidecar',
          posterPath: `${dir}/film-poster.jpg`,
        }),
      );
    }
  });

  it('prefers an exact-case poster of any extension over a case-insensitive match', async () => {
    const dir = '/lib/Films';
    const { fs } = fakeFs({
      [`${dir}/Film.mkv`]: 'video',
      [`${dir}/film.mkv`]: 'video',
      [`${dir}/Film-poster.png`]: 'img',
      [`${dir}/film-poster.jpg`]: 'img',
    });
    const r = createMediaResolver({ fs, log });
    expect((await r.resolve(`${dir}/Film.mkv`, '/lib')).posterPath).toBe(`${dir}/Film-poster.png`);
    expect((await r.resolve(`${dir}/film.mkv`, '/lib')).posterPath).toBe(`${dir}/film-poster.jpg`);
  });

  it('takes no stray poster for a file in the library root, only <stem>-poster', async () => {
    const one = fakeFs({ '/lib/The General (1926).mkv': 'video', '/lib/poster.jpg': 'img' });
    expect(
      (
        await createMediaResolver({ fs: one.fs, log }).resolve(
          '/lib/The General (1926).mkv',
          '/lib',
        )
      ).posterPath,
    ).toBeNull();
    const two = fakeFs({
      '/lib/The General (1926).mkv': 'video',
      '/lib/poster.jpg': 'img',
      '/lib/The General (1926)-poster.jpg': 'img',
    });
    expect(
      (
        await createMediaResolver({ fs: two.fs, log }).resolve(
          '/lib/The General (1926).mkv',
          '/lib',
        )
      ).posterPath,
    ).toBe('/lib/The General (1926)-poster.jpg');
  });

  it('applies movie.nfo in the library root to no file, but <stem>.nfo there still', async () => {
    const one = fakeFs({
      '/lib/The General (1926).mkv': 'video',
      '/lib/movie.nfo': movieNfo('Sherlock Jr.', 1924),
    });
    expect(
      await createMediaResolver({ fs: one.fs, log }).resolve('/lib/The General (1926).mkv', '/lib'),
    ).toEqual(media({ kind: 'movie', title: 'The General', year: 1926 }));
    expect(one.calls.filter((c) => c.op === 'readText')).toEqual([]);
    const two = fakeFs({
      '/lib/The General (1926).mkv': 'video',
      '/lib/movie.nfo': movieNfo('Sherlock Jr.', 1924),
      '/lib/The General (1926).nfo': movieNfo('The General', 1927),
    });
    expect(
      await createMediaResolver({ fs: two.fs, log }).resolve('/lib/The General (1926).mkv', '/lib'),
    ).toEqual(media({ kind: 'movie', title: 'The General', year: 1927, source: 'sidecar' }));
  });

  it('never reads above the library root', async () => {
    const { fs, calls } = fakeFs({
      '/media/lib/Show - S01E02.mkv': 'video',
      '/media/lib/Show/Show - S01E03.mkv': 'video',
      '/media/tvshow.nfo': '<tvshow><title>Wrong</title></tvshow>',
      '/media/poster.jpg': 'img',
      '/media/folder.jpg': 'img',
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve('/media/lib/Show - S01E02.mkv', '/media/lib')).toEqual(
      media({ kind: 'episode', title: 'Show', season: 1, episode: 2 }),
    );
    expect(await r.resolve('/media/lib/Show/Show - S01E03.mkv', '/media/lib')).toEqual(
      media({ kind: 'episode', title: 'Show', season: 1, episode: 3 }),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(isWithin(c.path, '/media/lib')).toBe(true);
  });

  it('ignores a symlinked movie.nfo and a symlinked poster', async () => {
    const dir = '/lib/Sherlock Jr (1924)';
    const { fs, calls } = fakeFs({
      [`${dir}/Sherlock Jr (1924).mkv`]: 'video',
      [`${dir}/movie.nfo`]: { symlinkTo: '/lib/other/movie.nfo' },
      [`${dir}/poster.jpg`]: { symlinkTo: '/lib/other/poster.jpg' },
      '/lib/other/movie.nfo': movieNfo('Wrong', 1999),
      '/lib/other/poster.jpg': 'img',
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(`${dir}/Sherlock Jr (1924).mkv`, '/lib')).toEqual(
      media({ kind: 'movie', title: 'Sherlock Jr', year: 1924 }),
    );
    expect(calls.filter((c) => c.path.startsWith('/lib/other'))).toEqual([]);
  });

  it.each([
    ['a bare URL', 'https://www.themoviedb.org/movie/992'],
    ['a BOM-only body', '﻿'],
    ['a truncated file', '<movie><title>Trunc'],
    ['a file that is too large', { error: 'it is larger than 1 MB' }],
  ] as const)('ignores a .nfo that is %s', async (_what, nfo) => {
    const dir = '/lib/Sherlock Jr (1924)';
    const { fs } = fakeFs({
      [`${dir}/Sherlock Jr (1924).mkv`]: 'video',
      [`${dir}/movie.nfo`]: nfo,
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(`${dir}/Sherlock Jr (1924).mkv`, '/lib')).toEqual(
      media({ kind: 'movie', title: 'Sherlock Jr', year: 1924 }),
    );
  });

  it('keeps the file-name result when the folder cannot be listed', async () => {
    const dir = '/lib/Sherlock Jr (1924)';
    const { fs } = fakeFs(
      { [`${dir}/Sherlock Jr (1924).mkv`]: 'video', [`${dir}/movie.nfo`]: movieNfo('X', 1999) },
      { readdirFails: [dir] },
    );
    const debug: unknown[] = [];
    const r = createMediaResolver({ fs, log: { ...log, debug: (e) => debug.push(e) } });
    expect(await r.resolve(`${dir}/Sherlock Jr (1924).mkv`, '/lib')).toEqual(
      media({ kind: 'movie', title: 'Sherlock Jr', year: 1924 }),
    );
    expect(debug.length).toBeGreaterThan(0);
  });

  it('never throws, even when every call fails', async () => {
    const fs = new Proxy(
      {},
      {
        get: () => async () => {
          throw new Error('boom');
        },
      },
    ) as FsOps;
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve('/lib/Show/Season 01/Show - S01E01.mkv', '/lib')).toEqual(
      media({ kind: 'episode', title: 'Show', season: 1, episode: 1 }),
    );
  });

  it('lists each folder once and reads tvshow.nfo once for a season', async () => {
    const show = '/lib/The Beverly Hillbillies';
    const season = `${show}/Season 01`;
    const files: Record<string, Entry> = {
      [`${show}/tvshow.nfo`]: '<tvshow><title>The Beverly Hillbillies</title></tvshow>',
      [`${show}/poster.jpg`]: 'img',
    };
    for (const n of [1, 2, 3]) files[`${season}/S01E0${n}.mkv`] = 'video';
    const { fs, calls } = fakeFs(files);
    const r = createMediaResolver({ fs, log });
    for (const n of [1, 2, 3]) {
      expect(await r.resolve(`${season}/S01E0${n}.mkv`, '/lib')).toMatchObject({
        title: 'The Beverly Hillbillies',
        episode: n,
        posterPath: `${show}/poster.jpg`,
      });
    }
    const readdirs = calls.filter((c) => c.op === 'readdir').map((c) => c.path);
    expect(readdirs.sort()).toEqual([show, season]);
    expect(calls.filter((c) => c.op === 'readText').map((c) => basename(c.path))).toEqual([
      'tvshow.nfo',
    ]);
    // The show poster is checked once for the folder, not once per episode.
    const posterChecks = (op: Call['op']) =>
      calls.filter((c) => c.op === op && c.path === `${show}/poster.jpg`);
    expect(posterChecks('realpath')).toHaveLength(1);
    expect(posterChecks('lstat')).toHaveLength(1);

    // A new resolver starts with an empty cache.
    const before = calls.length;
    await createMediaResolver({ fs, log }).resolve(`${season}/S01E01.mkv`, '/lib');
    const again = calls.slice(before);
    expect(
      again
        .filter((c) => c.op === 'readdir')
        .map((c) => dirname(`${c.path}/x`))
        .sort(),
    ).toEqual([show, season]);
    expect(again.filter((c) => c.op === 'readText')).toHaveLength(1);
  });
});
