import { type ReactNode, useState } from 'react';
import { api } from '../api/client.ts';
import { useToast } from '../components/Toast.tsx';
import type { Queue } from './useQueue.ts';

export const QUEUE_PAUSED_TEXT = 'Queue paused — running jobs are frozen, nothing new starts';

export interface LaneHolder {
  /** "Encoder", "Quick tasks", or a GPU slot's label ("GPU 0 · RTX 3060"). */
  label: string;
  /** The job's file name, "busy" when it is not on the page, or "idle". */
  holder: string;
}

/**
 * Who holds the lanes (the encode lane, or each GPU's slot by name on a multi-GPU server, then the
 * quick lane), or null before the queue status loads. `fileNameOf` names a lane's job from the
 * page's list ("busy" when it is not on the page).
 */
export function queueLanes(
  status: Queue['status'],
  fileNameOf: (jobId: string) => string | null,
): LaneHolder[] | null {
  if (!status) return null;
  const lane = (id: string | null) => (id ? (fileNameOf(id) ?? 'busy') : 'idle');
  // One slot reads as the encode lane; several (one per GPU) each by name. An older server
  // sends no slots.
  const slots = status.encodeSlots ?? [];
  const encode =
    slots.length > 1
      ? slots.map((s) => ({ label: s.label, holder: lane(s.jobId) }))
      : [{ label: 'Encoder', holder: lane(status.lanes.encode ?? null) }];
  return [...encode, { label: 'Quick tasks', holder: lane(status.lanes.quick) }];
}

/** The lanes in one line: "Encoder: idle · Quick tasks: idle". */
export function queueLanesText(
  status: Queue['status'],
  fileNameOf: (jobId: string) => string | null,
): string | null {
  const lanes = queueLanes(status, fileNameOf);
  return lanes ? lanes.map((l) => `${l.label}: ${l.holder}`).join(' · ') : null;
}

/**
 * The lanes under a page's H1, one row per lane: the lane's name, then its file name, cut short
 * with an ellipsis when it doesn't fit (the whole name on hover).
 */
export function QueueLanes({
  queue,
  fileNameOf,
}: {
  queue: Queue;
  fileNameOf(jobId: string): string | null;
}) {
  const lanes = queueLanes(queue.status, fileNameOf);
  return lanes ? (
    <dl className="head-sub lanes" data-testid="lanes">
      {lanes.map((l) => (
        <div className="lane" key={l.label}>
          <dt>{l.label}</dt>
          <dd className={l.holder === 'idle' ? 'is-idle' : undefined} title={l.holder}>
            {l.holder}
          </dd>
        </div>
      ))}
    </dl>
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
