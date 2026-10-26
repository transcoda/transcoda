// What the job page's player can tell before it plays a test output: from the plan's output
// tracks, the video and the first audio track, their names, and whether this browser plays them.
import type { JobDetail } from '@transcoda/contract';
import { codecName } from '../data/codecs.ts';

type Track = NonNullable<NonNullable<JobDetail['plan']>['output']>[number];

/** Audio the server copies into an mkv's mp4 preview (server PREVIEW_AUDIO); other audio is left out. */
const PREVIEW_AUDIO: ReadonlySet<string> = new Set([
  'aac',
  'mp3',
  'opus',
  'flac',
  'alac',
  'ac3',
  'eac3',
]);

const CHANNELS: Record<number, string> = { 1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1' };

/** "HEVC 10-bit", "H.264" (8-bit is not named). */
export function videoLabel(t: Track): string {
  const name = codecName('video', t.codec).split(' / ')[0] ?? t.codec;
  return t.bitDepth !== undefined && t.bitDepth !== 8 ? `${name} ${t.bitDepth}-bit` : name;
}

/** "E-AC-3 5.1", "AAC stereo", "PCM". */
export function audioLabel(t: Track): string {
  const name = t.codec.startsWith('pcm_') ? 'PCM' : codecName('audio', t.codec);
  if (t.channels === undefined) return name;
  return `${name} ${CHANNELS[t.channels] ?? `${t.channels}ch`}`;
}

/** The mp4 `codecs` parameter for canPlayType; null for a codec no browser plays in mp4. */
function codecString(t: Track): string | null {
  const deep = t.bitDepth !== undefined && t.bitDepth > 8;
  switch (t.codec) {
    case 'hevc':
      return deep ? 'hvc1.2.4.L153.B0' : 'hvc1.1.6.L93.B0';
    case 'h264':
      return deep ? 'avc1.6E0028' : 'avc1.640028';
    case 'av1':
      return deep ? 'av01.0.08M.10' : 'av01.0.08M.08';
    case 'vp9':
      return deep ? 'vp09.02.10.10' : 'vp09.00.10.08';
    case 'aac':
      return 'mp4a.40.2';
    case 'mp3':
      return 'mp4a.40.34';
    case 'opus':
      return 'opus';
    case 'flac':
      return 'fLaC';
    case 'alac':
      return 'alac';
    case 'ac3':
      return 'ac-3';
    case 'eac3':
      return 'ec-3';
    default:
      return null;
  }
}

let probe: HTMLVideoElement | null = null;

/** Whether this browser says it may play `t` in mp4 (`canPlayType` not empty). */
function browserPlays(t: Track): boolean {
  const codecs = codecString(t);
  if (codecs === null) return false;
  probe ??= document.createElement('video');
  return probe.canPlayType(`video/mp4; codecs="${codecs}"`) !== '';
}

export interface PreviewNotes {
  /** Lines to show above the player. */
  lines: string[];
  /** The video's label when this browser cannot play it; null otherwise. */
  unplayableVideo: string | null;
}

/**
 * What to say before the preview plays. An mkv's preview carries only audio the server copies
 * (PREVIEW_AUDIO), and none when the plan does not list the output's tracks; an mp4 output plays
 * as it is.
 */
export function previewNotes(
  plan: JobDetail['plan'] | undefined,
  container: 'mkv' | 'mp4',
): PreviewNotes {
  const output = plan?.output;
  const lines: string[] = [];
  let unplayableVideo: string | null = null;
  if (!output) {
    if (container === 'mkv') lines.push('The preview plays without sound.');
    return { lines, unplayableVideo };
  }
  const video = output.find((t) => t.type === 'video');
  if (video && !browserPlays(video)) {
    unplayableVideo = videoLabel(video);
    lines.push(`This browser can't play ${unplayableVideo} video.`);
  }
  const audio = output.find((t) => t.type === 'audio');
  if (audio) {
    const label = audioLabel(audio);
    if (container === 'mkv' && !PREVIEW_AUDIO.has(audio.codec)) {
      lines.push(`The preview can't carry ${label} audio, so it plays without sound.`);
    } else if (!browserPlays(audio)) {
      lines.push(
        `This browser can't play ${label} audio, so the preview plays without sound. Download the file to check the audio.`,
      );
    }
  }
  return { lines, unplayableVideo };
}
