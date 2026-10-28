import type { JobDetail } from '@transcoda/contract';
import {
  isFinalState,
  type JobState,
  type JsonValue,
  RUN_SUBWORKFLOW_TYPE,
  RUNNING_JOB_STATES,
  type WorkflowGraph,
} from '@transcoda/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'wouter';
import { api, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Dialog } from '../components/Dialog.tsx';
import { Icon } from '../components/Icon.tsx';
import { Loading } from '../components/Loading.tsx';
import { NotFound } from '../components/NotFound.tsx';
import { useToast } from '../components/Toast.tsx';
import { SubworkflowsContext } from '../editor/flow/subworkflows-context.ts';
import { type NodeRef, TraceCanvas } from '../editor/trace/TraceCanvas.tsx';
import {
  type CurrentNode,
  currentNodeOf,
  decisions,
  encodeNode,
  nodeTitle,
  pathKey,
  runTitle,
  type TraceSource,
} from '../editor/trace/traceOverlay.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { useCatalog } from '../hooks/useCatalog.ts';
import { useEvents } from '../hooks/useEvents.ts';
import { useRefetchOn } from '../hooks/useRefetchOn.ts';
import { useWorkflows } from '../hooks/useWorkflows.ts';
import { BeforeAfter } from '../jobs/BeforeAfter.tsx';
import { FfmpegNotes } from '../jobs/FfmpegNotes.tsx';
import { JobPlanSection } from '../jobs/JobPlanSection.tsx';
import { JobResult } from '../jobs/JobResult.tsx';
import { JobStateChip } from '../jobs/JobStateChip.tsx';
import { JobSteps } from '../jobs/JobSteps.tsx';
import {
  activityLine,
  dependsOnSizeText,
  detailLine,
  isWaitingForLane,
  percentOf,
  wouldText,
} from '../jobs/jobText.ts';
import { ProcessAgain } from '../jobs/ProcessAgain.tsx';
import { damagedSideOf, type StepContext } from '../jobs/steps.ts';
import { TestEncodeFile } from '../jobs/TestEncodeFile.tsx';
import { TestOutputPanel } from '../jobs/TestOutputPanel.tsx';
import { useQueue } from '../jobs/useQueue.ts';
import { useNodeParam } from '../jobs/useTryOnFile.ts';
import { usePageTitle } from '../lib/pageTitle.ts';
import { jobTimesLine } from '../lib/time.ts';

type Live = Pick<JobDetail, 'state' | 'paused' | 'progress' | 'lane' | 'problems' | 'reason'>;

function runTarget(settings: JsonValue): { id: string; version: number } | null {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return null;
  const { subworkflowId, version } = settings;
  return typeof subworkflowId === 'string' && typeof version === 'number'
    ? { id: subworkflowId, version }
    : null;
}

interface Subgraphs {
  /** By `pathKey` of the Run node; null when that version cannot be read (NOT_FOUND). */
  graphs: ReadonlyMap<string, WorkflowGraph | null>;
  /** The sub-workflows' names, by the same keys. */
  names: ReadonlyMap<string, string>;
}

/**
 * The sub-workflow graphs (and names) of the Run nodes the file entered, by `pathKey`. Fetched
 * once per Run node with `workflows.get({ id, version })`; nested Run nodes are found once their
 * parent graph is in. NOT_FOUND is final (null); any other failure is asked again on the job's
 * next update.
 */
function useSubgraphs(job: JobDetail | undefined): Subgraphs {
  const [state, setState] = useState<Subgraphs>({ graphs: new Map(), names: new Map() });
  const asked = useRef(new Set<string>());
  const { graphs } = state;
  useEffect(() => {
    if (!job?.graph) return;
    const entered = new Set(job.trace.map((e) => pathKey(e.workflowPath)));
    for (const s of job.path) entered.add(pathKey(s.workflowPath));
    const visit = (graph: WorkflowGraph, path: string[]) => {
      for (const n of graph.nodes) {
        if (n.type !== RUN_SUBWORKFLOW_TYPE) continue;
        const childPath = [...path, n.id];
        const key = pathKey(childPath);
        if (!entered.has(key)) continue;
        const child = graphs.get(key);
        if (child) visit(child, childPath);
        const target = runTarget(n.settings);
        if (child !== undefined || !target || asked.current.has(key)) continue;
        asked.current.add(key);
        api.workflows.get(target).then(
          (w) =>
            setState((s) => ({
              graphs: new Map(s.graphs).set(key, w.graph),
              names: new Map(s.names).set(key, w.name),
            })),
          (err: unknown) => {
            if (describeError(err).code === 'NOT_FOUND') {
              setState((s) => ({ ...s, graphs: new Map(s.graphs).set(key, null) }));
            } else {
              asked.current.delete(key);
            }
          },
        );
      }
    };
    visit(job.graph, []);
  }, [job, graphs]);
  return state;
}

