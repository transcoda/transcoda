import { z } from 'zod';
import { IdSchema } from './graph.ts';

export const ISSUE_CODES = [
  'UNKNOWN_NODE_TYPE',
  'UNKNOWN_NODE_VERSION',
  'NODE_OUTDATED',
  'INVALID_SETTINGS',
  'UNKNOWN_PORT',
  'PORT_TYPE_MISMATCH',
  'DANGLING_EDGE',
  'INPUT_UNCONNECTED',
  'INPUT_MULTIPLE_EDGES',
  'OUTPUT_MULTIPLE_EDGES',
  'OUTPUT_MULTIPLE_WRITES',
  'SIZE_GATE_SHARED_OUTPUT',
  'GRAPH_CYCLE',
  'TRIGGER_COUNT',
  'NO_FINISH_PATH',
  'NODE_NOT_ALLOWED_HERE',
  'SUBWORKFLOW_IO_COUNT',
  'SUBWORKFLOW_MISSING',
  'SUBWORKFLOW_REFERENCE_CYCLE',
  'SUBWORKFLOW_BROKEN',
  'INVALID_OVERRIDE',
  'NODE_UNAVAILABLE',
  'CORRUPT_GRAPH',
  'FINISH_ORDER',
  'ELSE_ONLY_NOTIFY',
  'TARGET_UNSUPPORTED',
  'ENCODER_UNAVAILABLE',
  'PLUGIN_UNAVAILABLE',
  // warnings
  'SUBWORKFLOW_OUTDATED',
  'OVERRIDE_DROPPED',
  'NODE_UNREACHABLE',
  'GROUP_MISSING',
  'NO_WRITE_PATH',
  'LIBRARY_MISSING',
  'VALUE_MISSING',
] as const;

export const IssueSeveritySchema = z.enum(['error', 'warning']);

export const IssueSchema = z.object({
  severity: IssueSeveritySchema,
  code: z.enum(ISSUE_CODES),
  message: z.string(),
  nodeId: IdSchema.optional(),
  edgeId: IdSchema.optional(),
  settingPath: z.string().optional(),
});

export type Issue = z.infer<typeof IssueSchema>;
export type IssueCode = (typeof ISSUE_CODES)[number];

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
