import type { JsonValue } from '@transcoda/shared';
import { type FieldSpec, snapNumber } from './schema-fields.ts';

/** How a stored setting value reads, on the card and in the inspector alike. */

/**
 * Plain names for the core nodes' single-word option values (codec, container and mode ids as
 * ffmpeg and the schemas spell them), so the inspector never shows a raw id such as "hevc" or
 * "reencode". The stored value never changes.
 */
const OPTION_LABELS: Record<string, string> = {
  hevc: 'HEVC (H.265)',
  h264: 'H.264',
  av1: 'AV1',
  quality: 'Quality',
  bitrate: 'Bitrate',
  never: 'Never',
  copy: 'Copy',
  reencode: 'Re-encode',
  aac: 'AAC',
  ac3: 'AC-3',
  opus: 'Opus',
  none: 'None',
  stereo: 'Stereo',
  convert: 'Convert',
  fail: 'Fail',
  keep: 'Keep',
  recycle: 'Recycle',
  move: 'Move',
  mkv: 'MKV',
  mp4: 'MP4',
  audio: 'Audio',
  subtitle: 'Subtitle',
  'android-tv': 'Android TV',
  chrome: 'Chrome',
};

/**
 * Display text for an enum value: a plain name from `OPTION_LABELS`, else multi-word ids are
 * sentence-cased ("drop-incompatible" → "Drop incompatible"); other single tokens stay as stored
 * (a plugin's ids, whose casing cannot be guessed). The stored value never changes.
 */
export function humanise(value: string): string {
  const named = OPTION_LABELS[value];
  if (named !== undefined) return named;
  if (!/[-_]/.test(value)) return value;
  const words = value.replace(/[-_]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A stored number as shown: on the field's step (a percent saved as 11.58 reads 12). */
export function numberText(spec: FieldSpec, v: JsonValue | undefined): string {
  if (typeof v !== 'number') return '';
  return String(spec.kind === 'number' && !spec.integer ? snapNumber(spec, v) : v);
}