/** A queued job's line: whether it waits for a lane or for the paused queue. */
function QueuedDetail({ job }: { job: JobDetail }) {
  const queue = useQueue();
  return (
    <span className="job-progress-detail">
      {detailLine(job, { queuePaused: queue.status?.paused ?? false })}
    </span>
  );
}

/** While ffmpeg runs, the node that stands for the encode is lit (see `encodeNode`). */
const ENCODE_STATES: readonly JobState[] = ['encoding', 'verifying', 'replacing'];

/**
 * `/jobs/:id`: where a job is now and why it went that way. Keyed by the id, so moving to another
 * job starts from nothing (no live fields, selection, sub-graphs or log of the last one).
 */
export function JobPage() {
  const { id = '' } = useParams<{ id: string }>();
  return <JobView key={id} id={id} />;
}

/**
 * The header (file, where, the node it is at, state chip, progress, Pause/Resume/Cancel), the
 * workflow drawn with the job's trace, full width above what each step does (screen 06b), the
 * result, and the notes from ffmpeg with its command and raw log collapsed below them. Live: a `job.trace` for this job, or a `job.changed` that moves its state, refetches
 * (coalesced); progress and the current node from `job.changed` are applied in place. A failed
 * refetch keeps the last state on screen with a note.
 */
function JobView({ id }: { id: string }) {
  const toast = useToast();
  const { catalog } = useCatalog();
  const { data, error, reload } = useAsync(() => api.jobs.get({ id }), [id]);
  // job.changed fields newer than the last fetch; a new fetch supersedes them.
  const [live, setLive] = useState<{ base: JobDetail; fields: Live } | null>(null);
  const [currentNode, setCurrentNode] = useState<CurrentNode | null | undefined>(undefined);
  const job = useMemo(
    (): JobDetail | undefined => (data && live?.base === data ? { ...data, ...live.fields } : data),
    [data, live],
  );
  usePageTitle(job?.fileName ?? 'Job');
  const shown = useRef(job);
  shown.current = job;

  useRefetchOn(
    (e) =>
      (e.type === 'job.trace' && e.jobId === id) ||
      (e.type === 'job.changed' &&
        e.jobId === id &&
        (e.state !== shown.current?.state || e.paused !== shown.current?.paused)),
    reload,
  );
  useEvents(
    (e) => {
      if (e.type !== 'job.changed' || e.jobId !== id) return;
      setCurrentNode(e.currentNode);
      if (data) {
        const { state, paused, progress, lane, problems, reason } = e;
        setLive({ base: data, fields: { state, paused, progress, lane, problems, reason } });
      }
    },
    [id, data],
  );

  const { graphs: subgraphs, names } = useSubgraphs(data);
  // One list for every Run card's sub-workflow name, at every trace level.
  const { workflows } = useWorkflows();
  // `?node=<id>` ("Try this node" in the editor): that node starts selected and its decision in view.
  const node = useNodeParam();
  const [selected, setSelected] = useState<NodeRef | null>(() =>
    node ? { workflowPath: [], nodeId: node } : null,
  );
  useEffect(() => {
    setSelected(node ? { workflowPath: [], nodeId: node } : null);
  }, [node]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);

  // While ffmpeg runs the engine reports the last built node (often a Run node behind the
  // encode); the node that encodes is lit instead.
  const lit = useMemo(() => {
    // Planned and waiting for a lane: no node is current, the job is between build and encode.
    if (job && isWaitingForLane(job)) return null;
    if (job?.graph && ENCODE_STATES.includes(job.state)) {
      const encoding = encodeNode(job.path, job.graph, subgraphs);
      if (encoding) return encoding;
    }
    return currentNode;
  }, [job, subgraphs, currentNode]);
  // A dry run changed nothing: its write steps read "would replace the original" on the canvas,
  // never as done; one its size gate decides says the replace is conditional (#41).
  const trace = useMemo(() => {
    if (!data?.dryRun) return data?.trace;
    const depends = data.state === 'dry_run' && data.dependsOnSize != null;
    return data.trace.map((e) => ({
      ...e,
      reason: depends ? dependsOnSizeText(e.reason) : wouldText(e.reason),
    }));
  }, [data]);
  const source = useMemo<TraceSource | null>(
    () => (job && trace ? { trace, steps: job.path, jobState: job.state, currentNode: lit } : null),
    [job, trace, lit],
  );
  const settled = job ? isFinalState(job.state) : false;
  // The steps are worded from the trace's structure (steps.ts), so they read the engine's entries.
  const items = useMemo(
    () =>
      data?.graph
        ? decisions(data.trace, data.graph, catalog, subgraphs, data.path, names, settled)
        : [],
    [data, catalog, subgraphs, names, settled],
  );
  const stepContext = useMemo(
    (): StepContext | null =>
      job
        ? {
            dryRun: job.dryRun,
            state: job.state,
            probe: job.probe,
            libraryName: job.libraryName,
            workflowId: job.workflowId,
            dependsOnSize: job.state === 'dry_run' && job.dependsOnSize != null,
            replacedTo: job.result?.replacedTo ?? null,
            sourceDamaged: job.result?.sourceDamaged === true,
            damagedSide: job.graph ? damagedSideOf(job.graph) : new Set(),
          }
        : null,
    [job],
  );

  const select = useCallback((ref: NodeRef | null) => {
    setSelected(ref);
    // A node inside a sub-workflow: open the chain of Run nodes down to it.
    if (ref && ref.workflowPath.length > 0) setExpanded(ref.workflowPath);
  }, []);

  async function control(action: 'pause' | 'resume' | 'cancel') {
    setBusy(true);
    const [err] = await safe(api.jobs[action]({ id }));
    setBusy(false);
    if (err) {
      const failure = describeError(err);
      if (failure.code === 'JOB_NOT_ACTIVE') toast.info('That job already finished');
      else toast.error(failure.message);
    }
    reload();
  }

  if (!job || !source) {
    if (error) {
      const failure = describeError(error);
      if (failure.code === 'NOT_FOUND') {
        return <NotFound what="job" backHref="/jobs" backLabel="Back to jobs" />;
      }
      return (
        <div className="page job-page">
          <div className="panel job-missing" role="alert">
            <p>{failure.message}</p>
            <button type="button" className="btn btn-sm btn-ghost" onClick={reload}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="page job-page">
        <Loading />
      </div>
    );
  }

  const active = !isFinalState(job.state);
  const running = RUNNING_JOB_STATES.includes(job.state);
  const percent = percentOf(job);
  const detail = active && job.state !== 'queued' ? detailLine(job) : null;
  const activity = activityLine(job);
  const at = currentNodeOf(source);
  const atText =
    at && job.graph
      ? `${nodeTitle(at, job.graph, subgraphs, catalog)}${
          at.workflowPath.length > 0
            ? ` in ${runTitle(at.workflowPath, job.graph, subgraphs, catalog, names)}`
            : ''
        }`
      : null;

  return (
    <div className="page job-page">
      {error ? (
        <p className="run-error" role="alert">
          <Icon name="alert" size={16} round />
          {`Could not refresh: ${describeError(error).message} — showing the last state.`}
        </p>
      ) : null}
      {job.problems.length > 0 ? (
        <section className="alert alert-warning problem-banner" role="alert">
          <Icon name="alert" size={16} round />
          <div className="problem-banner-text">
            <b>Finished with a problem</b>
            <ul>
              {job.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
      <header className="job-head">
        <nav aria-label="Breadcrumb" className="job-crumbs">
          <Link href="/jobs" className="job-crumb-link">
            Jobs
          </Link>
          <span aria-hidden="true">/</span>
          <span>{job.fileName}</span>
        </nav>
        <div className="job-head-chips">
          <JobStateChip job={job} />
          {/* The dry-run plan carries this badge itself (screen 06); a dry run without one shows it here. */}
          {job.dryRun && !job.plan && (
            <span className="badge badge-dry">
              <Icon name="eye" size={12} />
              Dry run · Nothing on disk changed
            </span>
          )}
        </div>
        <h1>{job.fileName}</h1>
        <p className="mono job-head-where">
          <Link href="/libraries" className="job-where-link">
            {job.libraryName}
          </Link>
          {' · '}
          <Link
            href={`/workflows/${job.workflowId}?version=${job.workflowVersion}`}
            className="job-where-link"
          >
            {`${job.workflowName} v${job.workflowVersion}`}
          </Link>
          {' · '}
          <Link href={`/runs/${job.runId}`} className="job-where-link">
            Run
          </Link>
        </p>
        <p className="job-head-times">{jobTimesLine(job)}</p>
        {job.encodedOn && (
          <p className="job-head-at">{`${active ? 'Encoding' : 'Encoded'} on ${job.encodedOn}`}</p>
        )}
        {atText && <p className="job-head-at">{`At: ${atText}`}</p>}
        {!active && (
          <ProcessAgain
            job={job}
            summary={workflows?.find((w) => w.id === job.workflowId) ?? null}
          />
        )}
        {active && (
          <div className="job-progress">
            {running && (
              <div
                className="job-progress-bar"
                role="progressbar"
                aria-label="Progress"
                aria-valuemin={0}
                aria-valuemax={100}
                {...(percent !== null && { 'aria-valuenow': percent })}
              >
                <span style={{ width: `${percent ?? 0}%` }} />
              </div>
            )}
            {detail && <span className="job-progress-detail">{detail}</span>}
            {job.state === 'queued' && <QueuedDetail job={job} />}
            <div className="job-progress-actions">
              {job.paused ? (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={busy}
                  onClick={() => void control('resume')}
                >
                  <Icon name="play" size={14} />
                  Resume
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={busy}
                  onClick={() => void control('pause')}
                >
                  <Icon name="pause" size={14} />
                  Pause
                </button>
              )}
              <button
                type="button"
                className="btn btn-sm btn-danger-outline"
                disabled={busy}
                onClick={() => setConfirmCancel(true)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </header>

      <JobPlanSection job={job} />

      <div className="trace-layout">
        <section className="panel trace-panel" aria-label="Workflow trace">
          {job.graph ? (
            <SubworkflowsContext.Provider value={workflows}>
              <TraceCanvas
                graph={job.graph}
                source={source}
                catalog={catalog}
                selected={selected}
                onSelect={select}
                expanded={expanded}
                onExpand={setExpanded}
                subgraphs={subgraphs}
                names={names}
                activity={activity}
                progress={running ? percent : null}
                paused={job.paused}
              />
            </SubworkflowsContext.Provider>
          ) : (
            <p className="trace-child-note">
              The workflow version this job ran can no longer be read.
            </p>
          )}
        </section>
        {stepContext && (
          <JobSteps
            items={items}
            context={stepContext}
            selected={selected}
            onSelect={select}
            reveal={node}
          />
        )}
      </div>

      {(job.result || !active) && (
        <JobResult job={job} testEncodeAction={<TestEncodeFile job={job} />} />
      )}
      {!active && <BeforeAfter job={job} />}
      {job.testEncode && !active && <TestOutputPanel job={job} onChanged={reload} />}
      <FfmpegNotes job={job} />

      <Dialog
        open={confirmCancel}
        title={`Cancel ${job.fileName}?`}
        tone="danger"
        onClose={() => setConfirmCancel(false)}
        footer={
          <>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              data-autofocus
              onClick={() => setConfirmCancel(false)}
            >
              Keep running
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => {
                setConfirmCancel(false);
                void control('cancel');
              }}
            >
              Cancel job
            </button>
          </>
        }
      >
        <p>The original stays untouched.</p>
      </Dialog>
    </div>
  );
}
