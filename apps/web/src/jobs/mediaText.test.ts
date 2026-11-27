import type { JobMedia } from '@transcoda/contract';
import { describe, expect, it } from 'vitest';
import { job } from '../test/fixtures/jobs.ts';
import { episodeCode, jobTitle, mediaSub, resultLines } from './mediaText.ts';

const media = (o: Partial<JobMedia>): JobMedia => ({
  kind: 'unknown',
  title: 'Shepherd Jr.',
  year: null,
  season: null,
  episode: null,
  episodeTitle: null,
  source: 'filename',
  poster: false,
  ...o,
});

describe('episodeCode', () => {
  it('pads season and episode to two digits', () => {
    expect(episodeCode({ season: 1, episode: 17 })).toBe('S01E17');
    expect(episodeCode({ season: 12, episode: 104 })).toBe('S12E104');
    expect(episodeCode({ season: 0, episode: 3 })).toBe('S00E03');
  });
  it('is null unless both are known', () => {
    expect(episodeCode({ season: null, episode: 3 })).toBeNull();
    expect(episodeCode({ season: 1, episode: null })).toBeNull();
  });
});

describe('jobTitle', () => {
  const ep = { kind: 'episode' as const, title: 'The Bramblewood Family' };
  it('names an episode with its code', () => {
    expect(jobTitle({ media: media({ ...ep, season: 1, episode: 17 }) })).toBe(
      'The Bramblewood Family S01E17',
    );
  });
  it('names a movie with its year when known', () => {
    expect(jobTitle({ media: media({ kind: 'movie', year: 1924 }) })).toBe('Shepherd Jr. (1924)');
    expect(jobTitle({ media: media({ kind: 'movie' }) })).toBe('Shepherd Jr.');
  });
  it('falls back to the title', () => {
    expect(jobTitle({ media: media({}) })).toBe('Shepherd Jr.');
    expect(jobTitle({ media: media(ep) })).toBe('The Bramblewood Family');
  });
});

describe('mediaSub', () => {
  it('shows the code and the episode name', () => {
    const m = media({ kind: 'episode', season: 1, episode: 17, episodeTitle: "Ada's Dilemma" });
    expect(mediaSub(m)).toEqual({ code: 'S01E17', text: "Ada's Dilemma" });
    expect(mediaSub({ ...m, episodeTitle: null })).toEqual({ code: 'S01E17', text: null });
  });
  it('shows a movie year and leaves out what is unknown', () => {
    expect(mediaSub(media({ kind: 'movie', year: 1924 }))).toEqual({ code: null, text: '1924' });
    expect(mediaSub(media({ kind: 'movie' }))).toEqual({ code: null, text: null });
    expect(mediaSub(media({}))).toEqual({ code: null, text: null });
  });
});

const finished = (before: number | null, after: number | null, over = {}) =>
  job({
    state: 'done',
    result: {
      outcome: 'done',
      beforeBytes: before,
      afterBytes: after,
      replacedTo: 'recycle',
      sourceDamaged: false,
    },
    ...over,
  });

describe('resultLines', () => {
  it('prints sizes and the saving', () => {
    expect(resultLines(finished(1_420_000_000, 610_000_000))).toEqual({
      sizes: '1.42 GB → 610 MB',
      change: 'saved 57% · 810 MB',
      tone: 'saved',
    });
  });
  it('prints growth', () => {
    expect(resultLines(finished(20_200_000, 21_149_000))).toMatchObject({
      change: 'grew 4.7% · 949 kB',
      tone: 'grew',
    });
  });
  it('uses one decimal below 10%, none from 10%', () => {
    expect(resultLines(finished(10_000, 9_025))?.change).toMatch(/^saved 9\.8% /);
    expect(resultLines(finished(10_000, 8_960))?.change).toMatch(/^saved 10% /);
  });
  it('handles equal sizes', () => {
    expect(resultLines(finished(1000, 1000))?.change).toBe('saved 0% · 0 B');
  });
  it('covers kept originals with both sizes', () => {
    expect(resultLines(finished(1000, 1200, { state: 'kept_original' }))).not.toBeNull();
  });
  it('is null when the row should show its detail line', () => {
    expect(resultLines(finished(null, 100))).toBeNull();
    expect(resultLines(finished(0, 100))).toBeNull();
    expect(resultLines(finished(1000, null))).toBeNull();
    expect(resultLines(finished(1000, 500, { state: 'failed' }))).toBeNull();
    expect(resultLines(job({ state: 'queued' }))).toBeNull();
    expect(resultLines(finished(1000, 500, { dryRun: true }))).toBeNull();
    const j = finished(1000, 500);
    if (!j.result) throw new Error('finished() gives the job a result');
    expect(resultLines({ ...j, result: { ...j.result, restored: true } })).toBeNull();
  });
});
