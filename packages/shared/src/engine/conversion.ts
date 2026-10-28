import type { STREAM_TYPES } from './probe.ts';

/**
 * What a plan note says an encode does. The engine writes a converted stream's note as
 * `convert <from>→<to> (<encoder>[ <crf|qp|cq|q> <n>][ <preset>][ <profile>][ [max ]<n>k][ <n>ch][ <pix_fmt>])`
 * (apps/server/src/engine/build-model.ts `conversion()`); this reads it back for the job page.
 */
export type Conversion = {
  encoder: string;
  /** "QP 24", "CRF 22", "CQ 24" (NVENC quality under a bitrate ceiling). */
  quality: string | null;
  /** An audio encode's bitrate (kb/s); never read for other types. */
  kbps: number | null;
  channels: number | null;
  /** From the pixel format the encode writes (`yuv420p10le` → 10, `yuv420p` → 8). */
  bitDepth: number | null;
};

/** The conversion in a plan note, or null when the note converts nothing. */
export function parseConversion(
  note: string,
  type: (typeof STREAM_TYPES)[number],
): Conversion | null {
  const m = /convert [^\s→]+→\S+ \(([^)]*)\)/.exec(note);
  if (!m?.[1]) return null;
  const tokens = m[1].split(' ').filter((t) => t !== '');
  const [encoder, ...rest] = tokens;
  if (!encoder) return null;
  let quality: string | null = null;
  if (['crf', 'qp', 'cq', 'q'].includes(rest[0] ?? '') && rest[0] && rest[1] !== undefined) {
    quality = `${rest[0].toUpperCase()} ${rest[1]}`;
    rest.splice(0, 2);
  }
  const whole = (re: RegExp): RegExpExecArray | null => {
    for (const t of rest) {
      const hit = re.exec(t);
      if (hit) return hit;
    }
    return null;
  };
  const kbps = type === 'audio' ? whole(/^(\d+)k$/) : null;
  const channels = whole(/^(\d+)ch$/);
  const depth = whole(/p0?(\d+)(?:le|be)$/);
  return {
    encoder,
    quality,
    kbps: kbps ? Number(kbps[1]) : null,
    channels: channels ? Number(channels[1]) : null,
    bitDepth: depth ? Number(depth[1]) : whole(/^(yuvj?\d{3}p|nv12)$/) ? 8 : null,
  };
}
