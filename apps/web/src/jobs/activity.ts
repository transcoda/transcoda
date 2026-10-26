// What the top-bar activity widget says (#9): the collapsed text and accessible name, the ring, and
// each running job's step and progress lines in the popover. Pure functions over the Jobs list rows.
import type { WalkStep } from '@transcoda/contract';
import type { TraceEntry, WorkflowGraph } from '@transcoda/shared';
import {
  type CurrentNode,
  currentNodeOf,
  encodeNode,
  nodeTitle,
  runTitle,
} from '../editor/trace/traceOverlay.ts';
import type { Catalog } from '../hooks/useCatalog.ts';
import { detailLine, fmtTimeLeft, isWaitingForLane, type Job, percentOf } from './jobText.ts';

export interface ActivityInput {
  /** RUNNING_JOB_STATES jobs (probing … replacing, planned jobs waiting for their lane included). */
  running: Job[];
  /**
   * The server's count of jobs in those states (what the Jobs nav badge and the Running chip
   * say); the loaded rows can lag behind it. Defaults to `running.length`.
   */
  runningCount?: number;
  /** `counts.queued`. */
  queued: number;
  /** The queue is paused. */
  paused: boolean;
}

export interface ActivitySummary {
  /** "Encoding 1 · 3 queued", "Running 2", "3 queued", "Paused · 3 queued", "Paused · 1 running · 3 queued" */
  text: string;
  /** The button's accessible name: "Activity: encoding 1 job at 42%, 3 queued. Show details" */
  label: string;
  /** Phone: running + queued. */
  count: number;
  /** Every running job is a dry run (the collapsed "Dry run" badge); false with nothing running. */
  allDryRun: boolean;
  /** Every running job is a test encode (the badge then says "Test encode"). */
  allTestEncode: boolean;
}

const jobs = (n: number) => (n === 1 ? 'job' : 'jobs');

/** null = render nothing: nothing running and nothing queued (paused with an empty queue included). */
export function activitySummary(a: ActivityInput): ActivitySummary | null {
  const n = a.runningCount ?? a.running.length;
  const q = a.queued;
  if (n === 0 && q === 0) return null;
  const allEncoding =
    n > 0 && n === a.running.length && a.running.every((j) => j.state === 'encoding');
  const queuedText = q > 0 ? `${q} queued` : null;

  let text: string[];
  let said: string[];
  if (a.paused) {
    text = ['Paused', n > 0 ? `${n} running` : null, queuedText].filter((x) => x !== null);
    said = ['queue paused', n > 0 ? `${n} ${jobs(n)} running` : null, queuedText].filter(
      (x) => x !== null,
    );
  } else {
    const verb = allEncoding ? 'Encoding' : 'Running';
    const only = n === 1 ? a.running[0] : undefined;
    const pct = allEncoding && only ? percentOf(only) : null;
    const runningSaid =
      n > 0 ? `${verb.toLowerCase()} ${n} ${jobs(n)}${pct !== null ? ` at ${pct}%` : ''}` : null;
    text = [n > 0 ? `${verb} ${n}` : null, queuedText].filter((x) => x !== null);
    said = [runningSaid, queuedText].filter((x) => x !== null);
  }
  return {
    text: text.join(' · '),
    label: `Activity: ${said.join(', ')}. Show details`,
    count: n + q,
    allDryRun: n > 0 && a.running.every((j) => j.dryRun),
    allTestEncode: n > 0 && a.running.every((j) => j.dryRun && j.testEncode === true),
  };
}

export type RingState = { kind: 'determinate'; percent: number } | { kind: 'neutral' };

/** One encoding job with a percent and nothing else running → determinate; else neutral (static full ring). */
export function ringState(running: Job[]): RingState {
  const only = running.length === 1 ? running[0] : undefined;
  const percent = only?.state === 'encoding' ? percentOf(only) : null;
  return percent === null ? { kind: 'neutral' } : { kind: 'determinate', percent };
}

/** What `stepLine` needs of `jobs.get` (a `JobDetail` fits). */
export interface StepSource {
  graph: WorkflowGraph | null;
  path: WalkStep[];
  trace: TraceEntry[];
}

/** The popover knows only the top-level graph (no sub-workflow fetches): sub-workflows stay closed. */
const NO_CHILDREN: ReadonlyMap<string, WorkflowGraph> = new Map();
const NO_NAMES: ReadonlyMap<string, string> = new Map();

/** While ffmpeg runs the engine reports the last built node; the encode node stands for the step. */
const FFMPEG_STATES: ReadonlyArray<Job['state']> = ['encoding', 'verifying', 'replacing'];

/**
 * A running job's step line for the popover: the node title when known (encoding/verifying/replacing →
 * the encode node via `encodeNode`, else `nodeTitle` of the current node; a node inside a sub-workflow →
 * the top-level Run node's title), else the phase words of `detailLine` ("Planned · waiting for the encoder").
 */
export function stepLine(
  job: Job,
  detail: StepSource | null,
  current: CurrentNode | null | undefined,
  catalog: Catalog | null,
): string {
  const phaseWords = job.state === 'encoding' ? 'Encoding' : detailLine(job);
  const graph = detail?.graph;
  if (!detail || !graph || isWaitingForLane(job)) return phaseWords;
  const ref =
    (FFMPEG_STATES.includes(job.state) ? encodeNode(detail.path, graph, NO_CHILDREN) : null) ??
    currentNodeOf({
      trace: detail.trace,
      steps: detail.path,
      jobState: job.state,
      currentNode: current,
    });
  if (!ref) return phaseWords;
  const run = ref.workflowPath[0];
  return run === undefined
    ? nodeTitle(ref, graph, NO_CHILDREN, catalog)
    : runTitle([run], graph, NO_CHILDREN, catalog, NO_NAMES);
}

/** "42% · about 3 min left" ("about": it is ffmpeg's estimate); null without a percent. */
export function progressLine(job: Job): string | null {
  const pct = percentOf(job);
  if (pct === null) return null;
  const eta = job.progress?.etaSeconds;
  return eta === null || eta === undefined ? `${pct}%` : `${pct}% · about ${fmtTimeLeft(eta)} left`;
}
