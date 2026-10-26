import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAsync } from './useAsync.ts';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useAsync', () => {
  it('resolves data', async () => {
    const { result } = renderHook(() => useAsync(async () => 42, []));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toBe(42));
    expect(result.current.loading).toBe(false);
  });

  it('exposes errors', async () => {
    const boom = new Error('boom');
    const { result } = renderHook(() =>
      useAsync(async () => {
        throw boom;
      }, []),
    );
    await waitFor(() => expect(result.current.error).toBe(boom));
    expect(result.current.loading).toBe(false);
  });

  it('reload re-runs the function', async () => {
    let n = 0;
    const { result } = renderHook(() => useAsync(async () => ++n, []));
    await waitFor(() => expect(result.current.data).toBe(1));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data).toBe(2));
  });

  it('ignores a result that resolves after a newer call', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const calls = [first, second];
    let i = 0;
    const { result } = renderHook(() => useAsync(() => calls[i++]?.promise ?? first.promise, []));
    act(() => result.current.reload());
    second.resolve('new');
    await waitFor(() => expect(result.current.data).toBe('new'));
    first.resolve('old');
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.data).toBe('new');
  });

  it('keeps the last data when a reload fails, and drops it when the deps change', async () => {
    let fail = false;
    const boom = new Error('boom');
    const { result, rerender } = renderHook(
      ({ id }) =>
        useAsync(async () => {
          if (fail) throw boom;
          return `job ${id}`;
        }, [id]),
      { initialProps: { id: 'a' } },
    );
    await waitFor(() => expect(result.current.data).toBe('job a'));
    fail = true;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error).toBe(boom));
    expect(result.current.data).toBe('job a');
    rerender({ id: 'b' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(boom);
    expect(result.current.data).toBeUndefined();
  });
});
