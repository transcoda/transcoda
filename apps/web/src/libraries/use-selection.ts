import { useCallback, useMemo, useState } from 'react';

export type Selection = {
  selected: ReadonlySet<string>;
  toggle(id: string): void;
  /** Select (`on`) or deselect every id in `ids`: one page of rows. */
  setPage(ids: string[], on: boolean): void;
  clear(): void;
};

const NONE: ReadonlySet<string> = new Set();

/**
 * The ids of the files ticked on a list. It starts again, empty, whenever `resetKey` changes
 * (another library, show, season or search); sorting and paging do not change it, so a selection
 * can span pages.
 */
export function useSelection(resetKey: string): Selection {
  const [state, setState] = useState<{ key: string; ids: ReadonlySet<string> }>({
    key: resetKey,
    ids: NONE,
  });
  // Another key discards the ids for good, so coming back to an earlier key starts empty.
  if (state.key !== resetKey) setState({ key: resetKey, ids: NONE });
  const selected = state.key === resetKey ? state.ids : NONE;

  const change = useCallback(
    (edit: (ids: Set<string>) => void) =>
      setState((prev) => {
        const ids = new Set(prev.key === resetKey ? prev.ids : NONE);
        edit(ids);
        return { key: resetKey, ids };
      }),
    [resetKey],
  );
  const toggle = useCallback(
    (id: string) =>
      change((ids) => {
        if (!ids.delete(id)) ids.add(id);
      }),
    [change],
  );
  const setPage = useCallback(
    (page: string[], on: boolean) =>
      change((ids) => {
        for (const id of page) {
          if (on) ids.add(id);
          else ids.delete(id);
        }
      }),
    [change],
  );
  const clear = useCallback(() => setState({ key: resetKey, ids: NONE }), [resetKey]);
  return useMemo(() => ({ selected, toggle, setPage, clear }), [selected, toggle, setPage, clear]);
}
