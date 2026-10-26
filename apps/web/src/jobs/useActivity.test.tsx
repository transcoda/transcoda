import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { EngineEvent, Job } from '@transcoda/contract';
import { JOB_STATES, type JobState } from '@transcoda/shared';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queue: { status: vi.fn() },
  jobs: { list: vi.fn(), get: vi.fn() },
  events: { subscribe: vi.fn() },
}));
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { EventsProvider } from '../hooks/useEvents.ts';
import { fakeEventSource, queueSnapshot } from '../test/fakeEventStream.ts';
import { fx, job } from '../test/fixtures/jobs.ts';
import { runningJobDetail } from '../test/fixtures/trace.ts';
import { useActivity } from './useActivity.ts';

let fake: ReturnType<typeof fakeEventSource>;
const idle = { encode: null, quick: null };

function counts(over: Partial<Record<JobState, number>>): Record<JobState, number> {
  return { ...Object.fromEntries(JOB_STATES.map((s) => [s, 0])), ...over } as Record<
    JobState,
    number
  >;
}

const A = job({ ...fx.running, id: 'a' });
const B = job({ ...fx.verifying, id: 'b' });

function serve(jobs: Job[], queued: number) {
  mocks.jobs.list.mockResolvedValue({
    jobs,
    counts: counts({ queued, encoding: jobs.length }),
    problemCount: 0,
  });
}

function changed(j: Job, over: Partial<Extract<EngineEvent, { type: 'job.changed' }>> = {}) {
  return {
    type: 'job.changed' as const,
    jobId: j.id,
    runId: j.runId,
    libraryId: j.libraryId,
    workflowId: j.workflowId,
    state: j.state,
    paused: false,
    progress: j.progress,
    lane: j.lane,
    currentNode: null,
    problems: [],
    reason: null,
    ...over,
  };
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <EventsProvider>{children}</EventsProvider>
);

/** Renders the hook and waits until the stream is up and the first answers are in. */
async function mount(detailsFor: readonly string[] = []) {
  const hook = renderHook(
    (props: { ids: readonly string[] }) => useActivity({ detailsFor: props.ids }),
    {
      wrapper,
      initialProps: { ids: detailsFor },
    },
  );
  await waitFor(() => expect(fake.streams.length).toBe(1));
  await act(async () => fake.last().push(queueSnapshot));
  await waitFor(() => expect(hook.result.current.summary).not.toBeNull());
  return hook;
}

beforeEach(() => {
  fake = fakeEventSource();
  mocks.events.subscribe.mockReset().mockImplementation(fake.subscribe);
  mocks.queue.status.mockReset().mockResolvedValue({ paused: false, lanes: idle, preparing: [] });
  mocks.jobs.list.mockReset();
  mocks.jobs.get
    .mockReset()
    .mockImplementation(({ id }: { id: string }) =>
      Promise.resolve(runningJobDetail({ id, state: 'encoding' })),
    );
});
afterEach(() => cleanup());

describe('useActivity', () => {
  it('follows a progress tick without asking for the list again', async () => {
    serve([A], 3);
    const hook = await mount();
    expect(hook.result.current.summary?.text).toBe('Encoding 1 · 3 queued');
    expect(hook.result.current.ring).toEqual({ kind: 'determinate', percent: 42 });
    const lists = mocks.jobs.list.mock.calls.length;

    const progress = { ...(A.progress ?? {}), percent: 60.2 } as Job['progress'];
    await act(async () => fake.last().push(changed(A, { progress })));
    await waitFor(() =>
      expect(hook.result.current.ring).toEqual({ kind: 'determinate', percent: 60 }),
    );
    expect(mocks.jobs.list.mock.calls.length).toBe(lists);
    expect(mocks.jobs.get).not.toHaveBeenCalled();
  });

  it('keeps the node each job.changed reports', async () => {
    serve([A], 0);
    const hook = await mount();
    const at = { workflowPath: ['run-b'], nodeId: 'rt' };
    await act(async () => fake.last().push(changed(A, { currentNode: at })));
    await waitFor(() => expect(hook.result.current.current.get('a')).toEqual(at));
  });

  it('asks jobs.get only for the jobs it is given, once per job', async () => {
    serve([A, B], 0);
    const hook = await mount();
    expect(mocks.jobs.get).not.toHaveBeenCalled();

    hook.rerender({ ids: ['a'] });
    await waitFor(() => expect(hook.result.current.details.get('a')?.id).toBe('a'));
    expect(mocks.jobs.get).toHaveBeenCalledTimes(1);
    expect(mocks.jobs.get).toHaveBeenCalledWith({ id: 'a' });

    // Progress ticks and re-renders ask for nothing new.
    await act(async () => fake.last().push(changed(A, { progress: A.progress })));
    hook.rerender({ ids: ['a'] });
    hook.rerender({ ids: ['a', 'b'] });
    await waitFor(() => expect(hook.result.current.details.get('b')?.id).toBe('b'));
    expect(mocks.jobs.get).toHaveBeenCalledTimes(2);

    // Closed and opened again: the answers are kept.
    hook.rerender({ ids: [] });
    hook.rerender({ ids: ['a', 'b'] });
    await act(async () => {});
    expect(mocks.jobs.get).toHaveBeenCalledTimes(2);
  });

  it('asks again once when a job it shows moves to another phase', async () => {
    serve([A], 0);
    const hook = await mount(['a']);
    await waitFor(() => expect(mocks.jobs.get).toHaveBeenCalledTimes(1));
    await act(async () => fake.last().push(changed(A, { state: 'verifying', progress: null })));
    await waitFor(() => expect(mocks.jobs.get).toHaveBeenCalledTimes(2));
    await act(async () => fake.last().push(changed(A, { state: 'verifying', progress: null })));
    await act(async () => {});
    expect(mocks.jobs.get).toHaveBeenCalledTimes(2);
    expect(hook.result.current.running.map((j) => j.state)).toEqual(['verifying']);
  });

  it('flips to paused on queue.changed', async () => {
    serve([], 3);
    const hook = await mount();
    expect(hook.result.current.summary?.text).toBe('3 queued');
    await act(async () =>
      fake.last().push({ type: 'queue.changed', paused: true, lanes: idle, encodeSlots: [] }),
    );
    await waitFor(() => expect(hook.result.current.summary?.text).toBe('Paused · 3 queued'));
  });
});
