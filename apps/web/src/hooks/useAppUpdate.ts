import type { AppUpdateOutput } from '@transcoda/contract';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { useRefetchOn } from './useRefetchOn.ts';

/** The last answer, shared by every Shell and the About page: navigation does not refetch. */
let known: AppUpdateOutput | null = null;

/** Test hook: forget the shared answer. */
export function resetAppUpdate(): void {
  known = null;
}

/**
 * Whether a newer Transcoda release exists (the server checks GitHub in the background); fetched
 * once, then again when the server publishes `app.update`. Null until known or when unreadable.
 */
export function useAppUpdate(): AppUpdateOutput | null {
  const [status, setStatus] = useState(known);
  const load = useCallback(() => {
    void (async () => {
      try {
        known = await api.system.update();
        setStatus(known);
      } catch {
        // No answer, no badge and no notice: About still shows the running version.
      }
    })();
  }, []);
  useEffect(() => {
    if (known === null) load();
  }, [load]);
  useRefetchOn((e) => e.type === 'app.update', load);
  return status;
}
