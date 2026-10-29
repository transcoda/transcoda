import type { AppUpdateOutput } from '@transcoda/contract';
import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { useRefetchOn } from './useRefetchOn.ts';

/** The last answer, shared by every Shell and the About page: navigation does not refetch. */
let known: AppUpdateOutput | null = null;
/** Every mounted consumer, so an answer fetched by one reaches all of them. */
const listeners = new Set<(status: AppUpdateOutput) => void>();
let requested = 0;
let applied = 0;

/** Test hook: forget the shared answer. */
export function resetAppUpdate(): void {
  known = null;
  requested = 0;
  applied = 0;
}

/** Fetches the status and hands it to every consumer; an answer older than the one shown is dropped. */
function load(): void {
  const mine = ++requested;
  void (async () => {
    try {
      const status = await api.system.update();
      if (mine < applied) return;
      applied = mine;
      known = status;
      for (const listener of listeners) listener(status);
    } catch {
      // No answer, no badge and no notice: About still shows the running version.
    }
  })();
}

/**
 * Whether a newer Transcoda release exists (the server checks GitHub in the background); fetched
 * once, then again when the server publishes `app.update`. Null until known or when unreadable.
 */
export function useAppUpdate(): AppUpdateOutput | null {
  const [status, setStatus] = useState(known);
  useEffect(() => {
    listeners.add(setStatus);
    if (known === null) load();
    else setStatus(known);
    return () => {
      listeners.delete(setStatus);
    };
  }, []);
  useRefetchOn((e) => e.type === 'app.update', load);
  return status;
}
