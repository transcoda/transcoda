import type { StreamPlan } from '@transcoda/sdk';
import { parseConversion } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import {
  containerCanHold,
  conversion,
  copyPictures,
  coverFile,
  diffFromProbe,
  extraInputOf,
  fitToContainer,
  isExtraStream,
  isIdentity,
  kept,
  modelFromProbe,
  normalizeDefaults,
  outputOrder,
  resolveEncoder,
  streamsOf,
} from './build-model.ts';
import { capsOf, probeOf, withSidecar, withStream } from './test-helpers.ts';

const probe = probeOf([
  { type: 'video', codec: 'hevc', default: true },
  { type: 'audio', codec: 'aac', language: 'eng', title: 'Stereo', channels: 2 },
  { type: 'audio', codec: 'ac3', language: 'tur', channels: 6 },
  { type: 'subtitle', codec: 'subrip', language: 'eng', forced: true, dispositions: ['comment'] },
  { type: 'video', codec: 'png', attachedPic: true },
]);

describe('modelFromProbe / isIdentity', () => {
  it('modelFromProbe is the identity and isIdentity holds', () => {
    const model = modelFromProbe(probe);
    expect(model.container).toBe('mkv');
    expect(model.targets).toEqual([]);
    expect(model.inputArgs).toEqual([]);
    expect(model.globalArgs).toEqual([]);
    expect(model.streams.map((s) => [s.sourceIndex, s.order, s.type, s.mode, s.keep])).toEqual([
      [0, 0, 'video', 'copy', true],
      [1, 1, 'audio', 'copy', true],
      [2, 2, 'audio', 'copy', true],
      [3, 3, 'subtitle', 'copy', true],
      [4, 4, 'video', 'copy', true],
    ]);
    expect(model.streams[1]).toMatchObject({
      codec: 'aac',
      language: 'eng',
      title: 'Stereo',
      default: false,
      encoder: null,
      channels: null,
    });
    expect(model.streams[3]).toMatchObject({ forced: true, dispositions: ['comment'] });
    expect(model.streams[4]).toMatchObject({ attachedPic: true, codec: 'png' });
    expect(isIdentity(model, probe)).toBe(true);
    expect(diffFromProbe(model, probe)).toEqual([]);
  });

  it('dropping a stream, changing a flag, reordering, or changing the container breaks identity', () => {
    const model = modelFromProbe(probe);
    expect(isIdentity(withStream(model, 2, { keep: false }), probe)).toBe(false);
    expect(isIdentity(withStream(model, 1, { default: true }), probe)).toBe(false);
    const reordered = withStream(withStream(model, 1, { order: 2 }), 2, { order: 1 });
    expect(isIdentity(reordered, probe)).toBe(false);
    expect(isIdentity({ ...model, container: 'mp4' }, probe)).toBe(false);
  });

  it('a data stream (tmcd) is kept as copy and its mode is ignored by isIdentity; a .ts input maps to mkv and is not identity', () => {
    const mp4 = probeOf(
      [
        { type: 'video', codec: 'h264' },
        { type: 'audio', codec: 'aac' },
        { type: 'data', codec: 'tmcd' },
      ],
      { container: 'mp4', formatName: 'mov,mp4,m4a,3gp,3g2,mj2' },
    );
    const model = modelFromProbe(mp4);
    expect(model.container).toBe('mp4');
    expect(model.streams[2]).toMatchObject({
      type: 'data',
      codec: 'tmcd',
      keep: true,
      mode: 'copy',
    });
    expect(isIdentity(model, mp4)).toBe(true);
    expect(isIdentity(withStream(model, 2, { mode: 'convert' }), mp4)).toBe(true);

    const ts = probeOf([{ type: 'video', codec: 'h264' }], {
      container: 'ts',
      formatName: 'mpegts',
    });
    const tsModel = modelFromProbe(ts);
    expect(tsModel.container).toBe('mkv');
    expect(isIdentity(tsModel, ts)).toBe(false);
    expect(diffFromProbe(tsModel, ts)).toEqual(['container: ts → mkv']);
  });
});

