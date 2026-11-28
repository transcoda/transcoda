import { useState } from 'react';
import { api, isDefinedError, safe } from '../../api/client.ts';
import { Dialog } from '../../components/Dialog.tsx';
import { useToast } from '../../components/Toast.tsx';
import type { Job } from '../job-text.ts';
import { jobTitle } from '../media-text.ts';

/** Pause / Resume / Cancel (with its confirmation) for one job. */
export function useJobControls(reload: () => void) {
  const toast = useToast();
  const [cancelling, setCancelling] = useState<Job | null>(null);

  async function run(kind: 'pause' | 'resume' | 'cancel', job: Job) {
    const call = { pause: api.jobs.pause, resume: api.jobs.resume, cancel: api.jobs.cancel }[kind];
    const [err] = await safe(call({ id: job.id }));
    if (isDefinedError(err) && err.code === 'JOB_NOT_ACTIVE') {
      toast.info('That job already finished');
    } else if (err) {
      toast.error(`Couldn't ${kind} ${jobTitle(job)}`);
      return;
    }
    // The event stream brings the change; a reload also covers a stream that is reconnecting.
    reload();
  }

  const dialog = (
    <Dialog
      open={cancelling !== null}
      title={`Cancel ${cancelling ? jobTitle(cancelling) : ''}?`}
      tone="danger"
      onClose={() => setCancelling(null)}
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost"
            data-autofocus
            onClick={() => setCancelling(null)}
          >
            Keep running
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              const job = cancelling;
              setCancelling(null);
              if (job) void run('cancel', job);
            }}
          >
            Cancel job
          </button>
        </>
      }
    >
      <p>The original stays untouched.</p>
    </Dialog>
  );

  return {
    pause: (job: Job) => void run('pause', job),
    resume: (job: Job) => void run('resume', job),
    askCancel: (job: Job) => setCancelling(job),
    dialog,
  };
}
