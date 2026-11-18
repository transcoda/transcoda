import type { JobProbe } from '@transcoda/contract';
import { isPicture } from '@transcoda/shared';
import { codecName } from '../data/codecs.ts';
import { languageNameOf } from '../jobs/planText.ts';
import { fmtDuration } from '../lib/time.ts';

/** What a file page says about a probe, one plain string per fact. */
export interface ProbeFacts {
  container: string;
  length: string;
  /** "HEVC 1920×1080"; null when the file has no video stream. */
  video: string | null;
  /** "English · AAC 5.1 (default)", one per track. */
  audio: string[];
  /** "English (forced)", one per track. */
  subtitles: string[];
}

type Stream = JobProbe['streams'][number];

const CHANNELS: Record<number, string> = { 1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1' };

/** "HEVC", "H.264", "AAC": the short name, without the "/ H.265" alias of the codec picker. */
function shortCodec(media: 'video' | 'audio', codec: string): string {
  if (codec.startsWith('pcm_')) return 'PCM';
  return codecName(media, codec).split(' / ')[0] ?? codec;
}

/** ISO 639-2 codes in either form ('ger' and 'deu') and the two-letter ones; null reads "Untagged". */
const language = (s: Stream) => languageNameOf(s.language);

function audioText(s: Stream): string {
  const codec = shortCodec('audio', s.codec);
  const layout = s.channels ? (CHANNELS[s.channels] ?? `${s.channels} ch`) : null;
  const flags = [s.default ? 'default' : null, s.forced ? 'forced' : null].filter(Boolean);
  const tail = flags.length > 0 ? ` (${flags.join(', ')})` : '';
  return `${language(s)} · ${codec}${layout ? ` ${layout}` : ''}${tail}`;
}

function subtitleText(s: Stream): string {
  return `${language(s)}${s.forced ? ' (forced)' : ''}`;
}

export function probeFacts(p: JobProbe): ProbeFacts {
  const video = p.streams.find((s) => s.type === 'video' && !isPicture(s, p.streams));
  const size = video?.width && video.height ? ` ${video.width}×${video.height}` : '';
  return {
    container: p.container,
    length: fmtDuration(p.durationSeconds * 1000),
    video: video ? `${shortCodec('video', video.codec)}${size}` : null,
    audio: p.streams.filter((s) => s.type === 'audio').map(audioText),
    subtitles: p.streams.filter((s) => s.type === 'subtitle').map(subtitleText),
  };
}
