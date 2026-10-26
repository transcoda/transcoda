import { act, cleanup, renderHook } from '@testing-library/react';
import type { Issue, WorkflowGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chainMainReplace } from '../../test/fixtures/graphs.ts';
import type { EditorAction } from '../model/editor-state.ts';
import { setLabel } from '../model/graph-ops.ts';

const mocks = vi.hoisted(() => ({ validate: vi.fn() }));
vi.mock('../../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return {
    api: { workflows: { validate: mocks.validate } },
    isDefinedError: orpc.isDefinedError,
    safe: orpc.safe,
  };
});

import { useValidation } from './useValidation.ts';

const issue: Issue = {
  severity: 'error',
  code: 'INPUT_UNCONNECTED',
  message: 'Input file is not connected',
  nodeId: 'keep',
};

/** A new graph each call: the label differs, so every edit is a real change. */
function edit(base: WorkflowGraph, label: string): WorkflowGraph {
  const r = setLabel(base, 'keep', label);
  if (!r.ok) throw new Error(r.refusal.reason);
  return r.graph;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(enabled = true) {
  const dispatch = vi.fn<(a: EditorAction) => void>();
  const first = chainMainReplace();
  const hook = renderHook(
    ({ draft, on }: { draft: WorkflowGraph; on: boolean }) =>
      useValidation({ id: 'wf1', draft, enabled: on, dispatch }),
    { initialProps: { draft: first, on: enabled } },
  );
  const rerender = (draft: WorkflowGraph, on = enabled) => hook.rerender({ draft, on });
  return { dispatch, first, rerender };
}

const types = (dispatch: ReturnType<typeof setup>['dispatch']) =>
  dispatch.mock.calls.map(([a]) => a.type);

beforeEach(() => {
  vi.useFakeTimers();
  mocks.validate.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useValidation', () => {
  it('validates 400 ms after the last change, once for three quick edits, and ignores a late response', async () => {
    const { dispatch, first, rerender } = setup();
    // Loading is not an edit: the server's issues came with the graph.
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(mocks.validate).not.toHaveBeenCalled();

    const slow = deferred<{ issues: Issue[]; valid: boolean }>();
    mocks.validate.mockReturnValueOnce(slow.promise);
    const a = edit(first, 'A');
    const b = edit(first, 'B');
    const c = edit(first, 'C');
    rerender(a);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    rerender(b);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    rerender(c);
    await act(async () => vi.advanceTimersByTimeAsync(399));
    expect(mocks.validate).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.validate).toHaveBeenCalledTimes(1);
    expect(mocks.validate).toHaveBeenCalledWith({ graph: c, id: 'wf1' });
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'validating', seq: 1 });

    // An edit while the request is in flight: no second request until the first returns.
    const d = edit(first, 'D');
    mocks.validate.mockResolvedValueOnce({ issues: [], valid: true });
    rerender(d);
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(mocks.validate).toHaveBeenCalledTimes(1);

    // The first response is late (the draft moved on): it is dropped, and D is sent next.
    await act(async () => slow.resolve({ issues: [issue], valid: false }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(dispatch.mock.calls.some(([x]) => x.type === 'validated' && x.seq === 1)).toBe(false);
    expect(mocks.validate).toHaveBeenCalledTimes(2);
    expect(mocks.validate).toHaveBeenLastCalledWith({ graph: d, id: 'wf1' });
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'validated', seq: 2, issues: [] });
  });

  it('a failed call leaves the issues as they were', async () => {
    const { dispatch, first, rerender } = setup();
    mocks.validate.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    rerender(edit(first, 'A'));
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(types(dispatch)).toEqual(['validating', 'validateFailed']);
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'validateFailed', seq: 1 });
  });

  it('does not validate the draft that arrives with the load', async () => {
    const { dispatch, first, rerender } = setup(false);
    // The page passes an empty placeholder until the workflow loads, then editing turns on.
    rerender(edit(first, 'Loaded'), true);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does nothing while disabled (read-only)', async () => {
    const { dispatch, first, rerender } = setup(false);
    rerender(edit(first, 'A'), false);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
