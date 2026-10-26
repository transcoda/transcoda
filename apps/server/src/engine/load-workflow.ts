import type { Issue, WorkflowGraph } from '@transcoda/shared';
import type { JobRow } from '../db/repos/jobs.ts';
import type { WorkflowService } from '../workflows/service.ts';

export type LoadedWorkflow = {
  kind: 'ok';
  graph: WorkflowGraph;
  /** The version to run: the active one for a real job, the pinned one for a dry run. */
  version: number;
};

/**
 * The version a job runs, ready to walk (see `WorkflowService.loadForRun`). A real job runs the
 * workflow's active version, whatever it was queued with; a dry run keeps its pinned version.
 * Pure: nothing is written.
 */
export function loadWorkflowForJob(
  service: WorkflowService,
  job: Pick<JobRow, 'workflowId' | 'workflowVersion' | 'dryRun'>,
):
  | LoadedWorkflow
  | { kind: 'invalid'; issues: Issue[] }
  | { kind: 'missing' }
  | { kind: 'not-active' } {
  let version = job.workflowVersion;
  if (!job.dryRun) {
    const active = service.activeVersionOf(job.workflowId);
    if (active === 'missing') return { kind: 'missing' };
    if (active === null) return { kind: 'not-active' };
    version = active;
  }
  const loaded = service.loadForRun(job.workflowId, version);
  if (loaded.kind !== 'ok') return loaded;
  return { kind: 'ok', graph: loaded.graph, version };
}
