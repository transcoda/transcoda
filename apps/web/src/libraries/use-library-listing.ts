import type {
  EngineEvent,
  LibraryFilesInput,
  LibraryFilesOutput,
  LibrarySeasonsOutput,
  LibraryTitle,
} from '@transcoda/contract';
import { isFinalState } from '@transcoda/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import { useAsync } from '../hooks/use-async.ts';
import { useRefetchOn } from '../hooks/use-refetch-on.ts';
import { titleKey } from './TitleGrid.tsx';

type AsyncState<T> = ReturnType<typeof useAsync<T>>;
type JobChanged = Extract<EngineEvent, { type: 'job.changed' }>;

/**
 * True when a job's state or paused flag differs from the last one seen (or the job is new): a row
 * shows both, while progress ticks are not news for a listing. Final jobs are forgotten.
 */
function rowChangeTracker(): (e: JobChanged) => boolean {
  const last = new Map<string, string>();
  return (e) => {
    const now = `${e.state}|${e.paused}`;
    const changed = last.get(e.jobId) !== now;
    if (isFinalState(e.state)) last.delete(e.jobId);
    else last.set(e.jobId, now);
    return changed;
  };
}

/**
 * A job of this library changed state or was paused or resumed (progress ticks are not news for a
 * listing), the library changed with no job change (the media pass filled titles and posters), or
 * any run changed (a run's files appear and go as it plans). Stateful: make one per listing and
 * keep it.
 */
export function libraryEvent(libraryId: string): (e: EngineEvent) => boolean {
  const changed = rowChangeTracker();
  return (e) =>
    (e.type === 'job.changed' && e.libraryId === libraryId && changed(e)) ||
    (e.type === 'library.changed' && e.libraryId === libraryId) ||
    e.type === 'run.changed';
}

/** Calls `reload` on the library's events ({@link libraryEvent}), one filter per library id. */
export function useLibraryRefetch(libraryId: string, reload: () => void): void {
  const filter = useMemo(() => libraryEvent(libraryId), [libraryId]);
  useRefetchOn(filter, reload);
}

/**
 * `base`, then each title of `next` it does not have yet: offset paging over a list that changes
 * underneath can repeat a card that moved onto the next page, and it is shown once.
 */
function appendNew(base: LibraryTitle[], next: LibraryTitle[]): LibraryTitle[] {
  const seen = new Set(base.map(titleKey));
  const out = [...base];
  for (const t of next) {
    const k = titleKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

export interface TitlePages {
  /** Every title of the pages loaded so far; undefined until the first page arrives. */
  items: LibraryTitle[] | undefined;
  total: number | undefined;
  /** There are titles past the loaded pages. */
  hasMore: boolean;
  /** The next page is loading ("Show more"). */
  loadingMore: boolean;
  /** The first page or the next one failed; a failed refresh keeps the cards and says nothing. */
  error: unknown;
  /** Appends the next page: the pages already shown are not asked for again. */
  more(): void;
  /** Asks for every loaded page again (a live refresh, or "Try again" on the first page). */
  reload(): void;
}

type PagesState = Pick<TitlePages, 'items' | 'total' | 'loadingMore' | 'error'> & {
  /** How many pages `items` holds. */
  pages: number;
};
const NO_PAGES: PagesState = {
  items: undefined,
  total: undefined,
  loadingMore: false,
  error: undefined,
  pages: 0,
};

/**
 * The library's shows and movies, `pageSize` at a time: `more()` appends the next page, and the
 * library's job and run events reload every loaded page, so cards shown before the last "Show
 * more" stay live too. The newest request wins.
 */
export function useLibraryTitlePages(id: string, search: string, pageSize: number): TitlePages {
  const [state, setState] = useState<PagesState>(NO_PAGES);
  const shown = useRef(0);
  const latest = useRef(0);
  const busy = useRef(false);
  const query = useRef({ id, search, pageSize });
  query.current = { id, search, pageSize };

  /** Loads pages `from`..`to - 1` and puts them after the first `from` shown pages. */
  const load = useCallback((from: number, to: number) => {
    const call = ++latest.current;
    busy.current = true;
    const q = query.current;
    const adds = to > shown.current;
    if (adds) setState((s) => ({ ...s, loadingMore: true, error: undefined }));
    const offsets = Array.from({ length: to - from }, (_, i) => (from + i) * q.pageSize);
    Promise.all(
      offsets.map((offset) =>
        api.libraries.titles({
          id: q.id,
          ...(q.search ? { search: q.search } : {}),
          limit: q.pageSize,
          offset,
        }),
      ),
    ).then(
      (outs) => {
        if (latest.current !== call) return;
        busy.current = false;
        shown.current = to;
        const fresh = outs.flatMap((o) => o.items);
        setState((s) => ({
          items: appendNew(from === 0 ? [] : (s.items ?? []), fresh),
          total: outs[outs.length - 1]?.total ?? s.total,
          loadingMore: false,
          error: undefined,
          pages: to,
        }));
      },
      (error: unknown) => {
        if (latest.current !== call) return;
        busy.current = false;
        setState((s) => (adds || s.items === undefined ? { ...s, loadingMore: false, error } : s));
      },
    );
  }, []);

  // A refresh while "Show more" loads reloads the pages shown and the one being added.
  const reload = useCallback(
    () => load(0, Math.max(1, shown.current + (busy.current && state.loadingMore ? 1 : 0))),
    [load, state.loadingMore],
  );
  // "Show more" during a refresh reloads the shown pages with the next one, so the refresh is not
  // lost; otherwise it asks for the next page only.
  const more = useCallback(
    () => (busy.current ? load(0, shown.current + 1) : load(shown.current, shown.current + 1)),
    [load],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts from its first page
  useEffect(() => {
    shown.current = 0;
    setState(NO_PAGES);
    load(0, 1);
    return () => {
      latest.current++;
    };
  }, [id, search, pageSize, load]);
  useLibraryRefetch(id, reload);

  return {
    items: state.items,
    total: state.total,
    hasMore: state.total !== undefined && state.pages * pageSize < state.total,
    loadingMore: state.loadingMore,
    error: state.error,
    more,
    reload,
  };
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

/**
 * One page of files, sorted and filtered by the server. `data` is only ever the answer for this
 * exact query: while another page, sort or search loads it is undefined (no rows of the last page
 * under the new page's range), and a refresh of the same query keeps it.
 */
export function useLibraryFiles(
  id: string,
  q: Omit<LibraryFilesInput, 'id'>,
): AsyncState<LibraryFilesOutput> {
  const key = JSON.stringify([
    id,
    q.show,
    q.season,
    q.search,
    q.damaged,
    q.sort,
    q.desc,
    q.offset,
    q.limit,
  ]);
  const state = useAsync(
    async () => ({ key, out: await api.libraries.files({ id, ...q }) }),
    [key],
  );
  useLibraryRefetch(id, state.reload);
  return { ...state, data: state.data?.key === key ? state.data.out : undefined };
}
