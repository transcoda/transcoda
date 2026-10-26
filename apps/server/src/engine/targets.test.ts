import { DEVICE_PROFILE_IDS } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { modelFromProbe } from './build-model.ts';
import {
  checkEncodeAudioSettings,
  checkEncodeVideoSettings,
  checkModelAgainstTargets,
  checkRemuxSettings,
  containerPlaysOn,
  defaultTracks,
  streamPlaysOn,
  targetWarnings,
} from './targets.ts';
import { probeOf, withSidecar, withStream } from './test-helpers.ts';

const allTargets = [...DEVICE_PROFILE_IDS];

describe('streamPlaysOn', () => {
  const hevc10 = probeOf([
    { codec: 'hevc', profile: 'Main 10', level: 120, pixelFormat: 'yuv420p10le', bitDepth: 10 },
  ]).streams[0];

  it('hevc main10 plays on android-tv but not chrome', () => {
    if (!hevc10) throw new Error('no stream');
    expect(streamPlaysOn(hevc10, ['android-tv'])).toEqual([]);
    expect(streamPlaysOn(hevc10, ['chrome'])).toEqual([
      {
        target: 'chrome',
        streamIndex: 0,
        kind: 'video-codec',
        message: 'Chrome (desktop) cannot play video #0: hevc',
      },
    ]);
  });

  it('exempts cover art, attachments and data streams', () => {
    const probe = probeOf([
      { type: 'video', codec: 'png', attachedPic: true },
      { type: 'attachment', codec: 'ttf' },
      { type: 'data', codec: 'tmcd' },
    ]);
    for (const s of probe.streams) expect(streamPlaysOn(s, allTargets)).toEqual([]);
  });

  it('8-channel aac exceeds the channel limit on both targets', () => {
    const aac = probeOf([{ type: 'video' }, { type: 'audio' }, { type: 'audio', channels: 8 }])
      .streams[2];
    if (!aac) throw new Error('no stream');
    expect(streamPlaysOn(aac, allTargets)).toEqual([
      {
        target: 'android-tv',
        streamIndex: 2,
        kind: 'audio-channels',
        message:
          'Android TV (Google TV / Shield class) cannot play audio #2: 8 channels (max 6 for aac)',
      },
      {
        target: 'chrome',
        streamIndex: 2,
        kind: 'audio-channels',
        message: 'Chrome (desktop) cannot play audio #2: 8 channels (max 6 for aac)',
      },
    ]);
  });

  it('PGS subtitles fail on chrome only', () => {
    const pgs = probeOf([{ type: 'subtitle', codec: 'hdmv_pgs_subtitle' }]).streams[0];
    if (!pgs) throw new Error('no stream');
    expect(streamPlaysOn(pgs, ['android-tv'])).toEqual([]);
    expect(streamPlaysOn(pgs, allTargets).map((i) => [i.target, i.kind])).toEqual([
      ['chrome', 'subtitle-format'],
    ]);
  });

  it('checks profile, level, bit depth and HDR', () => {
    const probe = probeOf([
      { codec: 'h264', profile: 'High 4:4:4 Predictive', level: 40, bitDepth: 8 },
      { codec: 'hevc', profile: 'Main', level: 186, bitDepth: 8 },
      { codec: 'h264', profile: 'High', level: 41, bitDepth: 10 },
      { codec: 'hevc', profile: 'Main 10', level: 150, bitDepth: 10, hdr: 'dolby-vision' },
    ]);
    const issues = probe.streams.map((s) => streamPlaysOn(s, ['android-tv']));
    expect(issues.map((list) => list.map((i) => i.kind))).toEqual([
      ['video-profile'],
      ['video-level'],
      ['bit-depth'],
      ['hdr'],
    ]);
    expect(issues.map((list) => list[0]?.message)).toEqual([
      'Android TV (Google TV / Shield class) cannot play video #0: h264 profile high444predictive',
      'Android TV (Google TV / Shield class) cannot play video #1: hevc level 186 (max 153)',
      'Android TV (Google TV / Shield class) cannot play video #2: 10-bit h264',
      'Android TV (Google TV / Shield class) cannot play video #3: dolby-vision hevc',
    ]);
  });

  it('empty targets never report', () => {
    const probe = probeOf([{ codec: 'mpeg2video' }, { type: 'audio', codec: 'dts', channels: 8 }]);
    for (const s of probe.streams) expect(streamPlaysOn(s, [])).toEqual([]);
  });
});

