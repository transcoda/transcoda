import type { ApiClient } from '@transcoda/contract';
import { useCallback, useState } from 'react';
import { api, safe } from '../api/client.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { useRefetchOn } from '../hooks/useRefetchOn.ts';

/** Derived from the contract, like the rest of the web app's API types. */
export type PluginCatalogOutput = Awaited<ReturnType<ApiClient['plugins']['catalog']>>;
export type CatalogView = PluginCatalogOutput['catalogs'][number];

/**
 * The installed plugins and the catalogs; both reload when a plugin changes state (install,
 * update, remove, enable, crash) and after every reconnect of the event stream.
 */
export function usePlugins() {
  const list = useAsync(() => api.plugins.list(), []);
  const catalog = useAsync(() => api.plugins.catalog({ refresh: false }), []);
  // The answer of "Check for updates" (a refreshed fetch); dropped by the next ordinary reload.
  const [fresh, setFresh] = useState<PluginCatalogOutput | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<unknown>(null);

  const reloadList = list.reload;
  const reloadCatalog = catalog.reload;
  const reload = useCallback(() => {
    setFresh(null);
    reloadList();
    reloadCatalog();
  }, [reloadList, reloadCatalog]);
  useRefetchOn((e) => e.type === 'plugins.changed', reload);

  const checkForUpdates = useCallback(async () => {
    setChecking(true);
    setCheckError(null);
    const [err, out] = await safe(api.plugins.catalog({ refresh: true }));
    setChecking(false);
    if (err) {
      setCheckError(err);
      return;
    }
    setFresh(out);
    // The refreshed fetch filled the server's update map that each plugin's
    // `updateAvailable` reads: reload the list so the cards offer the update.
    reloadList();
  }, [reloadList]);

  /**
   * Replaces what the page shows with a catalog answer (adding or removing a catalog) and reloads
   * the list, whose `updateAvailable` depends on the catalogs.
   */
  const setCatalogs = useCallback(
    (out: PluginCatalogOutput) => {
      setFresh(out);
      reloadList();
    },
    [reloadList],
  );

  return {
    plugins: list.data?.plugins,
    /** Plugins that are not installed but whose nodes workflows use. */
    missing: list.data?.missing,
    pluginsError: list.error,
    loading: list.loading && !list.data,
    catalogs: (fresh ?? catalog.data)?.catalogs,
    blocklist: (fresh ?? catalog.data)?.blocklist,
    catalogError: catalog.error,
    reload,
    checkForUpdates,
    checking,
    checkError,
    setCatalogs,
  };
}
