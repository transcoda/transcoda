import type {
  EngineEvent,
  LibraryFilesInput,
  LibraryFilesOutput,
  LibrarySeasonsOutput,
  LibraryTitlesOutput,
} from '@transcoda/contract';
import { useMemo } from 'react';
import { api } from '../api/client.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { useRefetchOn } from '../hooks/useRefetchOn.ts';
import { stateChangeTracker } from '../jobs/useJobsList.ts';

type AsyncState<T> = ReturnType<typeof useAsync<T>>;

/**
 * A job of this library changed state (progress ticks of the same state are not news for a
 * listing), or any run changed (a run's files appear and go as it plans). Stateful: make one per
 * listing and keep it.
 */
export function libraryEvent(libraryId: string): (e: EngineEvent) => boolean {
  const changed = stateChangeTracker();
  return (e) =>
    (e.type === 'job.changed' && e.libraryId === libraryId && changed(e)) ||
    e.type === 'run.changed';
}

/** Calls `reload` on the library's events ({@link libraryEvent}), one filter per library id. */
export function useLibraryRefetch(libraryId: string, reload: () => void): void {
  const filter = useMemo(() => libraryEvent(libraryId), [libraryId]);
  useRefetchOn(filter, reload);
}

/** One page of the library's shows and movies; reloads on the library's job and run events. */
export function useLibraryTitles(
  id: string,
  q: { search: string; limit: number; offset: number },
): AsyncState<LibraryTitlesOutput> {
  const state = useAsync(
    () =>
      api.libraries.titles({
        id,
        ...(q.search ? { search: q.search } : {}),
        limit: q.limit,
        offset: q.offset,
      }),
    [id, q.search, q.limit, q.offset],
  );
  useLibraryRefetch(id, state.reload);
  return state;
}

/** The seasons of one show; nothing is asked (and `data` stays undefined) without a show. */
export function useLibrarySeasons(
  id: string,
  show: string | undefined,
): AsyncState<LibrarySeasonsOutput | null> {
  const state = useAsync(
    () => (show === undefined ? Promise.resolve(null) : api.libraries.seasons({ id, show })),
    [id, show],
  );
  useLibraryRefetch(id, state.reload);
  return state;
}

/** One page of files, sorted and filtered by the server. */
export function useLibraryFiles(
  id: string,
  q: Omit<LibraryFilesInput, 'id'>,
): AsyncState<LibraryFilesOutput> {
  const state = useAsync(
    () => api.libraries.files({ id, ...q }),
    [id, q.show, q.season, q.search, q.sort, q.desc, q.offset, q.limit],
  );
  useLibraryRefetch(id, state.reload);
  return state;
}
