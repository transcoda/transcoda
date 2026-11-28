import type { JobState } from '@transcoda/shared';
import { useState } from 'react';
import { api } from '../../api/client.ts';
import { useAsync } from '../../hooks/use-async.ts';
import { useRefetchOn } from '../../hooks/use-refetch-on.ts';
import { countsScopeOf, stateChangeTracker } from '../use-jobs-list.ts';

/**
 * Jobs per state for "Cancel all", which covers real and dry runs alike: the list's own counts,
 * or (while the dry-run facet narrows the list) the library's counts fetched apart. Counts are
 * used only for the scope that produced them: right after a filter change the old answer is still
 * held, and it must never stand for what the action will cancel (null hides Cancel all meanwhile).
 */
export function useCancelCounts(
  libraryId: string | null,
  list: { counts: Record<JobState, number> | null; countsScope: string | null },
  narrowed: boolean,
): { counts: Record<JobState, number> | null; reload(): void } {
  // Each answer carries the library it counts: useAsync keeps the last data while a call for a
  // new library is in flight, and those counts must never stand for the new one.
  const all = useAsync(
    async () =>
      narrowed
        ? {
            libraryId,
            counts: (await api.jobs.list({ limit: 1, ...(libraryId ? { libraryId } : {}) })).counts,
          }
        : null,
    [libraryId, narrowed],
  );
  const [changed] = useState(stateChangeTracker);
  useRefetchOn(
    (e) => narrowed && (e.type === 'run.changed' || (e.type === 'job.changed' && changed(e))),
    all.reload,
  );
  // After Cancel all, the narrowed list's reload does not refresh these counts.
  const reload = all.reload;
  if (!narrowed) {
    const counts = list.countsScope === countsScopeOf(libraryId, null) ? list.counts : null;
    return { counts, reload };
  }
  return { counts: all.data && all.data.libraryId === libraryId ? all.data.counts : null, reload };
}
