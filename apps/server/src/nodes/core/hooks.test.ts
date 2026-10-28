import { readFileSync } from 'node:fs';
import {
  type AnyNodeDefinition,
  type BuildContext,
  type BuildModel,
  corePluginContext,
  type DataValue,
  type DecideContext,
  type FinishContext,
  type ProbeResult,
  type StreamPlan,
} from '@transcoda/sdk';
import {
  CHECK_SOURCE_TYPE,
  type JsonValue,
  portShown,
  RENDER_DAMAGED_PORT,
  RENDER_DONE_PORT,
  RENDER_TYPE,
} from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { kept, modelFromProbe, streamsOf } from '../../engine/build-model.ts';
import type { CheckSourceResult, CoreTools } from '../../engine/check-source.ts';
import { parseProbe } from '../../engine/probe.ts';
import { capsOf, fileOf, probeOf, withStream } from '../../engine/test-helpers.ts';
import {
  coverAttachments,
  encodeAudio,
  encodeVideo,
  keepLanguages,
  remux,
  reorderTracks,
  setDefaultTrack,
} from './actions.ts';
import { checkSource } from './check-source.ts';
import { fileMatches, hasStream, videoIs } from './conditions.ts';
import { moveCopy, notifyWebhook, render, replaceOriginal, sizeGate } from './finish.ts';
import { NodeHookError } from './stream-rules.ts';

const tigger: ProbeResult = parseProbe(
  JSON.parse(
    readFileSync(
      new URL('../../engine/fixtures/ffprobe-tigger-pooh.json', import.meta.url),
      'utf8',
    ),
  ),
);

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const DAY = 86_400_000;

function decideCtx(
  probe: ProbeResult,
  opts: { data?: Record<string, DataValue>; path?: string; mtime?: string } = {},
): DecideContext {
  return {
    probe,
    file: { ...fileOf(opts.path ?? '/media/movie.mkv', probe.sizeBytes), ...pick(opts.mtime) },
    data: opts.data ?? { language: 'eng' },
    capabilities: capsOf(['libx265', 'aac']),
    log: () => {},
    plugin: corePluginContext(),
    now: NOW,
  };
}

function pick(mtime: string | undefined): { mtime?: string } {
  return mtime === undefined ? {} : { mtime };
}

function buildCtx(
  probe: ProbeResult,
  opts: {
    model?: BuildModel;
    data?: Record<string, DataValue>;
    encoders?: string[];
  } = {},
): BuildContext {
  const { now: _now, ...base } = decideCtx(
    probe,
    opts.data === undefined ? {} : { data: opts.data },
  );
  return {
    ...base,
    capabilities: capsOf(opts.encoders ?? ['libx265', 'aac']),
    model: opts.model ?? modelFromProbe(probe),
  };
}

function decide(def: AnyNodeDefinition, ctx: DecideContext, raw: Record<string, unknown> = {}) {
  if (!def.decide) throw new Error(`${def.type} has no decide`);
  return def.decide(ctx, def.settings.parse(raw));
}

function build(def: AnyNodeDefinition, ctx: BuildContext, raw: Record<string, unknown> = {}) {
  if (!def.build) throw new Error(`${def.type} has no build`);
  return def.build(ctx, def.settings.parse(raw));
}

function finish(def: AnyNodeDefinition, ctx: FinishContext, raw: Record<string, unknown> = {}) {
  if (!def.finish) throw new Error(`${def.type} has no finish`);
  return def.finish(ctx, def.settings.parse(raw));
}

const indices = (streams: StreamPlan[]) => streams.map((s) => s.sourceIndex);
const languages = (streams: StreamPlan[]) => streams.map((s) => s.language);
const byIndex = (model: BuildModel, i: number) => {
  const s = model.streams.find((p) => p.sourceIndex === i);
  if (!s) throw new Error(`no stream ${i}`);
  return s;
};

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
      reason: 'video is hevc 2160p, 20000 kbps, wanted at most 8000 kbps → no',
      findings: { bitrateKbps: 20_000 },
    });
    expect((await decide(videoIs, decideCtx(big), { minHeight: 720 })).port).toBe('pass');

    const unknown = probeOf([{ codec: 'hevc' }], { bitrateKbps: null });
    expect(await decide(videoIs, decideCtx(unknown), { maxBitrateKbps: 8000 })).toMatchObject({
      port: 'else',
      reason: 'video is hevc, bitrate unknown, wanted at most 8000 kbps → no',
      findings: { bitrateKbps: null },
    });
  });
});

