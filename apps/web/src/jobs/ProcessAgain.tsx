import type { JobDetail, Library, WorkflowDetail, WorkflowSummary } from '@transcoda/contract';
import { useId, useState } from 'react';
import { useLocation } from 'wouter';
import { api, isDefinedError, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Dialog } from '../components/Dialog.tsx';
import { Icon } from '../components/Icon.tsx';
import { useToast } from '../components/Toast.tsx';

/** Where a replace puts the original: the library's folder, or `<root>/.transcoda-recycle`. */
export function recycleFolderOf(library: Pick<Library, 'path' | 'recycleFolder'>): string {
  return library.recycleFolder ?? `${library.path.replace(/\/+$/, '')}/.transcoda-recycle`;
}

type Confirm = { workflow: WorkflowDetail | null; recycle: string | null };

/**
 * "Process again" / "Dry run again" on a finished job: queues the same file with the same
 * workflow and `force: true` (an `already_processed` file is queued anyway). The real run asks
 * first, naming the recycle folder the current file goes to if it is rewritten, and runs the
 * active version (the server's rule for real runs). The dry run plans the active version too when
 * there is one (else the newest) and needs no confirmation. Force is per request: nothing is
 * remembered. A queued file opens its new job; a failure is a toast and the page stays. "Dry run
 * again" comes first, "Process again" on the right; `primary` makes it the lime primary.
 */
export function ProcessAgain({
  job,
  summary = null,
  primary = false,
}: {
  job: JobDetail;
  /** The job's workflow from the page's list (null while it loads): its `active` decides Process again. */
  summary?: Pick<WorkflowSummary, 'active'> | null;
  /** Process again is the page's primary action (a failed job: running it again is what's next). */
  primary?: boolean;
}) {
  const toast = useToast();
  const [, navigate] = useLocation();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  // With no active version a real run would only be another dry run: say so instead of offering it.
  const inactive = summary !== null && summary.active === null;

  /** Loads the workflow and the library together, so the dialog opens with its final text. */
  async function openConfirm() {
    setLoading(true);
    const [workflow, library] = await Promise.all([
      safe(api.workflows.get({ id: job.workflowId })),
      safe(api.libraries.get({ id: job.libraryId })),
    ]);
    setLoading(false);
    setConfirm({
      workflow: workflow[0] ? null : workflow[1],
      recycle: library[0] ? null : recycleFolderOf(library[1]),
    });
  }

  async function activeVersion(): Promise<number | undefined> {
    const [err, workflow] = await safe(api.workflows.get({ id: job.workflowId }));
    return err ? undefined : (workflow.active?.version ?? undefined);
  }

  async function queue(dryRun: boolean) {
    setBusy(true);
    const version = dryRun ? await activeVersion() : undefined;
    const [err, out] = await safe(
      api.jobs.queue({
        path: job.filePath,
        workflowId: job.workflowId,
        ...(dryRun ? { dryRun: true } : {}),
        force: true,
        ...(version !== undefined ? { workflowVersion: version } : {}),
      }),
    );
    setBusy(false);
    const again = `Couldn't queue ${job.fileName} again`;
    if (err) {
      if (isDefinedError(err) && err.code === 'PATH_REJECTED') {
        toast.error(`${again}: ${err.data.reason}`);
      } else if (isDefinedError(err) && err.code === 'WORKFLOW_INVALID') {
        toast.error(`${again}: the workflow version can't run`);
      } else toast.error(`${again}: ${describeError(err).message}`);
      return;
    }
    const jobId = out.jobIds[0];
    if (jobId === undefined) {
      toast.error(`${again}: the file is no longer there`);
      return;
    }
    // A real request with no active version was turned into a dry run by the server.
    if (!dryRun && out.dryRun) toast.info(`${job.workflowName} has no active version: dry run`);
    navigate(`/jobs/${jobId}`);
  }

  const workflow = confirm?.workflow ?? null;
  const dry = workflow !== null && workflow.active === null;
  const blocked = workflow?.active != null && !workflow.active.runnable;

  return (
    <>
      <div className="job-again">
        <div className="job-again-actions">
          <button
            type="button"
            className={`btn btn-sm ${primary ? 'btn-secondary' : 'btn-ghost'}`}
            disabled={busy}
            onClick={() => void queue(true)}
          >
            <Icon name="eye" size={14} />
            Dry run again
          </button>
          <button
            type="button"
            className={`btn btn-sm ${primary ? 'btn-primary' : 'btn-secondary'}`}
            disabled={busy || loading}
            aria-busy={loading || undefined}
            {...(inactive ? { 'aria-disabled': true, 'aria-describedby': hintId } : {})}
            onClick={() => {
              if (!inactive) void openConfirm();
            }}
          >
            <Icon name="play" size={14} />
            Process again
          </button>
        </div>
        {inactive ? (
          <span id={hintId} className="field-hint">
            Activate a version to run for real
          </span>
        ) : null}
      </div>
      {loading ? (
        <span className="sr-only" role="status">
          Checking {job.workflowName} and the library
        </span>
      ) : null}
      <Dialog
        open={confirm !== null}
        title={`${dry ? 'Dry run' : 'Process'} ${job.fileName} again?`}
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
                void queue(dry);
              }}
            >
              {dry ? 'Start dry run' : 'Process again'}
            </button>
          </>
        }
      >
        {dry && workflow ? (
          <p>{`${workflow.name} has no active version, so this is a dry run of v${workflow.version}; nothing on disk changes.`}</p>
        ) : blocked && workflow?.active ? (
          <p>{`${workflow.name} v${workflow.active.version} is active but can't run, so this file can't be processed again. Activate a version that runs first.`}</p>
        ) : (
          <p>
            {`Runs ${job.workflowName} (its active version) on this file again, even if that version already processed it. If the file is rewritten, the current file goes to the recycle folder`}
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
        )}
      </Dialog>
    </>
  );
}
