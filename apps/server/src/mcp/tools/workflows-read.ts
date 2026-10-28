import {
  LibraryRefSchema,
  NodeInfoSchema,
  NodeKindSchema,
  WorkflowDetailSchema,
  WorkflowRefSchema,
  type WorkflowSummary,
  WorkflowValidateOutputSchema,
  WorkflowVersionsOutputSchema,
} from '@transcoda/contract';
import { type Issue, WorkflowGraphInputSchema, WorkflowKindSchema } from '@transcoda/shared';
import { z } from 'zod';
import { type AnyToolDef, defineTool, ToolFailure } from '../tool.ts';

/** No dates here; the activating user's id is only in get_workflow's full detail. */
export const WorkflowActiveBriefSchema = z
  .object({ version: z.number().int(), runnable: z.boolean() })
  .nullable();

export const WorkflowBriefShape = {
  id: z.string(),
  name: z.string(),
  kind: WorkflowKindSchema,
  active: WorkflowActiveBriefSchema,
  currentVersion: z.number().int(),
  valid: z.boolean(),
  errorCount: z.number().int(),
  usedBy: z.array(WorkflowRefSchema),
  feedsLibrary: LibraryRefSchema.nullable().describe(
    'The library whose files the active version takes (its Library input); null: none',
  ),
  updatedAt: z.iso.datetime(),
};
export type WorkflowBrief = z.infer<z.ZodObject<typeof WorkflowBriefShape>>;

export function workflowBrief(s: WorkflowSummary): WorkflowBrief {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    active: s.active ? { version: s.active.version, runnable: s.active.runnable } : null,
    currentVersion: s.currentVersion,
    valid: s.valid,
    errorCount: s.errorCount,
    usedBy: s.usedBy,
    feedsLibrary: s.feedsLibrary,
    updatedAt: s.updatedAt,
  };
}

function activeWord(w: WorkflowBrief): string {
  if (w.kind === 'subworkflow') return 'never active';
  if (!w.active) return 'not active';
  const word = w.active.runnable
    ? `active v${w.active.version}`
    : `active v${w.active.version} (can't run)`;
  return w.currentVersion > w.active.version ? `${word}, v${w.currentVersion} newest` : word;
}

export function workflowLine(w: WorkflowBrief): string {
  return (
    `${w.name} (${w.id}) — ${w.kind}, v${w.currentVersion}, ` +
    `${activeWord(w)}, ` +
    `${w.valid ? 'valid' : `${w.errorCount} error(s)`}` +
    `${w.usedBy.length ? `, used by ${w.usedBy.length}` : ''}` +
    `${w.feedsLibrary ? `, feeds ${w.feedsLibrary.name}` : ''}`
  );
}

export const NodeBriefShape = {
  type: z.string(),
  version: z.number().int(),
  kind: NodeKindSchema,
  title: z.string(),
  description: z.string(),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  available: z.boolean(),
  unavailableReason: z.string().optional(),
};

/** '' when there are none; else one line per issue. */
export function issuesText(issues: Issue[]): string {
  return issues
    .map(
      (i) =>
        `- ${i.severity} ${i.code}${i.nodeId ? ` on ${i.nodeId}` : ''}` +
        `${i.settingPath ? ` (${i.settingPath})` : ''}: ${i.message}`,
    )
    .join('\n');
}

