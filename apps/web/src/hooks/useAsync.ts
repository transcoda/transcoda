import { useCallback, useEffect, useRef, useState } from 'react';

const sameDeps = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

/**
 * Runs `fn` on mount, whenever `deps` change and on `reload()`; the newest call wins. A failed
 * `reload()` keeps the last data next to the error (a transient refetch error does not blank the
 * view); a failed call for new `deps` drops the old data, which belongs to other inputs.
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
): { data: T | undefined; error: unknown; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
    data: undefined,
    error: undefined,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  /** The deps of the last data, to tell a reload from a call for other inputs. */
  const dataDeps = useRef<readonly unknown[] | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are caller-supplied
  useEffect(() => {
    const id = ++latest.current;
    const callDeps = deps;
    setState((s) => ({ ...s, loading: true }));
    fnRef.current().then(
      (data) => {
        if (latest.current !== id) return;
        dataDeps.current = callDeps;
        setState({ data, error: undefined, loading: false });
      },
      (error: unknown) => {
        if (latest.current !== id) return;
        const keep = dataDeps.current !== null && sameDeps(dataDeps.current, callDeps);
        setState((s) => ({ data: keep ? s.data : undefined, error, loading: false }));
      },
    );
    return () => {
      // Invalidate in-flight calls on unmount or dependency change.
      latest.current++;
    };
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
