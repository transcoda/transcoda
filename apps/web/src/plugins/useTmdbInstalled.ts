import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { useRefetchOn } from '../hooks/useRefetchOn.ts';

/** The last answer, shared by every Shell (each route mounts its own): navigation does not refetch. */
let known: boolean | null = null;

/** Test hook: forget the shared answer. */
export function resetTmdbInstalled(): void {
  known = null;
}

/** Whether the tmdb plugin is installed; fetched once, then only when `plugins.changed`. */
export function useTmdbInstalled(): boolean {
  const [installed, setInstalled] = useState(known === true);
  const load = useCallback(() => {
    void (async () => {
      try {
        known = (await api.plugins.list()).plugins.some((p) => p.name === 'tmdb');
        setInstalled(known);
      } catch {
        // No list, no notice; the TMDB card still carries it.
      }
    })();
  }, []);
  useEffect(() => {
    if (known === null) load();
  }, [load]);
  useRefetchOn((e) => e.type === 'plugins.changed', load);
  return installed;
}
