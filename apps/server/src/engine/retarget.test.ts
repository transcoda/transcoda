import { describe, expect, it } from 'vitest';
import { modelFromProbe } from './build-model.ts';
import { autoStreams, retarget } from './retarget.ts';
import { probeOf, withStream } from './test-helpers.ts';

const probe = probeOf([
  { type: 'video', codec: 'h264' },
  { type: 'video', codec: 'h264' },
]);
const nvenc = (preset: string, pixelFormat: string) =>
  withStream(
    withStream(modelFromProbe(probe), 0, {
      mode: 'convert',
      codec: 'hevc',
      encoder: 'hevc_nvenc',
      quality: 24,
      bitrateKbps: 8000,
      preset,
      pixelFormat,
    }),
    1,
    {
      mode: 'convert',
      codec: 'hevc',
      encoder: 'hevc_nvenc',
      quality: 26,
      preset: 'p4',
      pixelFormat: 'yuv420p',
    },
  );
const ENCODERS = ['hevc_nvenc', 'h264_nvenc', 'hevc_qsv', 'h264_qsv', 'libx265'];

describe('retarget', () => {
  it('moves an auto NVENC stream to QSV with its preset and pixel format mapped', () => {
    const model = nvenc('p5', 'yuv420p10le');
    const out = retarget(model, new Set([0]), 'intel', ENCODERS);
    expect(out?.streams[0]).toMatchObject({
      encoder: 'hevc_qsv',
      preset: 'slow',
      pixelFormat: 'p010le',
      quality: 24,
      bitrateKbps: 8000,
    });
  });

  it('leaves a stream that is not auto as it is', () => {
    const model = nvenc('p5', 'yuv420p10le');
    const out = retarget(model, new Set([0]), 'intel', ENCODERS);
    expect(out?.streams[1]).toBe(model.streams[1]);
    expect(out?.streams[1]?.encoder).toBe('hevc_nvenc');
  });

  it('is null when this ffmpeg has no encoder of the target vendor', () => {
    const model = nvenc('p5', 'yuv420p10le');
    expect(retarget(model, new Set([0]), 'intel', ['hevc_nvenc', 'libx265'])).toBeNull();
  });

  it('gives the same model when the stream is already on the vendor', () => {
    const model = nvenc('p5', 'yuv420p10le');
    expect(retarget(model, new Set([0, 1]), 'nvidia', ENCODERS)).toBe(model);
  });

  it('maps QSV presets back to NVENC and keeps the pixel format', () => {
    const model = withStream(modelFromProbe(probe), 0, {
      mode: 'convert',
      codec: 'h264',
      encoder: 'h264_qsv',
      preset: 'veryslow',
      pixelFormat: 'nv12',
    });
    const out = retarget(model, new Set([0]), 'nvidia', ENCODERS);
    expect(out?.streams[0]).toMatchObject({
      encoder: 'h264_nvenc',
      preset: 'slow',
      pixelFormat: 'nv12',
    });
  });

  it('an unknown preset becomes medium', () => {
    const model = nvenc('hq', 'yuv420p');
    const out = retarget(model, new Set([0]), 'intel', ENCODERS);
    expect(out?.streams[0]).toMatchObject({ preset: 'medium', pixelFormat: 'nv12' });
  });
});

describe('autoStreams', () => {
  it('names a picked stream that still has the picked encoder', () => {
    const model = nvenc('p5', 'yuv420p');
    const picks = [{ sourceIndex: 0, input: 0, encoder: 'hevc_nvenc' }];
    expect(autoStreams(model, picks)).toEqual(new Set([0]));
  });

  it('drops a stream whose encoder a later hook changed', () => {
    const model = withStream(nvenc('p5', 'yuv420p'), 0, { encoder: 'libx265' });
    const picks = [{ sourceIndex: 0, input: 0, encoder: 'hevc_nvenc' }];
    expect(autoStreams(model, picks)).toEqual(new Set());
  });

  it('drops a picked stream that is no longer kept or converted', () => {
    const picks = [{ sourceIndex: 0, input: 0, encoder: 'hevc_nvenc' }];
    expect(autoStreams(withStream(nvenc('p5', 'yuv420p'), 0, { keep: false }), picks)).toEqual(
      new Set(),
    );
    expect(autoStreams(modelFromProbe(probe), picks)).toEqual(new Set());
  });
});
