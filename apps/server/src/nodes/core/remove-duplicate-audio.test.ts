import {
  type AnyNodeDefinition,
  type BuildContext,
  type BuildModel,
  corePluginContext,
  type ProbeResult,
  type StreamPlan,
} from '@transcoda/sdk';
import type { ProbeStream } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { kept, modelFromProbe, streamsOf } from '../../engine/build-model.ts';
import { renderArgs } from '../../engine/render.ts';
import { capsOf, fileOf, probeOf } from '../../engine/test-helpers.ts';
import { encodeAudio, keepLanguages } from './actions.ts';
import { removeDuplicateAudio } from './remove-duplicate-audio.ts';

function ctx(probe: ProbeResult, model: BuildModel = modelFromProbe(probe)): BuildContext {
  return {
    probe,
    file: fileOf('/lib/Film.mkv', probe.sizeBytes),
    data: {},
    capabilities: capsOf(['libx265', 'aac']),
    log: () => {},
    plugin: corePluginContext(),
    model,
  };
}

function build(def: AnyNodeDefinition, c: BuildContext, raw: Record<string, unknown> = {}) {
  if (!def.build) throw new Error(`${def.type} has no build`);
  return def.build(c, def.settings.parse(raw));
}

/** Encode audio to AAC 2.0 160k (every track), then Remove duplicate audio. */
async function afterEncode(probe: ProbeResult) {
  const encoded = await build(encodeAudio, ctx(probe), {
    mode: 'reencode',
    codec: 'aac',
    bitrateKbps: 160,
    downmixTo: 'stereo',
  });
  return build(removeDuplicateAudio, ctx(probe, encoded.model));
}

const audio = (s: Partial<ProbeStream>): Partial<ProbeStream> => ({ type: 'audio', ...s });
const video: Partial<ProbeStream> = { type: 'video', codec: 'hevc', default: true };
const keptAudio = (model: BuildModel) => streamsOf(model, 'audio').map((s) => s.sourceIndex);
const byIndex = (model: BuildModel, i: number): StreamPlan => {
  const s = model.streams.find((p) => p.sourceIndex === i);
  if (!s) throw new Error(`no stream ${i}`);
  return s;
};

/** The motivating film: TrueHD 5.1 and AC-3 5.1 640k, both English. */
const film = probeOf([
  video,
  audio({ codec: 'truehd', channels: 6, language: 'eng', default: true, bitrateKbps: 3500 }),
  audio({ codec: 'ac3', channels: 6, language: 'eng', bitrateKbps: 640 }),
  { type: 'subtitle', codec: 'subrip', language: 'eng' },
]);

