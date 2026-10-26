/** Display names of audio codecs, as a title or a reason writes them. */
export const CODEC_NAMES: Record<string, string> = {
  aac: 'AAC',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  truehd: 'TrueHD',
  dts: 'DTS',
  flac: 'FLAC',
  opus: 'Opus',
  mp3: 'MP3',
  vorbis: 'Vorbis',
  alac: 'ALAC',
};

/**
 * Codec names a title may carry, longest first so `DTS-HD MA` wins over `DTS`. An `Audio` after
 * one belongs to it (`DTS Audio`, `DTS-HD Master Audio`); alone it stays.
 */
const CODEC =
  'dolby\\s+digital\\s+plus|dolby\\s+digital|dolby\\s+true\\s*hd|dolby\\s+atmos|true\\s*hd|dts[-\\s]?hd(?:\\s+(?:ma|master\\s+audio|hra|high\\s+resolution(?:\\s+audio)?))?|dts[-:\\s]?(?:x|es)|dd\\+|ddp|dd|e-?ac-?3|ac-?3|he-?aac(?:v2)?|aac(?:-?lc)?|dts|dolby|atmos|flac|l?pcm|alac|mlp|opus|vorbis|mp[23]|lossless';

/**
 * One format part of a title, as a whole word: a codec name, a layout (`5.1`, `stereo`), a channel
 * count, a bitrate, a sample rate or a bit depth. Plain numbers (a year, a part) are never one.
 */
const PART = new RegExp(
  '(?<![\\p{L}\\p{N}.])(?:' +
    `(?<codec>(?:${CODEC})(?:\\s+audio)?)` +
    '|(?<layout>[1-9]\\.[0-2](?:\\.\\d)?|stereo|mono|surround|\\d+\\s*ch)' +
    '|(?<bitrate>\\d+(?:[.,]\\d+)?\\s*(?:kb/s|kbps|kbit/s))' +
    '|(?<rate>\\d+(?:[.,]\\d+)?\\s*khz)' +
    '|(?<depth>\\d+[\\s-]*bits?)' +
    ')(?![\\p{L}\\p{N}])',
  'giu',
);

const LAYOUTS: Record<number, string> = {
  1: '1.0',
  2: '2.0',
  3: '2.1',
  6: '5.1',
  7: '6.1',
  8: '7.1',
};

/** What a converted track writes, as its new title names it. */
export interface TitleFormat {
  codec: string;
  channels: number | null;
  bitrateKbps: number | null;
}

/**
 * The title of a converted audio track with its format parts naming what the encode writes. The
 * first format part becomes the new format (codec, layout, then the sample rate and bitrate when
 * the title named them; never a bit depth, which a lossy codec does not have), the others go, and
 * every other word stays: `USA / DTS-HD Master Audio / 5.1 / 48 kHz / 2823 kbps / 24-bit` →
 * `USA / AAC / 2.0 / 48 kHz / 160 kbps`. The new parts are joined the way the title joined its
 * own (` / ` or a space). A title without format parts is left as it is.
 */
export function retitle(title: string | null, out: TitleFormat): string | null {
  if (!title) return title;
  const parts = [...title.matchAll(PART)];
  if (parts.length === 0) return title;
  const first = (kind: string) => parts.find((m) => m.groups?.[kind] !== undefined);
  const named = [CODEC_NAMES[out.codec] ?? out.codec.toUpperCase()];
  if (out.channels !== null) named.push(LAYOUTS[out.channels] ?? `${out.channels}ch`);
  const rate = first('rate');
  // libopus encodes at 48 kHz whatever the source rate; the other encoders keep it.
  if (rate) named.push(out.codec === 'opus' ? '48 kHz' : rate[0]);
  if (first('bitrate') && out.bitrateKbps !== null) named.push(`${out.bitrateKbps} kbps`);
  const gaps = parts.slice(1).map((m, i) => {
    const prev = parts[i] as RegExpExecArray;
    return title.slice(prev.index + prev[0].length, m.index);
  });
  const separator = gaps.some((g) => /[/|]/.test(g)) ? ' / ' : ' ';
  let result = '';
  let last = 0;
  for (const [i, m] of parts.entries()) {
    result += title.slice(last, m.index) + (i === 0 ? named.join(separator) : '');
    last = m.index + m[0].length;
  }
  return tidy(result + title.slice(last));
}

/** Separators and brackets left empty by the dropped parts go; spaces collapse. */
function tidy(s: string): string {
  return s
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s*([/|,])(?:\s*[/|,])+/g, ' $1 ')
    .replace(/^[\s/|,-]+|[\s/|,-]+$/g, '')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s{2,}/g, ' ');
}
