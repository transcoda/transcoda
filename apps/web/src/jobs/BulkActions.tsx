// The Jobs page's whole-list actions in its header: "Retry failed" and "Cancel all".
import { CANCELLABLE_JOB_STATES, type JobState } from '@transcoda/shared';
import { useState } from 'react';
import { api, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Dialog } from '../components/Dialog.tsx';
import { Icon } from '../components/Icon.tsx';
import { useToast } from '../components/Toast.tsx';

const num = new Intl.NumberFormat('en-US');

/**
 * "Retry failed": every failed job back in the queue, one more attempt each, on the workflow
 * version active when it starts (after a fix or a new build). Shown while any job has failed.
 */
export function RetryFailed({ failed, onDone }: { failed: number; onDone(): void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (failed === 0) return null;
  async function retry() {
    setBusy(true);
    const [err, out] = await safe(api.jobs.retryFailed());
    setBusy(false);
    if (err || !out) {
      toast.error(`Could not retry the failed jobs: ${describeError(err).message}`);
      return;
    }
    toast.success(
      out.retried === 0
        ? 'Nothing to retry: each failed file has a newer job'
        : `Queued ${out.retried} failed ${out.retried === 1 ? 'job' : 'jobs'} again`,
    );
    onDone();
  }
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      aria-busy={busy}
      disabled={busy}
      onClick={() => void retry()}
    >
      <Icon name="refresh" size={14} />
      Retry failed
    </button>
  );
}

const jobsWord = (n: number) => `${num.format(n)} ${n === 1 ? 'job' : 'jobs'}`;

/** The toast after "Cancel all", and its tone: an error when any cancel failed. */
function cancelAllResult(out: { cancelled: number; writing: number; failed: number }): {
  tone: 'success' | 'info' | 'error';
  text: string;
} {
  const parts: string[] = [];
  if (out.cancelled > 0) parts.push(`Canceled ${jobsWord(out.cancelled)}`);
  else if (out.writing > 0 || out.failed > 0) parts.push('Nothing was canceled');
  if (out.writing > 0) {
    parts.push(`${jobsWord(out.writing)} already replacing their file will finish`);
  }
  if (out.failed > 0) parts.push(`${jobsWord(out.failed)} could not be canceled`);
  if (parts.length === 0)
    return { tone: 'info', text: 'Nothing to cancel: those jobs already finished' };
  const tone = out.failed > 0 ? 'error' : out.cancelled > 0 ? 'success' : 'info';
  return { tone, text: parts.join('. ') };
}

/**
 * "Cancel all": every queued, running and paused job of the library filter, or of every library,
 * after a confirmation. A job already replacing its file is left to finish (the server's rule; the
 * count leaves `replacing` out too). The status chips do not narrow it; the dialog says so when
 * one is on. Shown while any job in that scope can be cancelled (`counts` covers the library
 * scope only).
 */
export function CancelAll({
  counts,
  libraryId,
  libraryName,
  statusFiltered,
  onDone,
}: {
  counts: Record<JobState, number> | null;
  libraryId: string | null;
  libraryName: string | null;
  statusFiltered: boolean;
  onDone(): void;
}) {
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const count = counts ? CANCELLABLE_JOB_STATES.reduce((sum, st) => sum + (counts[st] ?? 0), 0) : 0;
  if (count === 0 && !asking) return null;

  async function cancelAll() {
    setAsking(false);
    setBusy(true);
    const [err, out] = await safe(api.jobs.cancelAll(libraryId ? { libraryId } : {}));
    setBusy(false);
    if (err || !out) {
      toast.error(`Couldn't cancel the jobs: ${describeError(err).message}`);
      return;
    }
    const { tone, text } = cancelAllResult(out);
    toast[tone](text);
    // The event stream brings the change; a reload also covers a stream that is reconnecting.
    onDone();
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-busy={busy}
        disabled={busy}
        onClick={() => setAsking(true)}
      >
        Cancel all
      </button>
      <Dialog
        open={asking}
        title={`Cancel ${jobsWord(count)}?`}
        tone="danger"
        onClose={() => setAsking(false)}
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost"
              data-autofocus
              onClick={() => setAsking(false)}
            >
              Keep running
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void cancelAll()}>
              {`Cancel ${jobsWord(count)}`}
            </button>
          </>
        }
      >
        <p>
          {`Every queued, running and paused job ${libraryId ? `in ${libraryName ?? 'this library'}` : 'in every library'} is canceled.`}
          {statusFiltered ? ' The status and run filters do not limit this.' : null}
        </p>
        <p>
          Running encodes stop now and their partial output is deleted. Their originals stay
          untouched. Jobs already replacing their file finish.
        </p>
      </Dialog>
    </>
  );
}
