import type { BuildModel, StreamPlan } from '@transcoda/sdk';
import { describe, expect, it } from 'vitest';
import { modelFromProbe } from '../model/model.ts';
import { probeOf } from '../testing/builders.ts';
import { trackChangesFor, trackChangesOnly, trackChangesReason } from './track-changes.ts';

/** The probe's model with `edit` applied to stream `i` (by position). */
function planned(
  probe: ReturnType<typeof probeOf>,
  edits: Record<number, Partial<StreamPlan>>,
  model: Partial<BuildModel> = {},
): BuildModel {
  const m = { ...modelFromProbe(probe), ...model };
  m.streams = m.streams.map((s, i) => ({ ...s, ...(edits[i] ?? {}) }));
  return m;
}

const toHevc: Partial<StreamPlan> = {
  mode: 'convert',
  codec: 'hevc',
  encoder: 'libx265',
  quality: 24,
  preset: 'medium',
  pixelFormat: 'yuv420p10le',
};
const toAac = (bitrateKbps: number, channels: number | null = null): Partial<StreamPlan> => ({
  mode: 'convert',
  codec: 'aac',
  encoder: 'aac',
  bitrateKbps,
  channels,
});

describe('trackChangesOnly', () => {
  it('copies every converted video and keeps every other change (drops, flags, order, titles, container)', () => {
    const probe = probeOf(
      [
        { type: 'video', codec: 'h264', default: true },
        { type: 'audio', codec: 'aac', language: 'eng', default: true },
        { type: 'audio', codec: 'aac', language: 'fre', title: 'French' },
        { type: 'audio', codec: 'aac', language: 'ger' },
      ],
      { container: 'mp4' },
    );
    const model = planned(
      probe,
      {
        0: toHevc,
        1: { default: false, order: 2 },
        2: { default: true, order: 1, title: 'Français' },
        3: { keep: false },
      },
      { container: 'mkv' },
    );
    const tc = trackChangesOnly(model, probe);
    const [video, eng, fre, ger] = tc.model.streams;
    expect(video).toMatchObject({
      mode: 'copy',
      codec: 'h264',
      encoder: null,
      quality: null,
      preset: null,
      pixelFormat: null,
    });
    expect(eng).toMatchObject({ default: false, order: 2 });
    expect(fre).toMatchObject({ default: true, order: 1, title: 'Français' });
    expect(ger?.keep).toBe(false);
    expect(tc.model.container).toBe('mkv');
    expect(tc.origins).toEqual([0, 1, 2, 3]);
    // The built model is left as it was.
    expect(model.streams[0]).toMatchObject({ mode: 'convert', codec: 'hevc' });
  });

  describe('converted audio', () => {
    const audio = (o: Parameters<typeof probeOf>[0][number]) =>
      probeOf([
        { type: 'video', codec: 'hevc' },
        { type: 'audio', default: true, ...o },
      ]);

    it('a lossless source stays converted: any lossy track is smaller', () => {
      const probe = audio({ codec: 'truehd', channels: 8 });
      const tc = trackChangesOnly(planned(probe, { 0: toHevc, 1: toAac(640, 6) }), probe);
      expect(tc.model.streams[1]).toMatchObject({ mode: 'convert', codec: 'aac', channels: 6 });
    });

    it('a lossy source at a known higher bitrate stays converted; at a lower or unknown one it is copied', () => {
      const high = audio({ codec: 'ac3', bitrateKbps: 640, channels: 6 });
      const kept = trackChangesOnly(planned(high, { 1: toAac(256) }), high);
      expect(kept.model.streams[1]?.mode).toBe('convert');

      const low = audio({ codec: 'ac3', bitrateKbps: 192, channels: 2 });
      const grown = trackChangesOnly(planned(low, { 1: toAac(256) }), low);
      expect(grown.model.streams[1]).toMatchObject({
        mode: 'copy',
        codec: 'ac3',
        encoder: null,
        bitrateKbps: null,
        channels: null,
      });

      const unknown = audio({ codec: 'ac3', channels: 6 });
      const tc = trackChangesOnly(planned(unknown, { 1: toAac(256) }), unknown);
      expect(tc.model.streams[1]?.mode).toBe('copy');
    });

    it('a conversion that makes the track play on more targets stays, even when it grows the track', () => {
      const probe = audio({ codec: 'dts', bitrateKbps: 128, channels: 2 });
      const tc = trackChangesOnly(
        planned(probe, { 1: toAac(160, 2) }, { targets: ['chrome'] }),
        probe,
      );
      expect(tc.model.streams[1]?.mode).toBe('convert');
    });

    it('a conversion that plays on fewer targets than the source is undone, even when it shrinks the track', () => {
      const probe = audio({ codec: 'flac', channels: 2 });
      const tc = trackChangesOnly(
        planned(
          probe,
          { 1: { mode: 'convert', codec: 'ac3', encoder: 'ac3', bitrateKbps: 192 } },
          { targets: ['chrome'] },
        ),
        probe,
      );
      expect(tc.model.streams[1]).toMatchObject({
        mode: 'copy',
        codec: 'flac',
      });
    });

    it("a copied track gets back the title Encode audio rewrote; another node's title stays", () => {
      const probe = audio({
        codec: 'ac3',
        channels: 6,
        title: 'English / AC-3 / 5.1 / 640 kbps',
      });
      const retitled = trackChangesOnly(
        planned(probe, { 1: { ...toAac(160, 2), title: 'English / AAC / 2.0 / 160 kbps' } }),
        probe,
      );
      expect(retitled.model.streams[1]?.title).toBe('English / AC-3 / 5.1 / 640 kbps');
      const named = trackChangesOnly(
        planned(probe, { 1: { ...toAac(160, 2), title: 'Main' } }),
        probe,
      );
      expect(named.model.streams[1]?.title).toBe('Main');
    });

    it('an added track whose conversion is undone is left out, and its source track is default again', () => {
      const probe = audio({ codec: 'ac3', channels: 2, bitrateKbps: 128 });
      const model = planned(probe, { 1: { default: false } });
      // Encode audio's "add track": a second plan of audio #1, the new default.
      model.streams.push({
        ...(model.streams[1] as StreamPlan),
        ...toAac(160, 2),
        default: true,
        order: 2,
      });
      const tc = trackChangesOnly(model, probe);
      expect(tc.model.streams).toHaveLength(2);
      expect(tc.origins).toEqual([0, 1]);
      expect(tc.model.streams[1]).toMatchObject({ mode: 'copy', default: true });
    });
  });
});

