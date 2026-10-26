import { describe, expect, it } from 'vitest';
import { modelFromProbe } from './build-model.ts';
import { ffmpegFailure, looksLikeGpuFailure, softwareFallback } from './fallback.ts';
import { probeOf, withStream } from './test-helpers.ts';

/** The tail of the Paddington 2 log on CT 111 (2026-10-23). */
const PADDINGTON = [
  '[in#0/matroska,webm @ 0x5630ed58e340] [warning] Stream #1: not enough frames to estimate rate',
  '[mjpeg @ 0x5630ee999ac0] [error] decoder->cvdl->cuvidDecodePicture(decoder->decoder, &ctx->pic_params) failed -> CUDA_ERROR_INVALID_IMAGE: device kernel image is invalid',
  '[vist#0:1/mjpeg @ 0x5630ed621bc0] [dec:mjpeg @ 0x5630ee998ec0] [error] Error submitting packet to decoder: Generic error in an external library',
  '[hevc_nvenc @ 0x5630ee9c8940] [error] InitializeEncoder failed: invalid param (8): Frame dimensions are less than the minimum supported value.',
  '[vf#0:3 @ 0x5630ee9e3f40] [error] Task finished with error code: -22 (Invalid argument)',
  '[out#0/matroska @ 0x5630ed5def40] [error] Nothing was written into output file, because at least one of its streams received no packets.',
].join('\n');

describe('ffmpegFailure', () => {
  it('names the first cause, not the "Nothing was written" that follows it, with a hint', () => {
    expect(ffmpegFailure(PADDINGTON)).toBe(
      'mjpeg: decoder->cvdl->cuvidDecodePicture(decoder->decoder, &ctx->pic_params) failed -> CUDA_ERROR_INVALID_IMAGE: device kernel image is invalid (the GPU could not decode a stream)',
    );
  });

  it('a too-small frame for NVENC reads as such; without error lines the last line stands', () => {
    expect(
      ffmpegFailure(
        '[hevc_nvenc @ 0x1] [error] InitializeEncoder failed: invalid param (8): Frame dimensions are less than the minimum supported value.',
      ),
    ).toBe(
      'hevc_nvenc: InitializeEncoder failed: invalid param (8): Frame dimensions are less than the minimum supported value. (a video stream is too small for the GPU encoder)',
    );
    expect(ffmpegFailure('frame=1 fps=0\nsomething odd happened')).toBe('something odd happened');
    expect(ffmpegFailure('')).toBeNull();
  });
});

describe('softwareFallback', () => {
  const probe = probeOf([{ type: 'video', codec: 'h264' }, { type: 'audio' }]);
  const nvenc = withStream(modelFromProbe(probe), 0, {
    mode: 'convert',
    codec: 'hevc',
    encoder: 'hevc_nvenc',
    quality: 20,
    preset: 'p5',
    pixelFormat: 'p010le',
  });

  it('moves a hardware HEVC encode to libx265 with the same quality, no preset and a software pixel format', () => {
    const soft = softwareFallback(nvenc, ['libx265', 'aac']);
    expect(soft?.streams[0]).toMatchObject({
      encoder: 'libx265',
      quality: 20,
      preset: null,
      pixelFormat: 'yuv420p10le',
    });
    expect(soft?.streams[1]).toEqual(nvenc.streams[1]);
  });

  it('is null without a software encoder here, and for a plan with no hardware encode', () => {
    expect(softwareFallback(nvenc, ['aac'])).toBeNull();
    expect(softwareFallback(modelFromProbe(probe), ['libx265'])).toBeNull();
  });

  it('tells GPU failures from others', () => {
    expect(looksLikeGpuFailure(PADDINGTON)).toBe(true);
    expect(looksLikeGpuFailure('No space left on device')).toBe(false);
  });
});
