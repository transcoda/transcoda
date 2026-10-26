/**
 * The codec picker's table (UI list #40): common codecs by ffmpeg id (what a setting stores and
 * what ffprobe reports) with a plain name, grouped by what a library owner does with them. The
 * target is HEVC or AV1; everything else is a candidate for re-encoding.
 */

export type CodecMedia = 'video' | 'audio';

export interface Codec {
  /** The ffmpeg codec id, as stored. */
  id: string;
  name: string;
  /** A short note under the name (e.g. that a profile cannot be told apart by codec). */
  note?: string;
}

export interface CodecGroup {
  key: string;
  label: string;
  codecs: Codec[];
}

/** A one-click choice: adds every codec of the named groups. */
export interface CodecPreset {
  label: string;
  groups: string[];
}

export const VIDEO_CODEC_GROUPS: CodecGroup[] = [
  {
    key: 'efficient',
    label: 'Efficient (target)',
    codecs: [
      { id: 'hevc', name: 'HEVC / H.265' },
      { id: 'av1', name: 'AV1' },
    ],
  },
  {
    key: 'common',
    label: 'Common',
    codecs: [
      { id: 'h264', name: 'H.264 / AVC' },
      { id: 'vp9', name: 'VP9' },
    ],
  },
  {
    key: 'older',
    label: 'Older (worth re-encoding)',
    codecs: [
      { id: 'mpeg4', name: 'MPEG-4 Part 2 (Xvid, DivX)' },
      { id: 'mpeg2video', name: 'MPEG-2' },
      { id: 'vc1', name: 'VC-1' },
      { id: 'wmv3', name: 'Windows Media Video 9' },
      { id: 'msmpeg4v3', name: 'MS MPEG-4 v3' },
      { id: 'mpeg1video', name: 'MPEG-1' },
      { id: 'h263', name: 'H.263' },
      { id: 'vp8', name: 'VP8' },
      { id: 'theora', name: 'Theora' },
    ],
  },
];

export const VIDEO_CODEC_PRESETS: CodecPreset[] = [
  { label: 'Efficient (HEVC, AV1)', groups: ['efficient'] },
  { label: 'Everything else', groups: ['common', 'older'] },
];

export const AUDIO_CODEC_GROUPS: CodecGroup[] = [
  {
    key: 'lossless',
    label: 'Lossless',
    codecs: [
      { id: 'flac', name: 'FLAC' },
      { id: 'truehd', name: 'TrueHD' },
      {
        id: 'dts',
        name: 'DTS-HD MA',
        note: 'Same codec id as DTS: the profile is not told apart by codec',
      },
    ],
  },
  {
    key: 'surround',
    label: 'Surround (lossy)',
    codecs: [
      { id: 'ac3', name: 'AC-3' },
      { id: 'eac3', name: 'E-AC-3' },
      { id: 'dts', name: 'DTS' },
    ],
  },
  {
    key: 'stereo',
    label: 'Stereo-friendly',
    codecs: [
      { id: 'aac', name: 'AAC' },
      { id: 'opus', name: 'Opus' },
      { id: 'mp3', name: 'MP3' },
      { id: 'vorbis', name: 'Vorbis' },
    ],
  },
];

export function codecGroups(media: CodecMedia): CodecGroup[] {
  return media === 'video' ? VIDEO_CODEC_GROUPS : AUDIO_CODEC_GROUPS;
}

export function codecPresets(media: CodecMedia): CodecPreset[] {
  return media === 'video' ? VIDEO_CODEC_PRESETS : [];
}

/**
 * A stored id's plain name for its chip; an id the table does not know (typed by hand) is shown
 * as it is. An id in two groups (audio `dts`) reads with its plain, last-listed name ("DTS").
 */
export function codecName(media: CodecMedia, id: string): string {
  let name: string | undefined;
  for (const g of codecGroups(media)) {
    for (const c of g.codecs) if (c.id === id) name = c.name;
  }
  return name ?? id;
}
