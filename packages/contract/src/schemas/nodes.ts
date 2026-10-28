import { NODE_KINDS, PORT_TYPE_PATTERN, type PortSpec, type PortType } from '@transcoda/sdk';
import { FinishPhaseSchema, JsonValueSchema } from '@transcoda/shared';
import { z } from 'zod';

export const NodeKindSchema = z.enum(NODE_KINDS);
export const PortTypeSchema = z
  .string()
  .regex(PORT_TYPE_PATTERN)
  .refine((v): v is PortType => PORT_TYPE_PATTERN.test(v));
export const PortSpecSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: PortTypeSchema,
  required: z.boolean().exactOptional(),
  shownWhen: z.object({ setting: z.string(), equals: JsonValueSchema }).exactOptional(),
}) satisfies z.ZodType<PortSpec>;
export const NodeSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('core') }),
  z.object({ kind: z.literal('plugin'), name: z.string(), version: z.string() }),
]);
export const NodeAvailabilitySchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true) }),
  z.object({ available: z.literal(false), reason: z.string() }),
]);
export const NodeInfoSchema = z.object({
  type: z.string(),
  version: z.number().int(),
  kind: NodeKindSchema,
  title: z.string(),
  description: z.string(),
  icon: z.string(),
  inputs: z.array(PortSpecSchema),
  outputs: z.array(PortSpecSchema),
  settingsSchema: JsonValueSchema,
  onNodeSettings: z.array(z.string()),
  source: NodeSourceSchema,
  availability: NodeAvailabilitySchema,
  /**
   * A finish node's phase (render → gate → write → library manager → media server → notify); null
   * for the other kinds. The server always sends it; optional so hand-made definitions in tests
   * still parse.
   */
  finishPhase: FinishPhaseSchema.nullable().optional(),
  /** A finish node that may run only on a Damaged side. The server always sends it. */
  damagedOnly: z.boolean().optional(),
});
export const NodesListOutputSchema = z.object({ nodes: z.array(NodeInfoSchema) });

export type NodeInfo = z.infer<typeof NodeInfoSchema>;
export type NodeSource = z.infer<typeof NodeSourceSchema>;
export type NodeAvailability = z.infer<typeof NodeAvailabilitySchema>;
export type NodesListOutput = z.infer<typeof NodesListOutputSchema>;