describe('core:file-matches', () => {
  const probe = probeOf([{}], { sizeBytes: 600 * 1024 * 1024 });
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
    const ctx = decideCtx(probeOf([{}], { sizeBytes: 100.04 * 1024 * 1024 }), { mtime });
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

describe('core:keep-languages', () => {
  it('Tigger & Pooh 20 audio with settings [en, de] → keeps eng, deu, untagged', async () => {
    const { model, reason } = await build(keepLanguages, buildCtx(tigger), {
      languages: ['en', 'de'],
    });
    expect(languages(streamsOf(model, 'audio'))).toEqual(['eng', 'deu']);
    expect(languages(streamsOf(model, 'subtitle'))).toEqual(['eng', 'deu', null]);
    // Video and the cover are untouched.
    expect(indices(streamsOf(model, 'video'))).toEqual([0, 42]);
    expect(reason).toMatch(
      /^audio: en, de, fr, .* → kept en, de; subtitles: en, .*, und → kept en, de, und; default audio now en \(#1\); default subtitle now en \(#21\)$/,
    );
    // The Turkish defaults were dropped; the first kept tracks take the flag.
    expect(indices(streamsOf(model, 'audio').filter((s) => s.default))).toEqual([1]);
    expect(indices(streamsOf(model, 'subtitle').filter((s) => s.default))).toEqual([21]);
  });

  it("'ger'-tagged audio matches 'de'", async () => {
    const probe = probeOf([
      { type: 'video' },
      { type: 'audio', language: 'eng' },
      { type: 'audio', language: 'ger' },
      { type: 'audio', language: 'jpn' },
      { type: 'subtitle', language: 'eng' },
      { type: 'subtitle', language: 'tur' },
    ]);
    const result = await build(keepLanguages, buildCtx(probe, { data: { language: 'unknown' } }), {
      languages: ['en', 'de'],
    });
    expect(indices(streamsOf(result.model, 'audio'))).toEqual([1, 2]);
    expect(result.reason).toBe('audio: en, de, ja → kept en, de; subtitles: en, tr → kept en');
  });

  it("data.language 'en' keeps 'eng'", async () => {
    const probe = probeOf([
      { type: 'audio', language: 'eng' },
      { type: 'audio', language: 'fra' },
    ]);
    const result = await build(keepLanguages, buildCtx(probe, { data: { language: 'en' } }), {
      languages: ['fr'],
    });
    expect(indices(streamsOf(result.model, 'audio'))).toEqual([0, 1]);
    expect(result.findings).toEqual({ originalLanguage: 'eng' });
  });

  it('unknown original keeps only listed', async () => {
    const probe = probeOf([
      { type: 'audio', language: 'eng' },
      { type: 'audio', language: 'jpn' },
      { type: 'audio' },
    ]);
    const result = await build(keepLanguages, buildCtx(probe, { data: { language: 'unknown' } }), {
      languages: ['en'],
      keepUntagged: false,
    });
    expect(indices(streamsOf(result.model, 'audio'))).toEqual([0]);
    expect(result.findings).toEqual({ originalLanguage: 'unknown' });
  });

  it('never drops the last audio', async () => {
    const probe = probeOf([
      { type: 'video' },
      { type: 'audio', language: 'jpn' },
      { type: 'audio', language: 'kor' },
      { type: 'subtitle', language: 'jpn' },
    ]);
    const result = await build(keepLanguages, buildCtx(probe, { data: { language: 'unknown' } }), {
      languages: ['en'],
    });
    expect(indices(streamsOf(result.model, 'audio'))).toEqual([1, 2]);
    expect(indices(streamsOf(result.model, 'subtitle'))).toEqual([]);
    expect(result.reason).toBe(
      'audio: ja, ko → kept none; subtitles: ja → kept none; kept all audio (none matched)',
    );
  });

  it('keeps untagged-only audio even with keepUntagged false', async () => {
    const probe = probeOf([{ type: 'video' }, { type: 'audio' }, { type: 'audio' }]);
    const result = await build(keepLanguages, buildCtx(probe), {
      languages: ['en'],
      keepUntagged: false,
    });
    expect(indices(streamsOf(result.model, 'audio'))).toEqual([1, 2]);
    expect(result.reason).toMatch(/; kept all audio \(none matched\)$/);
  });

  it('a dropped default hands the flag to the first kept track of its type', async () => {
    const probe = probeOf([
      { type: 'video' },
      { type: 'audio', language: 'jpn', default: true },
      { type: 'audio', language: 'eng' },
      { type: 'audio', language: 'deu' },
      { type: 'subtitle', language: 'jpn', default: true },
      { type: 'subtitle', language: 'deu' },
    ]);
    const result = await build(keepLanguages, buildCtx(probe, { data: { language: 'unknown' } }), {
      languages: ['de', 'en'],
    });
    expect(streamsOf(result.model, 'audio').map((s) => [s.sourceIndex, s.default])).toEqual([
      [2, true],
      [3, false],
    ]);
    expect(streamsOf(result.model, 'subtitle').map((s) => [s.sourceIndex, s.default])).toEqual([
      [5, true],
    ]);
    expect(result.reason).toBe(
      'audio: ja, en, de → kept en, de; subtitles: ja, de → kept de; default audio now en (#2); default subtitle now de (#5)',
    );
  });

  it('leaves a file without audio alone', async () => {
    const probe = probeOf([{ type: 'video' }, { type: 'subtitle', language: 'eng' }]);
    const result = await build(keepLanguages, buildCtx(probe), { languages: ['en'] });
    expect(kept(result.model)).toHaveLength(2);
    expect(result.reason).toBe('audio: none → kept none; subtitles: en → kept en');
  });
});

describe('core:set-default-track', () => {
  const probe = probeOf([
    { type: 'video', default: true },
    { type: 'audio', language: 'deu', default: true },
    { type: 'audio', language: 'eng' },
    { type: 'audio', language: 'jpn' },
    { type: 'subtitle', language: 'eng', default: true },
    { type: 'subtitle', language: 'deu', forced: true },
  ]);
  const defaults = (model: BuildModel, type: StreamPlan['type']) =>
    indices(streamsOf(model, type).filter((s) => s.default));

  it('exactly one default audio (original first)', async () => {
    const ctx = buildCtx(probe, { data: { language: 'jpn' } });
    const result = await build(setDefaultTrack, ctx, {
      audioLanguages: ['en', 'ja'],
      subtitleLanguages: ['de'],
    });
    expect(defaults(result.model, 'audio')).toEqual([3]);
    expect(defaults(result.model, 'subtitle')).toEqual([5]);
    expect(byIndex(result.model, 5).forced).toBe(true);
    expect(result.reason).toBe('default audio: ja (#3); default subtitle: de (#5)');
    expect(result.findings).toEqual({ audio: 3, subtitle: 5 });

    // The original is not in the list: list order wins.
    const notListed = await build(setDefaultTrack, buildCtx(probe, { data: { language: 'jpn' } }), {
      audioLanguages: ['en', 'de'],
    });
    expect(defaults(notListed.model, 'audio')).toEqual([2]);
  });

  it('says that an mp4 output keeps a default subtitle even with an empty list', () => {
    const shape = setDefaultTrack.settings as unknown as {
      shape: { subtitleLanguages: { description?: string } };
    };
    expect(shape.shape.subtitleLanguages.description).toBe(
      'Subtitle languages in order of preference; empty means no default subtitle (an mp4 output still flags its first subtitle: the mp4 muxer always marks one)',
    );
  });

  it('no default subtitle when list empty', async () => {
    const result = await build(setDefaultTrack, buildCtx(probe), { audioLanguages: ['en'] });
    expect(defaults(result.model, 'subtitle')).toEqual([]);
    expect(byIndex(result.model, 5).forced).toBe(true);
    expect(result.reason).toBe('default audio: en (#2); default subtitle: none');
  });

  it('sets no default audio when there is no audio', async () => {
    const silent = probeOf([{ type: 'video' }, { type: 'subtitle', language: 'eng' }]);
    const result = await build(setDefaultTrack, buildCtx(silent), { subtitleLanguages: ['en'] });
    expect(result.reason).toBe('default audio: none; default subtitle: en (#1)');
    expect(result.findings).toEqual({ audio: null, subtitle: 1 });
  });

  it('two-defaults fixture → one', async () => {
    const two = probeOf([
      { type: 'video', default: true },
      { type: 'audio', language: 'eng', default: true },
      { type: 'audio', language: 'deu', default: true },
    ]);
    const noMatch = await build(setDefaultTrack, buildCtx(two, { data: { language: 'unknown' } }), {
      audioLanguages: ['fr'],
    });
    // No listed language and no single existing default → the first audio.
    expect(defaults(noMatch.model, 'audio')).toEqual([1]);

    const single = withStream(modelFromProbe(two), 1, { default: false });
    const kept = await build(
      setDefaultTrack,
      buildCtx(two, { model: single, data: { language: 'unknown' } }),
      { audioLanguages: ['fr'] },
    );
    // Exactly one existing default (deu) → it stays.
    expect(defaults(kept.model, 'audio')).toEqual([2]);
  });
});

describe('core:reorder-tracks', () => {
  it('eng, deu, then others, untagged last; video stays first', async () => {
    const probe = probeOf([
      { type: 'video' },
      { type: 'audio' },
      { type: 'audio', language: 'fra' },
      { type: 'audio', language: 'ger' },
      { type: 'audio', language: 'eng' },
      { type: 'audio', language: 'spa' },
      { type: 'subtitle', language: 'deu' },
      { type: 'subtitle', language: 'eng' },
      { type: 'attachment', codec: 'ttf' },
    ]);
    const result = await build(reorderTracks, buildCtx(probe), { languages: ['en', 'de'] });
    expect(indices(kept(result.model))).toEqual([0, 4, 3, 2, 5, 1, 7, 6, 8]);
    expect(result.reason).toBe('audio: en, de, fr, es, und; subtitles: en, de');
  });
});

describe('core:cover-attachments', () => {
  const probe = probeOf([
    { type: 'video' },
    { type: 'audio', language: 'eng' },
    { type: 'subtitle', codec: 'ass', language: 'eng' },
    { type: 'attachment', codec: 'ttf' },
    { type: 'attachment', codec: 'otf' },
    { type: 'attachment', codec: 'bin_data' },
    { type: 'video', codec: 'mjpeg', attachedPic: true },
  ]);

  it('drops cover', async () => {
    const result = await build(coverAttachments, buildCtx(probe), {
      keepCover: false,
      keepAttachments: true,
    });
    expect(byIndex(result.model, 6).keep).toBe(false);
    expect(indices(kept(result.model))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.reason).toBe('dropped cover #6');
  });

  it('drops images stored as video tracks with the covers, never the real video', async () => {
    const withImage = probeOf([
      { codec: 'hevc' },
      { codec: 'hevc', imageTrack: true },
      { type: 'audio' },
    ]);
    const result = await build(coverAttachments, buildCtx(withImage), { keepCover: false });
    expect(indices(kept(result.model))).toEqual([0, 2]);
    expect(result.reason).toBe('dropped cover #1');
  });

  it('keeps ttf while an ass subtitle is kept', async () => {
    const result = await build(coverAttachments, buildCtx(probe));
    expect(indices(kept(result.model))).toEqual([0, 1, 2, 3, 4, 6]);
    expect(result.findings).toEqual({ fontsKeptForAss: true });
    expect(result.reason).toBe('dropped attachment #5; kept fonts #3, #4 for ass subtitles');
  });

  it('drops it when the ass track was dropped', async () => {
    const model = withStream(modelFromProbe(probe), 2, { keep: false });
    const result = await build(coverAttachments, buildCtx(probe, { model }));
    expect(indices(kept(result.model))).toEqual([0, 1, 6]);
    expect(result.findings).toEqual({});
    expect(result.reason).toBe('dropped attachments #3, #4, #5');
  });
});

describe('core:encode-video', () => {
  const hevc = probeOf([{ codec: 'hevc', profile: 'Main', bitDepth: 8 }, { type: 'audio' }]);
  const h264 = probeOf([{ codec: 'h264', bitDepth: 8 }, { type: 'audio' }]);

  it('already hevc → copy', async () => {
    const result = await build(encodeVideo, buildCtx(hevc));
    expect(byIndex(result.model, 0)).toMatchObject({ mode: 'copy', codec: 'hevc' });
    expect(result.reason).toBe('video already hevc → copy');
  });

  it('h264 → convert libx265 crf 24', async () => {
    const result = await build(encodeVideo, buildCtx(h264));
    expect(byIndex(result.model, 0)).toMatchObject({
      mode: 'convert',
      codec: 'hevc',
      encoder: 'libx265',
      quality: 24,
      preset: 'medium',
      pixelFormat: 'yuv420p',
      profile: null,
    });
    expect(result.reason).toBe(
      'video h264 → hevc (libx265 crf 24 medium, at most 13333k: the whole file’s bitrate)',
    );

    const tenBit = probeOf([{ codec: 'h264', bitDepth: 10 }]);
    const converted = await build(encodeVideo, buildCtx(tenBit), { skipIf: 'never' });
    expect(byIndex(converted.model, 0).pixelFormat).toBe('yuv420p10le');
  });

  it('never encodes an image stored as a video track (skipIf never)', async () => {
    const withImage = probeOf([
      { codec: 'hevc', bitDepth: 8 },
      { codec: 'hevc', bitDepth: 8, imageTrack: true },
      { type: 'audio' },
    ]);
    const result = await build(encodeVideo, buildCtx(withImage), { skipIf: 'never' });
    expect(byIndex(result.model, 0).mode).toBe('convert');
    expect(byIndex(result.model, 1)).toMatchObject({ mode: 'copy', encoder: null });
  });

  it('plays-on-all-targets with hevc + [android-tv] → copy', async () => {
    const result = await build(encodeVideo, buildCtx(hevc), {
      skipIf: 'plays-on-all-targets',
      targets: ['android-tv'],
    });
    expect(byIndex(result.model, 0).mode).toBe('copy');
    expect(result.model.targets).toEqual(['android-tv']);
    expect(result.reason).toBe('video hevc plays on all targets → copy');
  });

  it('plays-on-all-targets without targets encodes, and says why', async () => {
    const result = await build(encodeVideo, buildCtx(hevc), {
      skipIf: 'plays-on-all-targets',
      neverIncreaseBitrate: false,
    });
    expect(byIndex(result.model, 0)).toMatchObject({ mode: 'convert', encoder: 'libx265' });
    expect(result.reason).toBe(
      'video hevc → hevc (libx265 crf 24 medium); plays-on-all-targets has no targets to check',
    );
  });

  it('reads the planned codec of a stream an earlier node already converts', async () => {
    const model = withStream(modelFromProbe(h264), 0, {
      mode: 'convert',
      codec: 'hevc',
      encoder: 'libx265',
      quality: 20,
      preset: 'slow',
      pixelFormat: 'yuv420p',
    });
    const result = await build(encodeVideo, buildCtx(h264, { model }));
    expect(byIndex(result.model, 0)).toEqual(byIndex(model, 0));
    expect(result.reason).toBe('video already converted to hevc → unchanged');
  });

  it('hevc + [chrome] → NodeHookError', async () => {
    for (const skipIf of ['already-target-codec', 'plays-on-all-targets']) {
      await expect(
        build(encodeVideo, buildCtx(hevc), { skipIf, targets: ['chrome'] }),
      ).rejects.toThrow(
        new NodeHookError('target unsupported: Chrome (desktop) cannot play video #0: hevc'),
      );
    }
  });

  describe('bitrate', () => {
    const sized = probeOf([{ codec: 'h264', bitDepth: 8, bitrateKbps: 5000.7 }, { type: 'audio' }]);
    const encoders = ['libx265', 'hevc_nvenc', 'hevc_qsv', 'hevc_vaapi', 'aac'];

    it('quality mode is capped at the source stream bitrate by default', async () => {
      const result = await build(encodeVideo, buildCtx(sized));
      expect(byIndex(result.model, 0)).toMatchObject({ quality: 24, bitrateKbps: 5000 });
      expect(result.reason).toBe('video h264 → hevc (libx265 crf 24 medium, at most 5000k)');
    });

    it('quality mode without a stream bitrate is capped at the file bitrate', async () => {
      const result = await build(encodeVideo, buildCtx(h264));
      expect(byIndex(result.model, 0)).toMatchObject({ quality: 24, bitrateKbps: 13_333 });
      expect(result.reason).toBe(
        'video h264 → hevc (libx265 crf 24 medium, at most 13333k: the whole file’s bitrate)',
      );
    });

    it('an unknown source bitrate is said, not guessed', async () => {
      const unknown = probeOf([{ codec: 'h264', bitDepth: 8 }], { bitrateKbps: null });
      const result = await build(encodeVideo, buildCtx(unknown));
      expect(byIndex(result.model, 0)).toMatchObject({ quality: 24, bitrateKbps: null });
      expect(result.reason).toBe(
        'video h264 → hevc (libx265 crf 24 medium); source bitrate unknown, not capped',
      );
    });

    it('neverIncreaseBitrate off leaves quality mode uncapped, as before', async () => {
      const result = await build(encodeVideo, buildCtx(sized), { neverIncreaseBitrate: false });
      expect(byIndex(result.model, 0)).toMatchObject({ quality: 24, bitrateKbps: null });
      expect(result.reason).toBe('video h264 → hevc (libx265 crf 24 medium)');
    });

    it('bitrate mode sets a target bitrate on every encoder, auto included', async () => {
      for (const encoder of ['auto', 'libx265', 'hevc_nvenc', 'hevc_qsv', 'hevc_vaapi']) {
        const ctx = buildCtx(sized, { encoders });
        const result = await build(encodeVideo, ctx, {
          encoder,
          rateControl: 'bitrate',
          bitrateKbps: 3000,
        });
        const s = byIndex(result.model, 0);
        expect(s).toMatchObject({ mode: 'convert', quality: null, bitrateKbps: 3000 });
        expect(result.reason).toBe(`video h264 → hevc (${s.encoder} 3000k medium)`);
      }
    });

    it('a capped quality on NVENC is named cq (VBR with a quality target), as render encodes it', async () => {
      const result = await build(encodeVideo, buildCtx(sized, { encoders }), {
        encoder: 'hevc_nvenc',
      });
      expect(result.reason).toBe('video h264 → hevc (hevc_nvenc cq 24 medium, at most 5000k)');
    });

    it('bitrate mode above the source bitrate is capped at it', async () => {
      const result = await build(encodeVideo, buildCtx(sized), {
        rateControl: 'bitrate',
        bitrateKbps: 8000,
      });
      expect(byIndex(result.model, 0)).toMatchObject({ quality: null, bitrateKbps: 5000 });
      expect(result.reason).toBe(
        'video h264 → hevc (libx265 5000k medium, capped from 8000k at the source bitrate)',
      );
      const uncapped = await build(encodeVideo, buildCtx(sized), {
        rateControl: 'bitrate',
        bitrateKbps: 8000,
        neverIncreaseBitrate: false,
      });
      expect(byIndex(uncapped.model, 0)).toMatchObject({ quality: null, bitrateKbps: 8000 });
    });
  });

  it('encoder missing → NodeHookError', async () => {
    const ctx = buildCtx(h264, { encoders: ['aac'] });
    const error = await build(encodeVideo, ctx, { encoder: 'libx265' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NodeHookError);
    expect(error).toMatchObject({ message: 'encoder libx265 is not available' });
    // The default is auto.
    await expect(build(encodeVideo, ctx)).rejects.toThrow(
      new NodeHookError('no hevc encoder is available'),
    );
  });

  it('JPEG poster tracks next to the video are copied, never encoded (the Paddington 2 failure)', async () => {
    const remux = probeOf([
      { type: 'video', codec: 'h264', profile: 'High', level: 40, bitDepth: 8, height: 1080 },
      { type: 'video', codec: 'mjpeg', width: 2000, height: 3000 },
      { type: 'video', codec: 'mjpeg', width: 120, height: 176 },
      { type: 'audio', codec: 'truehd', channels: 8 },
    ]);
    const result = await build(encodeVideo, buildCtx(remux), { encoder: 'libx265' });
    expect(byIndex(result.model, 0)).toMatchObject({ mode: 'convert', codec: 'hevc' });
    expect(byIndex(result.model, 1)).toMatchObject({ mode: 'copy', codec: 'mjpeg' });
    expect(byIndex(result.model, 2)).toMatchObject({ mode: 'copy', codec: 'mjpeg' });
  });
});

describe('core:encode-audio', () => {
  const probe = probeOf([
    { type: 'video', codec: 'h264', profile: 'High', level: 40, bitDepth: 8 },
    { type: 'audio', codec: 'eac3', channels: 8, language: 'eng', default: true },
    { type: 'audio', codec: 'aac', channels: 2, language: 'deu' },
    { type: 'subtitle', language: 'eng' },
  ]);

  it('add-track appends an aac stereo copy of an 8-channel eac3 for chrome', async () => {
    const result = await build(encodeAudio, buildCtx(probe), { targets: ['chrome'] });
    const audio = streamsOf(result.model, 'audio');
    expect(audio.map((s) => [s.sourceIndex, s.codec, s.mode])).toEqual([
      [1, 'eac3', 'copy'],
      [1, 'aac', 'convert'],
      [2, 'aac', 'copy'],
    ]);
    expect(audio[1]).toMatchObject({
      encoder: 'aac',
      bitrateKbps: 160,
      channels: 2,
      language: 'eng',
      title: 'eng (aac)',
      // The default track must play on every target, so the compatible copy takes over.
      default: true,
    });
    expect(audio[0]?.default).toBe(false);
    expect(indices(kept(result.model))).toEqual([0, 1, 1, 2, 3]);
    expect(result.model.targets).toEqual(['chrome']);
    expect(result.reason).toBe(
      "audio #1 eac3 8ch: added default aac 160k 2ch copy for chrome; warning: audio #1 won't direct-play on Chrome (desktop)",
    );
    expect(result.findings).toEqual({
      unsupported: [1],
      warnings: ["audio #1 won't direct-play on Chrome (desktop)"],
    });
  });

  it('a non-default track a target cannot play only warns, under every whenUnsupported but convert', async () => {
    const second = probeOf([
      { type: 'video', codec: 'h264', profile: 'High', level: 40, bitDepth: 8 },
      { type: 'audio', codec: 'aac', channels: 2, language: 'deu', default: true },
      { type: 'audio', codec: 'eac3', channels: 8, language: 'eng' },
    ]);
    for (const whenUnsupported of ['add-track', 'fail']) {
      const ctx = buildCtx(second);
      const result = await build(encodeAudio, ctx, { targets: ['chrome'], whenUnsupported });
      expect(result.model.streams).toEqual(ctx.model.streams);
      expect(result.reason).toBe(
        "audio copied; warning: audio #2 won't direct-play on Chrome (desktop)",
      );
    }
    const converted = await build(encodeAudio, buildCtx(second), {
      targets: ['chrome'],
      whenUnsupported: 'convert',
    });
    expect(byIndex(converted.model, 2)).toMatchObject({ mode: 'convert', codec: 'aac' });
    expect(converted.findings).toEqual({ unsupported: [2] });
  });

  it('convert replaces it', async () => {
    const result = await build(encodeAudio, buildCtx(probe), {
      targets: ['chrome'],
      whenUnsupported: 'convert',
    });
    const audio = streamsOf(result.model, 'audio');
    expect(audio).toHaveLength(2);
    expect(audio[0]).toMatchObject({
      sourceIndex: 1,
      mode: 'convert',
      codec: 'aac',
      channels: 6,
      default: true,
    });
    expect(audio[1]).toMatchObject({ sourceIndex: 2, mode: 'copy' });
    expect(result.reason).toBe('audio #1 eac3 8ch: converted to aac 160k 6ch for chrome');
  });

  it('fail throws', async () => {
    await expect(
      build(encodeAudio, buildCtx(probe), { targets: ['chrome'], whenUnsupported: 'fail' }),
    ).rejects.toThrow(
      new NodeHookError('target unsupported: Chrome (desktop) cannot play audio #1: eac3'),
    );
  });

  it('reencode converts every kept audio and downmixes to stereo', async () => {
    const result = await build(encodeAudio, buildCtx(probe), {
      mode: 'reencode',
      bitrateKbps: 192,
      downmixTo: 'stereo',
    });
    expect(
      streamsOf(result.model, 'audio').map((s) => [s.mode, s.codec, s.bitrateKbps, s.channels]),
    ).toEqual([
      ['convert', 'aac', 192, 2],
      // Already stereo: no -ac, the source's two channels carry over.
      ['convert', 'aac', 192, null],
    ]);
    expect(result.reason).toBe('audio #1, #2 → aac 192k 2ch');
  });

  describe('never above the source bitrate', () => {
    const sized = probeOf([
      { type: 'video', codec: 'h264', profile: 'High', level: 40, bitDepth: 8 },
      {
        type: 'audio',
        codec: 'ac3',
        channels: 6,
        language: 'eng',
        default: true,
        bitrateKbps: 640,
      },
      { type: 'audio', codec: 'aac', channels: 2, language: 'deu', bitrateKbps: 96.4 },
      { type: 'audio', codec: 'flac', channels: 2, language: 'fra' },
    ]);

    it('reencode caps a track whose source bitrate is lower, by default', async () => {
      const result = await build(encodeAudio, buildCtx(sized), { mode: 'reencode' });
      expect(streamsOf(result.model, 'audio').map((s) => s.bitrateKbps)).toEqual([160, 96, 160]);
      expect(result.reason).toBe('audio #1, #2, #3 → aac 160k; audio #2 capped at its source 96k');
    });

    it('neverIncreaseBitrate off encodes every track at the set bitrate, as before', async () => {
      const result = await build(encodeAudio, buildCtx(sized), {
        mode: 'reencode',
        neverIncreaseBitrate: false,
      });
      expect(streamsOf(result.model, 'audio').map((s) => s.bitrateKbps)).toEqual([160, 160, 160]);
      expect(result.reason).toBe('audio #1, #2, #3 → aac 160k');
    });

    it('a converted or added track is capped too', async () => {
      const low = probeOf([
        { type: 'video', codec: 'h264', profile: 'High', level: 40, bitDepth: 8 },
        { type: 'audio', codec: 'eac3', channels: 6, default: true, bitrateKbps: 128 },
      ]);
      const converted = await build(encodeAudio, buildCtx(low), {
        targets: ['chrome'],
        whenUnsupported: 'convert',
      });
      expect(byIndex(converted.model, 1)).toMatchObject({ codec: 'aac', bitrateKbps: 128 });
      expect(converted.reason).toBe('audio #1 eac3 6ch: converted to aac 128k 6ch for chrome');
      const added = await build(encodeAudio, buildCtx(low), { targets: ['chrome'] });
      expect(streamsOf(added.model, 'audio')[1]).toMatchObject({ codec: 'aac', bitrateKbps: 128 });
    });
  });

  describe('track titles', () => {
    const titled = probeOf([
      { type: 'video', codec: 'h264', profile: 'High', level: 40, bitDepth: 8 },
      {
        type: 'audio',
        codec: 'dts',
        channels: 6,
        language: 'eng',
        default: true,
        title: 'USA / DTS-HD Master Audio / 5.1 / 48 kHz / 2823 kbps / 24-bit',
      },
      { type: 'audio', codec: 'ac3', channels: 2, language: 'eng', title: 'Commentary' },
    ]);

    it('a re-encoded track gets its title rewritten to the new format, by default', async () => {
      const result = await build(encodeAudio, buildCtx(titled), {
        mode: 'reencode',
        downmixTo: 'stereo',
      });
      expect(streamsOf(result.model, 'audio').map((s) => s.title)).toEqual([
        'USA / AAC / 2.0 / 48 kHz / 160 kbps',
        'Commentary',
      ]);
    });

    it('updateTitles off keeps every title as it was', async () => {
      const result = await build(encodeAudio, buildCtx(titled), {
        mode: 'reencode',
        downmixTo: 'stereo',
        updateTitles: false,
      });
      expect(streamsOf(result.model, 'audio').map((s) => s.title)).toEqual([
        'USA / DTS-HD Master Audio / 5.1 / 48 kHz / 2823 kbps / 24-bit',
        'Commentary',
      ]);
    });

    it('a track converted for a target is retitled; an added copy keeps its own name', async () => {
      const converted = await build(encodeAudio, buildCtx(titled), {
        targets: ['chrome'],
        whenUnsupported: 'convert',
      });
      expect(byIndex(converted.model, 1).title).toBe('USA / AAC / 5.1 / 48 kHz / 160 kbps');
      const added = await build(encodeAudio, buildCtx(titled), { targets: ['chrome'] });
      expect(streamsOf(added.model, 'audio').map((s) => s.title)).toEqual([
        'USA / DTS-HD Master Audio / 5.1 / 48 kHz / 2823 kbps / 24-bit',
        'eng (aac)',
        'Commentary',
      ]);
    });
  });

  it('copy with targets that play every track changes nothing', async () => {
    const ctx = buildCtx(probe);
    const result = await build(encodeAudio, ctx, { targets: ['android-tv'] });
    expect(result.model.streams).toEqual(ctx.model.streams);
    expect(result.reason).toBe('audio copied');
  });
});

describe('core:remux', () => {
  const probe = probeOf([
    { type: 'video' },
    { type: 'audio', language: 'eng' },
    { type: 'subtitle', codec: 'subrip', language: 'eng' },
    { type: 'subtitle', codec: 'ass', language: 'deu' },
    { type: 'subtitle', codec: 'hdmv_pgs_subtitle', language: 'eng' },
    { type: 'subtitle', codec: 'dvd_subtitle', language: 'fra' },
    { type: 'attachment', codec: 'ttf' },
  ]);

  it('mp4 converts subrip→mov_text and drops pgs under drop-incompatible', async () => {
    const result = await build(remux, buildCtx(probe), {
      container: 'mp4',
      subtitleConversion: 'drop-incompatible',
    });
    expect(result.model.container).toBe('mp4');
    expect(
      streamsOf(result.model, 'subtitle').map((s) => [s.sourceIndex, s.codec, s.mode]),
    ).toEqual([
      [2, 'mov_text', 'convert'],
      [3, 'mov_text', 'convert'],
    ]);
    expect(indices(kept(result.model))).toEqual([0, 1, 2, 3]);
    expect(result.reason).toBe(
      "container mkv → mp4; subtitles #2, #3 → mov_text; dropped (container can't hold it): #4 hdmv_pgs_subtitle, #5 dvd_subtitle, #6 ttf",
    );
  });

  it('keep throws', async () => {
    for (const subtitleConversion of ['keep', 'convert']) {
      await expect(
        build(remux, buildCtx(probe), { container: 'mp4', subtitleConversion }),
      ).rejects.toThrow(
        new NodeHookError(
          'mp4 cannot carry these subtitles: #4 hdmv_pgs_subtitle, #5 dvd_subtitle (no OCR; use drop-incompatible)',
        ),
      );
    }
  });

  it('mkv converts mov_text→subrip and drops data streams', async () => {
    const mp4 = probeOf(
      [
        { type: 'video' },
        { type: 'subtitle', codec: 'mov_text', language: 'eng' },
        { type: 'data', codec: 'bin_data' },
      ],
      { container: 'mp4' },
    );
    const result = await build(remux, buildCtx(mp4), { container: 'mkv' });
    expect(byIndex(result.model, 1)).toMatchObject({ mode: 'convert', codec: 'subrip' });
    expect(byIndex(result.model, 2).keep).toBe(false);
    expect(result.reason).toBe(
      "container mp4 → mkv; subtitles #1 → subrip; dropped (container can't hold it): #2 bin_data",
    );
  });

  it('drops subtitles a target cannot play under drop-incompatible, else throws', async () => {
    const pgs = probeOf([
      { type: 'video' },
      { type: 'subtitle', codec: 'hdmv_pgs_subtitle', language: 'eng', default: true },
      { type: 'subtitle', codec: 'hdmv_pgs_subtitle', language: 'deu' },
    ]);
    const dropped = await build(remux, buildCtx(pgs), {
      targets: ['chrome'],
      subtitleConversion: 'drop-incompatible',
    });
    expect(byIndex(dropped.model, 1).keep).toBe(false);
    expect(byIndex(dropped.model, 2).keep).toBe(false);
    expect(dropped.model.targets).toEqual(['chrome']);
    expect(dropped.reason).toBe(
      'container mkv; dropped subtitles the targets cannot play: #1 hdmv_pgs_subtitle, #2 hdmv_pgs_subtitle',
    );
    // Not the default: kept with a warning.
    const second = withStream(modelFromProbe(pgs), 1, { keep: false });
    const warned = await build(remux, buildCtx(pgs, { model: second }), { targets: ['chrome'] });
    expect(byIndex(warned.model, 2).keep).toBe(true);
    expect(warned.reason).toBe(
      "container mkv; warning: subtitle #2 won't direct-play on Chrome (desktop)",
    );
    expect(warned.findings).toEqual({
      warnings: ["subtitle #2 won't direct-play on Chrome (desktop)"],
    });
    await expect(build(remux, buildCtx(pgs), { targets: ['chrome'] })).rejects.toThrow(
      new NodeHookError(
        'target unsupported: Chrome (desktop) cannot play subtitle #1: hdmv_pgs_subtitle',
      ),
    );
  });
});

describe('hooks never mutate ctx.model', () => {
  const probe = probeOf([
    { type: 'video', codec: 'h264', bitDepth: 8 },
    { type: 'video', codec: 'png', attachedPic: true },
    { type: 'audio', codec: 'eac3', channels: 8, language: 'jpn', default: true },
    { type: 'audio', codec: 'aac', channels: 2, language: 'eng' },
    { type: 'subtitle', codec: 'ass', language: 'eng', default: true },
    { type: 'subtitle', codec: 'hdmv_pgs_subtitle', language: 'jpn' },
    { type: 'attachment', codec: 'ttf' },
  ]);
  const cases: [AnyNodeDefinition, Record<string, unknown>][] = [
    [keepLanguages, { languages: ['en'] }],
    [setDefaultTrack, { audioLanguages: ['en'], subtitleLanguages: ['en'] }],
    [reorderTracks, { languages: ['en'] }],
    [coverAttachments, { keepCover: false }],
    [encodeVideo, {}],
    [encodeAudio, { mode: 'reencode', downmixTo: 'stereo' }],
    [encodeAudio, { targets: ['chrome'] }],
    [remux, { container: 'mp4', subtitleConversion: 'drop-incompatible' }],
  ];

  it.each(cases.map(([def, raw]) => [def.type, def, raw] as const))(
    '%s works on a copy',
    async (_, def, raw) => {
      const ctx = buildCtx(probe, { data: { language: 'unknown' } });
      const before = structuredClone(ctx.model);
      const result = await build(def, ctx, raw);
      expect(ctx.model).toEqual(before);
      expect(result.model).not.toBe(ctx.model);
    },
  );
});

describe('finish nodes', () => {
  it('finish nodes return their actions', async () => {
    const probe = probeOf([{}]);
    const ctx: FinishContext = { ...decideCtx(probe), model: modelFromProbe(probe) };
    expect(await finish(sizeGate, ctx)).toEqual({
      actions: [{ kind: 'size-gate', minSavingPercent: 10 }],
      reason: 'size gate: at least 10% smaller',
    });
    expect(await finish(replaceOriginal, ctx)).toEqual({
      actions: [{ kind: 'replace', recycleFolder: null }],
      reason: 'replace the original (recycle folder: library default)',
    });
    expect((await finish(replaceOriginal, ctx, { recycleFolder: '/r' })).actions).toEqual([
      { kind: 'replace', recycleFolder: '/r' },
    ]);
    expect(await finish(moveCopy, ctx, { outputRoot: '/out' })).toEqual({
      actions: [{ kind: 'move-copy', mode: 'copy', outputRoot: '/out' }],
      reason: 'copy the result to /out',
    });
    // The webhook URL may carry a token, so the reason never shows it.
    expect(await finish(notifyWebhook, ctx, { url: 'https://hooks.example/t?token=abc' })).toEqual({
      actions: [{ kind: 'notify', url: 'https://hooks.example/t?token=abc', method: 'POST' }],
      reason: 'notify webhook (POST)',
    });
  });

  it('render: Quality check off → one render action, Damaged hidden; on → the action carries qualityCheck true and Damaged is shown', async () => {
    const probe = probeOf([{}]);
    const ctx: FinishContext = { ...decideCtx(probe), model: modelFromProbe(probe) };
    expect(render).toMatchObject({ kind: 'finish', finishPhase: 'render', type: RENDER_TYPE });
    const shown = (settings: JsonValue) =>
      render.outputs.filter((p) => portShown(p, settings)).map((p) => p.id);
    expect(await finish(render, ctx)).toEqual({
      actions: [{ kind: 'render', qualityCheck: false }],
      reason: 'render',
    });
    expect(shown(render.settings.parse({}) as JsonValue)).toEqual([RENDER_DONE_PORT]);
    expect(await finish(render, ctx, { qualityCheck: true })).toEqual({
      actions: [{ kind: 'render', qualityCheck: true }],
      reason: 'render; a damaged source continues on Damaged',
    });
    expect(shown({ qualityCheck: true })).toEqual([RENDER_DONE_PORT, RENDER_DAMAGED_PORT]);
  });

  it('check-source: ok → port ok; damaged → port damaged with findings; error → throws retryable', async () => {
    const probe = probeOf([{}]);
    const asked: boolean[] = [];
    const withCore = (r: CheckSourceResult): DecideContext => {
      const core: CoreTools = {
        async checkSource({ decodeVideo }) {
          asked.push(decodeVideo);
          return r;
        },
      };
      return { ...decideCtx(probe), core } as DecideContext;
    };
    expect(checkSource).toMatchObject({ kind: 'condition', type: CHECK_SOURCE_TYPE });
    expect(checkSource.outputs.map((p) => p.id)).toEqual(['ok', 'damaged']);
    expect(await decide(checkSource, withCore({ kind: 'ok', warnings: [] }))).toEqual({
      port: 'ok',
      reason: 'source reads clean',
      findings: { warnings: [] },
    });
    expect(
      await decide(
        checkSource,
        withCore({ kind: 'ok', warnings: ['ends 5 s short of the declared 1:40'] }),
        { decodeVideo: true },
      ),
    ).toMatchObject({
      port: 'ok',
      reason: 'source reads clean; ends 5 s short of the declared 1:40',
    });
    expect(asked).toEqual([false, true]);
    expect(
      await decide(
        checkSource,
        withCore({
          kind: 'damaged',
          reason: 'audio #1 (DTS): Invalid LFE scale factor index',
          stream: 'audio #1 (DTS)',
        }),
      ),
    ).toEqual({
      port: 'damaged',
      reason: 'audio #1 (DTS): Invalid LFE scale factor index',
      findings: {
        reason: 'audio #1 (DTS): Invalid LFE scale factor index',
        stream: 'audio #1 (DTS)',
      },
    });
    const failed = decide(checkSource, withCore({ kind: 'error', message: 'Input/output error' }));
    await expect(failed).rejects.toMatchObject({
      message: 'check source failed: Input/output error',
      retryable: true,
    });
    await expect(decide(checkSource, decideCtx(probe))).rejects.toThrow(
      'check source is not available here',
    );
  });
});
