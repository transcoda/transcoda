import { z } from 'zod';
import type { JsonValue } from '../json.ts';

/** Format 2 renders in a visible Render node (`upgradeGraphJson` brings format 1 up). */
export const FORMAT_VERSION = 2;
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const IdSchema = z.string().regex(ID_PATTERN);
export const NodeTypeSchema = z.string().regex(/^[a-z0-9-]+:[a-z0-9-]+$/);

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const PositionSchema = z.object({ x: z.number(), y: z.number() });

export const NodeInstanceSchema = z.object({
  id: IdSchema,
  type: NodeTypeSchema,
  typeVersion: z.number().int().min(1),
  settings: JsonValueSchema,
  position: PositionSchema,
  label: z.string().max(120).optional(),
  groupId: IdSchema.optional(),
  bypassed: z.boolean().optional(),
  /** Setting key → the name of the shared value it follows (`values`); the settings keep a copy. */
  links: z.record(z.string(), z.string().min(1).max(60)).optional(),
});

export const PortRefSchema = z.object({ node: IdSchema, port: z.string().min(1) });

export const EdgeSchema = z.object({ id: IdSchema, from: PortRefSchema, to: PortRefSchema });

export const MAX_NOTE_LENGTH = 4000;
export const MAX_SHARED_VALUES = 50;

export const GroupSchema = z.object({
  id: IdSchema,
  name: z.string(),
  collapsed: z.boolean(),
  position: PositionSchema,
  size: z.object({ width: z.number(), height: z.number() }),
  /** Markdown shown inside the frame: an explanation for whoever opens the workflow. */
  note: z.string().max(MAX_NOTE_LENGTH).optional(),
});

/**
 * A named value several node settings can follow (`NodeInstance.links`). `schema` is the JSON
 * schema of the setting it was made from, so the editor knows how to edit it and which other
 * settings may link to it.
 */
export const SharedValueSchema = z.object({
  name: z.string().trim().min(1).max(60),
  schema: JsonValueSchema,
  value: JsonValueSchema,
});

/** The canvas card that holds the shared values. */
export const SharedValuesSchema = z.object({
  position: PositionSchema,
  entries: z.array(SharedValueSchema).max(MAX_SHARED_VALUES),
});

export const WorkflowKindSchema = z.enum(['workflow', 'subworkflow']);

export const MAX_GRAPH_NODES = 500;
export const MAX_GRAPH_EDGES = 2000;
export const MAX_GRAPH_GROUPS = 100;

function graphSchema<V extends z.ZodType<number>>(formatVersion: V) {
  return z
    .object({
      formatVersion,
      kind: WorkflowKindSchema,
      nodes: z
        .array(NodeInstanceSchema)
        .max(MAX_GRAPH_NODES, `A workflow can have at most ${MAX_GRAPH_NODES} nodes`),
      edges: z
        .array(EdgeSchema)
        .max(MAX_GRAPH_EDGES, `A workflow can have at most ${MAX_GRAPH_EDGES} edges`),
      groups: z
        .array(GroupSchema)
        .max(MAX_GRAPH_GROUPS, `A workflow can have at most ${MAX_GRAPH_GROUPS} groups`),
      values: SharedValuesSchema.optional(),
    })
    .superRefine((graph, ctx) => {
      const check = (label: string, key: 'nodes' | 'edges' | 'groups', items: { id: string }[]) => {
        const seen = new Set<string>();
        items.forEach((item, index) => {
          if (seen.has(item.id)) {
            ctx.addIssue({
              code: 'custom',
              message: `duplicate ${label} id "${item.id}"`,
              path: [key, index],
            });
          }
          seen.add(item.id);
        });
      };
      check('node', 'nodes', graph.nodes);
      check('edge', 'edges', graph.edges);
      check('group', 'groups', graph.groups);
      const names = new Set<string>();
      graph.values?.entries.forEach((v, index) => {
        if (names.has(v.name)) {
          ctx.addIssue({
            code: 'custom',
            message: `duplicate value name "${v.name}"`,
            path: ['values', 'entries', index],
          });
        }
        names.add(v.name);
      });
    });
}

export const WorkflowGraphSchema = graphSchema(z.literal(FORMAT_VERSION));

/**
 * A graph as the API and MCP accept it: format 1 too (an older client, an exported file), which
 * the server brings to format 2 (`upgradeGraphJson`) before anything else reads it.
 */
export const WorkflowGraphInputSchema = graphSchema(
  z.union([z.literal(1), z.literal(FORMAT_VERSION)]),
);

export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;
export type WorkflowGraphInput = z.infer<typeof WorkflowGraphInputSchema>;
export type NodeInstance = z.infer<typeof NodeInstanceSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
export type Group = z.infer<typeof GroupSchema>;
export type SharedValue = z.infer<typeof SharedValueSchema>;
export type SharedValues = z.infer<typeof SharedValuesSchema>;
export type PortRef = z.infer<typeof PortRefSchema>;
export type WorkflowKind = z.infer<typeof WorkflowKindSchema>;

export const SUBWORKFLOW_START_TYPE = 'core:subworkflow-start';
export const SUBWORKFLOW_END_TYPE = 'core:subworkflow-end';
export const RUN_SUBWORKFLOW_TYPE = 'core:run-subworkflow';

export const RunSubworkflowSettingsSchema = z.object({
  subworkflowId: z.string().min(1).describe('Sub-workflow'),
  version: z.number().int().min(1).describe('Pinned version'),
  overrides: z.record(z.string(), JsonValueSchema).default({}).describe('Setting overrides'),
});
export type RunSubworkflowSettings = z.infer<typeof RunSubworkflowSettingsSchema>;

export const ALREADY_PROCESSED_TYPE = 'core:already-processed';

/**
 * Already processed: which workflow and version to look for. No `workflowId` means "This
 * workflow": the workflow the job runs (in a sub-workflow too, since results are recorded for
 * the top-level workflow); no `version` means any version.
 */
export const AlreadyProcessedSettingsSchema = z.object({
  workflowId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Workflow; the id of the workflow to look for. Leave it out for this workflow (the one the job runs, also inside a sub-workflow)',
    ),
  version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Version; only this version of that workflow counts. Leave it out for any version'),
});
export type AlreadyProcessedSettings = z.infer<typeof AlreadyProcessedSettingsSchema>;

export function emptyGraph(kind: WorkflowKind): WorkflowGraph {
  if (kind === 'workflow') {
    return { formatVersion: FORMAT_VERSION, kind, nodes: [], edges: [], groups: [] };
  }
  return {
    formatVersion: FORMAT_VERSION,
    kind,
    nodes: [
      {
        id: 'start',
        type: SUBWORKFLOW_START_TYPE,
        typeVersion: 1,
        settings: {},
        position: { x: 0, y: 0 },
      },
      {
        id: 'end',
        type: SUBWORKFLOW_END_TYPE,
        typeVersion: 1,
        settings: {},
        position: { x: 400, y: 0 },
      },
    ],
    edges: [
      { id: 'start-end', from: { node: 'start', port: 'file' }, to: { node: 'end', port: 'file' } },
    ],
    groups: [],
  };
}
