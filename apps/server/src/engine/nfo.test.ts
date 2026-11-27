import { describe, expect, it } from 'vitest';
import { readNfo } from './nfo.ts';

const none = { showTitle: null, season: null, episode: null, year: null };

describe('readNfo', () => {
  it('reads a movie', () => {
    expect(
      readNfo('<?xml version="1.0"?><movie><title>Shepherd Jr.</title><year>1924</year></movie>'),
    ).toEqual({ ...none, root: 'movie', title: 'Shepherd Jr.', year: 1924 });
  });

  it('reads a show, its year from premiered', () => {
    expect(
      readNfo(
        '<tvshow><title>The Bramblewood Family</title><premiered>1962-09-26</premiered></tvshow>',
      ),
    ).toEqual({ ...none, root: 'tvshow', title: 'The Bramblewood Family', year: 1962 });
  });

  it('reads an episode', () => {
    expect(
      readNfo(
        '<episodedetails><title>Ada&apos;s Dilemma</title><showtitle>The Bramblewood Family</showtitle><season>1</season><episode>17</episode></episodedetails>',
      ),
    ).toEqual({
      root: 'episodedetails',
      title: "Ada's Dilemma",
      showTitle: 'The Bramblewood Family',
      season: 1,
      episode: 17,
      year: null,
    });
  });

  it('skips a BOM, comments and a doctype, and reads CDATA as is', () => {
    expect(readNfo('﻿<movie><title><![CDATA[Fish & Chips]]></title></movie>')?.title).toBe(
      'Fish & Chips',
    );
    expect(
      readNfo('﻿  <?xml version="1.0"?>\n<!-- made by hand -->\n<movie><title>T</title></movie>')
        ?.title,
    ).toBe('T');
  });

  it('decodes the five entities and numeric ones', () => {
    expect(readNfo('<movie><title>A &amp; B &#233; &#xE9;</title></movie>')?.title).toBe(
      'A & B é é',
    );
    expect(readNfo('<movie><title>&lt;&gt;&quot;</title></movie>')?.title).toBe('<>"');
  });

  it('takes the first direct-looking tag and trims it', () => {
    expect(
      readNfo('<movie><actor><name>X</name></actor><title>  Real  </title></movie>')?.title,
    ).toBe('Real');
    expect(readNfo('<movie><title>Outer<b>x</b></title><title>Plain</title></movie>')?.title).toBe(
      'Plain',
    );
  });

  it('ignores empty and out-of-range values', () => {
    expect(readNfo('<movie><title></title><year>abc</year></movie>')).toEqual({
      ...none,
      root: 'movie',
      title: null,
    });
    expect(readNfo('<movie><year>99999</year><title>T</title></movie>')?.year).toBeNull();
    expect(readNfo('<movie><year>1799</year></movie>')?.year).toBeNull();
    expect(readNfo('<movie><year>2200</year></movie>')?.year).toBe(2200);
    expect(
      readNfo('<episodedetails><season>-1</season><episode>10000</episode></episodedetails>'),
    ).toMatchObject({ season: null, episode: null });
    expect(
      readNfo('<episodedetails><season>0</season><episode>9999</episode></episodedetails>'),
    ).toMatchObject({ season: 0, episode: 9999 });
  });

  it('caps a value at 300 characters', () => {
    const long = 'x'.repeat(400);
    expect(readNfo(`<movie><title>${long}</title></movie>`)?.title).toBe('x'.repeat(300));
  });

  it('returns null for anything that is not one of the three roots', () => {
    expect(readNfo('https://www.themoviedb.org/movie/992')).toBeNull();
    expect(readNfo('<video><title>x</title></video>')).toBeNull();
    expect(readNfo('')).toBeNull();
    expect(readNfo('﻿')).toBeNull();
    expect(readNfo('<?xml version="1.0"?>')).toBeNull();
  });

  it('reads the root of a truncated file without throwing', () => {
    expect(readNfo('<movie><title>Trunc')).toEqual({ ...none, root: 'movie', title: null });
    expect(readNfo('<MOVIE><title>T</title></MOVIE>')?.root).toBe('movie');
    expect(readNfo('<movie><title>&#x110000;</title></movie>')?.title).toBe('&#x110000;');
  });

  it.each([
    ['unclosed openings', `<movie>${'<title>'.repeat(150_000)}`],
    ['openings closed once at the end', `<movie>${'<title>'.repeat(150_000)}</title></movie>`],
    ['openings without >', `<movie>${'<title '.repeat(150_000)}>x</title></movie>`],
    ['nested content', `<movie>${'<title><b>'.repeat(100_000)}</title></movie>`],
    ['comments before the root', `${'<!---->'.repeat(150_000)}<movie><title>T</title></movie>`],
    ['unclosed CDATA', `<movie>${'<title><![CDATA['.repeat(60_000)}`],
  ])('reads a ~1 MB file of %s in linear time', (_what, text) => {
    expect(text.length).toBeGreaterThan(900_000);
    const started = performance.now();
    readNfo(text);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
