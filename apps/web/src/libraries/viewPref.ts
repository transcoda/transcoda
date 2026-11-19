// The Library page's view (posters or table), remembered per browser. Storage can be missing or
// throw (private window, blocked site data), so every access is guarded and the page works without.

export type LibraryView = 'posters' | 'table';

export const LIBRARY_VIEW_KEY = 'transcoda.libraryView';

/** `posters` when nothing is stored, the value is unknown or storage throws. */
export function readLibraryView(): LibraryView {
  try {
    return localStorage.getItem(LIBRARY_VIEW_KEY) === 'table' ? 'table' : 'posters';
  } catch {
    return 'posters';
  }
}

export function writeLibraryView(view: LibraryView): void {
  try {
    localStorage.setItem(LIBRARY_VIEW_KEY, view);
  } catch {
    // Not remembered; the choice still holds until the page closes.
  }
}
