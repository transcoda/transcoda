import { useEffect, useRef } from 'react';
import { type EngineEvent, useEvents, useOnReconnect } from './useEvents.ts';

/** At most one reload per this many ms for one resource. */
export const REFETCH_COALESCE_MS = 1000;

/**
 * Calls `reload` when a matching event arrives and after every reconnect or resync, coalesced to
 * at most one call per second: the first trigger reloads at once, later ones inside the window
 * collapse into one trailing reload at its end.
 */
export function useRefetchOn(filter: (e: EngineEvent) => boolean, reload: () => void): void {
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const last = useRef(Number.NEGATIVE_INFINITY);
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null);

  const trigger = useRef(() => {
    if (trailing.current) return;
    const wait = last.current + REFETCH_COALESCE_MS - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      reloadRef.current();
      return;
    }
    trailing.current = setTimeout(() => {
      trailing.current = null;
      last.current = Date.now();
      reloadRef.current();
    }, wait);
  }).current;

  useEffect(
    () => () => {
      if (trailing.current) clearTimeout(trailing.current);
      trailing.current = null;
    },
    [],
  );
  useEvents((e) => {
    if (filterRef.current(e)) trigger();
  }, []);
  useOnReconnect(trigger);
}