describe('diffFromProbe', () => {
  it('diffFromProbe names each change in output order', () => {
    const p = probeOf([
      { type: 'video', codec: 'hevc' },
      { type: 'audio', codec: 'aac', language: 'eng' },
      { type: 'audio', codec: 'aac', language: 'tur' },
    ]);
    const m = withStream(withStream(modelFromProbe(p), 2, { keep: false }), 1, { default: true });
    expect(diffFromProbe(m, p)).toEqual(['drop audio #2 (tur)', 'audio #1: default']);
  });

  it('describes conversions, metadata, flag and order changes on one line per stream', () => {
    let m = modelFromProbe(probe);
    m = withStream(m, 0, {
      mode: 'convert',
      codec: 'hevc',
      encoder: 'libx265',
      quality: 24,
      preset: 'medium',
      profile: 'main10',
      pixelFormat: 'yuv420p10le',
    });
    m = withStream(m, 1, {
      mode: 'convert',
      codec: 'aac',
      encoder: 'aac',
      bitrateKbps: 160,
      channels: 2,
      title: null,
      order: 2,
    });
    m = withStream(m, 2, { language: 'deu', default: true, order: 1 });
    m = withStream(m, 3, { forced: false, dispositions: [], title: 'Signs' });
    m = withStream(m, 4, { keep: false });
    expect(diffFromProbe(m, probe)).toEqual([
      'drop video #4',
      'video #0: convert hevc→hevc (libx265 crf 24 medium main10 yuv420p10le)',
      'audio #2: moved to output #1, language tur→deu, default',
      'audio #1: convert aac→aac (aac 160k 2ch), moved to output #2, title cleared',
      'subtitle #3: title "Signs", not forced, -comment',
    ]);
  });
});

describe('video bitrate in the diff', () => {
  const probe = probeOf([{ type: 'video', codec: 'h264' }]);
  const diff = (encoder: string, quality: number | null, bitrateKbps: number | null) =>
    diffFromProbe(
      withStream(modelFromProbe(probe), 0, {
        mode: 'convert',
        codec: 'hevc',
        encoder,
        quality,
        bitrateKbps,
        preset: 'medium',
      }),
      probe,
    );

  it('names a target bitrate, and a capped quality with its ceiling', () => {
    expect(diff('libx265', null, 3000)).toEqual([
      'video #0: convert h264→hevc (libx265 medium 3000k)',
    ]);
    expect(diff('libx265', 24, 5000)).toEqual([
      'video #0: convert h264→hevc (libx265 crf 24 medium max 5000k)',
    ]);
    expect(diff('hevc_nvenc', 24, 5000)).toEqual([
      'video #0: convert h264→hevc (hevc_nvenc cq 24 medium max 5000k)',
    ]);
    expect(diff('hevc_nvenc', 24, null)).toEqual([
      'video #0: convert h264→hevc (hevc_nvenc qp 24 medium)',
    ]);
  });
});

describe('data streams in the diff', () => {
  const withData = probeOf([
    { type: 'video', codec: 'h264' },
    { type: 'data', codec: 'tmcd' },
    { type: 'audio', codec: 'aac', language: 'eng' },
    { type: 'audio', codec: 'aac', language: 'deu' },
  ]);

  it('an explicit drop of a data stream is reported and breaks identity', () => {
    const m = withStream(modelFromProbe(withData), 1, { keep: false });
    // probeOf files are mkv, which cannot hold a data stream, so the drop says why too.
    expect(diffFromProbe(m, withData)).toEqual(["drop data #1 (container can't hold it)"]);
    expect(isIdentity(m, withData)).toBe(false);
    const omitted = { ...m, streams: m.streams.filter((s) => s.sourceIndex !== 1) };
    expect(isIdentity(omitted, withData)).toBe(false);
  });

  it('moving a data stream does not report its neighbours as moved', () => {
    const m = withStream(modelFromProbe(withData), 1, { order: 9 });
    expect(diffFromProbe(m, withData)).toEqual([]);
    expect(isIdentity(m, withData)).toBe(true);
  });

  it('a moved stream names the output index it is written at, data streams counted', () => {
    const m = withStream(withStream(modelFromProbe(withData), 2, { order: 3 }), 3, { order: 2 });
    expect(diffFromProbe(m, withData)).toEqual([
      'audio #3: moved to output #2',
      'audio #2: moved to output #3',
    ]);
  });
});

