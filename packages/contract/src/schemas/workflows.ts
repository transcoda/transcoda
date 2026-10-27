import {
  IssueSchema,
  JsonValueSchema,
  WorkflowGraphInputSchema,
  WorkflowGraphSchema,
  WorkflowKindSchema,
} from '@transcoda/shared';
import { z } from 'zod';
import { LibraryRefSchema } from './libraries.ts';

export const WorkflowRefSchema = z.object({ id: z.string(), name: z.string() });
export const WorkflowActiveSchema = z
  .object({
    version: z.number().int(),
    /** false: real runs are refused; shown as "Needs review". */
    runnable: z.boolean(),
    activatedAt: z.iso.datetime(),
    /** User id, or 'system:migration'. */
    activatedBy: z.string(),
  })
  .nullable(); // null: not active, dry runs only; always null for a sub-workflow
export const WorkflowSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: WorkflowKindSchema,
  active: WorkflowActiveSchema,
  currentVersion: z.number().int(),
  valid: z.boolean(),
  errorCount: z.number().int(),
  usesOutdatedSubworkflow: z.boolean(),
  usedBy: z.array(WorkflowRefSchema),
  /**
   * The live library this workflow takes files from: the active version's Library input. null when
   * not active, the active version has no Library input, or that library is deleted; always null
   * for a sub-workflow.
   */
  feedsLibrary: LibraryRefSchema.nullable(),
  /**
   * The newest version's Library input: its library id and that live library's name (null when no
   * live library has the id). null when the newest version has no Library input or an empty id;
   * always null for a sub-workflow.
   */
  libraryInput: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const SubworkflowSettingSchema = z.object({
  key: z.string(),
  nodeId: z.string(),
  nodeTitle: z.string(),
  settingKey: z.string(),
  schema: JsonValueSchema,
  default: JsonValueSchema,
});
export const WorkflowDetailSchema = WorkflowSummarySchema.extend({
  version: z.number().int(),
  /**
   * Webhook URLs are write-only: a notify node's `url` and URL-valued Run-node overrides are shown
   * as `scheme://host/…` (as in the job detail). Saving that value back unchanged keeps the stored
   * URL; any other value replaces it. The editor shows these like a password field.
   */
  graph: WorkflowGraphSchema,
  issues: z.array(IssueSchema),
  /** The active version's load errors; [] when it is runnable or none is active. */
  activeIssues: z.array(IssueSchema),
  /** Sub-workflows only; null for workflows. A notify node's `url` default is redacted too. */
  settings: z.array(SubworkflowSettingSchema).nullable(),
});
export const WorkflowsListOutputSchema = z.object({ workflows: z.array(WorkflowSummarySchema) });
export const WorkflowCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: WorkflowKindSchema,
  /**
   * Version 1's graph; default emptyGraph(kind). Must have the same kind (400 KIND_MISMATCH).
   * A graph of format 1 is accepted and stored at format 2 (with its Render steps).
   */
  graph: WorkflowGraphInputSchema.optional(),
  note: z.string().trim().max(120).optional(),
});
export const WorkflowDuplicateInputSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(120),
  note: z.string().trim().max(120).optional(),
});
/** The copy, the source version it was taken from, and the ids of nodes whose webhook URL was dropped (the copy needs new ones). */
export const WorkflowDuplicateOutputSchema = WorkflowDetailSchema.extend({
  sourceVersion: z.number().int(),
  droppedWebhookUrls: z.array(z.string()),
});
export const WorkflowIdInputSchema = z.object({ id: z.string() });
export const WorkflowGetInputSchema = z.object({
  id: z.string(),
  version: z.number().int().min(1).optional(),
});
export const WorkflowSaveInputSchema = z.object({
  id: z.string(),
  baseVersion: z.number().int().min(1),
  /** Format 1 is accepted and stored at format 2 (with its Render steps). */
  graph: WorkflowGraphInputSchema,
  /** Shown in the version history ("Layout only", "Restored from v3", the user's message). */
  note: z.string().trim().max(120).optional(),
  /**
   * The past version this graph restores ("Restore as new version"): its webhook URLs are the
   * first match for values sent back redacted.
   */
  restoredFrom: z.number().int().min(1).optional(),
});
export const WorkflowSaveOutputSchema = z.object({
  version: z.number().int(),
  issues: z.array(IssueSchema),
  valid: z.boolean(),
  /** Unchanged by the save; echoed so the editor can say "Saved v6 · v3 stays active". */
  active: WorkflowActiveSchema,
  /** What this save changed against the base, computed by the server; informational, not stored. */
  changes: z.array(z.string()),
});
export const WorkflowValidateInputSchema = z.object({
  /** Format 1 is checked as format 2 (with its Render steps). */
  graph: WorkflowGraphInputSchema,
  id: z.string().optional(),
});
export const WorkflowValidateOutputSchema = z.object({
  issues: z.array(IssueSchema),
  valid: z.boolean(),
});
/** Activating requires `confirm: true`; a missing or false `confirm` is a plain 400 from this schema. */
export const WorkflowActivateInputSchema = z.object({
  id: z.string(),
  version: z.number().int().min(1),
  confirm: z.literal(true),
});
export const WorkflowRenameInputSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(120),
});
export const WorkflowVersionInfoSchema = z.object({
  version: z.number().int(),
  note: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
});
export const WorkflowVersionsOutputSchema = z.object({
  versions: z.array(WorkflowVersionInfoSchema),
});

export type WorkflowActive = z.infer<typeof WorkflowActiveSchema>;
export type WorkflowActivateInput = z.infer<typeof WorkflowActivateInputSchema>;
export type WorkflowRef = z.infer<typeof WorkflowRefSchema>;
export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;
export type SubworkflowSetting = z.infer<typeof SubworkflowSettingSchema>;
export type WorkflowDetail = z.infer<typeof WorkflowDetailSchema>;
export type WorkflowDuplicateOutput = z.infer<typeof WorkflowDuplicateOutputSchema>;
export type WorkflowSaveOutput = z.infer<typeof WorkflowSaveOutputSchema>;
export type WorkflowValidateOutput = z.infer<typeof WorkflowValidateOutputSchema>;
export type WorkflowVersionInfo = z.infer<typeof WorkflowVersionInfoSchema>;
