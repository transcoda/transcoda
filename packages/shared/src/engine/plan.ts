import { z } from 'zod';
import { STREAM_TYPES } from './probe.ts';

/** The build model rendered per stream for the dry-run and job screens. */
export const JobPlanSchema = z.object({
  container: z.object({ from: z.string(), to: z.string() }),
  streams: z.array(
    z.object({
      index: z.number().int(),
      type: z.enum(STREAM_TYPES),
      codec: z.string(),
      language: z.string().nullable(),
      title: z.string().nullable(),
      isOriginalLanguage: z.boolean(),
      default: z.object({ before: z.boolean(), after: z.boolean() }),
      forced: z.boolean(),
      action: z.enum(['keep', 'drop', 'convert']),
      /** e.g. 'hevc → hevc (libx265 crf 24)', 'added for chrome', '' */
      note: z.string(),
    }),
  ),
  /**
   * Subtitle files read next to the source (sidecars) and what happens to each. Absent when the
   * model has no extra input files (and in plans stored before they existed).
   */
  sidecars: z
    .array(
      z.object({
        file: z.string(),
        language: z.string().nullable(),
        forced: z.boolean(),
        sdh: z.boolean(),
        codec: z.string(),
        action: z.enum(['embed', 'drop']),
        /** e.g. "container can't hold it", '' */
        note: z.string(),
      }),
    )
    .optional(),
  /** false when the model is the identity */
  rewrite: z.boolean(),
  /**
   * The output file's tracks in the order it has them (an mkv's cover images, written as
   * attachments, are left out): what a player of the output sees. A video track carries its bit
   * depth and an audio track its channel count when known. Absent in plans stored before it
   * existed (and the details in plans stored before they did).
   */
  output: z
    .array(
      z.object({
        type: z.enum(STREAM_TYPES),
        codec: z.string(),
        /**
         * The probe index of the source stream it is made from; null for a track from a subtitle
         * file. Absent in plans stored before it existed.
         */
        sourceIndex: z.number().int().nullable().optional(),
        bitDepth: z.number().int().optional(),
        channels: z.number().int().optional(),
      }),
    )
    .optional(),
  /**
   * Plan-only dry runs: the path writes (replace, move or copy) and a size gate sits between the
   * encode and that write, so whether it would replace is decided after encoding. Carries the
   * gate's minimum saving (the strictest, with several). Absent when no gate decides (no gate, a
   * gate on a branch not taken, a bypassed gate), on a path that writes nothing, and on test-encode
   * dry runs (they measure).
   */
  dependsOnSize: z.object({ minSavingPercent: z.number() }).optional(),
});
export type JobPlan = z.infer<typeof JobPlanSchema>;

const SUMMARY_NOUN = {
  video: 'video track',
  audio: 'audio track',
  subtitle: 'subtitle track',
  attachment: 'attachment',
  data: 'data track',
} as const;

/**
 * One lower-case line of what a dry run would do, for lists that have no room for the plan table:
 * "convert 1 video track; drop 2 subtitle tracks; remux MP4 → MKV". An identity plan says
 * "nothing to change"; a rewrite with no track or container change (flags, metadata) says
 * "rewrite the file".
 */
export function planSummary(plan: JobPlan): string {
  if (!plan.rewrite) return 'nothing to change';
  const parts: string[] = [];
  for (const type of STREAM_TYPES) {
    const noun = SUMMARY_NOUN[type];
    for (const action of ['convert', 'drop'] as const) {
      const n = plan.streams.filter((s) => s.type === type && s.action === action).length;
      if (n > 0) parts.push(`${action} ${n} ${noun}${n === 1 ? '' : 's'}`);
    }
  }
  const embedded = (plan.sidecars ?? []).filter((s) => s.action === 'embed').length;
  if (embedded > 0) parts.push(`embed ${embedded} subtitle file${embedded === 1 ? '' : 's'}`);
  const { from, to } = plan.container;
  if (from.toLowerCase() !== to.toLowerCase()) {
    parts.push(`remux ${from.toUpperCase()} → ${to.toUpperCase()}`);
  }
  return parts.length > 0 ? parts.join('; ') : 'rewrite the file';
}
