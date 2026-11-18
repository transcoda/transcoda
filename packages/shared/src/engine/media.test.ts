import { describe, expect, it } from 'vitest';
import { isMediaPath, isSeasonFolder, MEDIA_EXTENSIONS, parseFileName } from './media.ts';

describe('isMediaPath', () => {
  it('is true for a media extension in any case, false for folders and other files', () => {
    expect(MEDIA_EXTENSIONS).toContain('.mkv');
    expect(isMediaPath('/media/Shows/a.mkv')).toBe(true);
    expect(isMediaPath('/media/Shows/A.MP4')).toBe(true);
    expect(isMediaPath('/media/Shows')).toBe(false);
    expect(isMediaPath('/media/Shows/')).toBe(false);
    expect(isMediaPath('/media/Shows.mkv/')).toBe(false);
    expect(isMediaPath('/media/Shows/notes.txt')).toBe(false);
    expect(isMediaPath('/media/.mkv')).toBe(false);
    expect(isMediaPath('/media/v1.0/clip')).toBe(false);
  });
});

type Expected = Partial<
  Pick<ReturnType<typeof parseFileName>, 'kind' | 'title' | 'year' | 'season' | 'episode'>
>;

describe('parseFileName', () => {
  const cases: [string, string, Expected][] = [
    [
      '/lib/The Beverly Hillbillies (1962)/Season 01/The Beverly Hillbillies (1962) - S01E17.mkv',
      '/lib',
      { kind: 'episode', title: 'The Beverly Hillbillies', year: 1962, season: 1, episode: 17 },
    ],
    [
      '/lib/Sherlock.Jr.1924.720p.H264.mkv',
      '/lib',
      { kind: 'movie', title: 'Sherlock Jr', year: 1924 },
    ],
    [
      '/lib/Bluey/Season 01/S01E04.mp4',
      '/lib',
      { kind: 'episode', title: 'Bluey', season: 1, episode: 4 },
    ],
    ['/lib/S01E04.mp4', '/lib', { kind: 'episode', title: 'S01E04', season: 1, episode: 4 }],
    ['/lib/Show/Show.1x02.avi', '/lib', { kind: 'episode', title: 'Show', season: 1, episode: 2 }],
    ['/lib/Show.S01E01E02.mkv', '/lib', { kind: 'episode', title: 'Show', season: 1, episode: 1 }],
    [
      '/lib/Show - S01E01-E02 - Pilot.mkv',
      '/lib',
      { kind: 'episode', title: 'Show', season: 1, episode: 1 },
    ],
    [
      '/lib/2001.A.Space.Odyssey.1968.mkv',
      '/lib',
      { kind: 'movie', title: '2001 A Space Odyssey', year: 1968 },
    ],
    [
      '/lib/The General (1926) [1080p].mkv',
      '/lib',
      { kind: 'movie', title: 'The General', year: 1926 },
    ],
    ['/lib/2012 (2009).mkv', '/lib', { kind: 'movie', title: '2012', year: 2009 }],
    ['/lib/1917.mkv', '/lib', { kind: 'unknown', title: '1917', year: null }],
    ['/lib/Show 2024-05-03.mkv', '/lib', { kind: 'unknown', title: 'Show 2024-05-03', year: null }],
    [
      '/lib/Home Movies 2019 Lake Trip.mkv',
      '/lib',
      { kind: 'movie', title: 'Home Movies', year: 2019 },
    ],
    ['/lib/A Proper Job (1999).mkv', '/lib', { kind: 'movie', title: 'A Proper Job', year: 1999 }],
    ['/lib/The DV Files (2001).mkv', '/lib', { kind: 'movie', title: 'The DV Files', year: 2001 }],
    ['/lib/HDR Test (2020).mkv', '/lib', { kind: 'movie', title: 'HDR Test', year: 2020 }],
    [
      '/lib/The.General.1926.PROPER.REMUX.mkv',
      '/lib',
      { kind: 'movie', title: 'The General', year: 1926 },
    ],
    [
      '/lib/The DV Files (2001)/Season 01/S01E03.mkv',
      '/lib',
      { kind: 'episode', title: 'The DV Files', year: 2001, season: 1, episode: 3 },
    ],
    ['/lib/clip_final_v2.mkv', '/lib', { kind: 'unknown', title: 'clip final v2', year: null }],
    ['/lib/1080p.mkv', '/lib', { kind: 'unknown', title: '1080p', year: null }],
    ['/lib/.mkv', '/lib', { kind: 'unknown', title: '.mkv', year: null }],
  ];

  it.each(cases)('%s (root %s)', (path, root, expected) => {
    const result = parseFileName(path, root);
    expect(result).toMatchObject(expected);
    expect(result.source).toBe('filename');
    expect(result.posterPath).toBeNull();
    expect(result.episodeTitle).toBeNull();
    expect(result.title).not.toBe('');
  });

  it('survives a 300-character base name', () => {
    const result = parseFileName(`/lib/${'a'.repeat(300)}.mkv`, '/lib');
    expect(result.title.length).toBeGreaterThan(0);
  });

  it('works without a library root', () => {
    expect(parseFileName('/a/b/Name (1950).mkv')).toMatchObject({
      kind: 'movie',
      title: 'Name',
      year: 1950,
    });
  });

  it('stays fast on long runs of brackets, dashes and slashes', () => {
    const n = 50_000;
    const started = performance.now();
    parseFileName(`/lib/${')'.repeat(n)}x.mkv`, '/lib');
    parseFileName(`/lib/a ${'- '.repeat(n)}b.mkv`, '/lib');
    parseFileName(`/lib/Show/S01E01.mkv`, `/lib${'/'.repeat(n)}x`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('never throws on odd input and never returns an empty title', () => {
    for (const p of ['', '/', '/a/', 'x', '///']) {
      expect(parseFileName(p, '/').title).not.toBe('');
    }
  });
});

describe('isSeasonFolder', () => {
  it('matches season folders only', () => {
    for (const n of ['Season 01', 'season 1', 'S01', 'Specials']) {
      expect(isSeasonFolder(n)).toBe(true);
    }
    for (const n of ['Show', 'Series']) expect(isSeasonFolder(n)).toBe(false);
  });
});
