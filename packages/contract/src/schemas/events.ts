import { JobStateSchema, LaneSchema, PluginStateSchema, TraceEntrySchema } from '@transcoda/shared';
import { z } from 'zod';
import { JobProgressSchema } from './jobs.ts';
import { QueueStatusSchema } from './queue.ts';

/** The graph node a job is at: Run-node ids from the top level down, and the node id. */
export const CurrentNodeSchema = z.object({
  workflowPath: z.array(z.string()),
  nodeId: z.string(),
});

/**
 * One server-sent event of `events.subscribe`. The first is always a `queue.changed` snapshot;
 * `ping` arrives every 30 s; `resync` means events were dropped for a slow reader (refetch).
 */
export const EngineEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('job.changed'),
    jobId: z.string(),
    runId: z.string(),
    libraryId: z.string(),
    workflowId: z.string(),
    state: JobStateSchema,
    paused: z.boolean(),
    progress: JobProgressSchema.nullable(),
    lane: LaneSchema.nullable(),
    currentNode: CurrentNodeSchema.nullable(),
    problems: z.array(z.string()),
    /** The job's reason; while running, what it waits for ("waiting for 5.4 GB free on …"). */
    reason: z.string().nullable(),
  }),
  z.object({ type: z.literal('job.trace'), jobId: z.string(), entry: TraceEntrySchema }),
  z.object({ type: z.literal('run.changed'), runId: z.string() }),
  z.object({
    type: z.literal('queue.changed'),
    paused: z.boolean(),
    lanes: QueueStatusSchema.shape.lanes,
    encodeSlots: QueueStatusSchema.shape.encodeSlots,
  }),
  /** The background update check found a newer release (or the running one caught up: null). */
  z.object({ type: z.literal('app.update'), version: z.string().nullable() }),
  z.object({
    type: z.literal('plugins.changed'),
    name: z.string(),
    state: PluginStateSchema,
    stateReason: z.string().nullable(),
  }),
  z.object({ type: z.literal('ping'), at: z.iso.datetime() }),
  z.object({ type: z.literal('resync'), at: z.iso.datetime() }),
]);
export type EngineEvent = z.infer<typeof EngineEventSchema>;
