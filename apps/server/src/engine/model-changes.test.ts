import type { BuildModel } from '@transcoda/sdk';
import { changesFile } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { modelFromProbe } from './build-model.ts';
import { modelChanges } from './model-changes.ts';
import { probeOf } from './test-helpers.ts';

const probe = probeOf([
  { type: 'video', codec: 'hevc', default: true },
  { type: 'audio', codec: 'aac', language: 'eng', channels: 2 },
  { type: 'audio', codec: 'ac3', language: 'tur', channels: 6, default: true },
  { type: 'subtitle', codec: 'subrip', language: 'eng', forced: true },
]);

/** A deep copy of the model, as a hook's `copyModel` makes one. */
const copy = (m: BuildModel): BuildModel => structuredClone(m);

describe('modelChanges', () => {
  it('an unchanged model (targets aside) changes nothing', () => {
    const before = modelFromProbe(probe);
    const after = copy(before);
    after.targets.push('chrome');
    const changes = modelChanges(before, after);
    expect(changes).toEqual({
      dropped: [],
      added: [],
      converted: [],
      defaults: [],
      reordered: false,
      other: false,
    });
    expect(changesFile(changes)).toBe(false);
  });

  it('names dropped streams and the defaults handed on, but not the dropped default', () => {
    const before = modelFromProbe(probe);
    const after = copy(before);
    const [, en, tr] = after.streams;
    if (!en || !tr) throw new Error('fixture');
    tr.keep = false;
    en.default = true;
    const changes = modelChanges(before, after);
    expect(changes.dropped).toEqual([
      { index: 2, type: 'audio', codec: 'ac3', language: 'tur', forced: false },
    ]);
    expect(changes.defaults).toEqual([
      {
        index: 1,
        type: 'audio',
        codec: 'aac',
        language: 'eng',
        forced: false,
        before: false,
        after: true,
      },
    ]);
    expect(changesFile(changes)).toBe(true);
  });

  it('a conversion says from what to what, with the encoder settings', () => {
    const before = modelFromProbe(probe);
    const after = copy(before);
    Object.assign(after.streams[0] ?? {}, {
      mode: 'convert',
      codec: 'hevc',
      encoder: 'hevc_nvenc',
      quality: 24,
      preset: 'medium',
      pixelFormat: 'yuv420p10le',
    });
    expect(modelChanges(before, after).converted).toEqual([
      {
        index: 0,
        type: 'video',
        codec: 'hevc',
        language: null,
        forced: false,
        from: 'hevc',
        encoder: 'hevc_nvenc',
        quality: 24,
        preset: 'medium',
        bitrateKbps: null,
        channels: null,
        pixelFormat: 'yuv420p10le',
      },
    ]);
  });

  it('a second stream from the same source is added, and the order change is seen', () => {
    const before = modelFromProbe(probe);
    const after = copy(before);
    const main = after.streams[2];
    if (!main) throw new Error('fixture');
    after.streams.push({
      ...main,
      mode: 'convert',
      codec: 'aac',
      encoder: 'aac',
      bitrateKbps: 160,
      channels: 2,
      order: 3,
    });
    const sub = after.streams[3];
    if (sub) sub.order = 4;
    const changes = modelChanges(before, after);
    expect(changes.added).toEqual([
      {
        index: 2,
        type: 'audio',
        codec: 'aac',
        language: 'tur',
        forced: false,
        from: 'ac3',
        encoder: 'aac',
        quality: null,
        preset: null,
        bitrateKbps: 160,
        channels: 2,
        pixelFormat: null,
      },
    ]);
    // The kept source streams are still in the same order among themselves.
    expect(changes.reordered).toBe(false);

    const swapped = copy(before);
    const [, a, b] = swapped.streams;
    if (!a || !b) throw new Error('fixture');
    a.order = 2;
    b.order = 1;
    expect(modelChanges(before, swapped).reordered).toBe(true);
  });

  it('a new container, a title or an ffmpeg option is a change', () => {
    const before = modelFromProbe(probe);
    const mp4 = copy(before);
    mp4.container = 'mp4';
    expect(modelChanges(before, mp4).container).toEqual({ from: 'mkv', to: 'mp4' });

    const titled = copy(before);
    if (titled.streams[1]) titled.streams[1].title = 'Stereo';
    expect(modelChanges(before, titled).other).toBe(true);

    const args = copy(before);
    args.inputArgs.push('-probesize', '50M');
    expect(modelChanges(before, args).other).toBe(true);
  });

  it('a stream from an extra input carries its file name', () => {
    const before = modelFromProbe(probe);
    const after = copy(before);
    after.extraInputs = [
      {
        path: '/media/Show.de.srt',
        kind: 'subtitle',
        afterReplace: 'keep',
        codec: 'subrip',
        label: { file: 'Show.de.srt', language: 'deu', forced: false, sdh: false },
      },
    ];
    after.streams.push({
      ...(after.streams[3] as BuildModel['streams'][number]),
      sourceIndex: -1,
      input: 1,
      language: 'deu',
      forced: false,
      order: 4,
    });
    expect(modelChanges(before, after).added).toMatchObject([
      { index: -1, type: 'subtitle', language: 'deu', file: 'Show.de.srt' },
    ]);
  });
});
