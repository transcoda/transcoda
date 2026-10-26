import { z } from 'zod';
import { IdSchema, JsonValueSchema } from '../workflow/graph.ts';
import { STREAM_TYPES } from './probe.ts';

/** `pass`: a node on the path without a hook (trigger, Run sub-workflow, sub-workflow Start/End). */
export const TRACE_PHASES = ['pass', 'data', 'decide', 'build', 'finish'] as const;

/** A stream a node changed, as the trace's `changes` names it. */
const ChangedStreamSchema = z.object({
  /** The probe index; negative for a stream from an extra input file (`StreamPlan.sourceIndex`). */
  index: z.number().int(),
  type: z.enum(STREAM_TYPES),
  /** The codec after the node (before it, for a dropped stream). */
  codec: z.string(),
  language: z.string().nullable(),
  forced: z.boolean(),
  /** A stream from an extra input: that file's base name. */
  file: z.string().optional(),
});

/** A stream the node converts (or adds as a conversion): what it is encoded to. */
const ConvertedStreamSchema = ChangedStreamSchema.extend({
  /** The codec before the node (an added copy: its source's). */
  from: z.string(),
  encoder: z.string().nullable(),
  quality: z.number().nullable(),
  preset: z.string().nullable(),
  bitrateKbps: z.number().nullable(),
  channels: z.number().int().nullable(),
  pixelFormat: z.string().nullable(),
});

/**
 * What an action node's build hook changed in the build model (the output file), so screens can
 * say it in words without reading the reason. Every list is empty and both flags false when the
 * node changed nothing.
 */
export const TraceChangesSchema = z.object({
  /** The container, when the node changed it. */
  container: z.object({ from: z.string(), to: z.string() }).optional(),
  /** Kept before the node, not after it. */
  dropped: z.array(ChangedStreamSchema),
  /** Kept after the node, not before it: a new stream (an added copy, an embedded file) or one kept again. */
  added: z.array(ConvertedStreamSchema),
  /** Kept on both sides, encoded differently after the node (or copied again). */
  converted: z.array(ConvertedStreamSchema),
  /** Kept after the node with its default flag changed. */
  defaults: z.array(ChangedStreamSchema.extend({ before: z.boolean(), after: z.boolean() })),
  /** The kept streams are in another order. */
  reordered: z.boolean(),
  /** Anything else the output differs in: titles, forced and other flags, ffmpeg options. */
  other: z.boolean(),
});
export type TraceChanges = z.infer<typeof TraceChangesSchema>;

/** Whether `changes` says the node changed the output at all. */
export function changesFile(changes: TraceChanges): boolean {
  return (
    changes.container !== undefined ||
    changes.dropped.length > 0 ||
    changes.added.length > 0 ||
    changes.converted.length > 0 ||
    changes.defaults.length > 0 ||
    changes.reordered ||
    changes.other
  );
}

/**
 * One node evaluation in a job's trace. Findings for a data node are
 * `{ [outputPortId]: value }` (e.g. `{ language: 'jpn' }`), so the UI can label data edges.
 * Every node on the file's path has an entry whose `port` is the file output the file took.
 */
export const TraceEntrySchema = z.object({
  /** Monotonic within a job: the order the entries were made in. */
  seq: z.number().int().min(1),
  attempt: z.number().int().min(1),
  nodeId: IdSchema,
  /** Run-node ids from the top-level graph down to the graph that holds nodeId; [] at top level. */
  workflowPath: z.array(IdSchema),
  phase: z.enum(TRACE_PHASES),
  port: z.string().nullable(),
  reason: z.string(),
  findings: z.record(z.string(), JsonValueSchema),
  /** Absent = core. */
  source: z.enum(['core', 'plugin']).optional(),
  /**
   * An action node whose build hook ran: what it changed in the build model. Absent on every other
   * entry (and in traces written before it existed).
   */
  changes: TraceChangesSchema.optional(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
});
export type TraceEntry = z.infer<typeof TraceEntrySchema>;
