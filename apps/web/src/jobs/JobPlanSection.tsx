import type { JobDetail, WorkflowSummary } from '@transcoda/contract';
import { useState } from 'react';
import { describeError } from '../api/errors.ts';
import { ActivateDialog } from '../editor/ui/ActivateDialog.tsx';
import { useWorkflow } from '../hooks/useWorkflows.ts';
import { PlanView } from './PlanView.tsx';
import { useTryOnFile } from './useTryOnFile.ts';

const NOTHING_TO_SAVE = async () => true;

/**
 * The job page's dry-run plan (Task 24): PlanView for a dry run with a plan, wired to the activate
 * confirmation ("files in <library>") and the file picker for "Dry run another file". "Activate vN of
 * <name>…" is for the job's own version and shows once the workflow's active version is known and
 * is not that one; a failed load says so with "Try again".
 */
export function JobPlanSection({ job }: { job: JobDetail }) {
  // Only a dry run with a plan has this section: its hooks (the workflow fetch) run only then.
  if (!job.dryRun || !job.plan) return null;
  return <DryRunPlan job={job} plan={job.plan} />;
}

function DryRunPlan({ job, plan }: { job: JobDetail; plan: NonNullable<JobDetail['plan']> }) {
  const { workflow, error, loading, reload } = useWorkflow(job.workflowId);
  const [activated, setActivated] = useState<WorkflowSummary | null>(null);
  const [activateOpen, setActivateOpen] = useState(false);
  const tryOnFile = useTryOnFile(
    { id: job.workflowId, name: job.workflowName },
    { dirty: false, save: NOTHING_TO_SAVE },
  );
  const summary: WorkflowSummary | null = activated ?? workflow ?? null;
  const loadFailed = Boolean(error) && !loading && summary === null;
  return (
    <>
      {loadFailed && (
        <div role="alert" className="alert alert-danger">
          <span>
            Could not check which version of {job.workflowName} is active:{' '}
            {describeError(error).message}
          </span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={reload}>
            Try again
          </button>
        </div>
      )}
      <PlanView
        plan={plan}
        probe={job.probe}
        result={job.result}
        measured={job.testEncode === true}
        // Unknown (undefined) until the workflow loads: "Activate …" waits for it.
        workflow={{
          id: job.workflowId,
          name: job.workflowName,
          version: job.workflowVersion,
          active: summary?.active,
        }}
        onActivate={() => setActivateOpen(true)}
        onTryAnother={() => tryOnFile.open()}
      />
      {summary && (
        <ActivateDialog
          open={activateOpen}
          workflow={summary}
          version={job.workflowVersion}
          issues={null}
          onClose={() => setActivateOpen(false)}
          onActivated={(next) => {
            setActivated(next);
            setActivateOpen(false);
          }}
        />
      )}
      {tryOnFile.element}
    </>
  );
}
