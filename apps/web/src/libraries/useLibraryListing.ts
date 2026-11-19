import type {
  EngineEvent,
  LibraryFilesInput,
  LibraryFilesOutput,
  LibrarySeasonsOutput,
  LibraryTitlesOutput,
} from '@transcoda/contract';
import { api } from '../api/client.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { useRefetchOn } from '../hooks/useRefetchOn.ts';

type AsyncState<T> = ReturnType<typeof useAsync<T>>;

/** A job of this library changed, or any run did (a run's files appear and go as it plans). */
export function libraryEvent(libraryId: string): (e: EngineEvent) => boolean {
  return (e) => (e.type === 'job.changed' && e.libraryId === libraryId) || e.type === 'run.changed';
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
  useRefetchOn(libraryEvent(id), state.reload);
  return state;
}

/** The seasons of one show. */
export function useLibrarySeasons(id: string, show: string): AsyncState<LibrarySeasonsOutput> {
  const state = useAsync(() => api.libraries.seasons({ id, show }), [id, show]);
  useRefetchOn(libraryEvent(id), state.reload);
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
  useRefetchOn(libraryEvent(id), state.reload);
  return state;
}
