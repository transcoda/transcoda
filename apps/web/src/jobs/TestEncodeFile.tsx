import type { JobDetail } from '@transcoda/contract';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { api, isDefinedError, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Icon } from '../components/Icon.tsx';
import { useToast } from '../components/Toast.tsx';

/**
 * "Test-encode this file" on a plan-only dry run whose size gate decides after encoding (#41):
 * queues a test-encode dry run of the same file with the same workflow version (`force`, so a file
 * already finished is taken too), then opens its job. Nothing in the library is written.
 */
export function TestEncodeFile({
  job,
}: {
  job: Pick<JobDetail, 'filePath' | 'fileName' | 'workflowId' | 'workflowVersion'>;
}) {
  const toast = useToast();
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    const [err, out] = await safe(
      api.jobs.queue({
        path: job.filePath,
        workflowId: job.workflowId,
        workflowVersion: job.workflowVersion,
        dryRun: true,
        testEncode: true,
        force: true,
      }),
    );
    setBusy(false);
    const failed = `Couldn't test-encode ${job.fileName}`;
    if (err) {
      if (isDefinedError(err) && err.code === 'PATH_REJECTED') {
        toast.error(`${failed}: ${err.data.reason}`);
      } else toast.error(`${failed}: ${describeError(err).message}`);
      return;
    }
    const jobId = out.jobIds[0];
    if (jobId === undefined) {
      toast.error(`${failed}: the file is no longer there`);
      return;
    }
    navigate(`/jobs/${jobId}`);
  }

  return (
    <button
      type="button"
      className="btn btn-sm btn-secondary job-result-action"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => void run()}
    >
      <Icon name="play" size={14} />
      {busy ? 'Queuing…' : 'Test-encode this file'}
    </button>
  );
}
