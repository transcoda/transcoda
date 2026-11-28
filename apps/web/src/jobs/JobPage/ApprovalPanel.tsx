import type { JobDetail } from '@transcoda/contract';
import { planSummary } from '@transcoda/shared';
import { useId, useState } from 'react';
import { api, safe } from '../../api/client.ts';
import { describeError } from '../../api/errors.ts';
import { Dialog } from '../../components/Dialog.tsx';
import { Icon } from '../../components/Icon.tsx';
import { useToast } from '../../components/Toast.tsx';
import { fmtBytes, fmtSaving } from '../../lib/bytes.ts';
import { fmtDate } from '../../lib/time.ts';

export type ApprovalJob = Pick<JobDetail, 'id' | 'approval' | 'plan'>;

/**
 * A result an Approval step holds (job page, under the header): the size it reaches, what the
 * plan does, until when it waits, and Approve (the finish steps go on) or Reject (asked first:
 * the result is discarded, the original kept). Before and after and the steps below show the
 * rest. A result answered elsewhere meanwhile says so and the page refreshes.
 */
export function ApprovalPanel({ job, onChanged }: { job: ApprovalJob; onChanged(): void }) {
  const headingId = useId();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const a = job.approval;
  if (!a) return null;

  async function answer(action: 'approve' | 'reject') {
    setBusy(true);
    const [err] = await safe(api.jobs[action]({ id: job.id }));
    setBusy(false);
    if (err) {
      const failure = describeError(err);
      if (failure.code === 'JOB_NOT_ACTIVE') {
        toast.info('That result is no longer waiting for approval');
      } else {
        toast.error(failure.message);
        return;
      }
    }
    onChanged();
  }

  return (
    <section className="panel approval" aria-labelledby={headingId}>
      <div className="approval-head">
        <Icon name="user-check" size={18} />
        <h2 id={headingId} className="approval-title">
          Waiting for your approval
        </h2>
      </div>
      <p className="approval-sizes mono">
        {`${fmtBytes(a.beforeBytes)} → ${fmtBytes(a.afterBytes)}, ${fmtSaving(a.beforeBytes, a.afterBytes)}`}
      </p>
      {job.plan && <p className="approval-plan">{`Plan: ${planSummary(job.plan)}`}</p>}
      <p className="approval-note">
        {`Nothing on disk has changed yet. Without an answer by ${fmtDate(a.expiresAt)}, the result is rejected and the original kept.`}
      </p>
      <div className="approval-actions">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy}
          onClick={() => void answer('approve')}
        >
          <Icon name="check" size={14} />
          Approve
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger-outline"
          disabled={busy}
          onClick={() => setConfirmReject(true)}
        >
          Reject
        </button>
      </div>
      <Dialog
        open={confirmReject}
        title="Reject this result?"
        tone="danger"
        onClose={() => setConfirmReject(false)}
        footer={
          <>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              data-autofocus
              onClick={() => setConfirmReject(false)}
            >
              Keep waiting
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => {
                setConfirmReject(false);
                void answer('reject');
              }}
            >
              Reject result
            </button>
          </>
        }
      >
        <p>
          The result is discarded and the original kept. Steps after Rejected, such as
          notifications, still run.
        </p>
      </Dialog>
    </section>
  );
}
