import { describe, expect, it } from 'vitest';
import { probeOf } from '../../engine/testing/builders.ts';
import { fileMatches, hasStream, videoIs } from './conditions.ts';
import { DAY, decide, decideCtx, NOW } from './testing.ts';

describe('core:video-is', () => {
  it('judges the video, not a JPEG poster track before it', async () => {
    const posterFirst = probeOf([
      { type: 'video', codec: 'mjpeg', width: 600, height: 900 },
      { type: 'video', codec: 'hevc', height: 1080 },
    ]);
    const result = await decide(videoIs, decideCtx(posterFirst), { codecs: ['hevc'] });
    expect(result.port).toBe('pass');
  });

  it('hevc passes; h264 with codecs [hevc] → no; no video → no', async () => {
    const hevc = probeOf([{ codec: 'hevc', height: 1080, bitrateKbps: 5000 }]);
    expect(await decide(videoIs, decideCtx(hevc), { codecs: ['hevc'] })).toEqual({
      port: 'pass',
      reason: 'video is hevc 1080p → yes',
      findings: { codec: 'hevc', height: 1080, bitrateKbps: 5000 },
    });

    const h264 = probeOf([{ codec: 'h264' }]);
    expect(await decide(videoIs, decideCtx(h264), { codecs: ['hevc'] })).toMatchObject({
      port: 'else',
      reason: 'video is h264, wanted hevc → no',
      findings: { codec: 'h264', height: null },
    });

    const audioOnly = probeOf([
      { type: 'audio' },
      { type: 'video', codec: 'png', attachedPic: true },
    ]);
    expect(await decide(videoIs, decideCtx(audioOnly))).toEqual({
      port: 'else',
      reason: 'no video stream',
      findings: {},
    });
  });

  it('checks height and bitrate (stream bitrate, else the container bitrate)', async () => {
    const big = probeOf([{ codec: 'hevc', height: 2160 }], { bitrateKbps: 20_000 });
    expect(await decide(videoIs, decideCtx(big), { maxHeight: 1080 })).toMatchObject({
      port: 'else',
      reason: 'video is hevc 2160p, wanted at most 1080p → no',
    });
    expect(await decide(videoIs, decideCtx(big), { maxBitrateKbps: 8000 })).toMatchObject({
      port: 'else',
      reason: 'video is hevc 2160p, 20.0 Mb/s, wanted at most 8.0 Mb/s → no',
      findings: { bitrateKbps: 20_000 },
    });
    expect((await decide(videoIs, decideCtx(big), { minHeight: 720 })).port).toBe('pass');

    const unknown = probeOf([{ codec: 'hevc' }], { bitrateKbps: null });
    expect(await decide(videoIs, decideCtx(unknown), { maxBitrateKbps: 8000 })).toMatchObject({
      port: 'else',
      reason: 'video is hevc, bitrate unknown, wanted at most 8.0 Mb/s → no',
      findings: { bitrateKbps: null },
    });
  });
});

describe('core:file-matches', () => {
  const probe = probeOf([{}], { sizeBytes: 600_000_000 });
  const tenDaysAgo = new Date(NOW - 10 * DAY).toISOString();

  it('matches size, age and glob, with findings', async () => {
    const ctx = decideCtx(probe, { path: '/media/tv/Show/S01/e01.mkv', mtime: tenDaysAgo });
    const result = await decide(fileMatches, ctx, {
      minSizeMb: 500,
      olderThanDays: 7,
      pathGlob: '/media/tv/**/*.mkv',
    });
    expect(result).toEqual({
      port: 'pass',
      reason: 'file matches (600.0 MB, 10 days old) → yes',
      findings: { sizeMb: 600, ageDays: 10, path: '/media/tv/Show/S01/e01.mkv' },
    });
  });

  it('names the first failing criterion', async () => {
    const ctx = decideCtx(probe, { path: '/media/movies/a.mp4', mtime: tenDaysAgo });
    expect((await decide(fileMatches, ctx, { maxSizeMb: 100 })).reason).toBe(
      'size 600.0 MB, wanted at most 100 MB → no',
    );
    expect((await decide(fileMatches, ctx, { olderThanDays: 30 })).reason).toBe(
      '10 days old, wanted older than 30 days → no',
    );
    expect((await decide(fileMatches, ctx, { pathGlob: '/media/tv/**' })).reason).toBe(
      'path does not match /media/tv/** → no',
    );
  });

  it('compares the rounded age and size it reports, and says "day" for one', async () => {
    // 1.04 days old reads (and compares) as 1 day: not older than 1 day.
    const mtime = new Date(NOW - 1.04 * DAY).toISOString();
    const ctx = decideCtx(probeOf([{}], { sizeBytes: 100_040_000 }), { mtime });
    expect(await decide(fileMatches, ctx, { olderThanDays: 1 })).toMatchObject({
      port: 'else',
      reason: '1 day old, wanted older than 1 day → no',
      findings: { ageDays: 1, sizeMb: 100 },
    });
    // 100.04 MB reads (and compares) as 100.0 MB: not over a 100 MB maximum.
    expect((await decide(fileMatches, ctx, { maxSizeMb: 100 })).port).toBe('pass');
  });
});

describe('core:has-stream', () => {
  it("finds eng subtitle with forced flag; setting 'de' matches a 'ger' tag", async () => {
    const probe = probeOf([
      { type: 'video' },
      { type: 'audio', language: 'eng' },
      { type: 'audio', language: 'ger' },
      { type: 'audio', language: 'jpn' },
      { type: 'subtitle', language: 'eng' },
      { type: 'subtitle', language: 'eng', forced: true },
    ]);
    expect(
      await decide(hasStream, decideCtx(probe), {
        streamType: 'subtitle',
        language: 'en',
        isForced: true,
      }),
    ).toEqual({
      port: 'pass',
      reason: 'subtitle: eng, eng → has eng (forced)',
      findings: { matching: [5] },
    });

    expect(await decide(hasStream, decideCtx(probe), { language: 'de' })).toEqual({
      port: 'pass',
      reason: 'audio: eng, ger, jpn → has ger',
      findings: { matching: [2] },
    });
    expect(await decide(hasStream, decideCtx(probe), { language: 'fr' })).toEqual({
      port: 'else',
      reason: 'audio: eng, ger, jpn → none matching language fr',
      findings: { matching: [] },
    });
    expect(
      (
        await decide(hasStream, decideCtx(probe), {
          language: 'en',
          codec: 'dts',
          isDefault: false,
        })
      ).reason,
    ).toBe('audio: eng, ger, jpn → none matching language en, codec dts, not default');
  });
});
