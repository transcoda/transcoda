import type { RunDetail, WorkflowDetail } from '@transcoda/contract';
import { useId, useState } from 'react';
import { useLocation } from 'wouter';
import { api, isDefinedError, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Dialog } from '../components/Dialog.tsx';
import { Icon } from '../components/Icon.tsx';
import { useToast } from '../components/Toast.tsx';
import { useWorkflows } from '../hooks/useWorkflows.ts';
import { recycleFolderOf } from './ProcessAgain.tsx';

const filesWord = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

type Confirm = { workflow: WorkflowDetail | null; recycle: string | null };

/**
 * "Process again" on a run with already-processed files: those files only (never the rest of the
 * run) go back to the queue with force, as one new run of the same workflow. The real run asks
 * first, like Process again on a job. A dry run's page, or a workflow with no active version,
 * offers "Dry run again" instead (no dialog: nothing on disk changes), since a real request would
 * only be another dry run; one found inactive only when the button is pressed is relabelled and a
 * toast says why. Several files queued open the new run, one opens its job; a failure is a toast
 * and the page stays.
 */
export function RunProcessAgain({ detail }: { detail: RunDetail }) {
  const { run, workflowName } = detail;
  const count = detail.counts.already_processed;
  const toast = useToast();
  const [, navigate] = useLocation();
  const { workflows } = useWorkflows();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [noActive, setNoActive] = useState(false);
  const hintId = useId();
  const summary = workflows?.find((w) => w.id === run.workflowId) ?? null;
  const inactive = noActive || (summary !== null && summary.active === null);
  const dry = run.dryRun || inactive;

  /** Loads the workflow and the library together, so the dialog opens with its final text. */
  async function openConfirm() {
    setLoading(true);
    const [workflow, library] = await Promise.all([
      safe(api.workflows.get({ id: run.workflowId })),
      safe(api.libraries.get({ id: run.libraryId })),
    ]);
    setLoading(false);
    const loaded = workflow[0] ? null : workflow[1];
    if (loaded !== null && loaded.active === null) {
      setNoActive(true);
      toast.info(`${loaded.name} has no active version: use Dry run again`);
      return;
    }
    setConfirm({ workflow: loaded, recycle: library[0] ? null : recycleFolderOf(library[1]) });
  }

  async function queue(dryRun: boolean) {
    setBusy(true);
    const [err, out] = await safe(api.runs.processAgain({ id: run.id, dryRun }));
    setBusy(false);
    const again = `Couldn't queue ${filesWord(count)} again`;
    if (err) {
      if (isDefinedError(err) && err.code === 'PATH_REJECTED') {
        toast.error(`${again}: ${err.data.reason}`);
      } else if (isDefinedError(err) && err.code === 'WORKFLOW_INVALID') {
        toast.error(`${again}: the workflow version can't run`);
      } else toast.error(`${again}: ${describeError(err).message}`);
      return;
    }
    // A real request with no active version was turned into a dry run by the server.
    if (!dryRun && out.dryRun) toast.info(`${workflowName} has no active version: dry run`);
    const jobId = out.jobIds[0];
    if (out.jobIds.length === 1 && jobId !== undefined) navigate(`/jobs/${jobId}`);
    else navigate(`/runs/${out.runId}`);
  }

  const workflow = confirm?.workflow ?? null;
  const blocked = workflow?.active != null && !workflow.active.runnable;

  return (
    <>
      <div className="job-again">
        <div className="job-again-actions">
          {dry ? (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={busy}
              {...(inactive && !run.dryRun ? { 'aria-describedby': hintId } : {})}
              onClick={() => void queue(true)}
            >
              <Icon name="eye" size={14} />
              Dry run again
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={busy || loading}
              aria-busy={loading || undefined}
              onClick={() => void openConfirm()}
            >
              <Icon name="play" size={14} />
              Process again
            </button>
          )}
        </div>
        {inactive && !run.dryRun ? (
          <span id={hintId} className="field-hint">
            Activate a version to run for real
          </span>
        ) : null}
      </div>
      {loading ? (
        <span className="sr-only" role="status">
          Checking {workflowName} and the library
        </span>
      ) : null}
      <Dialog
        open={confirm !== null}
        title={`Process ${filesWord(count)} again?`}
        onClose={() => setConfirm(null)}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              data-autofocus
              onClick={() => setConfirm(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={blocked}
              onClick={() => {
                setConfirm(null);
                void queue(false);
              }}
            >
              Process again
            </button>
          </>
        }
      >
        {blocked && workflow?.active ? (
          <p>{`${workflow.name} v${workflow.active.version} is active but can't run, so these files can't be processed again. Activate a version that runs first.`}</p>
        ) : (
          <>
            <p>
              {`Runs ${workflowName} (its active version) again on the ${count === 1 ? 'file' : `${count} files`} of this run marked Already processed, even though that version already processed ${count === 1 ? 'it' : 'them'}. The other files of the run are left alone.`}
            </p>
            <p>
              {'If a file is rewritten, the current file goes to the recycle folder'}
              {confirm?.recycle ? (
                <>
                  {': '}
                  <span className="mono">{confirm.recycle}</span>
                </>
              ) : (
                ' of the library'
              )}
              .
            </p>
          </>
        )}
      </Dialog>
    </>
  );
}
