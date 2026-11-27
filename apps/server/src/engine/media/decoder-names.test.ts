import { describe, expect, it } from 'vitest';
import { sourceDecoderNames } from './decoder-names.ts';

describe('sourceDecoderNames', () => {
  it('maps ffprobe codec names to the decoder names ffmpeg logs under', () => {
    const names = sourceDecoderNames(['dts', 'h264', 'mp3', 'hdmv_pgs_subtitle']);
    for (const n of ['dts', 'dca', 'h264', 'mp3', 'mp3float', 'hdmv_pgs_subtitle', 'pgssub']) {
      expect(names.has(n)).toBe(true);
    }
    expect(names.has('aac')).toBe(false);
  });

  it('adds no name that is also an ffmpeg encoder Transcoda runs (srt, ssa)', () => {
    const names = sourceDecoderNames(['subrip', 'ass']);
    expect([...names].sort()).toEqual(['ass', 'subrip']);
  });
});
