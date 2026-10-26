import { describe, expect, it } from 'vitest';
import { retitle } from './audio-title.ts';

const aac = (channels: number | null, bitrateKbps: number | null = 160) => ({
  codec: 'aac',
  channels,
  bitrateKbps,
});

describe('retitle', () => {
  it('replaces each format part of a slash-separated title and keeps the other parts', () => {
    expect(
      retitle('USA / DTS-HD Master Audio / 5.1 / 48 kHz / 2823 kbps / 24-bit', aac(2, 320)),
    ).toBe('USA / AAC / 2.0 / 48 kHz / 320 kbps');
    expect(
      retitle(
        'Commentary with creator Nick Park / DTS Audio / 2.0 / 48 kHz / 320 kbps / 16-bit',
        aac(2),
      ),
    ).toBe('Commentary with creator Nick Park / AAC / 2.0 / 48 kHz / 160 kbps');
  });

  it('rewrites format words inside a title written with spaces', () => {
    expect(retitle('English DTS 5.1 1509 kbps', aac(2))).toBe('English AAC 2.0 160 kbps');
    expect(retitle('Theatrical (DD+ 5.1)', aac(2))).toBe('Theatrical (AAC 2.0)');
    expect(retitle('German Stereo', aac(2))).toBe('German AAC 2.0');
  });

  it('a title of format words only becomes the new format', () => {
    expect(retitle('DTS-HD MA 7.1', { codec: 'ac3', channels: 6, bitrateKbps: 640 })).toBe(
      'AC-3 5.1',
    );
    expect(retitle('Dolby TrueHD Atmos 7.1', aac(2))).toBe('AAC 2.0');
    expect(retitle('Dolby Digital Plus 5.1', aac(6))).toBe('AAC 5.1');
    expect(retitle('Stereo', aac(2))).toBe('AAC 2.0');
  });

  it('names the bitrate and sample rate only when the title did; never a bit depth', () => {
    expect(retitle('FLAC 2.0 24-bit', aac(2))).toBe('AAC 2.0');
    expect(
      retitle('Main / FLAC / 5.1 / 44.1 kHz', { codec: 'opus', channels: 6, bitrateKbps: 256 }),
    ).toBe('Main / Opus / 5.1 / 48 kHz');
    expect(retitle('Main / FLAC / 5.1 / 44.1 kHz', aac(6))).toBe('Main / AAC / 5.1 / 44.1 kHz');
  });

  it('leaves out the layout when the channel count is unknown', () => {
    expect(retitle('DTS 5.1', aac(null))).toBe('AAC');
  });

  it('leaves a title without format words as it is', () => {
    for (const title of [
      'Theatrical',
      'Isolated score',
      'Hörfilm',
      'Master of Puppets',
      'Director 2004',
    ]) {
      expect(retitle(title, aac(2))).toBe(title);
    }
    expect(retitle(null, aac(2))).toBeNull();
    expect(retitle('', aac(2))).toBe('');
  });
});
