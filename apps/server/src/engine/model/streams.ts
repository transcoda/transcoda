// Stream helpers the model's files share: kept streams, extra (sidecar) inputs, what a container
// holds, covers. Internal to model/: code outside imports them through model.ts.
import type { BuildModel, ExtraInput, StreamPlan } from '@transcoda/sdk';

/** The stream comes from an extra input file (a sidecar), not from the source. */
export function isExtraStream(s: StreamPlan): boolean {
  return (s.input ?? 0) > 0;
}

/** The extra input file an extra stream reads from; null for a source stream or a missing entry. */
export function extraInputOf(model: BuildModel, s: StreamPlan): ExtraInput | null {
  return isExtraStream(s) ? (model.extraInputs?.[(s.input as number) - 1] ?? null) : null;
}

/**
 * Whether the container's muxer accepts the stream as planned (checked against ffmpeg 9.0.2):
 * matroska takes no data streams (tmcd) and no mov_text; mp4 takes no attachments (fonts) and no
 * subtitles other than mov_text (PGS, VobSub, subrip, ass).
 */
export function containerCanHold(
  container: BuildModel['container'],
  s: { type: StreamPlan['type']; codec: string },
): boolean {
  if (container === 'mkv') {
    return s.type !== 'data' && !(s.type === 'subtitle' && s.codec === 'mov_text');
  }
  return s.type !== 'attachment' && (s.type !== 'subtitle' || s.codec === 'mov_text');
}

const COVER_FILES: Record<string, { ext: string; mimetype: string }> = {
  png: { ext: 'png', mimetype: 'image/png' },
  mjpeg: { ext: 'jpg', mimetype: 'image/jpeg' },
  bmp: { ext: 'bmp', mimetype: 'image/bmp' },
  gif: { ext: 'gif', mimetype: 'image/gif' },
  webp: { ext: 'webp', mimetype: 'image/webp' },
};

/** The attachment file extension and mimetype for a cover's image codec. */
export function coverFile(codec: string): { ext: string; mimetype: string } {
  return Object.hasOwn(COVER_FILES, codec)
    ? (COVER_FILES[codec] as { ext: string; mimetype: string })
    : { ext: codec, mimetype: `image/${codec}` };
}

/**
 * True for a kept cover that an mkv output carries as an attachment (`cover.<ext>`): ffmpeg
 * writes an attached_pic stream into matroska as a plain one-frame video track otherwise.
 */
export function isMkvCover(model: BuildModel, s: StreamPlan): boolean {
  return model.container === 'mkv' && s.type === 'video' && s.attachedPic;
}

/** Kept streams in output order (ties by source index); the order renderArgs maps them in. */
export function kept(model: BuildModel): StreamPlan[] {
  return model.streams
    .filter((s) => s.keep)
    .sort((a, b) => a.order - b.order || a.sourceIndex - b.sourceIndex);
}