describe('streamsOf', () => {
  it('returns kept streams of the type in output order', () => {
    const m = withStream(
      withStream(withStream(modelFromProbe(probe), 1, { order: 2 }), 2, { order: 1 }),
      4,
      { keep: false },
    );
    expect(streamsOf(m, 'audio').map((s) => s.sourceIndex)).toEqual([2, 1]);
    expect(streamsOf(m, 'video').map((s) => s.sourceIndex)).toEqual([0]);
    expect(streamsOf(m, 'attachment')).toEqual([]);
  });
});

describe('resolveEncoder', () => {
  it('resolveEncoder: auto prefers hevc_nvenc only with cuda, else libx265; a named encoder missing from caps → null', () => {
    const all = ['hevc_nvenc', 'hevc_qsv', 'libx265', 'h264_nvenc', 'libx264', 'libsvtav1'];
    expect(resolveEncoder('hevc', 'auto', capsOf(all, ['cuda']))).toBe('hevc_nvenc');
    expect(resolveEncoder('hevc', 'auto', capsOf(['hevc_nvenc', 'libx265']))).toBe('libx265');
    expect(resolveEncoder('hevc', 'auto', capsOf(all))).toBe('hevc_qsv');
    expect(resolveEncoder('h264', 'auto', capsOf(all))).toBe('libx264');
    expect(resolveEncoder('av1', 'auto', capsOf(['libaom-av1']))).toBe('libaom-av1');
    expect(resolveEncoder('av1', 'auto', capsOf(['libx265']))).toBeNull();
    expect(resolveEncoder('hevc', 'libx265', capsOf(['libx265']))).toBe('libx265');
    expect(resolveEncoder('hevc', 'hevc_vaapi', capsOf(['libx265']))).toBeNull();
  });
});

describe('container fit (streams a container cannot hold)', () => {
  it('containerCanHold: mkv takes no data or mov_text; mp4 no attachments or non-mov_text subtitles', () => {
    const s = (type: 'data' | 'subtitle' | 'attachment' | 'video', codec: string) => ({
      type,
      codec,
    });
    expect(containerCanHold('mkv', s('data', 'tmcd'))).toBe(false);
    expect(containerCanHold('mkv', s('subtitle', 'mov_text'))).toBe(false);
    expect(containerCanHold('mkv', s('subtitle', 'hdmv_pgs_subtitle'))).toBe(true);
    expect(containerCanHold('mkv', s('attachment', 'ttf'))).toBe(true);
    expect(containerCanHold('mp4', s('attachment', 'ttf'))).toBe(false);
    expect(containerCanHold('mp4', s('subtitle', 'hdmv_pgs_subtitle'))).toBe(false);
    expect(containerCanHold('mp4', s('subtitle', 'subrip'))).toBe(false);
    expect(containerCanHold('mp4', s('subtitle', 'mov_text'))).toBe(true);
    expect(containerCanHold('mp4', s('data', 'tmcd'))).toBe(true);
  });

  it('fitToContainer converts text subtitles and drops what the container cannot hold', () => {
    const mov = probeOf(
      [
        { type: 'video', codec: 'h264' },
        { type: 'subtitle', codec: 'mov_text', language: 'eng' },
        { type: 'data', codec: 'tmcd' },
      ],
      { container: 'mov', formatName: 'mov,mp4,m4a,3gp,3g2,mj2' },
    );
    // modelFromProbe fits a non-mkv/mp4 input into mkv, so it never fails in the muxer.
    const model = modelFromProbe(mov);
    expect(model.container).toBe('mkv');
    expect(model.streams[1]).toMatchObject({ mode: 'convert', codec: 'subrip', keep: true });
    expect(model.streams[2]?.keep).toBe(false);
    expect(diffFromProbe(model, mov)).toEqual([
      'container: mov → mkv',
      "drop data #2 (container can't hold it)",
      'subtitle #1: convert mov_text→subrip (subrip)',
    ]);

    const mkv = probeOf([
      { type: 'video' },
      { type: 'subtitle', codec: 'subrip' },
      { type: 'subtitle', codec: 'hdmv_pgs_subtitle' },
      { type: 'attachment', codec: 'ttf' },
    ]);
    const toMp4 = { ...modelFromProbe(mkv), container: 'mp4' as const };
    const fit = fitToContainer(toMp4);
    expect(fit.converted.map((s) => s.sourceIndex)).toEqual([1]);
    expect(fit.dropped.map((s) => s.sourceIndex)).toEqual([2, 3]);
    expect(kept(toMp4).map((s) => [s.sourceIndex, s.codec])).toEqual([
      [0, 'hevc'],
      [1, 'mov_text'],
    ]);
  });

  it('mkv and mp4 inputs are left as they are (identity holds)', () => {
    const tmcd = probeOf([{ type: 'video' }, { type: 'data', codec: 'tmcd' }], {
      container: 'mp4',
    });
    expect(isIdentity(modelFromProbe(tmcd), tmcd)).toBe(true);
  });
});

