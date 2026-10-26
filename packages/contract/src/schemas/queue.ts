import { z } from 'zod';

export const EncodeSlotStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  jobId: z.string().nullable(),
});
export type EncodeSlotStatus = z.infer<typeof EncodeSlotStatusSchema>;

export const QueueStatusSchema = z.object({
  /** Persisted: running jobs are frozen and nothing new starts. */
  paused: z.boolean(),
  /** The job holding each lane; `encode` is the first busy encode slot. */
  lanes: z.object({ encode: z.string().nullable(), quick: z.string().nullable() }),
  /**
   * The encode lane's slots: one per GPU on a machine with several (auto), else one. A slot the
   * setting no longer offers is listed while a job still runs in it.
   */
  encodeSlots: z.array(EncodeSlotStatusSchema),
  /** Jobs being probed, decided and built. */
  preparing: z.array(z.string()),
});
export type QueueStatus = z.infer<typeof QueueStatusSchema>;
