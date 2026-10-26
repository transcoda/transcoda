import type { QueueStatus } from '@transcoda/contract';
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