describe('containerPlaysOn', () => {
  it('reports a container no target accepts', () => {
    expect(containerPlaysOn('mkv', allTargets)).toEqual([]);
    expect(containerPlaysOn('avi', ['chrome'])).toEqual([
      {
        target: 'chrome',
        streamIndex: null,
        kind: 'container',
        message: 'Chrome (desktop) cannot play avi files',
      },
    ]);
    expect(containerPlaysOn('avi', [])).toEqual([]);
  });
});

describe('checkModelAgainstTargets', () => {
  const probe = probeOf([
    { codec: 'h264', profile: 'High', level: 41, pixelFormat: 'yuv420p', bitDepth: 8 },
    { type: 'audio', codec: 'eac3', channels: 8 },
    { type: 'subtitle', codec: 'hdmv_pgs_subtitle' },
    { type: 'video', codec: 'mjpeg', attachedPic: true },
    { type: 'attachment', codec: 'ttf' },
    { type: 'data', codec: 'tmcd' },
  ]);

  it('checks copied streams with their probed values', () => {
    const model = modelFromProbe(probe);
    expect(checkModelAgainstTargets(model, probe, ['android-tv'])).toEqual([]);
    expect(
      checkModelAgainstTargets(model, probe, ['chrome']).map((i) => [i.streamIndex, i.kind]),
    ).toEqual([[1, 'audio-codec']]);
  });

  it('a warning for a sidecar stream names its file, not #-1', () => {
    const probe = probeOf([{ codec: 'h264', profile: 'High', level: 41, bitDepth: 8 }]);
    const model = withSidecar(modelFromProbe(probe), 1, 'Show.fr.sup', {
      codec: 'hdmv_pgs_subtitle',
    });
    expect(targetWarnings(model, probe, ['chrome']).map((w) => w.message)).toEqual([
      "subtitle Show.fr.sup won't direct-play on Chrome (desktop)",
    ]);
  });

  it('a default sidecar subtitle a target cannot play is named by its file, not #-1', () => {
    const probe = probeOf([{ codec: 'h264', profile: 'High', level: 41, bitDepth: 8 }]);
    const model = withSidecar(modelFromProbe(probe), 1, 'Show.fr.sup', {
      codec: 'hdmv_pgs_subtitle',
      default: true,
    });
    expect(checkModelAgainstTargets(model, probe, ['chrome']).map((i) => i.message)).toEqual([
      'Chrome (desktop) cannot play subtitle Show.fr.sup: hdmv_pgs_subtitle',
    ]);
  });

  it('only video and the default audio and subtitle block; other tracks warn', () => {
    const two = probeOf([
      { codec: 'h264', profile: 'High', level: 41, bitDepth: 8 },
      { type: 'audio', codec: 'aac', channels: 2 },
      { type: 'audio', codec: 'eac3', channels: 8 },
      { type: 'subtitle', codec: 'hdmv_pgs_subtitle' },
      { type: 'subtitle', codec: 'subrip' },
    ]);
    const model = modelFromProbe(two);
    // No audio flagged: the first one is what players pick. No subtitle flagged: none.
    expect(defaultTracks(model)).toMatchObject({ audio: { sourceIndex: 1 }, subtitle: null });
    expect(checkModelAgainstTargets(model, two, ['chrome'])).toEqual([]);
    expect(targetWarnings(model, two, ['chrome']).map((w) => [w.streamIndex, w.message])).toEqual([
      [2, "audio #2 won't direct-play on Chrome (desktop)"],
      [3, "subtitle #3 won't direct-play on Chrome (desktop)"],
    ]);

    const flagged = withStream(withStream(model, 2, { default: true }), 3, { default: true });
    expect(
      checkModelAgainstTargets(flagged, two, ['chrome']).map((i) => [i.streamIndex, i.kind]),
    ).toEqual([
      [2, 'audio-codec'],
      [3, 'subtitle-format'],
    ]);
    expect(targetWarnings(flagged, two, ['chrome'])).toEqual([]);
    expect(targetWarnings(flagged, two, [])).toEqual([]);
  });

  it('checks converted streams with their planned values', () => {
    let model = withStream(modelFromProbe(probe), 0, {
      mode: 'convert',
      codec: 'hevc',
      encoder: 'libx265',
      profile: 'main10',
      pixelFormat: 'yuv420p10le',
    });
    model = withStream(model, 1, { mode: 'convert', codec: 'aac', encoder: 'aac' });
    expect(checkModelAgainstTargets(model, probe, ['android-tv'])).toEqual([
      {
        target: 'android-tv',
        streamIndex: 1,
        kind: 'audio-channels',
        message:
          'Android TV (Google TV / Shield class) cannot play audio #1: 8 channels (max 6 for aac)',
      },
    ]);
    model = withStream(model, 1, { channels: 2 });
    expect(checkModelAgainstTargets(model, probe, ['android-tv'])).toEqual([]);
  });

  it('a 10-bit pixel format on h264 is a bit-depth issue; a non-4:2:0 one is too', () => {
    const tenBit = withStream(modelFromProbe(probe), 0, {
      mode: 'convert',
      codec: 'h264',
      encoder: 'libx264',
      profile: null,
      pixelFormat: 'yuv420p10le',
    });
    expect(checkModelAgainstTargets(tenBit, probe, ['android-tv']).map((i) => i.kind)).toEqual([
      'bit-depth',
    ]);
    const yuv444 = withStream(tenBit, 0, { pixelFormat: 'yuv444p' });
    expect(checkModelAgainstTargets(yuv444, probe, ['android-tv'])[0]?.message).toBe(
      'Android TV (Google TV / Shield class) cannot play video #0: pixel format yuv444p',
    );
  });

  it('ignores dropped streams and empty targets', () => {
    const model = withStream(withStream(modelFromProbe(probe), 1, { keep: false }), 2, {
      keep: false,
    });
    expect(checkModelAgainstTargets(model, probe, ['chrome'])).toEqual([]);
    expect(checkModelAgainstTargets(modelFromProbe(probe), probe, [])).toEqual([]);
  });
});

