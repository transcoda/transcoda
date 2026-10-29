import { type ReactNode, useState } from 'react';
import { api } from '../api/client.ts';
import { useToast } from '../components/Toast.tsx';
import type { Queue } from './useQueue.ts';

export const QUEUE_PAUSED_TEXT = 'Queue paused — running jobs are frozen, nothing new starts';

/**
 * Who holds the lanes ("Encode lane: idle · Quick lane: idle"; each GPU's slot by name on a
 * multi-GPU server), or null before the queue status loads. `fileNameOf` names a lane's job from
 * the page's list ("busy" when it is not on the page).
 */
export function queueLanesText(
  status: Queue['status'],
  fileNameOf: (jobId: string) => string | null,
): string | null {
  if (!status) return null;
  const lane = (id: string | null) => (id ? (fileNameOf(id) ?? 'busy') : 'idle');
  // One slot reads as the encode lane; several (one per GPU) each by name. An older server
  // sends no slots.
  const slots = status.encodeSlots ?? [];
  const encode =
    slots.length > 1
      ? slots.map((s) => `${s.label}: ${lane(s.jobId)}`).join(' · ')
      : `Encode lane: ${lane(status.lanes.encode ?? null)}`;
  return `${encode} · Quick lane: ${lane(status.lanes.quick)}`;
}

/** The lanes as the muted status line under a page's H1. */
export function QueueLanes({
  queue,
  fileNameOf,
  className = 'head-sub',
}: {
  queue: Queue;
  fileNameOf(jobId: string): string | null;
  className?: string;
}) {
  const text = queueLanesText(queue.status, fileNameOf);
  return text ? (
    <p className={className} data-testid="lanes">
      {text}
    </p>
  ) : null;
}

/** "Pause queue" / "Resume queue" (persisted on the server). */
export function QueueToggle({
  queue,
  className = 'btn btn-secondary btn-sm',
}: {
  queue: Queue;
  className?: string;
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

  return (
    <button
      type="button"
      className={className}
      disabled={!current || busy}
      onClick={() => void toggle()}
    >
      {paused ? 'Resume queue' : 'Pause queue'}
    </button>
  );
}

/** The paused banner; a live region that stays mounted so the change is announced. */
export function QueuePausedNote({ queue }: { queue: Queue }) {
  const paused = queue.status?.paused ?? false;
  return (
    <div role="status" className="queue-status">
      {paused ? <p className="alert alert-warning queue-paused">{QUEUE_PAUSED_TEXT}</p> : null}
    </div>
  );
}

/**
 * The whole-queue control in one bar: the lanes, "Pause queue" / "Resume queue" and the paused
 * banner, from the page's `useQueue()`. `children` follow the queue button. (The Jobs page places
 * the same pieces in its header instead.)
 */
export function QueueBar({
  queue,
  fileNameOf,
  children,
}: {
  queue: Queue;
  fileNameOf(jobId: string): string | null;
  children?: ReactNode;
}) {
  const text = queueLanesText(queue.status, fileNameOf);
  return (
    <div className="queue">
      <div className="queue-bar">
        {text ? (
          <span className="queue-lanes" data-testid="lanes">
            {text}
          </span>
        ) : null}
        <QueueToggle queue={queue} className="btn btn-ghost btn-sm" />
        {children}
      </div>
      <QueuePausedNote queue={queue} />
    </div>
  );
}
