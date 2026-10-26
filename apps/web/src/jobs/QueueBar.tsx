import { useState } from 'react';
import { api } from '../api/client.ts';
import { useToast } from '../components/Toast.tsx';
import type { Queue } from './useQueue.ts';

export const QUEUE_PAUSED_TEXT = 'Queue paused — running jobs are frozen, nothing new starts';

/**
 * The whole-queue control: "Pause queue" / "Resume queue" (persisted on the server), the paused
 * banner and who holds the lanes (each GPU's slot on a multi-GPU server), from the page's `useQueue()`. `fileNameOf` names a lane's
 * job from the page's list ("busy" when it is not on the page).
 */
export function QueueBar({
  queue,
  fileNameOf,
}: {
  queue: Queue;
  fileNameOf(jobId: string): string | null;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const current = queue.status;
  const paused = current?.paused ?? false;

  async function toggle() {
    setBusy(true);
    try {
      const next = paused ? await api.queue.resume() : await api.queue.pause();
      queue.set({ paused: next.paused, lanes: next.lanes, encodeSlots: next.encodeSlots });
    } catch {
      toast.error(paused ? "Couldn't resume the queue" : "Couldn't pause the queue");
    } finally {
      setBusy(false);
    }
  }

  const lane = (id: string | null) => (id ? (fileNameOf(id) ?? 'busy') : 'idle');
  // One slot reads as the encode lane; several (one per GPU) each by name. An older server
  // sends no slots.
  const slots = current?.encodeSlots ?? [];
  const encode =
    slots.length > 1
      ? slots.map((s) => `${s.label}: ${lane(s.jobId)}`).join(' · ')
      : `Encode lane: ${lane(current?.lanes.encode ?? null)}`;

  return (
    <div className="queue">
      <div className="queue-bar">
        {current ? (
          <span className="queue-lanes" data-testid="lanes">
            {`${encode} · Quick lane: ${lane(current.lanes.quick)}`}
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!current || busy}
          onClick={() => void toggle()}
        >
          {paused ? 'Resume queue' : 'Pause queue'}
        </button>
      </div>
      <div role="status" className="queue-status">
        {paused ? <p className="alert alert-warning queue-paused">{QUEUE_PAUSED_TEXT}</p> : null}
      </div>
    </div>
  );
}
