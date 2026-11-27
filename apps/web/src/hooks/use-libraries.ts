import type { Library } from '@transcoda/contract';
import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';

/** What the editor needs of a library: the id a workflow stores and the name people read. */
export type LibraryChoice = Pick<Library, 'id' | 'name'>;

type State = { libraries: LibraryChoice[] | null; error: boolean };

// One libraries.list request shared by every consumer (the Library card and its inspector field).
// It lives while at least one consumer is mounted, so the next editor visit reads a fresh list.
let state: State = { libraries: null, error: false };
let started = false;
let consumers = 0;
const listeners = new Set<() => void>();

function load(): void {
  if (started) return;
  started = true;
  api.libraries.list().then(
    (r) => {
      state = { libraries: r.libraries, error: false };
      for (const l of listeners) l();
    },
    () => {
      state = { libraries: null, error: true };
      for (const l of listeners) l();
    },
  );
}

/** Clears the shared list (tests; and when the last consumer unmounts). */
export function resetLibrariesCache(): void {
  state = { libraries: null, error: false };
  started = false;
}

export function useLibraries(): State {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    listeners.add(listener);
    consumers++;
    load();
    return () => {
      listeners.delete(listener);
      if (--consumers === 0) resetLibrariesCache();
    };
  }, []);
  return state;
}
