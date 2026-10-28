import { OkOutputSchema, WorkflowSaveOutputSchema } from '@transcoda/contract';
import { IssueSchema, WorkflowGraphInputSchema, WorkflowKindSchema } from '@transcoda/shared';
import { z } from 'zod';
import { type AnyToolDef, defineTool, mcpNote, NoteInput } from '../tool.ts';
import {
  issuesText,
  WorkflowActiveBriefSchema,
  WorkflowBriefShape,
  workflowBrief,
} from './workflows-read.ts';

export const WorkflowWriteBriefShape = {
  id: z.string(),
  name: z.string(),
  kind: WorkflowKindSchema,
  version: z.number().int(),
  valid: z.boolean(),
  issues: z.array(IssueSchema),
  active: WorkflowActiveBriefSchema,
};

interface WriteSource {
  id: string;
  name: string;
  kind: z.infer<typeof WorkflowKindSchema>;
  version: number;
  valid: boolean;
  issues: z.infer<typeof IssueSchema>[];
  active: { version: number; runnable: boolean } | null;
}

function writeBrief(d: WriteSource) {
  return {
    id: d.id,
    name: d.name,
    kind: d.kind,
    version: d.version,
    valid: d.valid,
    issues: d.issues,
    active: d.active ? { version: d.active.version, runnable: d.active.runnable } : null,
  };
}

const withIssues = (head: string, issues: z.infer<typeof IssueSchema>[]): string =>
  `${head}\n${issues.length ? issuesText(issues) : 'No issues.'}`;

export const WEBHOOK_HINT =
  "A webhook URL shown as 'an invalid URL' or 'scheme://host/…' is hidden or empty: to set one, send a full real URL, never the placeholder.";

const createWorkflow = defineTool({
  name: 'create_workflow',
  title: 'Create a workflow',
  description: `Create a workflow or sub-workflow as version 1 (an empty graph unless one is given). It is not active: real runs stay off until a person activates a version in the UI. ${WEBHOOK_HINT}`,
  scopes: ['workflows:write'],
  annotations: { openWorldHint: false },
  input: {
    name: z.string().trim().min(1).max(120).describe('Name shown in the UI'),
    kind: WorkflowKindSchema.describe(
      '"workflow" runs on files; "subworkflow" is called by others',
    ),
    graph: WorkflowGraphInputSchema.optional().describe(
      'Version 1 graph (format 2; format 1 is upgraded); its kind must match `kind`',
    ),
    note: NoteInput.optional(),
  },
  output: WorkflowWriteBriefShape,
  async run({ api }, { name, kind, graph, note }) {
    const created = await api.workflows.create({
      name,
      kind,
      ...(graph !== undefined ? { graph } : {}),
      note: mcpNote(note),
    });
    return {
      text: [
        withIssues(`Created ${kind} "${name}" (${created.id}) v1, not active.`, created.issues),
        'Next: save_workflow with baseVersion 1 to change it; dry_run to try it on a file.',
      ].join('\n'),
      data: writeBrief(created),
    };
  },
});

const saveWorkflow = defineTool({
  name: 'save_workflow',
  title: 'Save a workflow version',
  description: `Save a graph as a new version. It never changes which version runs for real: the active version keeps running and a person activates the new one in the UI. baseVersion must be the current version (VERSION_CONFLICT otherwise). ${WEBHOOK_HINT}`,
  scopes: ['workflows:write'],
  annotations: { openWorldHint: false },
  input: {
    id: z.string().describe('Workflow id'),
    baseVersion: z.number().int().min(1).describe('The current version this graph is based on'),
    graph: WorkflowGraphInputSchema.describe(
      'The full graph (format 2; format 1 is upgraded); its kind must match the workflow',
    ),
    note: NoteInput.optional(),
  },
  output: WorkflowSaveOutputSchema.shape,
  async run({ api }, { id, baseVersion, graph, note }) {
    const saved = await api.workflows.save({ id, baseVersion, graph, note: mcpNote(note) });
    const errors = saved.issues.filter((i) => i.severity === 'error').length;
    const activeLine = saved.active
      ? `v${saved.active.version} stays active; a person activates v${saved.version} in the UI.`
      : 'Not active; real runs stay off until a person activates a version in the UI.';
    return {
      text: [
        `Saved ${id} as v${saved.version} (${saved.valid ? 'valid' : `${errors} error(s)`}). ${activeLine}`,
        ...saved.changes,
        ...(saved.issues.length ? [issuesText(saved.issues)] : []),
      ].join('\n'),
      data: saved,
    };
  },
});

const duplicateWorkflow = defineTool({
  name: 'duplicate_workflow',
  title: 'Duplicate a workflow',
  description: `Copy the current version of a workflow under a new name as its v1. The copy is not active. Webhook URLs are not copied: the result lists the nodes that need a new one. ${WEBHOOK_HINT}`,
  scopes: ['workflows:write'],
  annotations: { openWorldHint: false },
  input: {
    id: z.string().describe('The workflow to copy'),
    name: z.string().trim().min(1).max(120).describe('Name of the copy'),
    note: NoteInput.optional(),
  },
  output: {
    ...WorkflowWriteBriefShape,
    sourceId: z.string(),
    sourceVersion: z.number().int(),
    droppedWebhookUrls: z.array(z.string()),
  },
  async run({ api }, { id, name, note }) {
    const copy = await api.workflows.duplicate({ id, name, note: mcpNote(note) });
    const dropped = copy.droppedWebhookUrls;
    return {
      text: [
        `Created "${name}" (${copy.id}) from ${id} v${copy.sourceVersion}.`,
        ...(dropped.length
          ? [`Webhook URLs were not copied; set a new url in: ${dropped.join(', ')}.`]
          : []),
        copy.issues.length ? issuesText(copy.issues) : 'No issues.',
      ].join('\n'),
      data: {
        ...writeBrief(copy),
        sourceId: id,
        sourceVersion: copy.sourceVersion,
        droppedWebhookUrls: dropped,
      },
    };
  },
});

const renameWorkflow = defineTool({
  name: 'rename_workflow',
  title: 'Rename a workflow',
  description: 'Change a workflow name. No version is created and nothing about what runs changes.',
  scopes: ['workflows:write'],
  annotations: { idempotentHint: true, openWorldHint: false },
  input: { id: z.string().describe('Workflow id'), name: z.string().trim().min(1).max(120) },
  output: WorkflowBriefShape,
  async run({ api }, { id, name }) {
    const renamed = await api.workflows.rename({ id, name });
    return { text: `Renamed ${id} to "${name}".`, data: workflowBrief(renamed) };
  },
});

const deleteWorkflow = defineTool({
  name: 'delete_workflow',
  title: 'Delete a workflow',
  description:
    'Delete a workflow. A sub-workflow used by other workflows is refused with IN_USE and the users are listed.',
  scopes: ['workflows:write'],
  annotations: { destructiveHint: true, openWorldHint: false },
  input: { id: z.string().describe('Workflow id') },
  output: { ok: z.literal(true), id: z.string() },
  async run({ api }, { id }) {
    OkOutputSchema.parse(await api.workflows.delete({ id }));
    return { text: `Deleted ${id}.`, data: { ok: true as const, id } };
  },
});

export const workflowWriteTools: AnyToolDef[] = [
  createWorkflow,
  saveWorkflow,
  duplicateWorkflow,
  renameWorkflow,
  deleteWorkflow,
];
