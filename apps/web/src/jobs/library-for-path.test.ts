import type { Library } from '@transcoda/contract';
import { describe, expect, it } from 'vitest';
import { libraryForPath } from './library-for-path.ts';

const lib = (id: string, path: string) => ({ id, name: id, path }) as unknown as Library;

describe('libraryForPath', () => {
  const tv = lib('tv', '/media/tv');
  const tv2 = lib('tv2', '/media/tv2');
  const kids = lib('kids', '/media/tv/kids');
  const slash = lib('films', '/media/films/');

  it('matches the library whose root is a path-segment prefix', () => {
    expect(libraryForPath([tv, tv2], '/media/tv/a.mkv')).toBe(tv);
    expect(libraryForPath([tv, tv2], '/media/tv2/x.mkv')).toBe(tv2);
  });

  it('does not match a root that is only a string prefix', () => {
    expect(libraryForPath([tv], '/media/tv2/x.mkv')).toBeNull();
    expect(libraryForPath([tv], '/media/other/x.mkv')).toBeNull();
  });

  it('picks the longest root when roots nest', () => {
    expect(libraryForPath([tv, kids], '/media/tv/kids/b.mkv')).toBe(kids);
    expect(libraryForPath([kids, tv], '/media/tv/kids/b.mkv')).toBe(kids);
    expect(libraryForPath([kids, tv], '/media/tv/kidsx/b.mkv')).toBe(tv);
  });

  it('accepts a root written with a trailing slash, and the root itself', () => {
    expect(libraryForPath([slash], '/media/films/c.mkv')).toBe(slash);
    expect(libraryForPath([tv], '/media/tv')).toBe(tv);
  });
});
