import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { type NavTarget, setBeforeNavigate } from '../../lib/navigation.tsx';

/**
 * Holds in-app navigation away from a dirty draft: while `dirty`, a `GuardedLink` /
 * `useGuardedNavigate` target (other than the route already shown) or a `guardedRun` action (log
 * out) lands in `pending` and the page shows the leave dialog. "Leave" continues it (navigates or
 * runs the action); "Save and leave" continues it once `save()` answers true (false keeps the
 * dialog — the page shows why, or closes it itself); "Stay" drops it.
 * While dirty, the browser's Back/Forward asks too: wouter has no history blocker, so a
 * `popstate` puts the editor's URL back (a new history entry) and holds the route Back/Forward
 * went to, which "Leave" then navigates to. Reloading or closing the tab asks via `beforeunload`.
 */
export function useLeaveGuard({ dirty, save }: { dirty: boolean; save(): Promise<boolean> }): {
  pending: NavTarget | null;
  confirmLeave(): void;
  cancelLeave(): void;
  saveAndLeave(): Promise<void>;
} {
  const [pending, setPending] = useState<NavTarget | null>(null);
  const [location, navigate] = useLocation();
  const search = useSearch();
  const here = search ? `${location}?${search}` : location;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!dirty) return;
    return setBeforeNavigate((target) => {
      if ('to' in target && target.to === here) return true;
      setPending(target);
      return false;
    });
  }, [dirty, here]);

  useEffect(() => {
    if (!dirty) return;
    const onPopState = () => {
      const to = `${window.location.pathname}${window.location.search}`;
      if (to === here) return;
      window.history.pushState(null, '', here);
      setPending({ to });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [dirty, here]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers show the prompt only when returnValue is set.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const proceed = useCallback(
    (target: NavTarget) => {
      if ('to' in target) navigate(target.to);
      else target.run();
    },
    [navigate],
  );

  const confirmLeave = useCallback(() => {
    const target = pendingRef.current;
    setPending(null);
    if (target !== null) proceed(target);
  }, [proceed]);

  const cancelLeave = useCallback(() => setPending(null), []);

  const saveAndLeave = useCallback(async () => {
    const target = pendingRef.current;
    if (target === null) return;
    const ok = await save();
    // Stayed (or left) meanwhile: the save stands, the navigation does not.
    if (!ok || !alive.current || pendingRef.current !== target) return;
    setPending(null);
    proceed(target);
  }, [save, proceed]);

  return { pending, confirmLeave, cancelLeave, saveAndLeave };
}
