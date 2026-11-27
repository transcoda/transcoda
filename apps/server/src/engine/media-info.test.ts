import type { Dirent, Stats } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { StoredJobMedia } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import type { FsOps } from '../platform/fs-ops.ts';
import type { Logger } from '../platform/logger.ts';
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

/** An episode also carries `showPosterPath` (null unless given): the resolver always looks. */
const media = (m: Partial<StoredJobMedia>): StoredJobMedia => ({
  kind: 'unknown',
  title: '',
  year: null,
  season: null,
  episode: null,
  episodeTitle: null,
  source: 'filename',
  posterPath: null,
  ...(m.kind === 'episode' && { showPosterPath: null }),
  ...m,
});

const movieNfo = (title: string, year: number): string =>
  `<movie><title>${title}</title><year>${year}</year></movie>`;

describe('createMediaResolver', () => {
  it('reads a movie folder: movie.nfo and poster.jpg', async () => {
    const dir = '/lib/Shepherd Jr (1924)';
    const { fs } = fakeFs({
      [`${dir}/Shepherd.Jr.1924.720p.mkv`]: 'video',
      [`${dir}/movie.nfo`]: movieNfo('Shepherd Jr.', 1924),
      [`${dir}/poster.jpg`]: 'img',
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(`${dir}/Shepherd.Jr.1924.720p.mkv`, '/lib')).toEqual(
      media({
        kind: 'movie',
        title: 'Shepherd Jr.',
        year: 1924,
        source: 'sidecar',
        posterPath: `${dir}/poster.jpg`,
      }),
    );
  });

  it('falls back to movie.nfo when <stem>.nfo is a movie .nfo with nothing usable', async () => {
    const dir = '/lib/Shepherd Jr (1924)';
    const { fs } = fakeFs({
      [`${dir}/clip.mkv`]: 'video',
      [`${dir}/clip.nfo`]: '<movie><title></title></movie>',
      [`${dir}/movie.nfo`]: movieNfo('Shepherd Jr.', 1924),
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(`${dir}/clip.mkv`, '/lib')).toMatchObject({
      kind: 'movie',
      title: 'Shepherd Jr.',
      year: 1924,
      source: 'sidecar',
    });
  });

  it('prefers <stem>.nfo over movie.nfo and <stem>-poster over poster', async () => {
    const dir = '/lib/The Gardener';
    const { fs, calls } = fakeFs({
      [`${dir}/The Gardener.mkv`]: 'video',
      [`${dir}/The Gardener.nfo`]: movieNfo('The Gardener', 1926),
      [`${dir}/movie.nfo`]: movieNfo('Wrong', 1999),
      [`${dir}/The Gardener-poster.png`]: 'img',
      [`${dir}/poster.jpg`]: 'img',
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(`${dir}/The Gardener.mkv`, '/lib')).toEqual(
      media({
        kind: 'movie',
        title: 'The Gardener',
        year: 1926,
        source: 'sidecar',
        posterPath: `${dir}/The Gardener-poster.png`,
      }),
    );
    // <stem>.nfo is read once (not again as a movie after the episode check); movie.nfo never.
    expect(calls.filter((c) => c.op === 'readText').map((c) => c.path)).toEqual([
      `${dir}/The Gardener.nfo`,
    ]);
  });

  it('makes a file the parser could not place a movie when a movie .nfo says so', async () => {
    const { fs } = fakeFs({
      '/lib/Films/clip.mkv': 'video',
      '/lib/Films/movie.nfo': movieNfo('The Gardener', 1926),
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve('/lib/Films/clip.mkv', '/lib')).toEqual(
      media({ kind: 'movie', title: 'The Gardener', year: 1926, source: 'sidecar' }),
    );
  });

  it('makes an episode-looking file a movie when its own .nfo is a movie .nfo', async () => {
    const dir = '/lib/Films';
    const { fs } = fakeFs({
      [`${dir}/Film.S01E01.mkv`]: 'video',
      [`${dir}/Film.S01E01.nfo`]: movieNfo('The Gardener', 1926),
      [`${dir}/tvshow.nfo`]: '<tvshow><title>Wrong Show</title></tvshow>',
      [`${dir}/poster.jpg`]: 'img',
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(`${dir}/Film.S01E01.mkv`, '/lib')).toEqual(
      media({
        kind: 'movie',
        title: 'The Gardener',
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
      [`${dir}/movie.nfo`]: movieNfo('The Gardener', 1926),
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
        '<episodedetails><title>Ada&apos;s Dilemma</title><showtitle>Ignored</showtitle><season>1</season><episode>17</episode></episodedetails>',
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
        episodeTitle: "Ada's Dilemma",
        source: 'sidecar',
        posterPath: `${show}/poster.jpg`,
        showPosterPath: `${show}/poster.jpg`,
      }),
    );
  });

  it('uses the episode .nfo showtitle when there is no tvshow.nfo', async () => {
    const file = '/lib/Hollowbrook/S01E02.mkv';
    const { fs } = fakeFs({
      [file]: 'video',
      '/lib/Hollowbrook/S01E02.nfo':
        '<episodedetails><title>Getting Settled</title><showtitle>The Bramblewood Family</showtitle><season>1</season><episode>2</episode></episodedetails>',
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(file, '/lib')).toEqual(
      media({
        kind: 'episode',
        title: 'The Bramblewood Family',
        season: 1,
        episode: 2,
        episodeTitle: 'Getting Settled',
        source: 'sidecar',
      }),
    );
  });

  it('finds tvshow.nfo in the file folder itself', async () => {
    const file = '/lib/Hollowbrook/Hollowbrook 1x03.mkv';
    const { fs } = fakeFs({
      [file]: 'video',
      '/lib/Hollowbrook/tvshow.nfo':
        '<tvshow><title>The Bramblewood Family</title><premiered>1962-09-26</premiered></tvshow>',
      '/lib/Hollowbrook/folder.png': 'img',
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(file, '/lib')).toEqual(
      media({
        kind: 'episode',
        title: 'The Bramblewood Family',
        year: 1962,
        season: 1,
        episode: 3,
        source: 'sidecar',
        posterPath: '/lib/Hollowbrook/folder.png',
        showPosterPath: '/lib/Hollowbrook/folder.png',
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
        showPosterPath: '/lib/The Show (1962)/folder.jpg',
      }),
    );
  });

  it('matches names case-insensitively and returns the entry real name', async () => {
    const dir = '/lib/Shepherd Jr (1924)';
    const { fs } = fakeFs({
      [`${dir}/Shepherd Jr (1924).mkv`]: 'video',
      [`${dir}/POSTER.JPG`]: 'img',
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(`${dir}/Shepherd Jr (1924).mkv`, '/lib')).toEqual(
      media({
        kind: 'movie',
        title: 'Shepherd Jr',
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
      [`${dir}/Film.nfo`]: movieNfo('The Gardener', 1926),
      [`${dir}/film.nfo`]: movieNfo('Shepherd Jr.', 1924),
      [`${dir}/Film-poster.jpg`]: 'img',
      [`${dir}/film-poster.jpg`]: 'img',
    };
    for (const order of [files, Object.fromEntries(Object.entries(files).reverse())]) {
      const r = createMediaResolver({ fs: fakeFs(order).fs, log });
      expect(await r.resolve(`${dir}/Film.mkv`, '/lib')).toEqual(
        media({
          kind: 'movie',
          title: 'The Gardener',
          year: 1926,
          source: 'sidecar',
          posterPath: `${dir}/Film-poster.jpg`,
        }),
      );
      expect(await r.resolve(`${dir}/film.mkv`, '/lib')).toEqual(
        media({
          kind: 'movie',
          title: 'Shepherd Jr.',
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
    const one = fakeFs({ '/lib/The Gardener (1926).mkv': 'video', '/lib/poster.jpg': 'img' });
    expect(
      (
        await createMediaResolver({ fs: one.fs, log }).resolve(
          '/lib/The Gardener (1926).mkv',
          '/lib',
        )
      ).posterPath,
    ).toBeNull();
    const two = fakeFs({
      '/lib/The Gardener (1926).mkv': 'video',
      '/lib/poster.jpg': 'img',
      '/lib/The Gardener (1926)-poster.jpg': 'img',
    });
    expect(
      (
        await createMediaResolver({ fs: two.fs, log }).resolve(
          '/lib/The Gardener (1926).mkv',
          '/lib',
        )
      ).posterPath,
    ).toBe('/lib/The Gardener (1926)-poster.jpg');
  });

  it('applies movie.nfo in the library root to no file, but <stem>.nfo there still', async () => {
    const one = fakeFs({
      '/lib/The Gardener (1926).mkv': 'video',
      '/lib/movie.nfo': movieNfo('Shepherd Jr.', 1924),
    });
    expect(
      await createMediaResolver({ fs: one.fs, log }).resolve(
        '/lib/The Gardener (1926).mkv',
        '/lib',
      ),
    ).toEqual(media({ kind: 'movie', title: 'The Gardener', year: 1926 }));
    expect(one.calls.filter((c) => c.op === 'readText')).toEqual([]);
    const two = fakeFs({
      '/lib/The Gardener (1926).mkv': 'video',
      '/lib/movie.nfo': movieNfo('Shepherd Jr.', 1924),
      '/lib/The Gardener (1926).nfo': movieNfo('The Gardener', 1927),
    });
    expect(
      await createMediaResolver({ fs: two.fs, log }).resolve(
        '/lib/The Gardener (1926).mkv',
        '/lib',
      ),
    ).toEqual(media({ kind: 'movie', title: 'The Gardener', year: 1927, source: 'sidecar' }));
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
    const dir = '/lib/Shepherd Jr (1924)';
    const { fs, calls } = fakeFs({
      [`${dir}/Shepherd Jr (1924).mkv`]: 'video',
      [`${dir}/movie.nfo`]: { symlinkTo: '/lib/other/movie.nfo' },
      [`${dir}/poster.jpg`]: { symlinkTo: '/lib/other/poster.jpg' },
      '/lib/other/movie.nfo': movieNfo('Wrong', 1999),
      '/lib/other/poster.jpg': 'img',
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(`${dir}/Shepherd Jr (1924).mkv`, '/lib')).toEqual(
      media({ kind: 'movie', title: 'Shepherd Jr', year: 1924 }),
    );
    expect(calls.filter((c) => c.path.startsWith('/lib/other'))).toEqual([]);
  });

  it.each([
    ['a bare URL', 'https://www.themoviedb.org/movie/992'],
    ['a BOM-only body', '﻿'],
    ['a truncated file', '<movie><title>Trunc'],
    ['a file that is too large', { error: 'it is larger than 1 MB' }],
  ] as const)('ignores a .nfo that is %s', async (_what, nfo) => {
    const dir = '/lib/Shepherd Jr (1924)';
    const { fs } = fakeFs({
      [`${dir}/Shepherd Jr (1924).mkv`]: 'video',
      [`${dir}/movie.nfo`]: nfo,
    });
    const r = createMediaResolver({ fs, log });
    expect(await r.resolve(`${dir}/Shepherd Jr (1924).mkv`, '/lib')).toEqual(
      media({ kind: 'movie', title: 'Shepherd Jr', year: 1924 }),
    );
  });

  it('keeps the file-name result when the folder cannot be listed', async () => {
    const dir = '/lib/Shepherd Jr (1924)';
    const { fs } = fakeFs(
      { [`${dir}/Shepherd Jr (1924).mkv`]: 'video', [`${dir}/movie.nfo`]: movieNfo('X', 1999) },
      { readdirFails: [dir] },
    );
    const debug: unknown[] = [];
    const r = createMediaResolver({ fs, log: { ...log, debug: (e) => debug.push(e) } });
    expect(await r.resolve(`${dir}/Shepherd Jr (1924).mkv`, '/lib')).toEqual(
      media({ kind: 'movie', title: 'Shepherd Jr', year: 1924 }),
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
    // No show poster key: a failed read is unknown, not "none", so a later pass looks again.
    const { showPosterPath: _none, ...want } = media({
      kind: 'episode',
      title: 'Show',
      season: 1,
      episode: 1,
    });
    const got = await r.resolve('/lib/Show/Season 01/Show - S01E01.mkv', '/lib');
    expect(got).toEqual(want);
    expect(got).not.toHaveProperty('showPosterPath');
  });

  describe('episode posters: episode, then season, then show', () => {
    const show = '/lib/The Show';
    const season = `${show}/Season 03`;
    const inSeason = `${season}/The Show - S03E01.mkv`;
    const flat = `${show}/The Show - S03E01.mkv`;
    const poster = (files: Record<string, Entry>, file: string) =>
      createMediaResolver({ fs: fakeFs({ [file]: 'video', ...files }).fs, log })
        .resolve(file, '/lib')
        .then((m) => m.posterPath);

    it("takes the episode's own <stem>-poster over every other poster", async () => {
      const files = {
        [`${season}/The Show - S03E01-poster.jpg`]: 'img',
        [`${season}/poster.jpg`]: 'img',
        [`${show}/season03-poster.jpg`]: 'img',
        [`${show}/poster.jpg`]: 'img',
      };
      expect(await poster(files, inSeason)).toBe(`${season}/The Show - S03E01-poster.jpg`);
    });

    it("never takes the episode's -thumb still (a landscape frame)", async () => {
      const files = {
        [`${show}/The Show - S03E01-thumb.jpg`]: 'img',
        [`${show}/folder.jpg`]: 'img',
      };
      expect(await poster(files, flat)).toBe(`${show}/folder.jpg`);
    });

    it("takes the season folder's poster, then its folder image, over the show's", async () => {
      expect(
        await poster(
          {
            [`${season}/poster.jpg`]: 'img',
            [`${season}/folder.jpg`]: 'img',
            [`${show}/poster.jpg`]: 'img',
          },
          inSeason,
        ),
      ).toBe(`${season}/poster.jpg`);
      expect(
        await poster({ [`${season}/folder.jpg`]: 'img', [`${show}/poster.jpg`]: 'img' }, inSeason),
      ).toBe(`${season}/folder.jpg`);
    });

    it('takes seasonNN-poster in the show folder over the show poster', async () => {
      const files = {
        [`${show}/season02-poster.jpg`]: 'img',
        [`${show}/season03-poster.jpg`]: 'img',
        [`${show}/folder.jpg`]: 'img',
      };
      expect(await poster(files, flat)).toBe(`${show}/season03-poster.jpg`);
      expect(await poster(files, inSeason)).toBe(`${show}/season03-poster.jpg`);
    });

    it('uses the season from the episode .nfo over the file name', async () => {
      const files = {
        [`${show}/The Show - S03E01.nfo`]:
          '<episodedetails><title>Pilot</title><season>4</season><episode>1</episode></episodedetails>',
        [`${show}/season03-poster.jpg`]: 'img',
        [`${show}/season04-poster.png`]: 'img',
      };
      expect(await poster(files, flat)).toBe(`${show}/season04-poster.png`);
    });

    it('takes season-specials-poster for season 0', async () => {
      const file = `${show}/The Show - S00E02.mkv`;
      const files = {
        [`${show}/season-specials-poster.jpg`]: 'img',
        [`${show}/season00-poster.jpg`]: 'img',
        [`${show}/poster.jpg`]: 'img',
      };
      expect(await poster(files, file)).toBe(`${show}/season-specials-poster.jpg`);
      // Any case of the specials name still comes before season00-poster.
      const upper = {
        [`${show}/SEASON-SPECIALS-POSTER.JPG`]: 'img',
        [`${show}/season00-poster.jpg`]: 'img',
      };
      expect(await poster(upper, file)).toBe(`${show}/SEASON-SPECIALS-POSTER.JPG`);
    });

    it("falls back to the show poster when the episode's season has none", async () => {
      const files = { [`${show}/season01-poster.jpg`]: 'img', [`${show}/poster.jpg`]: 'img' };
      expect(await poster(files, flat)).toBe(`${show}/poster.jpg`);
    });

    it('a folder in the library root is no season folder: its poster is the show poster', async () => {
      // A flat show folder named like a season folder is still checked for poster.jpg once.
      const file = '/lib/Season 3/S03E01.mkv';
      expect(await poster({ '/lib/Season 3/poster.jpg': 'img' }, file)).toBe(
        '/lib/Season 3/poster.jpg',
      );
    });
  });

  describe("an episode's show poster (for the show card)", () => {
    const show = '/lib/The Show';
    const season = `${show}/Season 03`;
    const inSeason = `${season}/The Show - S03E01.mkv`;
    const resolve = (files: Record<string, Entry>, file = inSeason) =>
      createMediaResolver({ fs: fakeFs({ [file]: 'video', ...files }).fs, log }).resolve(
        file,
        '/lib',
      );

    it('names the show poster beside a more specific episode or season poster', async () => {
      const got = await resolve({
        [`${season}/poster.jpg`]: 'img',
        [`${show}/season03-poster.jpg`]: 'img',
        [`${show}/poster.jpg`]: 'img',
      });
      expect(got.posterPath).toBe(`${season}/poster.jpg`);
      expect(got.showPosterPath).toBe(`${show}/poster.jpg`);
      const own = await resolve({
        [`${season}/The Show - S03E01-poster.jpg`]: 'img',
        [`${show}/folder.jpg`]: 'img',
      });
      expect(own.posterPath).toBe(`${season}/The Show - S03E01-poster.jpg`);
      expect(own.showPosterPath).toBe(`${show}/folder.jpg`);
    });

    it('is null when the show folder has no poster of its own', async () => {
      const got = await resolve({ [`${show}/season03-poster.jpg`]: 'img' });
      expect(got.posterPath).toBe(`${show}/season03-poster.jpg`);
      expect(got.showPosterPath).toBeNull();
    });

    it('a show folder that cannot be listed is unreadable, never none, and resolve leaves the key out', async () => {
      const files: Record<string, Entry> = {
        [inSeason]: 'video',
        [`${show}/poster.jpg`]: 'img',
      };
      const failing = () =>
        createMediaResolver({ fs: fakeFs(files, { readdirFails: [show] }).fs, log });
      expect(await failing().showPoster(inSeason, '/lib')).toEqual({ unreadable: true });
      const got = await failing().resolve(inSeason, '/lib');
      expect(got.kind).toBe('episode');
      expect(got).not.toHaveProperty('showPosterPath');
      // The library root itself gone: unreadable too.
      const gone = createMediaResolver({
        fs: fakeFs({}, { readdirFails: ['/lib', show, season] }).fs,
        log,
      });
      expect(await gone.showPoster(inSeason, '/lib')).toEqual({ unreadable: true });
      // Readable with no poster: none.
      const none = createMediaResolver({ fs: fakeFs({ [inSeason]: 'video' }).fs, log });
      expect(await none.showPoster(inSeason, '/lib')).toEqual({ path: null });
    });

    it("an unlistable episode folder is unreadable even when its parent's tvshow.nfo and poster are found", async () => {
      const files: Record<string, Entry> = {
        [inSeason]: 'video',
        [`${show}/tvshow.nfo`]: '<tvshow><title>The Show</title></tvshow>',
        [`${show}/poster.jpg`]: 'img',
      };
      const failing = () =>
        createMediaResolver({ fs: fakeFs(files, { readdirFails: [season] }).fs, log });
      expect(await failing().showPoster(inSeason, '/lib')).toEqual({ unreadable: true });
      expect(await failing().resolve(inSeason, '/lib')).not.toHaveProperty('showPosterPath');
      // Readable again: the poster.
      expect(
        await createMediaResolver({ fs: fakeFs(files).fs, log }).showPoster(inSeason, '/lib'),
      ).toEqual({ path: `${show}/poster.jpg` });
    });

    it('an earlier poster candidate that cannot be checked makes a later one found unreadable', async () => {
      const { fs } = fakeFs({
        [inSeason]: 'video',
        [`${show}/poster.jpg`]: 'img',
        [`${show}/folder.jpg`]: 'img',
      });
      const posterFails: FsOps = {
        ...fs,
        lstat: async (p) => {
          if (p === `${show}/poster.jpg`) throw new Error('EIO');
          return fs.lstat(p);
        },
      };
      expect(
        await createMediaResolver({ fs: posterFails, log }).showPoster(inSeason, '/lib'),
      ).toEqual({ unreadable: true });
    });

    it('a poster candidate whose check fails, or a tvshow.nfo that cannot be read, is unreadable', async () => {
      const { fs } = fakeFs({ [inSeason]: 'video', [`${show}/poster.jpg`]: 'img' });
      const lstatFails: FsOps = {
        ...fs,
        lstat: async () => {
          throw new Error('EIO');
        },
      };
      expect(
        await createMediaResolver({ fs: lstatFails, log }).showPoster(inSeason, '/lib'),
      ).toEqual({ unreadable: true });
      const nfoFails = fakeFs({
        [inSeason]: 'video',
        [`${season}/tvshow.nfo`]: { error: 'EACCES' },
      });
      expect(
        await createMediaResolver({ fs: nfoFails.fs, log }).showPoster(inSeason, '/lib'),
      ).toEqual({ unreadable: true });
    });

    it('showPoster gives what resolve gives, reading no episode sidecar and each folder once', async () => {
      const files: Record<string, Entry> = {
        [`${show}/tvshow.nfo`]: '<tvshow><title>The Show</title></tvshow>',
        [`${show}/folder.jpg`]: 'img',
        [`${season}/poster.jpg`]: 'img',
        [`${season}/The Show - S03E01.nfo`]: '<episodedetails><title>A</title></episodedetails>',
      };
      for (const n of [1, 2, 3]) files[`${season}/The Show - S03E0${n}.mkv`] = 'video';
      const { fs, calls } = fakeFs(files);
      const r = createMediaResolver({ fs, log });
      for (const n of [1, 2, 3]) {
        expect(await r.showPoster(`${season}/The Show - S03E0${n}.mkv`, '/lib')).toEqual({
          path: `${show}/folder.jpg`,
        });
      }
      expect(calls.filter((c) => c.op === 'readText').map((c) => basename(c.path))).toEqual([
        'tvshow.nfo',
      ]);
      expect(
        calls
          .filter((c) => c.op === 'readdir')
          .map((c) => c.path)
          .sort(),
      ).toEqual([show, season]);
      expect(calls.filter((c) => c.op === 'lstat' && c.path === `${show}/folder.jpg`)).toHaveLength(
        1,
      );
      const fresh = createMediaResolver({ fs: fakeFs(files).fs, log });
      expect((await fresh.resolve(`${season}/The Show - S03E01.mkv`, '/lib')).showPosterPath).toBe(
        `${show}/folder.jpg`,
      );
      // A movie-like flat folder in the root, or a file in the root itself: none.
      const root = createMediaResolver({ fs: fakeFs({ '/lib/S01E01.mkv': 'video' }).fs, log });
      expect(await root.showPoster('/lib/S01E01.mkv', '/lib')).toEqual({ path: null });
    });

    it('a movie never gets one', async () => {
      const file = '/lib/The Gardener (1926)/The Gardener (1926).mkv';
      const got = await resolve({ '/lib/The Gardener (1926)/poster.jpg': 'img' }, file);
      expect(got.kind).toBe('movie');
      expect(got).not.toHaveProperty('showPosterPath');
    });
  });

  it('lists each folder once and reads tvshow.nfo once for a season', async () => {
    const show = '/lib/The Bramblewood Family';
    const season = `${show}/Season 01`;
    const files: Record<string, Entry> = {
      [`${show}/tvshow.nfo`]: '<tvshow><title>The Bramblewood Family</title></tvshow>',
      [`${show}/poster.jpg`]: 'img',
    };
    for (const n of [1, 2, 3]) files[`${season}/S01E0${n}.mkv`] = 'video';
    const { fs, calls } = fakeFs(files);
    const r = createMediaResolver({ fs, log });
    for (const n of [1, 2, 3]) {
      expect(await r.resolve(`${season}/S01E0${n}.mkv`, '/lib')).toMatchObject({
        title: 'The Bramblewood Family',
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