describe('covers into mkv', () => {
  const mp4 = probeOf(
    [
      { type: 'video', codec: 'hevc' },
      { type: 'video', codec: 'png', attachedPic: true },
      { type: 'audio', codec: 'aac' },
    ],
    { container: 'mp4' },
  );

  it('coverFile names the attachment by image codec', () => {
    expect(coverFile('png')).toEqual({ ext: 'png', mimetype: 'image/png' });
    expect(coverFile('mjpeg')).toEqual({ ext: 'jpg', mimetype: 'image/jpeg' });
    expect(coverFile('webp')).toEqual({ ext: 'webp', mimetype: 'image/webp' });
  });

  it('an mkv output writes the cover last, as an attachment, and the diff says so', () => {
    const model = { ...modelFromProbe(mp4), container: 'mkv' as const };
    expect(outputOrder(model).map((s) => s.sourceIndex)).toEqual([0, 2, 1]);
    expect(outputOrder({ ...model, container: 'mp4' }).map((s) => s.sourceIndex)).toEqual([
      0, 1, 2,
    ]);
    expect(diffFromProbe(model, mp4)).toEqual([
      'container: mp4 → mkv',
      'video #1: written as attachment cover.png',
    ]);
  });

  it('an mkv source with a cover attachment stays identity', () => {
    const mkv = probeOf([
      { type: 'video', codec: 'hevc' },
      { type: 'audio', codec: 'aac' },
      { type: 'video', codec: 'png', attachedPic: true },
    ]);
    const model = modelFromProbe(mkv);
    expect(isIdentity(model, mkv)).toBe(true);
    expect(diffFromProbe(model, mkv)).toEqual([]);
  });
});

describe('copyPictures (a picture is never encoded)', () => {
  const src = probeOf([
    { type: 'video', codec: 'hevc' },
    { type: 'video', codec: 'hevc', imageTrack: true },
    { type: 'video', codec: 'mjpeg' },
    { type: 'audio', codec: 'aac' },
  ]);
  const encode = { mode: 'convert' as const, codec: 'hevc', encoder: 'hevc_nvenc', quality: 24 };

  it('puts pictures a node converts back to copy and notes it; real video stays converted', () => {
    let model = modelFromProbe(src);
    for (const i of [0, 1, 2]) model = withStream(model, i, encode);
    const notes = copyPictures(model, src);
    expect(model.streams.map((s) => [s.mode, s.codec, s.encoder, s.quality])).toEqual([
      ['convert', 'hevc', 'hevc_nvenc', 24],
      ['copy', 'hevc', null, null],
      ['copy', 'mjpeg', null, null],
      ['copy', 'aac', null, null],
    ]);
    expect([...notes.entries()].map(([s, note]) => [s.sourceIndex, note])).toEqual([
      [1, 'a picture, copied: pictures are never encoded'],
      [2, 'a picture, copied: pictures are never encoded'],
    ]);
  });

  it('changes nothing when no picture is converted', () => {
    const model = withStream(modelFromProbe(src), 0, encode);
    expect(copyPictures(model, src).size).toBe(0);
  });
});

