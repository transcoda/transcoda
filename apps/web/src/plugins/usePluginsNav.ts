import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { useRefetchOn } from '../hooks/useRefetchOn.ts';

/** What the app frame shows of the installed plugins. */
export interface PluginsNav {
  /** The tmdb plugin is installed: its terms ask for a notice. */
  tmdb: boolean;
  /** Installed plugins with an update available: the Plugins menu item's badge. */
  updates: number;
}

const NONE: PluginsNav = { tmdb: false, updates: 0 };

/** The last answer, shared by every Shell (each route mounts its own): navigation does not refetch. */
let known: PluginsNav | null = null;

/** Test hook: forget the shared answer. */
export function resetPluginsNav(): void {
  known = null;
}

/**
 * The installed plugins as the app frame needs them; fetched once, then only when
 * `plugins.changed` (the server's background update check publishes it when updates change).
 */
export function usePluginsNav(): PluginsNav {
  const [nav, setNav] = useState(known ?? NONE);
  const load = useCallback(() => {
    void (async () => {
      try {
        const { plugins } = await api.plugins.list();
        known = {
          tmdb: plugins.some((p) => p.name === 'tmdb'),
          updates: plugins.filter((p) => p.updateAvailable !== null).length,
        };
        setNav(known);
      } catch {
        // No list, no notice and no badge; the Plugins page shows both itself.
      }
    })();
  }, []);
  useEffect(() => {
    if (known === null) load();
  }, [load]);
  useRefetchOn((e) => e.type === 'plugins.changed', load);
  return nav;
}
