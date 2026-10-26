// The top-bar activity widget's data (#9): the queue's paused flag (`useQueue`), the running jobs and
// the queued count from the Jobs page's own list hook (one list, patched by `job.changed`, so a
// progress tick costs no request), the node each job is at, and `jobs.get` details only for the jobs
// the open popover shows. Events only: no timers, no polling.
import type { JobDetail } from '@transcoda/contract';
import { type JobState, RUNNING_JOB_STATES } from '@transcoda/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import type { CurrentNode } from '../editor/trace/traceOverlay.ts';
import { useEvents } from '../hooks/useEvents.ts';
import { activitySummary, ringState } from './activity.ts';
import type { Job } from './jobText.ts';
import { useJobsList } from './useJobsList.ts';
import { useQueue } from './useQueue.ts';

export interface Activity {
  summary: ReturnType<typeof activitySummary>;
  running: Job[];
  /** `counts.queued` (the popover's "3 queued"). */
  queued: number;
  /** The queue is paused (the popover's "Queue paused"). */
  paused: boolean;
  ring: ReturnType<typeof ringState>;
  /** jobs.get answers for `detailsFor` (the popover passes the running ids while open, [] when closed), cached per id. */
  details: ReadonlyMap<string, JobDetail>;
  /** Latest currentNode per job from job.changed. */
  current: ReadonlyMap<string, CurrentNode | null>;
}

const FILTER = { libraryId: null, states: [...RUNNING_JOB_STATES] };

/** A cached answer and the job state it was asked in: a new phase asks once more (a longer trace). */
interface Cached {
  detail: JobDetail;
  state: JobState;
}

const sameNode = (a: CurrentNode | null | undefined, b: CurrentNode | null) =>
  a === b ||
  (a != null &&
    b !== null &&
    a.nodeId === b.nodeId &&
    a.workflowPath.length === b.workflowPath.length &&
    a.workflowPath.every((x, i) => x === b.workflowPath[i]));

export function useActivity(opts: { detailsFor: readonly string[] }): Activity {
  const queue = useQueue();
  const list = useJobsList(FILTER);
  const paused = queue.status?.paused ?? false;
  const queued = list.counts?.queued ?? 0;
  const counts = list.counts;
  const runningCount = counts
    ? RUNNING_JOB_STATES.reduce((n, s) => n + (counts[s] ?? 0), 0)
    : undefined;
  // A job that just left the running states stays on the page until the list reloads.
  const running = useMemo(
    () => list.jobs.filter((j) => RUNNING_JOB_STATES.includes(j.state)),
    [list.jobs],
  );

  const [current, setCurrent] = useState<ReadonlyMap<string, CurrentNode | null>>(new Map());
  useEvents((e) => {
    if (e.type !== 'job.changed') return;
    const active = RUNNING_JOB_STATES.includes(e.state);
    setCurrent((m) => {
      if (!active) {
        if (!m.has(e.jobId)) return m;
        const next = new Map(m);
        next.delete(e.jobId);
        return next;
      }
      if (m.has(e.jobId) && sameNode(m.get(e.jobId), e.currentNode)) return m;
      return new Map(m).set(e.jobId, e.currentNode);
    });
  }, []);

  const [cache, setCache] = useState<ReadonlyMap<string, Cached>>(new Map());
  /** id → the state a request is out for. */
  const asked = useRef(new Map<string, JobState>());
  const stateOf = new Map(running.map((j) => [j.id, j.state] as const));
  const runningKey = running.map((j) => `${j.id}:${j.state}`).join(',');
  const wantedKey = opts.detailsFor.join(',');

  // biome-ignore lint/correctness/useExhaustiveDependencies: the keys stand for `running` and `detailsFor`
  useEffect(() => {
    // Forget the jobs that stopped running.
    for (const id of asked.current.keys()) if (!stateOf.has(id)) asked.current.delete(id);
    setCache((c) => {
      const gone = [...c.keys()].filter((id) => !stateOf.has(id));
      if (gone.length === 0) return c;
      const next = new Map(c);
      for (const id of gone) next.delete(id);
      return next;
    });
    for (const id of opts.detailsFor) {
      const state = stateOf.get(id);
      if (state === undefined || asked.current.get(id) === state) continue;
      asked.current.set(id, state);
      api.jobs.get({ id }).then(
        (detail) => {
          if (asked.current.get(id) !== state) return;
          setCache((c) => new Map(c).set(id, { detail, state }));
        },
        () => {
          // Asked again on the next open or phase change; the step line falls back to phase words.
          if (asked.current.get(id) === state) asked.current.delete(id);
        },
      );
    }
  }, [runningKey, wantedKey]);

  const details = useMemo(() => {
    const out = new Map<string, JobDetail>();
    for (const [id, { detail }] of cache) out.set(id, detail);
    return out;
  }, [cache]);

  return {
    summary: activitySummary({
      running,
      queued,
      paused,
      ...(runningCount !== undefined ? { runningCount } : {}),
    }),
    running,
    queued,
    paused,
    ring: ringState(running),
    details,
    current,
  };
}