describe('normalizeDefaults (final review I1)', () => {
  const src = probeOf([
    { type: 'video', codec: 'hevc', default: true },
    { type: 'audio', codec: 'aac', language: 'eng' },
    { type: 'audio', codec: 'aac', language: 'deu' },
    { type: 'subtitle', codec: 'subrip', language: 'eng' },
    { type: 'subtitle', codec: 'subrip', language: 'deu' },
  ]);
  const flags = (m: ReturnType<typeof modelFromProbe>, type: 'audio' | 'subtitle') =>
    streamsOf(m, type).map((s) => s.default);

  it('flags the first kept audio when none is default; mkv subtitles stay without a default', () => {
    const model = modelFromProbe(src);
    const notes = normalizeDefaults(model);
    expect(flags(model, 'audio')).toEqual([true, false]);
    expect(flags(model, 'subtitle')).toEqual([false, false]);
    expect([...notes.entries()].map(([s, n]) => [s.sourceIndex, n])).toEqual([
      [1, 'no audio track was default'],
    ]);
  });

  it('keeps the first flagged default per type and clears the rest (output order)', () => {
    let model = modelFromProbe(src);
    for (const i of [1, 2, 3, 4]) model = withStream(model, i, { default: true });
    // deu audio first in the output: it is the first flagged default and stays.
    model = withStream(withStream(model, 1, { order: 2 }), 2, { order: 1 });
    const notes = normalizeDefaults(model);
    expect(model.streams.map((s) => [s.sourceIndex, s.default])).toEqual([
      [0, true],
      [1, false],
      [2, true],
      [3, true],
      [4, false],
    ]);
    expect([...notes.entries()].map(([s, n]) => [s.sourceIndex, n])).toEqual([
      [1, 'only one default audio track'],
      [4, 'only one default subtitle track'],
    ]);
  });

  it('mp4: flags the first kept subtitle when none is (the muxer would anyway)', () => {
    const model = { ...modelFromProbe(src), container: 'mp4' as const };
    for (const s of model.streams) if (s.type === 'subtitle') s.codec = 'mov_text';
    model.streams[1] = { ...(model.streams[1] as StreamPlan), keep: false };
    const notes = normalizeDefaults(model);
    expect(flags(model, 'audio')).toEqual([true]);
    expect(flags(model, 'subtitle')).toEqual([true, false]);
    expect(notes.get(model.streams[3] as StreamPlan)).toBe('mp4 cannot have no default subtitle');
  });

  it('mp4: flags the first kept non-cover video when none is (the muxer would anyway); mkv does not', () => {
    const plain = probeOf([
      { type: 'video', codec: 'png', attachedPic: true },
      { type: 'video', codec: 'h264' },
      { type: 'audio', codec: 'aac', language: 'eng', default: true },
    ]);
    const mp4 = { ...modelFromProbe(plain), container: 'mp4' as const };
    const notes = normalizeDefaults(mp4);
    expect(mp4.streams.map((s) => [s.sourceIndex, s.default])).toEqual([
      [0, false],
      [1, true],
      [2, true],
    ]);
    expect([...notes.entries()].map(([s, n]) => [s.sourceIndex, n])).toEqual([
      [1, 'mp4 cannot have no default video'],
    ]);
    const mkv = modelFromProbe(plain);
    expect(normalizeDefaults(mkv).size).toBe(0);
    expect(mkv.streams[1]?.default).toBe(false);
  });

  it('mp4 with the probe: an image track ahead of the real video never takes the default flag', () => {
    const src = probeOf([
      { type: 'video', codec: 'hevc', imageTrack: true },
      { type: 'video', codec: 'h264' },
      { type: 'audio', codec: 'aac', language: 'eng', default: true },
    ]);
    const mp4 = { ...modelFromProbe(src), container: 'mp4' as const };
    const notes = normalizeDefaults(mp4, src);
    expect(streamsOf(mp4, 'video').map((s) => [s.sourceIndex, s.default])).toEqual([
      [0, false],
      [1, true],
    ]);
    expect([...notes.keys()].map((s) => s.sourceIndex)).toEqual([1]);
    // Without the probe only flagged covers are known: the image track would be the lead.
    const blind = { ...modelFromProbe(src), container: 'mp4' as const };
    normalizeDefaults(blind);
    expect(blind.streams[0]?.default).toBe(true);
  });

  it('mp4: flags the first kept video when none is, clears extra video defaults (the muxer enables a video told 0)', () => {
    const two = probeOf([
      { type: 'video', codec: 'hevc' },
      { type: 'video', codec: 'hevc' },
      { type: 'audio', codec: 'aac', language: 'eng', default: true },
    ]);
    const model = { ...modelFromProbe(two), container: 'mp4' as const };
    const notes = normalizeDefaults(model);
    expect(streamsOf(model, 'video').map((s) => s.default)).toEqual([true, false]);
    expect(notes.get(model.streams[0] as StreamPlan)).toBe('mp4 cannot have no default video');
    const mkv = modelFromProbe(two);
    expect(normalizeDefaults(mkv).size).toBe(0);
    expect(streamsOf(mkv, 'video').map((s) => s.default)).toEqual([false, false]);
  });

  it('leaves already-normalised models (and models without audio) alone', () => {
    const model = modelFromProbe(probe);
    model.streams[1] = { ...(model.streams[1] as StreamPlan), default: true };
    const before = structuredClone(model);
    expect(normalizeDefaults(model).size).toBe(0);
    expect(model).toEqual(before);
    const silent = modelFromProbe(probeOf([{ type: 'video', codec: 'hevc', default: true }]));
    expect(normalizeDefaults(silent).size).toBe(0);
  });
});

