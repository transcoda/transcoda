import type { JobDetail } from '@transcoda/contract';
import {
  isFinalState,
  type JobState,
  type JsonValue,
  RUN_SUBWORKFLOW_TYPE,
  RUNNING_JOB_STATES,
  type WorkflowGraph,
} from '@transcoda/shared';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'wouter';
import { api, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Dialog } from '../components/Dialog.tsx';
import { Disclosure } from '../components/Disclosure.tsx';
import { Fact } from '../components/Fact.tsx';
import { FilePath } from '../components/FilePath.tsx';
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
  executingNode,
  nodeTitle,
  pathKey,
  runTitle,
  type TraceSource,
} from '../editor/trace/trace-overlay.ts';
import { useAsync } from '../hooks/use-async.ts';
import { useCatalog } from '../hooks/use-catalog.ts';
import { useEvents } from '../hooks/use-events.ts';
import { useRefetchOn } from '../hooks/use-refetch-on.ts';
import { useWorkflows } from '../hooks/use-workflows.ts';
import { BeforeAfter } from '../jobs/BeforeAfter.tsx';
import { FfmpegNotes, RawOutput, useJobLog } from '../jobs/FfmpegNotes.tsx';
import { JobPlanSection } from '../jobs/JobPlanSection.tsx';
import { JobResult } from '../jobs/JobResult.tsx';
import { JobStateChip } from '../jobs/JobStateChip.tsx';
import { JobSteps } from '../jobs/JobSteps.tsx';
import { jobWhenLine } from '../jobs/job-outcome.ts';
import {
  activityLine,
  dependsOnSizeText,
  detailLine,
  isWaitingForLane,
  percentOf,
  verdictOf,
  wouldText,
} from '../jobs/job-text.ts';
import { jobTitle, mediaSub } from '../jobs/media-text.ts';
import { Poster } from '../jobs/Poster.tsx';
import { ProcessAgain } from '../jobs/ProcessAgain.tsx';
import { damagedSideOf, didText, type StepContext, videoConversionOf } from '../jobs/steps.ts';
import { TestEncodeFile } from '../jobs/TestEncodeFile.tsx';
import { TestOutputPanel } from '../jobs/TestOutputPanel.tsx';
import { encodeStopped, useQueue } from '../jobs/use-queue.ts';
import { useNodeParam } from '../jobs/use-try-on-file.ts';
import { usePageTitle } from '../lib/page-title.ts';
import { fmtDate } from '../lib/time.ts';
import { usePhone } from '../lib/use-phone.ts';
import { Crumbs } from '../libraries/Crumbs.tsx';
import { RestoreButton } from '../recycle/RestoreButton.tsx';

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

/** While ffmpeg runs or a finish step writes, the node at work is lit (see `executingNode`). */
const ENCODE_STATES: readonly JobState[] = ['encoding', 'verifying', 'replacing'];

/**
 * `/jobs/:id`: where a job is now and why it went that way. Keyed by the id, so moving to another
 * job starts from nothing (no live fields, selection, sub-graphs or log of the last one).
 */
/** A running job's state chip; a paused queue stills its turning icon. */
function QueueAwareChip({ job }: { job: JobDetail }) {
  const queue = useQueue();
  return <JobStateChip job={job} frozen={encodeStopped(queue.status, job)} />;
}

export function JobPage() {
  const { id = '' } = useParams<{ id: string }>();
  return <JobView key={id} id={id} />;
}

/**
 * On a phone the workflow drawing starts closed under a toggle (the steps list above it says what
 * happened; the drawing is mostly zoom controls at that width); on a wider window it is shown as is.
 */
function PhoneFold({ title, children }: { title: string; children: ReactNode }) {
  const phone = usePhone();
  if (!phone) return <>{children}</>;
  return (
    <Disclosure title={title} className="phone-fold">
      {children}
    </Disclosure>
  );
}

