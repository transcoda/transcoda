// The live job list: one `jobs.list` page from the top (active jobs first), patched in place by
// `job.changed` events and reloaded (coalesced, ≤ 1/s) when an event means the page or its counts
// are out of date. Reconnects and `resync` reload too (useRefetchOn).
import type { EngineEvent, JobsListInput } from '@transcoda/contract';
import { JOBS_LIST_MAX } from '@transcoda/contract';
import { ACTIVE_JOB_STATES, isFinalState, type JobState } from '@transcoda/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { useEvents } from '../hooks/useEvents.ts';
import { useRefetchOn } from '../hooks/useRefetchOn.ts';
import type { Job } from './jobText.ts';

export interface JobsFilter {
  libraryId: string | null;
  /** null: every state. */
  states: JobState[] | null;
  /** true: only jobs whose result has problems. */
  problems?: boolean;
  /** true: only plan-only dry runs whose size gate decides after encoding. */
  dependsOnSize?: boolean;
}

type JobChanged = Extract<EngineEvent, { type: 'job.changed' }>;

/**
 * A `job.changed` filter that is true when a job's state differs from the last one seen (or the
 * job is new): progress ticks of the same state are not news for counts. Final jobs are forgotten.
 */
export function stateChangeTracker(): (e: JobChanged) => boolean {
  const last = new Map<string, JobState>();
  return (e) => {
    const changed = last.get(e.jobId) !== e.state;
    if (isFinalState(e.state)) last.delete(e.jobId);
    else last.set(e.jobId, e.state);
    return changed;
  };
}

interface ListState {
  jobs: Job[];
  /**
   * The active jobs of the library, when the page's own filter leaves some of them out: the
   * "Paused" chip counts the paused flag, which only active jobs carry.
   */
  active: Job[] | null;
  counts: Record<JobState, number> | null;
  problemCount: number | null;
  dependsOnSizeCount: number | null;
  loading: boolean;
  error: unknown;
}

const coversActive = (states: JobState[] | null) =>
  states === null || ACTIVE_JOB_STATES.every((s) => states.includes(s));

function patchJob(j: Job, e: JobChanged): Job {
  return j.id === e.jobId
    ? {
        ...j,
        state: e.state,
        paused: e.paused,
        progress: e.progress,
        lane: e.lane,
        problems: e.problems,
        reason: e.reason,
      }
    : j;
}

export function useJobsList(filter: JobsFilter): {
  jobs: Job[];
  counts: Record<JobState, number> | null;
  problemCount: number | null;
  dependsOnSizeCount: number | null;
  pausedCount: number;
  loading: boolean;
  error: unknown;
  reload(): void;
} {
  const { libraryId, states } = filter;
  const problems = filter.problems === true;
  const depends = filter.dependsOnSize === true;
  const key = `${libraryId ?? ''}|${states?.join(',') ?? '*'}|${problems ? 'p' : ''}|${depends ? 'd' : ''}`;
  const [state, setState] = useState<ListState>({
    jobs: [],
    active: null,
    counts: null,
    problemCount: null,
    dependsOnSizeCount: null,
    loading: true,
    error: null,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const seq = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the filter
  const load = useCallback(async () => {
    const id = ++seq.current;
    const scope: JobsListInput = { limit: JOBS_LIST_MAX };
    if (libraryId) scope.libraryId = libraryId;
    const withStates: JobsListInput = states ? { ...scope, state: states } : scope;
    const input: JobsListInput = {
      ...withStates,
      ...(problems ? { problems: true } : {}),
      ...(depends ? { dependsOnSize: true } : {}),
    };
    try {
      const [page, active] = await Promise.all([
        api.jobs.list(input),
        coversActive(states)
          ? Promise.resolve(null)
          : api.jobs.list({ ...scope, state: [...ACTIVE_JOB_STATES] }),
      ]);
      if (id !== seq.current) return;
      setState({
        jobs: page.jobs,
        active: active?.jobs ?? null,
        counts: page.counts,
        problemCount: page.problemCount,
        dependsOnSizeCount: page.dependsOnSizeCount ?? null,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (id === seq.current) setState((s) => ({ ...s, loading: false, error }));
    }
  }, [key]);

  useEffect(() => {
    setState((s) => ({ ...s, loading: true }));
    void load();
    return () => {
      seq.current++;
    };
  }, [load]);

  const reload = useCallback(() => void load(), [load]);

  // Apply what a job.changed says to a job on the page (and its counts) without a request.
  useEvents((e) => {
    if (e.type !== 'job.changed') return;
    setState((s) => {
      const old = s.jobs.find((j) => j.id === e.jobId) ?? s.active?.find((j) => j.id === e.jobId);
      if (!old) return s;
      let counts = s.counts;
      if (counts && old.state !== e.state) {
        counts = {
          ...counts,
          [old.state]: Math.max(0, counts[old.state] - 1),
          [e.state]: counts[e.state] + 1,
        };
      }
      return {
        ...s,
        jobs: s.jobs.map((j) => patchJob(j, e)),
        active: s.active?.map((j) => patchJob(j, e)) ?? null,
        counts,
      };
    });
  }, []);

  // When is a reload needed? A job that is new to the page (or one off the page that changed
  // state: counts moved), a job finishing, a job leaving the current filter, and run changes.
  // `queue.changed` (pause, lanes) moves no job between states; the job.changed events that go
  // with a lane change carry the states.
  const unseen = useRef(stateChangeTracker());
  const needsReload = (e: EngineEvent): boolean => {
    if (e.type === 'run.changed') return true;
    if (e.type !== 'job.changed') return false;
    const f = filterRef.current;
    if (f.libraryId && e.libraryId !== f.libraryId) return false;
    const { jobs, active } = stateRef.current;
    const onPage = jobs.find((j) => j.id === e.jobId);
    const known = onPage ?? active?.find((j) => j.id === e.jobId);
    if (!known) return unseen.current(e);
    if (known.state === e.state) return false;
    if (isFinalState(e.state)) return true;
    const fits = f.states === null || f.states.includes(e.state);
    // On the page and leaving the filter, or off the page (active only) and entering it.
    return onPage ? !fits : fits;
  };
  useRefetchOn(needsReload, reload);

  const pausedFrom = state.active ?? state.jobs;
  return {
    jobs: state.jobs,
    counts: state.counts,
    problemCount: state.problemCount,
    dependsOnSizeCount: state.dependsOnSizeCount,
    pausedCount: pausedFrom.filter((j) => j.paused).length,
    loading: state.loading,
    error: state.error,
    reload,
  };
}

/**
 * Jobs with problems (`jobs.list({ limit: 1, problems: true }).problemCount`), for the "Needs
 * attention" tile; reloaded when a job changes state or a run changes.
 */
export function useProblemCount(): number | null {
  const { data, reload } = useAsync(
    async () => (await api.jobs.list({ limit: 1, problems: true })).problemCount,
    [],
  );
  const changed = useRef(stateChangeTracker());
  useRefetchOn(
    (e) => e.type === 'run.changed' || (e.type === 'job.changed' && changed.current(e)),
    reload,
  );
  return data ?? null;
}

/** Jobs per state for the nav pill (`jobs.list` with the smallest page; only `counts` is read). */
export function useJobsCounts(): Record<JobState, number> | null {
  const { data, reload } = useAsync(async () => (await api.jobs.list({ limit: 1 })).counts, []);
  const changed = useRef(stateChangeTracker());
  useRefetchOn(
    (e) => e.type === 'run.changed' || (e.type === 'job.changed' && changed.current(e)),
    reload,
  );
  return data ?? null;
}
