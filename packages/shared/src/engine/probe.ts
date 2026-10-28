import { z } from 'zod';

export const STREAM_TYPES = ['video', 'audio', 'subtitle', 'attachment', 'data'] as const;

/** What the API and UI see of a probed stream; the engine's full ProbeResult extends it in sdk. */
export const ProbeStreamSchema = z.object({
  index: z.number().int(),
  type: z.enum(STREAM_TYPES),
  codec: z.string(),
  /** normalised ISO 639-2/T, see language.ts */
  language: z.string().nullable(),
  title: z.string().nullable(),
  default: z.boolean(),
  forced: z.boolean(),
  attachedPic: z.boolean(),
  /**
   * A video stream that holds one picture though it is not flagged `attached_pic`: an image
   * `MIMETYPE` or `FILENAME` tag (an attachment an earlier remux turned into a video track), or a
   * single frame (`nb_frames` 1) next to a real video. Set by the probe; absent means no. Read it
   * through isPicture.
   */
  imageTrack: z.boolean().optional(),
  /**
   * Every other ffprobe disposition flag set to 1: comment, hearing_impaired, visual_impaired,
   * original, dub, lyrics, karaoke, clean_effects, captions, descriptions, metadata, dependent,
   * still_image.
   */
  dispositions: z.array(z.string()),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  profile: z.string().nullable(),
  level: z.number().int().nullable(),
  pixelFormat: z.string().nullable(),
  bitDepth: z.number().int().nullable(),
  hdr: z.enum(['none', 'hdr10', 'hlg', 'dolby-vision']).nullable(),
  channels: z.number().int().nullable(),
  sampleRate: z.number().int().nullable(),
  bitrateKbps: z.number().nullable(),
  frameRate: z.number().nullable(),
});

export const ProbeSummarySchema = z.object({
  container: z.string(),
  durationSeconds: z.number(),
  sizeBytes: z.number().int(),
  bitrateKbps: z.number().nullable(),
  streams: z.array(ProbeStreamSchema),
});

export type ProbeStream = z.infer<typeof ProbeStreamSchema>;
export type ProbeSummary = z.infer<typeof ProbeSummarySchema>;

/**
 * Normalises an ffprobe profile name: lowercase, ':' and '.' removed, spaces next to a digit
 * removed, other spaces (between two words) become '-'. 'Main 10' → 'main10',
 * 'Constrained Baseline' → 'constrained-baseline', 'High 4:4:4 Predictive' → 'high444predictive';
 * null stays null.
 */
export function normalizeProfile(raw: string | null): string | null {
  if (raw === null) return null;
  return raw
    .trim()
    .toLowerCase()
    .replace(/[:.]/g, '')
    .replace(/\s*(\d+)\s*/g, '$1')
    .replace(/\s+/g, '-');
}

/** Codecs that hold pictures, not motion video, when a file also has a real video stream. */
export const PICTURE_CODECS: ReadonlySet<string> = new Set([
  'mjpeg',
  'png',
  'bmp',
  'gif',
  'webp',
  'tiff',
  'jpegls',
]);

/**
 * Is this stream a picture (cover art, a poster, a still) rather than video? Flagged ones always
 * are (`attached_pic`, the `still_image` disposition), and so are tracks the probe marked
 * `imageTrack` (image tags, or one frame next to real video). Remuxes also carry posters as plain
 * video tracks (JPEGs with no flag): an image codec next to a real video stream counts as a
 * picture too. A file whose only video is MJPEG (a camera clip) keeps it as video. Pictures are
 * copied as they are, never encoded or decoded: an encoder (or a frame-threaded decoder) holds a
 * lone frame until the input ends, and the muxer then queues every other stream in memory.
 */
export function isPicture(
  s: Pick<ProbeStream, 'type' | 'codec' | 'attachedPic' | 'dispositions' | 'imageTrack'>,
  streams: readonly Pick<ProbeStream, 'type' | 'codec' | 'attachedPic' | 'imageTrack'>[],
): boolean {
  if (s.type !== 'video') return false;
  if (s.attachedPic || s.imageTrack || s.dispositions.includes('still_image')) return true;
  return (
    PICTURE_CODECS.has(s.codec) &&
    streams.some(
      (o) => o.type === 'video' && !o.attachedPic && !o.imageTrack && !PICTURE_CODECS.has(o.codec),
    )
  );
}