describe('trackChangesFor', () => {
  it('null when only the video would change; else the model with the output flags', () => {
    const probe = probeOf([
      { type: 'video', codec: 'h264', default: true },
      { type: 'audio', codec: 'aac', language: 'eng', default: true },
    ]);
    expect(trackChangesFor(planned(probe, { 0: toHevc }), probe)).toBeNull();
    const dropped = probeOf([
      { type: 'video', codec: 'h264', default: true },
      { type: 'audio', codec: 'aac', language: 'eng', default: true },
      { type: 'audio', codec: 'aac', language: 'ger' },
    ]);
    const tc = trackChangesFor(planned(dropped, { 0: toHevc, 2: { keep: false } }), dropped);
    expect(tc?.model.streams[2]?.keep).toBe(false);
  });

  it('normalises the default flags as the output will have them', () => {
    const probe = probeOf([
      { type: 'video', codec: 'h264', default: true },
      { type: 'audio', codec: 'aac', language: 'eng' },
      { type: 'audio', codec: 'aac', language: 'ger' },
    ]);
    // No audio is default in the source or the plan: the output's first audio is.
    const tc = trackChangesFor(planned(probe, { 0: toHevc, 2: { keep: false } }), probe);
    expect(tc?.model.streams[1]?.default).toBe(true);
  });
});

describe('trackChangesReason', () => {
  it('says the video was kept', () => {
    expect(trackChangesReason('saved only 4.0%, below 20%')).toBe(
      'saved only 4.0%, below 20% → wrote track changes without re-encoding',
    );
  });
});