/**
 * One layout for every outcome: the header (crumb, state chip, file name with Process again /
 * Dry run again or Pause / Cancel on the right, one muted meta line, progress while active), the
 * Result right under it (its command, raw error and log collapsed inside), then Before and after,
 * what each step did (screen 06b), notes from ffmpeg when there are any, and the workflow drawn
 * with the job's trace last. Empty sections are not shown. Live: a `job.trace` for this job, or a
 * `job.changed` that moves its state, refetches
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
  usePageTitle(job ? jobTitle(job) : 'Job');
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
  // The ffmpeg log, read once for the notes and the raw output (both follow the job's state).
  const jobLog = useJobLog(id, data?.state ?? null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);

  // While ffmpeg runs the Render is at work, then each finish step: the node a failure or cancel
  // is traced on is the one lit.
  const lit = useMemo(() => {
    // Planned and waiting for a lane: no node is current, the job is between build and encode.
    if (job && isWaitingForLane(job)) return null;
    if (job?.graph && ENCODE_STATES.includes(job.state)) {
      return executingNode(job.state, job.path, job.graph, subgraphs, currentNode);
    }
    return currentNode;
  }, [job, subgraphs, currentNode]);
  // A dry run changed nothing: its write steps read "would replace the original" on the canvas,
  // never as done; one its size gate decides says the replace is conditional (#41). A real run
  // that wrote says it did ("replaced the original"), like its steps.
  const trace = useMemo(() => {
    if (!data?.dryRun) {
      if (data?.state !== 'done') return data?.trace;
      return data.trace.map((e) => ({ ...e, reason: didText(e.reason) }));
    }
    const depends = data.state === 'dry_run' && data.dependsOnSize != null;
    return data.trace.map((e) => ({
      ...e,
      reason: depends ? dependsOnSizeText(e.reason) : wouldText(e.reason),
    }));
  }, [data]);
  const source = useMemo<TraceSource | null>(
    () =>
      job && trace
        ? {
            trace,
            steps: job.path,
            jobState: job.state,
            currentNode: lit,
            nodeProblems: job.result?.nodeProblems ?? [],
          }
        : null,
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
            nodeProblems: job.result?.nodeProblems ?? [],
            videoConversion: videoConversionOf(job.plan),
            damagedSide: job.graph
              ? damagedSideOf(job.graph, (type) => catalog?.byType.get(type)?.kind)
              : new Set(),
          }
        : null,
    [job, catalog],
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

  const sub = mediaSub(job.media);
  const showResult = Boolean(job.result) || !active;
  const failed = job.state === 'failed';
  const raw = (
    <RawOutput job={job} jobLog={jobLog} error={failed ? (job.reason?.trim() ?? null) : null} />
  );

  return (
    <div className="page job-page">
      {error ? (
        <p className="run-error" role="alert">
          <Icon name="alert" size={16} round />
          {`Could not refresh: ${describeError(error).message} — showing the last state.`}
        </p>
      ) : null}
      <header className="job-head">
        <Crumbs
          crumbs={[
            { label: 'Jobs', href: '/jobs' },
            { label: jobTitle(job), href: null },
          ]}
        />
        <div className="job-head-body">
          <Poster job={job} size="page" />
          <div className="job-head-main">
            <div className="job-head-chips">
              {verdictOf(job) === 'running' ? (
                <QueueAwareChip job={job} />
              ) : (
                <JobStateChip job={job} />
              )}
              {/* The dry-run plan carries this badge itself (screen 06); a dry run without one shows it here. */}
              {job.dryRun && !job.plan && (
                <span className="badge badge-dry">
                  <Icon name="eye" size={12} />
                  Dry run · Nothing on disk changed
                </span>
              )}
            </div>
            <div className="head-row job-title-row">
              <div className="job-title-line">
                <h1>{job.media.title}</h1>
                {job.media.kind === 'movie' && job.media.year !== null && (
                  <span className="job-year">{job.media.year}</span>
                )}
              </div>
              <div className="head-actions">
                {!active && job.state === 'done' && job.recycled !== null && (
                  <RestoreButton
                    path={job.recycled.path}
                    fileName={job.fileName}
                    targetPath={job.filePath}
                    direction="restore"
                    onDone={reload}
                  />
                )}
                {!active && job.state === 'done' && job.restore?.outputPath && (
                  <RestoreButton
                    path={job.restore.outputPath}
                    fileName={job.fileName}
                    targetPath={job.filePath}
                    direction="undo"
                    onDone={reload}
                  />
                )}
                {!active && (
                  <ProcessAgain
                    job={job}
                    summary={workflows?.find((w) => w.id === job.workflowId) ?? null}
                    primary={failed}
                  />
                )}
                {active && (
                  <>
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
                  </>
                )}
              </div>
            </div>
            {sub.code || sub.text ? (
              <p className="job-sub">
                {sub.code && <strong>{sub.code}</strong>}
                {sub.code && sub.text ? ' · ' : ''}
                {sub.text}
              </p>
            ) : null}
            <FilePath path={job.filePath} />
            <dl className="job-facts">
              <Fact term="Library">
                <Link href="/libraries" className="link-muted text-target">
                  {job.libraryName}
                </Link>
              </Fact>
              <Fact term="Workflow">
                <Link
                  href={`/workflows/${job.workflowId}?version=${job.workflowVersion}`}
                  className="link-muted text-target"
                >
                  {`${job.workflowName} v${job.workflowVersion}`}
                </Link>
              </Fact>
              <Fact term="Run">
                <Link href={`/runs/${job.runId}`} className="link-muted text-target">
                  Run
                </Link>
              </Fact>
              <Fact term="When">{jobWhenLine(job, !active)}</Fact>
              {job.encodedOn && job.state !== 'queued' && (
                <Fact term={active ? 'Encoding on' : 'Encoded on'}>{job.encodedOn}</Fact>
              )}
              {job.recycled && (
                <Fact term="Original kept until">{fmtDate(job.recycled.keptUntil)}</Fact>
              )}
              {job.restore && (
                <Fact term="Original restored">
                  {`${fmtDate(job.restore.restoredAt)} by ${job.restore.restoredBy}`}
                </Fact>
              )}
            </dl>
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
                {atText && (
                  <span className="job-progress-detail job-head-at">{`At: ${atText}`}</span>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {showResult && (
        <JobResult job={job} testEncodeAction={<TestEncodeFile job={job} />} raw={raw} />
      )}
      <JobPlanSection job={job} />
      {!active && <BeforeAfter job={job} />}
      {job.testEncode && !active && <TestOutputPanel job={job} onChanged={reload} />}
      {stepContext && (
        <JobSteps
          items={items}
          context={stepContext}
          selected={selected}
          onSelect={select}
          reveal={node}
        />
      )}
      <FfmpegNotes job={job} jobLog={jobLog} raw={!showResult} />
      <PhoneFold title="Workflow">
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
      </PhoneFold>

      <Dialog
        open={confirmCancel}
        title={`Cancel ${jobTitle(job)}?`}
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
