import type { QueueStatus } from '@transcoda/contract';
import type { JobState } from '@transcoda/shared';
import { useState } from 'react';
import { api } from '../api/client.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { useEvents, useOnReconnect } from '../hooks/useEvents.ts';

export type QueueState = Pick<QueueStatus, 'paused' | 'lanes' | 'encodeSlots'>;

export interface Queue {
  /** Null until the first `queue.status` answers. */
  status: QueueState | null;
  /** Applies a state the server just answered with (pause / resume). */
  set(next: QueueState): void;
}

/**
 * The whole queue: `queue.status`, kept current by `queue.changed`. A reconnect or `resync` drops
 * the live snapshot (events may have been missed) and refetches, so the server's answer wins.
 */
export function useQueue(): Queue {
  const fetched = useAsync(() => api.queue.status(), []);
  const [live, setLive] = useState<QueueState | null>(null);
  useEvents((e) => {
    if (e.type === 'queue.changed') {
      setLive({ paused: e.paused, lanes: e.lanes, encodeSlots: e.encodeSlots });
    }
  }, []);
  useOnReconnect(() => {
    setLive(null);
    fetched.reload();
  });
  const data = fetched.data;
  return {
    status:
      live ??
      (data ? { paused: data.paused, lanes: data.lanes, encodeSlots: data.encodeSlots } : null),
    set: setLive,
  };
}

/**
 * An encoding job whose process stands still: the queue is paused (that stops the encode), or the
 * job doesn't hold a lane (the encode lane, a GPU's slot or the quick lane), so it waits for one,
 * as a resumed job does while another took its lane. Other states go on working (verify and
 * replace run without a process the pause stops); false until the queue status loads.
 */
export function encodeStopped(
  status: QueueState | null,
  job: { id: string; state: JobState },
): boolean {
  if (status === null || job.state !== 'encoding') return false;
  if (status.paused) return true;
  const { encode, quick } = status.lanes;
  const holdsLane =
    encode === job.id ||
    quick === job.id ||
    (status.encodeSlots ?? []).some((slot) => slot.jobId === job.id);
  return !holdsLane;
}