describe('extra inputs (sidecar subtitles)', () => {
  const base = modelFromProbe(probe);

  it('isExtraStream / extraInputOf tell a sidecar stream from a probe stream', () => {
    const model = withSidecar(base, 1, 'Show.de.srt', { forced: true });
    const extra = model.streams.at(-1) as StreamPlan;
    expect(isExtraStream(extra)).toBe(true);
    expect(isExtraStream(model.streams[0] as StreamPlan)).toBe(false);
    expect(extraInputOf(model, extra)?.label.file).toBe('Show.de.srt');
    expect(extraInputOf(model, model.streams[0] as StreamPlan)).toBeNull();
  });

  it('a kept extra stream breaks identity; a dropped one does not', () => {
    const model = withSidecar(base, 1, 'Show.de.srt');
    expect(isIdentity(model, probe)).toBe(false);
    const dropped = withSidecar(base, 1, 'Show.de.srt', { keep: false });
    expect(isIdentity(dropped, probe)).toBe(true);
  });

  it('diffFromProbe adds one line per sidecar and no "subtitle #-1" line', () => {
    let model = withSidecar(base, 1, 'Show.de.srt', { forced: true });
    model = withSidecar(model, 2, 'Show.en.srt', { language: 'eng', sdh: true });
    model = withSidecar(model, 3, 'Show.xx.srt', { language: null });
    expect(diffFromProbe(model, probe)).toEqual([
      'add subtitle from Show.de.srt (deu, forced)',
      'add subtitle from Show.en.srt (eng, sdh)',
      'add subtitle from Show.xx.srt (und)',
    ]);
  });

  it('diffFromProbe names a conversion, and a dropped sidecar says nothing as an add line', () => {
    const mp4 = { ...base, container: 'mp4' as const };
    const model = withSidecar(mp4, 1, 'Show.de.srt');
    fitToContainer(model);
    expect(diffFromProbe(model, probe)).toContain(
      'add subtitle from Show.de.srt (deu, convert subrip→mov_text)',
    );
    const sup = withSidecar(mp4, 1, 'Show.de.sup', { codec: 'hdmv_pgs_subtitle' });
    fitToContainer(sup);
    expect(diffFromProbe(sup, probe).some((l) => l.startsWith('add subtitle'))).toBe(false);
    expect(diffFromProbe(sup, probe)).toContain(
      "drop subtitle from Show.de.sup (container can't hold it)",
    );
  });

  it('fitToContainer converts an extra subrip stream to mov_text on mp4 and drops an extra PGS one', () => {
    let model = withSidecar({ ...base, container: 'mp4' as const }, 1, 'Show.de.srt');
    model = withSidecar(model, 2, 'Show.fr.sup', { language: 'fra', codec: 'hdmv_pgs_subtitle' });
    const { converted, dropped } = fitToContainer(model);
    expect(converted.filter(isExtraStream).map((s) => [s.input, s.codec, s.mode])).toEqual([
      [1, 'mov_text', 'convert'],
    ]);
    expect(dropped.filter(isExtraStream).map((s) => s.input)).toEqual([2]);
  });

  it('normalizeDefaults treats extra subtitle streams like any other subtitle', () => {
    let model = withSidecar(base, 1, 'Show.de.srt', { default: true });
    model = withSidecar(model, 2, 'Show.en.srt', { language: 'eng', default: true });
    const notes = normalizeDefaults(model);
    const flags = streamsOf(model, 'subtitle').map((s) => s.default);
    expect(flags.filter(Boolean)).toHaveLength(1);
    expect([...notes.values()]).toContain('only one default subtitle track');
  });
});