describe('node settings checks', () => {
  it('encode-video', () => {
    expect(checkEncodeVideoSettings({ codec: 'av1', targets: ['android-tv'] })).toEqual([
      {
        target: 'android-tv',
        streamIndex: null,
        kind: 'video-codec',
        message: 'Android TV (Google TV / Shield class) cannot play av1',
      },
    ]);
    expect(checkEncodeVideoSettings({ codec: 'hevc', targets: ['chrome'] })[0]?.message).toBe(
      'Chrome (desktop) cannot play hevc',
    );
    expect(checkEncodeVideoSettings({ codec: 'h264', targets: allTargets })).toEqual([]);
    expect(checkEncodeVideoSettings({ codec: 'av1', targets: [] })).toEqual([]);
  });

  it('encode-audio', () => {
    expect(checkEncodeAudioSettings({ codec: 'ac3', targets: allTargets })).toEqual([
      {
        target: 'chrome',
        streamIndex: null,
        kind: 'audio-codec',
        message: 'Chrome (desktop) cannot play ac3',
      },
    ]);
    expect(checkEncodeAudioSettings({ codec: 'aac', targets: allTargets })).toEqual([]);
    expect(checkEncodeAudioSettings({ codec: 'ac3', targets: [] })).toEqual([]);
  });

  it('remux', () => {
    expect(checkRemuxSettings({ container: 'mp4', targets: allTargets })).toEqual([]);
    expect(checkRemuxSettings({ container: 'mkv', targets: [] })).toEqual([]);
  });
});
