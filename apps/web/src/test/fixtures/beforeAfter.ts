import type { JobProbe } from '@transcoda/contract';
import type { BeforeAfterJob } from '../../jobs/compareJob.ts';

// The before/after panel's example: a test-encode of an 11.58 GB HEVC MKV (TrueHD 5.1 and
// AC-3 5.1 English, PGS English) to 2.12 GB with hevc_nvenc QP 24 and two AAC 2.0 160 kb/s tracks.

type Stream = JobProbe['streams'][number];
type PlanStream = NonNullable<BeforeAfterJob['plan']>['streams'][number];

export function stream(over: Partial<Stream> & Pick<Stream, 'index' | 'type' | 'codec'>): Stream {
  return {
    language: null,
    title: null,
    default: false,
    forced: false,
    attachedPic: false,
    dispositions: [],
    width: null,
    height: null,
    profile: null,
    level: null,
    pixelFormat: null,
    bitDepth: null,
    hdr: null,
    channels: null,
    sampleRate: null,
    bitrateKbps: null,
    frameRate: null,
    tagBitrateKbps: null,
    ...over,
  };
}

/** The 1h52m film of the example: 11.58 GB at 13.7 Mbit/s. */
const DURATION = 6762;

/**
 * The source: HEVC with stale DVDFab statistics (17.9 Mbit/s of video would be 15.1 GB in an
 * 11.58 GB file), TrueHD whose statistics fit, AC-3 with ffprobe's own bitrate, PGS subtitles.
 */
export function source(): JobProbe {
  return {
    container: 'mkv',
    durationSeconds: DURATION,
    sizeBytes: 11_580_000_000,
    bitrateKbps: 13_700,
    streams: [
      stream({
        index: 0,
        type: 'video',
        codec: 'hevc',
        profile: 'main',
        width: 1920,
        height: 1080,
        frameRate: 24000 / 1001,
        bitDepth: 8,
        hdr: 'none',
        tagBitrateKbps: 17_900,
      }),
      stream({
        index: 1,
        type: 'audio',
        codec: 'truehd',
        channels: 6,
        language: 'eng',
        tagBitrateKbps: 3_460,
      }),
      stream({
        index: 2,
        type: 'audio',
        codec: 'ac3',
        channels: 6,
        language: 'eng',
        bitrateKbps: 640,
        tagBitrateKbps: 640,
      }),
      stream({ index: 3, type: 'subtitle', codec: 'hdmv_pgs_subtitle', language: 'eng' }),
    ],
  };
}

/** What ffmpeg wrote: the source's statistics tags copied onto re-encoded streams (stale). */
export function output(): JobProbe {
  return {
    container: 'mkv',
    durationSeconds: DURATION,
    sizeBytes: 2_120_000_000,
    bitrateKbps: 2_500,
    streams: [
      stream({
        index: 0,
        type: 'video',
        codec: 'hevc',
        profile: 'main',
        width: 1920,
        height: 1080,
        frameRate: 24000 / 1001,
        bitDepth: 8,
        hdr: 'none',
        tagBitrateKbps: 17_900,
      }),
      stream({
        index: 1,
        type: 'audio',
        codec: 'aac',
        channels: 2,
        language: 'eng',
        tagBitrateKbps: 640,
      }),
      stream({
        index: 2,
        type: 'audio',
        codec: 'aac',
        channels: 2,
        language: 'eng',
        tagBitrateKbps: 640,
      }),
      stream({ index: 3, type: 'subtitle', codec: 'hdmv_pgs_subtitle', language: 'eng' }),
    ],
  };
}

export function planStream(
  over: Partial<PlanStream> & Pick<PlanStream, 'index' | 'type' | 'codec'>,
) {
  return {
    language: 'eng',
    title: null,
    isOriginalLanguage: true,
    default: { before: false, after: false },
    forced: false,
    action: 'keep' as const,
    note: '',
    ...over,
  };
}

export const AAC = 'convert truehd→aac (aac 160k 2ch)';

export function plan(): NonNullable<BeforeAfterJob['plan']> {
  return {
    container: { from: 'mkv', to: 'mkv' },
    rewrite: true,
    streams: [
      planStream({
        index: 0,
        type: 'video',
        codec: 'hevc',
        language: null,
        action: 'convert',
        note: 'convert hevc→hevc (hevc_nvenc qp 24 p5 yuv420p)',
      }),
      planStream({ index: 1, type: 'audio', codec: 'aac', action: 'convert', note: AAC }),
      planStream({
        index: 2,
        type: 'audio',
        codec: 'aac',
        action: 'convert',
        note: 'convert ac3→aac (aac 160k 2ch)',
      }),
      planStream({ index: 3, type: 'subtitle', codec: 'hdmv_pgs_subtitle' }),
    ],
    output: [
      { type: 'video', codec: 'hevc', sourceIndex: 0, bitDepth: 8 },
      { type: 'audio', codec: 'aac', sourceIndex: 1, channels: 2 },
      { type: 'audio', codec: 'aac', sourceIndex: 2, channels: 2 },
      { type: 'subtitle', codec: 'hdmv_pgs_subtitle', sourceIndex: 3 },
    ],
  };
}

export function testEncode(over: Partial<BeforeAfterJob> = {}): BeforeAfterJob {
  return {
    state: 'dry_run',
    dryRun: true,
    testEncode: true,
    dependsOnSize: null,
    probe: source(),
    outputProbe: output(),
    plan: plan(),
    result: { beforeBytes: 11_580_000_000, afterBytes: 2_120_000_000, estimatedBytes: null },
    ...over,
  };
}