describe('conversion notes read back (the job page parses them)', () => {
  const model = modelFromProbe(
    probeOf([
      { type: 'video', codec: 'h264', default: true },
      { type: 'audio', codec: 'truehd', channels: 6, default: true },
    ]),
  );
  const [video, audio] = model.streams;
  if (!video || !audio) throw new Error('streams missing');
  const note = (s: StreamPlan) => `convert x→${s.codec} (${conversion(s)})`;

  it('a video encode: encoder, quality and bit depth; a video bitrate is never an audio one', () => {
    const v: StreamPlan = {
      ...video,
      mode: 'convert',
      codec: 'hevc',
      encoder: 'hevc_nvenc',
      quality: 24,
      preset: 'p5',
      profile: 'main10',
      bitrateKbps: 8000,
      pixelFormat: 'yuv420p10le',
    };
    expect(parseConversion(note(v), 'video')).toEqual({
      encoder: 'hevc_nvenc',
      quality: 'CQ 24',
      kbps: null,
      channels: null,
      bitDepth: 10,
    });
    expect(
      parseConversion(note({ ...v, encoder: 'libx265', pixelFormat: 'yuv420p' }), 'video'),
    ).toMatchObject({ encoder: 'libx265', quality: 'CRF 24', bitDepth: 8 });
  });

  it('a capped quality (Encode video never above the source): cq, and the ceiling is no bitrate', () => {
    expect(
      parseConversion(
        'convert h264→hevc (hevc_nvenc cq 24 p5 main10 max 8000k yuv420p10le)',
        'video',
      ),
    ).toEqual({
      encoder: 'hevc_nvenc',
      quality: 'CQ 24',
      kbps: null,
      channels: null,
      bitDepth: 10,
    });
  });

  it('an audio encode: bitrate and channels', () => {
    const a: StreamPlan = {
      ...audio,
      mode: 'convert',
      codec: 'aac',
      encoder: 'aac',
      bitrateKbps: 160,
      channels: 2,
    };
    expect(parseConversion(note(a), 'audio')).toEqual({
      encoder: 'aac',
      quality: null,
      kbps: 160,
      channels: 2,
      bitDepth: null,
    });
    // The note as the plan carries it, among other changes.
    expect(parseConversion(`added: ${note(a)}, default`, 'audio')?.kbps).toBe(160);
  });
});
