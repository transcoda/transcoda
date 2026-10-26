import { z } from 'zod';

export const DEVICE_PROFILE_IDS = ['android-tv', 'chrome'] as const;
export type DeviceProfileId = (typeof DEVICE_PROFILE_IDS)[number];
export const DeviceProfileIdSchema = z.enum(DEVICE_PROFILE_IDS).describe('Target devices');

/** What a playback device decodes without transcoding. Profiles are in `normalizeProfile` form. */
export interface DeviceProfile {
  id: DeviceProfileId;
  name: string;
  sources: string[];
  /** Keyed by ffprobe codec name: 'h264', 'hevc', 'av1', 'vp9'. A missing codec is unsupported. */
  video: Record<
    string,
    { profiles: string[]; maxLevel: number; bitDepths: number[]; hdr: string[] }
  >;
  audio: Record<string, { maxChannels: number }>;
  /** ffprobe subtitle codec names. */
  subtitles: string[];
  containers: Array<'mkv' | 'mp4'>;
}

/**
 * Device profiles are data. Each value was checked against the listed sources; a value they do
 * not confirm is left out (unsupported) or lowered. See docs/decisions.md, M1 engine Task 2.
 */
export const DEVICE_PROFILES: Record<DeviceProfileId, DeviceProfile> = {
  'android-tv': {
    id: 'android-tv',
    name: 'Android TV (Google TV / Shield class)',
    sources: [
      'https://developer.android.com/media/platform/supported-formats',
      'https://developer.android.com/media/media3/exoplayer/supported-formats',
      'https://github.com/androidx/media/tree/release/libraries/extractor/src/main/java/androidx/media3/extractor/text',
      'https://www.nvidia.com/en-us/shield/shield-tv-pro/',
    ],
    video: {
      h264: {
        profiles: ['constrained-baseline', 'baseline', 'main', 'high'],
        maxLevel: 51,
        bitDepths: [8],
        hdr: [],
      },
      hevc: {
        profiles: ['main', 'main10'],
        maxLevel: 153,
        bitDepths: [8, 10],
        hdr: ['hdr10', 'hlg'],
      },
    },
    audio: {
      aac: { maxChannels: 6 },
      ac3: { maxChannels: 6 },
      eac3: { maxChannels: 8 },
      opus: { maxChannels: 8 },
      flac: { maxChannels: 2 },
      mp3: { maxChannels: 2 },
    },
    subtitles: ['subrip', 'ass', 'ssa', 'hdmv_pgs_subtitle', 'mov_text'],
    containers: ['mkv', 'mp4'],
  },
  chrome: {
    id: 'chrome',
    name: 'Chrome (desktop)',
    sources: [
      'https://www.chromium.org/audio-video/',
      'https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs',
    ],
    video: {
      h264: {
        profiles: ['constrained-baseline', 'baseline', 'main', 'high'],
        maxLevel: 51,
        bitDepths: [8],
        hdr: [],
      },
      av1: { profiles: ['main'], maxLevel: 53, bitDepths: [8, 10], hdr: ['hdr10'] },
      vp9: {
        profiles: ['profile0', 'profile2'],
        maxLevel: 62,
        bitDepths: [8, 10],
        hdr: ['hdr10', 'hlg'],
      },
    },
    audio: {
      aac: { maxChannels: 6 },
      opus: { maxChannels: 8 },
      flac: { maxChannels: 8 },
      mp3: { maxChannels: 2 },
      vorbis: { maxChannels: 8 },
    },
    // <video> renders only WebVTT in-band; Jellyfin's web player extracts text subtitles
    // server-side, so the text formats count as playable through that path.
    subtitles: ['webvtt', 'subrip', 'ass', 'ssa', 'mov_text'],
    containers: ['mkv', 'mp4'],
  },
};