const listWorkflows = defineTool({
  name: 'list_workflows',
  title: 'List workflows',
  description:
    'Every workflow and sub-workflow with its kind, active version, current version, validity and where it is used.',
  scopes: ['read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: {},
  output: { workflows: z.array(z.object(WorkflowBriefShape)) },
  async run({ api }) {
    const { workflows } = await api.workflows.list();
    const briefs = workflows.map(workflowBrief);
    return {
      text: [`${briefs.length} workflow(s)`, ...briefs.map(workflowLine)].join('\n'),
      data: { workflows: briefs },
    };
  },
});

const getWorkflow = defineTool({
  name: 'get_workflow',
  title: 'Get a workflow',
  description:
    'A workflow or sub-workflow with its graph (webhook URLs are shown as scheme://host/…) and its issues. Without version: the current one.',
  scopes: ['read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: {
    id: z.string().describe('Workflow id'),
    version: z.number().int().min(1).optional().describe('A past version; default the current'),
  },
  output: WorkflowDetailSchema.shape,
  async run({ api }, { id, version }) {
    const detail = await api.workflows.get({ id, ...(version !== undefined ? { version } : {}) });
    const lines = [
      workflowLine(workflowBrief(detail)),
      `Version ${detail.version} of ${detail.currentVersion}`,
      ...(detail.active && detail.active.version !== detail.version
        ? [
            `Active: v${detail.active.version} — this version is v${detail.version}, not active; a person activates it in the UI.`,
          ]
        : []),
      ...(detail.activeIssues.length
        ? [`Active version can't run:`, issuesText(detail.activeIssues)]
        : []),
      `${detail.graph.nodes.length} node(s):`,
      ...detail.graph.nodes.map(
        (n) => `- ${n.id}: ${n.type} v${n.typeVersion}${n.label ? ` "${n.label}"` : ''}`,
      ),
      detail.issues.length ? issuesText(detail.issues) : 'No issues.',
    ];
    if (detail.settings) {
      lines.push(`Settings (override keys): ${detail.settings.map((s) => s.key).join(', ')}`);
    }
    return { text: lines.join('\n'), data: detail };
  },
});

const listWorkflowVersions = defineTool({
  name: 'list_workflow_versions',
  title: 'List workflow versions',
  description: 'The saved versions of a workflow, newest first, with who saved them and the note.',
  scopes: ['read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: { id: z.string().describe('Workflow id') },
  output: WorkflowVersionsOutputSchema.shape,
  async run({ api }, { id }) {
    const data = await api.workflows.versions({ id });
    return {
      text: data.versions
        .map((v) => `v${v.version} ${v.createdAt} by ${v.createdBy}${v.note ? ` — ${v.note}` : ''}`)
        .join('\n'),
      data,
    };
  },
});

const NodesOutputShape = {
  nodes: z.array(z.union([NodeInfoSchema, z.object(NodeBriefShape)])),
};

const listNodes = defineTool({
  name: 'list_nodes',
  title: 'List node types',
  description:
    'The node types a workflow can use, with port ids and availability. Pass type for one node with its settings JSON Schema.',
  scopes: ['read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: { type: z.string().optional().describe('A node type id such as core:video-is') },
  output: NodesOutputShape,
  async run({ api }, { type }) {
    const { nodes } = await api.nodes.list();
    if (type !== undefined) {
      const found = nodes.find((n) => n.type === type);
      if (!found) throw new ToolFailure('NOT_FOUND', `Unknown node type ${type}`);
      return {
        text: `${found.type} (${found.kind}): ${found.title} — ${found.description}`,
        data: { nodes: [found] },
      };
    }
    const briefs = nodes.map((n) => ({
      type: n.type,
      version: n.version,
      kind: n.kind,
      title: n.title,
      description: n.description,
      inputs: n.inputs.map((p) => p.id),
      outputs: n.outputs.map((p) => p.id),
      available: n.availability.available,
      ...(n.availability.available ? {} : { unavailableReason: n.availability.reason }),
    }));
    return {
      text: briefs
        .map(
          (b) =>
            `${b.type} (${b.kind}): ${b.title} — in ${b.inputs.join(',') || '-'} → out ` +
            `${b.outputs.join(',') || '-'}${b.available ? '' : ` [unavailable: ${b.unavailableReason}]`}`,
        )
        .join('\n'),
      data: { nodes: briefs },
    };
  },
});

const validateWorkflow = defineTool({
  name: 'validate_workflow',
  title: 'Validate a workflow graph',
  description:
    'Check a graph for issues without saving anything. Pass workflowId when the graph belongs to an existing workflow so sub-workflow references resolve.',
  scopes: ['read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: {
    graph: WorkflowGraphInputSchema.describe(
      'The workflow graph to check (format 1 is checked as format 2)',
    ),
    workflowId: z.string().optional().describe('The workflow this graph is meant for'),
  },
  output: WorkflowValidateOutputSchema.shape,
  async run({ api }, { graph, workflowId }) {
    const data = await api.workflows.validate({
      graph,
      ...(workflowId !== undefined ? { id: workflowId } : {}),
    });
    const errors = data.issues.filter((i) => i.severity === 'error').length;
    const warnings = data.issues.length - errors;
    return {
      text:
        data.valid && data.issues.length === 0
          ? 'Valid.'
          : `${errors} error(s), ${warnings} warning(s):\n${issuesText(data.issues)}`,
      data,
    };
  },
});

export const workflowReadTools: AnyToolDef[] = [
  listWorkflows,
  getWorkflow,
  listWorkflowVersions,
  listNodes,
  validateWorkflow,
];