describe('core:remove-duplicate-audio', () => {
  it('is a version 1 action without settings', () => {
    expect([removeDuplicateAudio.version, removeDuplicateAudio.kind]).toEqual([1, 'action']);
    expect(removeDuplicateAudio.settings.parse({})).toEqual({});
  });

  it('after Encode audio drops the AAC 2.0 made from the AC-3 and keeps the one from the TrueHD', async () => {
    const result = await afterEncode(film);
    expect(keptAudio(result.model)).toEqual([1]);
    expect(byIndex(result.model, 1)).toMatchObject({ keep: true, default: true, codec: 'aac' });
    expect(byIndex(result.model, 2)).toMatchObject({
      keep: false,
      dropReason: 'same as audio #1 (AAC 2.0 English)',
    });
    expect(result.reason).toBe('dropped audio #2: same as audio #1 (AAC 2.0 English)');
    expect(result.findings).toEqual({
      dropped: [{ index: 2, sameAs: 1, codec: 'aac', channels: 2 }],
    });
  });

  it('keeps the better source even when it comes later, and hands it the default flag', async () => {
    const probe = probeOf([
      video,
      audio({ codec: 'ac3', channels: 6, language: 'eng', default: true, bitrateKbps: 640 }),
      audio({ codec: 'truehd', channels: 6, language: 'eng' }),
    ]);
    const result = await afterEncode(probe);
    expect(keptAudio(result.model)).toEqual([2]);
    expect(byIndex(result.model, 2).default).toBe(true);
    expect(result.reason).toBe(
      'dropped audio #1: same as audio #2 (AAC 2.0 English); default audio now audio #2',
    );
  });

  it('leaves the default alone when another kept audio track is already default', async () => {
    const probe = probeOf([
      video,
      audio({ codec: 'aac', channels: 2, language: 'jpn', default: true }),
      audio({ codec: 'ac3', channels: 6, language: 'eng', default: true }),
      audio({ codec: 'truehd', channels: 6, language: 'eng' }),
    ]);
    const result = await afterEncode(probe);
    expect(keptAudio(result.model)).toEqual([1, 3]);
    expect(byIndex(result.model, 1).default).toBe(true);
    expect(byIndex(result.model, 3).default).toBe(false);
  });

  it('keeps tracks in different languages, and untagged apart from English', async () => {
    const probe = probeOf([
      video,
      audio({ codec: 'ac3', channels: 6, language: 'eng' }),
      audio({ codec: 'ac3', channels: 6, language: 'deu' }),
      audio({ codec: 'ac3', channels: 6, language: null }),
      audio({ codec: 'ac3', channels: 6, language: 'und' }),
    ]);
    const result = await afterEncode(probe);
    // The two untagged tracks are the same; neither is the same as the English one.
    expect(keptAudio(result.model)).toEqual([1, 2, 3]);
    expect(result.reason).toBe('dropped audio #4: same as audio #3 (AAC 2.0 untagged)');
  });

  it('keeps commentary, description, hearing-impaired, karaoke and dub tracks', async () => {
    const probe = probeOf([
      video,
      audio({ codec: 'truehd', channels: 6, language: 'eng' }),
      audio({ codec: 'ac3', channels: 6, language: 'eng', dispositions: ['comment'] }),
      audio({ codec: 'ac3', channels: 6, language: 'eng', dispositions: ['visual_impaired'] }),
      audio({ codec: 'ac3', channels: 6, language: 'eng', dispositions: ['hearing_impaired'] }),
      audio({ codec: 'ac3', channels: 6, language: 'eng', dispositions: ['karaoke'] }),
      audio({ codec: 'ac3', channels: 6, language: 'eng', dispositions: ['dub'] }),
      audio({ codec: 'ac3', channels: 6, language: 'eng', title: "Director's Commentary" }),
      audio({ codec: 'ac3', channels: 6, language: 'eng', title: 'Audio Description' }),
    ]);
    const result = await afterEncode(probe);
    expect(keptAudio(result.model)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.reason).toBe('no duplicate audio');
  });

  it('matches titles only when their words beyond format are equal; an untitled track matches only a format-only title', async () => {
    const probe = probeOf([
      video,
      audio({ codec: 'truehd', channels: 6, language: 'eng', title: 'Theatrical' }),
      audio({ codec: 'ac3', channels: 6, language: 'eng', title: 'Extended' }),
      audio({ codec: 'dts', channels: 6, language: 'eng', title: 'English DTS 5.1 1509 kbps' }),
      audio({ codec: 'eac3', channels: 6, language: 'eng', title: 'Theatrical (DD+ 5.1)' }),
      audio({ codec: 'ac3', channels: 6, language: 'eng' }),
    ]);
    const result = await afterEncode(probe);
    // "Theatrical" = "Theatrical (DD+ 5.1)"; the format-only title = no title; "Extended" alone.
    expect(keptAudio(result.model)).toEqual([1, 2, 3]);
    expect(result.reason).toBe(
      'dropped audio #4: same as audio #1 (AAC 2.0 English); dropped audio #5: same as audio #3 (AAC 2.0 English)',
    );
  });

  it('never drops a titled track for an untitled one: German description and commentary, isolated score, music only', async () => {
    const probe = probeOf([
      video,
      audio({ codec: 'truehd', channels: 6, language: 'deu' }),
      audio({ codec: 'ac3', channels: 6, language: 'deu', title: 'Audiodeskription' }),
      audio({ codec: 'ac3', channels: 6, language: 'deu', title: 'Hörfilm' }),
      audio({ codec: 'ac3', channels: 6, language: 'deu', title: 'Kommentar' }),
      audio({ codec: 'ac3', channels: 6, language: 'deu', title: 'Isolated score' }),
      audio({ codec: 'ac3', channels: 6, language: 'deu', title: 'Music only' }),
      audio({ codec: 'ac3', channels: 6, language: 'deu', title: 'Dolby Digital Plus' }),
      audio({ codec: 'ac3', channels: 6, language: 'deu', title: 'DD 5.1 640 kbps' }),
    ]);
    const result = await afterEncode(probe);
    // "Plus" alone is a word; only the whole "Dolby Digital Plus" is a format name.
    expect(keptAudio(result.model)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.reason).toBe(
      'dropped audio #7: same as audio #1 (AAC 2.0 German); dropped audio #8: same as audio #1 (AAC 2.0 German)',
    );
  });

  it('keeps ordinary words that also appear in format names', async () => {
    const probe = probeOf([
      video,
      audio({ codec: 'truehd', channels: 6, language: 'eng' }),
      audio({ codec: 'ac3', channels: 6, language: 'eng', title: 'Master' }),
      audio({ codec: 'ac3', channels: 6, language: 'eng', title: 'Audio' }),
      audio({ codec: 'ac3', channels: 6, language: 'eng', title: 'X' }),
      audio({ codec: 'ac3', channels: 6, language: 'eng', title: 'Digital' }),
    ]);
    expect(keptAudio((await afterEncode(probe)).model)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps the same set whatever the track order', async () => {
    const tracks: Partial<ProbeStream>[] = [
      audio({ codec: 'truehd', channels: 6, language: 'eng' }),
      audio({ codec: 'ac3', channels: 6, language: 'eng', bitrateKbps: 640 }),
      audio({ codec: 'eac3', channels: 6, language: 'eng', title: 'Theatrical' }),
      audio({ codec: 'aac', channels: 2, language: 'eng', title: 'Theatrical' }),
      audio({ codec: 'ac3', channels: 6, language: 'deu' }),
    ];
    const permutations = (xs: Partial<ProbeStream>[]): Partial<ProbeStream>[][] =>
      xs.length <= 1
        ? [xs]
        : xs.flatMap((x, i) =>
            permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
          );
    for (const order of permutations(tracks)) {
      const probe = probeOf([video, ...order]);
      const { model } = await afterEncode(probe);
      const keptTracks = streamsOf(model, 'audio').map((s) => {
        const p = probe.streams.find((x) => x.index === s.sourceIndex);
        return `${p?.codec} ${p?.language}`;
      });
      expect(keptTracks.sort()).toEqual(['eac3 eng', 'ac3 deu', 'truehd eng'].sort());
    }
  });

  it('leaves an added copy (Encode audio add-track) alone when it would win', async () => {
    const probe = probeOf([
      video,
      audio({ codec: 'eac3', channels: 8, language: 'eng', default: true }),
      audio({ codec: 'aac', channels: 2, language: 'eng' }),
    ]);
    const added = await build(encodeAudio, ctx(probe), { targets: ['chrome'] });
    expect(streamsOf(added.model, 'audio')).toHaveLength(3);
    const result = await build(removeDuplicateAudio, ctx(probe, added.model));
    expect(streamsOf(result.model, 'audio')).toHaveLength(3);
    expect(result.reason).toBe('no duplicate audio');
  });

  it('leaves an added copy alone when it would lose', async () => {
    const probe = probeOf([
      video,
      audio({ codec: 'eac3', channels: 8, language: 'eng', default: true }),
      audio({ codec: 'truehd', channels: 8, language: 'eng' }),
    ]);
    const added = await build(encodeAudio, ctx(probe), { targets: ['chrome'] });
    // The TrueHD now writes AAC 2.0 too, from a better source than the copy's E-AC-3.
    Object.assign(byIndex(added.model, 2), {
      mode: 'convert',
      codec: 'aac',
      encoder: 'aac',
      bitrateKbps: 160,
      channels: 2,
    });
    const result = await build(removeDuplicateAudio, ctx(probe, added.model));
    expect(streamsOf(result.model, 'audio').map((s) => [s.sourceIndex, s.codec])).toEqual([
      [1, 'eac3'],
      [1, 'aac'],
      [2, 'aac'],
    ]);
    expect(result.reason).toBe('no duplicate audio');
  });

  it('keeps copied tracks with a different known sample rate or bit depth, or a different forced flag', async () => {
    const probe = probeOf([
      video,
      audio({ codec: 'flac', channels: 2, language: 'eng', bitDepth: 16, sampleRate: 44100 }),
      audio({ codec: 'flac', channels: 2, language: 'eng', bitDepth: 24, sampleRate: 96000 }),
      audio({ codec: 'flac', channels: 2, language: 'eng', bitDepth: 24, sampleRate: 44100 }),
      audio({ codec: 'aac', channels: 2, language: 'eng' }),
      audio({ codec: 'aac', channels: 2, language: 'eng', forced: true }),
    ]);
    const result = await build(removeDuplicateAudio, ctx(probe));
    expect(keptAudio(result.model)).toEqual([1, 2, 3, 4, 5]);
  });

  it('ranks lossless sources by bit depth, then sample rate, before bitrate', async () => {
    const depth = probeOf([
      video,
      audio({ codec: 'flac', channels: 2, language: 'eng', bitDepth: 16, sampleRate: 48000 }),
      audio({ codec: 'flac', channels: 2, language: 'eng', bitDepth: 24, sampleRate: 48000 }),
    ]);
    expect(keptAudio((await afterEncode(depth)).model)).toEqual([2]);
    const rate = probeOf([
      video,
      audio({ codec: 'flac', channels: 2, language: 'eng', sampleRate: 48000, bitrateKbps: 3000 }),
      audio({ codec: 'flac', channels: 2, language: 'eng', sampleRate: 96000, bitrateKbps: 2000 }),
    ]);
    expect(keptAudio((await afterEncode(rate)).model)).toEqual([2]);
  });

  it('keeps tracks with different channel counts', async () => {
    const probe = probeOf([
      video,
      audio({ codec: 'aac', channels: 6, language: 'eng' }),
      audio({ codec: 'aac', channels: 2, language: 'eng' }),
    ]);
    const result = await build(removeDuplicateAudio, ctx(probe));
    expect(keptAudio(result.model)).toEqual([1, 2]);
    expect(result.reason).toBe('no duplicate audio');
  });

  it('three duplicates → one kept: lossless first (DTS-HD MA, not plain DTS)', async () => {
    const probe = probeOf([
      video,
      audio({ codec: 'dts', profile: 'dts', channels: 8, language: 'eng', bitrateKbps: 1509 }),
      audio({ codec: 'eac3', channels: 8, language: 'eng', bitrateKbps: 1024 }),
      audio({ codec: 'dts', profile: 'dts-hd-ma', channels: 6, language: 'eng' }),
    ]);
    const result = await afterEncode(probe);
    expect(keptAudio(result.model)).toEqual([3]);
    expect(result.findings).toEqual({
      dropped: [
        { index: 1, sameAs: 3, codec: 'aac', channels: 2 },
        { index: 2, sameAs: 3, codec: 'aac', channels: 2 },
      ],
    });
  });

  it('ranks lossy sources by channels, then bitrate (unknown lowest), then track order', async () => {
    const more = probeOf([
      video,
      audio({ codec: 'ac3', channels: 2, language: 'eng', bitrateKbps: 640 }),
      audio({ codec: 'eac3', channels: 6, language: 'eng', bitrateKbps: 256 }),
    ]);
    expect(keptAudio((await afterEncode(more)).model)).toEqual([2]);
    const rate = probeOf([
      video,
      audio({ codec: 'ac3', channels: 6, language: 'eng' }),
      audio({ codec: 'ac3', channels: 6, language: 'eng', bitrateKbps: 448 }),
      audio({ codec: 'ac3', channels: 6, language: 'eng', bitrateKbps: 640 }),
    ]);
    expect(keptAudio((await afterEncode(rate)).model)).toEqual([3]);
    const tie = probeOf([
      video,
      audio({ codec: 'flac', channels: 2, language: 'eng' }),
      audio({ codec: 'pcm_s24le', channels: 2, language: 'eng' }),
    ]);
    expect(keptAudio((await afterEncode(tie)).model)).toEqual([1]);
  });

  it('compares copied streams by their probe codec and channels', async () => {
    const probe = probeOf([
      video,
      audio({ codec: 'ac3', channels: 6, language: 'eng', bitrateKbps: 448 }),
      audio({ codec: 'ac3', channels: 6, language: 'eng', bitrateKbps: 640 }),
      audio({ codec: 'eac3', channels: 6, language: 'eng' }),
      audio({ codec: 'aac', channels: 2, language: 'eng' }),
      audio({ codec: 'aac', language: 'eng' }),
    ]);
    const result = await build(removeDuplicateAudio, ctx(probe));
    // Unknown channels (#5) never match anything.
    expect(keptAudio(result.model)).toEqual([2, 3, 4, 5]);
    expect(result.reason).toBe('dropped audio #1: same as audio #2 (AC-3 5.1 English)');
    expect(byIndex(result.model, 2).mode).toBe('copy');
  });

  it('compares a converted track with a copied one by what each writes', async () => {
    const probe = probeOf([
      video,
      audio({ codec: 'truehd', channels: 6, language: 'eng', default: true }),
      audio({ codec: 'aac', channels: 2, language: 'eng' }),
    ]);
    // Only the TrueHD is converted (to AAC stereo): it now writes what the AAC copy writes.
    const model = modelFromProbe(probe);
    Object.assign(byIndex(model, 1), {
      mode: 'convert',
      codec: 'aac',
      encoder: 'aac',
      bitrateKbps: 160,
      channels: 2,
    });
    const result = await build(removeDuplicateAudio, ctx(probe, model));
    expect(keptAudio(result.model)).toEqual([1]);
  });

  it('with nothing to drop changes nothing', async () => {
    const probe = probeOf([
      video,
      audio({ codec: 'ac3', channels: 6, language: 'eng', default: true }),
      audio({ codec: 'aac', channels: 2, language: 'eng' }),
    ]);
    const c = ctx(probe);
    const result = await build(removeDuplicateAudio, c);
    expect(result.model.streams).toEqual(c.model.streams);
    expect(result.reason).toBe('no duplicate audio');
    expect(result.findings).toBeUndefined();
  });

  it('ignores audio an earlier node already dropped', async () => {
    const kl = await build(keepLanguages, ctx(film), { languages: ['de'], keepUntagged: false });
    // Nothing matched, so Keep languages kept all audio; drop the TrueHD by hand instead.
    const model = kl.model;
    byIndex(model, 1).keep = false;
    const result = await build(removeDuplicateAudio, ctx(film, model));
    expect(keptAudio(result.model)).toEqual([2]);
    expect(result.reason).toBe('no duplicate audio');
  });

  it('works on a copy of the model', async () => {
    const c = ctx(film);
    const encoded = await build(encodeAudio, c, { mode: 'reencode', downmixTo: 'stereo' });
    const c2 = ctx(film, encoded.model);
    const before = structuredClone(c2.model);
    const result = await build(removeDuplicateAudio, c2);
    expect(c2.model).toEqual(before);
    expect(result.model).not.toBe(c2.model);
  });

  it('renderArgs maps the remaining streams in order, with the kept track as default', async () => {
    const probe = probeOf([
      video,
      audio({ codec: 'ac3', channels: 6, language: 'eng', default: true, bitrateKbps: 640 }),
      audio({ codec: 'truehd', channels: 6, language: 'eng' }),
      audio({ codec: 'ac3', channels: 6, language: 'deu' }),
      { type: 'subtitle', codec: 'subrip', language: 'eng' },
    ]);
    const { model } = await afterEncode(probe);
    expect(kept(model).map((s) => s.sourceIndex)).toEqual([0, 2, 3, 4]);
    const args = renderArgs({ model, input: '/lib/Film.mkv', output: '/tc/j1/out.mkv' });
    const maps = args.flatMap((a, i) => (a === '-map' ? [args[i + 1]] : []));
    expect(maps).toEqual(['0:0', '0:2', '0:3', '0:4']);
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect([at('-c:1'), at('-b:1'), at('-ac:1')]).toEqual(['aac', '160k', '2']);
    expect(at('-disposition:1')).toBe('default');
    expect(at('-disposition:2')).toBe('0');
  });
});
