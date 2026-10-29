// Jobs (screens 07, 08): the live job list with filters, per-job pause/resume/cancel and the
// whole-queue controls (pause, cancel all); below 640 px the phone layout of screen 08. One header
// row (title, lanes line, queue actions), today's tiles, four half-height history cards, then the
// list: the list stays above the fold.
import { CANCELLABLE_JOB_STATES, isFinalState, type JobState } from '@transcoda/shared';
import { useState } from 'react';
import { Link } from 'wouter';
import { api, isDefinedError, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Dialog } from '../components/Dialog.tsx';
import { SectionHeading } from '../components/Headings.tsx';
import { Icon } from '../components/Icon.tsx';
import { ListboxSelect } from '../components/ListboxSelect.tsx';
import { LiveDot } from '../components/LiveDot.tsx';
import { Loading } from '../components/Loading.tsx';
import { StatTile } from '../components/StatTile.tsx';
import { useToast } from '../components/Toast.tsx';
import { useAsync } from '../hooks/useAsync.ts';
import { useRefetchOn } from '../hooks/useRefetchOn.ts';
import { JobProgress } from '../jobs/JobProgress.tsx';
import { JobStateChip, VERDICT_ICON } from '../jobs/JobStateChip.tsx';
import {
  detailLine,
  FILTERS,
  type Job,
  percentOf,
  phoneLine,
  phoneRunningLine,
  QUEUED_VERSION_NOTE,
  verdictOf,
  versionText,
  whereLine,
  wherePrefix,
} from '../jobs/jobText.ts';
import { QueueLanes, QueuePausedNote, QueueToggle } from '../jobs/QueueBar.tsx';
import { stateChangeTracker, useJobsList, useProblemCount } from '../jobs/useJobsList.ts';
import { useQueue } from '../jobs/useQueue.ts';
import { fmtBytes } from '../lib/bytes.ts';
import { usePageTitle } from '../lib/pageTitle.ts';
import { fmtFull, fmtStamp, jobLastTime } from '../lib/time.ts';
import { usePhone } from '../lib/usePhone.ts';
import { AllTimeTile, JobsHistory, useJobsHistory } from './jobs-history.tsx';

const num = new Intl.NumberFormat('en-US');

/**
 * Today's totals, "today" being the server's local day (as the history's last bar); refetched
 * (coalesced) when a job changes state or a run changes.
 */
function useTodayStats() {
  const stats = useAsync(() => api.jobs.stats({}), []);
  const [changed] = useState(stateChangeTracker);
  useRefetchOn(
    (e) => e.type === 'run.changed' || (e.type === 'job.changed' && changed(e)),
    stats.reload,
  );
  return stats.data;
}

const isActive = (j: Job) => !isFinalState(j.state);

/** Pause / Resume / Cancel (with its confirmation) for one job. */
function useJobControls(reload: () => void) {
  const toast = useToast();
  const [cancelling, setCancelling] = useState<Job | null>(null);

  async function run(kind: 'pause' | 'resume' | 'cancel', job: Job) {
    const call = { pause: api.jobs.pause, resume: api.jobs.resume, cancel: api.jobs.cancel }[kind];
    const [err] = await safe(call({ id: job.id }));
    if (isDefinedError(err) && err.code === 'JOB_NOT_ACTIVE') {
      toast.info('That job already finished');
    } else if (err) {
      toast.error(`Couldn't ${kind} ${job.fileName}`);
      return;
    }
    // The event stream brings the change; a reload also covers a stream that is reconnecting.
    reload();
  }

  const dialog = (
    <Dialog
      open={cancelling !== null}
      title={`Cancel ${cancelling?.fileName ?? ''}?`}
      tone="danger"
      onClose={() => setCancelling(null)}
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost"
            data-autofocus
            onClick={() => setCancelling(null)}
          >
            Keep running
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              const job = cancelling;
              setCancelling(null);
              if (job) void run('cancel', job);
            }}
          >
            Cancel job
          </button>
        </>
      }
    >
      <p>The original stays untouched.</p>
    </Dialog>
  );

  return {
    pause: (job: Job) => void run('pause', job),
    resume: (job: Job) => void run('resume', job),
    askCancel: (job: Job) => setCancelling(job),
    dialog,
  };
}

type Controls = ReturnType<typeof useJobControls>;

/** "Pause" alone is ambiguous in a list of rows: the accessible name adds the file. */
const named = (word: string, job: Job) => `${word} ${job.fileName}`;

function JobActions({ job, controls, block }: { job: Job; controls: Controls; block?: boolean }) {
  const cls = block ? 'btn btn-ghost btn-sm btn-block' : 'btn btn-ghost btn-sm';
  return (
    <>
      <button
        type="button"
        className={cls}
        aria-label={named(job.paused ? 'Resume' : 'Pause', job)}
        onClick={() => (job.paused ? controls.resume(job) : controls.pause(job))}
      >
        {job.paused ? 'Resume' : 'Pause'}
      </button>
      <button
        type="button"
        className={cls}
        aria-label={named('Cancel', job)}
        onClick={() => controls.askCancel(job)}
      >
        Cancel
      </button>
    </>
  );
}

/**
 * "Retry failed": every failed job back in the queue, one more attempt each, on the workflow
 * version active when it starts (after a fix or a new build). Shown while any job has failed.
 */
function RetryFailed({ failed, onDone }: { failed: number; onDone(): void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (failed === 0) return null;
  async function retry() {
    setBusy(true);
    const [err, out] = await safe(api.jobs.retryFailed());
    setBusy(false);
    if (err || !out) {
      toast.error(`Could not retry the failed jobs: ${describeError(err).message}`);
      return;
    }
    toast.success(
      out.retried === 0
        ? 'Nothing to retry: each failed file has a newer job'
        : `Queued ${out.retried} failed ${out.retried === 1 ? 'job' : 'jobs'} again`,
    );
    onDone();
  }
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      aria-busy={busy}
      disabled={busy}
      onClick={() => void retry()}
    >
      <Icon name="refresh" size={14} />
      Retry failed
    </button>
  );
}

const jobsWord = (n: number) => `${num.format(n)} ${n === 1 ? 'job' : 'jobs'}`;

/** The toast after "Cancel all", and its tone: an error when any cancel failed. */
function cancelAllResult(out: { cancelled: number; writing: number; failed: number }): {
  tone: 'success' | 'info' | 'error';
  text: string;
} {
  const parts: string[] = [];
  if (out.cancelled > 0) parts.push(`Cancelled ${jobsWord(out.cancelled)}`);
  else if (out.writing > 0 || out.failed > 0) parts.push('Nothing was cancelled');
  if (out.writing > 0) {
    parts.push(`${jobsWord(out.writing)} already replacing their file will finish`);
  }
  if (out.failed > 0) parts.push(`${jobsWord(out.failed)} could not be cancelled`);
  if (parts.length === 0)
    return { tone: 'info', text: 'Nothing to cancel: those jobs already finished' };
  const tone = out.failed > 0 ? 'error' : out.cancelled > 0 ? 'success' : 'info';
  return { tone, text: parts.join('. ') };
}

/**
 * "Cancel all": every queued, running and paused job of the library filter, or of every library,
 * after a confirmation. A job already replacing its file is left to finish (the server's rule; the
 * count leaves `replacing` out too). The status chips do not narrow it; the dialog says so when
 * one is on. Shown while any job in that scope can be cancelled (`counts` covers the library
 * scope only).
 */
function CancelAll({
  counts,
  libraryId,
  libraryName,
  statusFiltered,
  onDone,
}: {
  counts: Record<JobState, number> | null;
  libraryId: string | null;
  libraryName: string | null;
  statusFiltered: boolean;
  onDone(): void;
}) {
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const count = counts ? CANCELLABLE_JOB_STATES.reduce((sum, st) => sum + (counts[st] ?? 0), 0) : 0;
  if (count === 0 && !asking) return null;

  async function cancelAll() {
    setAsking(false);
    setBusy(true);
    const [err, out] = await safe(api.jobs.cancelAll(libraryId ? { libraryId } : {}));
    setBusy(false);
    if (err || !out) {
      toast.error(`Couldn't cancel the jobs: ${describeError(err).message}`);
      return;
    }
    const { tone, text } = cancelAllResult(out);
    toast[tone](text);
    // The event stream brings the change; a reload also covers a stream that is reconnecting.
    onDone();
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-busy={busy}
        disabled={busy}
        onClick={() => setAsking(true)}
      >
        Cancel all
      </button>
      <Dialog
        open={asking}
        title={`Cancel ${jobsWord(count)}?`}
        tone="danger"
        onClose={() => setAsking(false)}
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost"
              data-autofocus
              onClick={() => setAsking(false)}
            >
              Keep running
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void cancelAll()}>
              {`Cancel ${jobsWord(count)}`}
            </button>
          </>
        }
      >
        <p>
          {`Every queued, running and paused job ${libraryId ? `in ${libraryName ?? 'this library'}` : 'in every library'} is cancelled.`}
          {statusFiltered ? ' The status filter does not limit this.' : null}
        </p>
        <p>
          Running encodes stop now and their partial output is deleted. Their originals stay
          untouched. Jobs already replacing their file finish.
        </p>
      </Dialog>
    </>
  );
}

function JobRow({
  job,
  controls,
  queuePaused,
  withActions,
}: {
  job: Job;
  controls: Controls;
  queuePaused: boolean;
  /** The list has a column for Pause / Cancel (some job on it is still active). */
  withActions: boolean;
}) {
  const percent = job.state === 'encoding' || job.state === 'verifying' ? percentOf(job) : null;
  // The row is the link (convention 9): the name's hit area covers the row; the run link and the
  // row's buttons sit above it.
  return (
    <div className="job-row row-link">
      <div className="job-file">
        <Link href={`/jobs/${job.id}`} className="job-name row-link-main">
          {job.fileName}
        </Link>
        <span className="job-where">
          {job.state === 'queued' && !job.dryRun ? (
            <>
              {wherePrefix(job)}
              <span title={QUEUED_VERSION_NOTE} aria-describedby={`queued-version-${job.id}`}>
                {versionText(job)}
              </span>
              <span id={`queued-version-${job.id}`} className="sr-only">
                {QUEUED_VERSION_NOTE}
              </span>
            </>
          ) : (
            whereLine(job)
          )}
          <span aria-hidden="true"> · </span>
          <Link
            href={`/runs/${job.runId}`}
            className="job-run-link link-muted"
            aria-label={`Run summary for ${job.fileName}`}
          >
            run
          </Link>
          <span aria-hidden="true"> · </span>
          <time dateTime={jobLastTime(job)} title={fmtFull(jobLastTime(job))}>
            {fmtStamp(jobLastTime(job))}
          </time>
        </span>
      </div>
      <div>
        <JobStateChip job={job} />
      </div>
      <div className="job-detail">
        {percent !== null ? <JobProgress job={job} percent={percent} /> : null}
        <span className={`job-detail-text is-${verdictOf(job)}`}>
          {detailLine(job, { queuePaused })}
        </span>
      </div>
      {withActions ? (
        <div className="job-actions">
          {isActive(job) ? <JobActions job={job} controls={controls} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function ListState({
  loading,
  error,
  empty,
  filtered,
  onRetry,
  onShowAll,
}: {
  loading: boolean;
  error: unknown;
  empty: boolean;
  filtered: boolean;
  onRetry(): void;
  /** Clears the library and state filters. */
  onShowAll(): void;
}) {
  if (error) {
    return (
      <div className="alert alert-danger jobs-error" role="alert">
        Couldn't load jobs
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  if (loading && empty) {
    return <Loading label="Loading jobs…" />;
  }
  if (empty && filtered) {
    return (
      <div className="jobs-empty">
        <p>No jobs match this filter.</p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onShowAll}>
          Show all
        </button>
      </div>
    );
  }
  if (empty) {
    return <p className="jobs-empty">No jobs yet. Queued files show up here.</p>;
  }
  return null;
}

/**
 * The four "Today" tiles. Without `onSelect` (phone) they are plain figures; with it (desktop)
 * Queued, Failed and Needs attention are buttons that apply the filter of the same name, and the
 * active one is `aria-pressed` (one ring and a check). "Saved today" has no filter. Plain tiles, no
 * fills (convention 6); nothing saved and nothing queued are dimmed at zero, while zero failed and
 * zero needing attention are good news and stay bright.
 */
function StatTiles({
  stats,
  problemCount,
  active,
  onSelect,
}: {
  stats: ReturnType<typeof useTodayStats>;
  problemCount: number | null;
  /** The label of the active filter chip. */
  active?: string | undefined;
  onSelect?(filterLabel: string): void;
}) {
  const tiles: Array<{ label: string; filter: string | null; value: string; zero: boolean }> = [
    {
      label: 'Saved today',
      filter: null,
      value: stats ? fmtBytes(stats.savedBytes) : '—',
      zero: stats?.savedBytes === 0,
    },
    {
      label: 'Queued',
      filter: 'Queued',
      value: stats ? num.format(stats.queued) : '—',
      zero: stats?.queued === 0,
    },
    {
      label: 'Failed',
      filter: 'Failed',
      value: stats ? num.format(stats.failed) : '—',
      zero: false,
    },
    {
      label: 'Needs attention',
      filter: 'Needs attention',
      value: problemCount === null ? '—' : num.format(problemCount),
      zero: false,
    },
  ];
  return (
    <ul className="stat-tiles" aria-label="Today">
      {tiles.map((t) => {
        const filter = t.filter;
        const clickable = onSelect !== undefined && filter !== null;
        return (
          <StatTile
            key={t.label}
            label={t.label}
            value={t.value}
            zero={t.zero}
            {...(clickable
              ? {
                  onClick: () => onSelect(filter),
                  pressed: active === filter,
                  buttonLabel: `Show ${filter}: ${t.value}`,
                }
              : {})}
          />
        );
      })}
    </ul>
  );
}

export function JobsPage() {
  usePageTitle('Jobs');
  const phone = usePhone();
  const [filterIndex, setFilterIndex] = useState(0);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const filter = FILTERS[filterIndex] ?? FILTERS[0];
  const states = filter && filter.states.length > 0 ? filter.states : null;
  const list = useJobsList({
    libraryId,
    states,
    problems: filter?.problems === true,
    dependsOnSize: filter?.dependsOnSize === true,
  });
  const stats = useTodayStats();
  const history = useJobsHistory();
  const problemCount = useProblemCount();
  const libraries = useAsync(async () => (await api.libraries.list()).libraries, []);
  const controls = useJobControls(list.reload);
  const queue = useQueue();
  const queuePaused = queue.status?.paused ?? false;

  const jobs = filter?.paused ? list.jobs.filter((j) => j.paused) : list.jobs;
  const cancelAll = (
    <CancelAll
      counts={list.counts}
      libraryId={libraryId}
      libraryName={(libraries.data ?? []).find((l) => l.id === libraryId)?.name ?? null}
      statusFiltered={filterIndex !== 0}
      onDone={list.reload}
    />
  );
  const fileNameOf = (id: string) => list.jobs.find((j) => j.id === id)?.fileName ?? null;
  const countOf = (f: (typeof FILTERS)[number]): number | null => {
    if (f.paused) return list.pausedCount;
    if (f.problems) return list.problemCount;
    if (f.dependsOnSize) return list.dependsOnSizeCount;
    const c = list.counts;
    if (!c) return null;
    const keys = (f.states.length > 0 ? f.states : Object.keys(c)) as JobState[];
    return keys.reduce((sum, s) => sum + (c[s] ?? 0), 0);
  };
  const failedFilter = FILTERS.find((f) => f.label === 'Failed');
  // The same all-time count the Failed filter shows, not today's tile.
  const failedCount = (failedFilter ? countOf(failedFilter) : null) ?? 0;
  const header = (Tag: 'header' | 'div') => (
    <Tag className="jobs-head head-row">
      <div className="jobs-title">
        <div className="jobs-title-row">
          <h1>Jobs</h1>
          <LiveDot />
        </div>
        <QueueLanes queue={queue} fileNameOf={fileNameOf} />
      </div>
      <div className="head-actions">
        <RetryFailed failed={failedCount} onDone={list.reload} />
        <QueueToggle queue={queue} />
        {cancelAll}
      </div>
    </Tag>
  );
  const listState = (
    <ListState
      loading={list.loading}
      error={list.error}
      empty={jobs.length === 0}
      filtered={filterIndex !== 0 || libraryId !== null}
      onRetry={list.reload}
      onShowAll={() => {
        setFilterIndex(0);
        setLibraryId(null);
      }}
    />
  );
  const filterChips = (
    <div className="filter-chips">
      <ListboxSelect
        label="Library"
        value={libraryId ?? ''}
        options={[
          { value: '', label: 'All libraries' },
          ...(libraries.data ?? []).map((l) => ({ value: l.id, label: l.name })),
        ]}
        onChange={(v) => setLibraryId(v || null)}
      />
      {FILTERS.map((f, i) => {
        const n = countOf(f);
        // Only options with something in them, plus "All" and the current one (convention 15).
        if (n === 0 && i !== 0 && i !== filterIndex) return null;
        return (
          <button
            key={f.label}
            type="button"
            className="filter-chip"
            aria-pressed={i === filterIndex}
            onClick={() => setFilterIndex(i)}
          >
            {f.label} {n === null ? null : <span className="mono">{num.format(n)}</span>}
          </button>
        );
      })}
    </div>
  );

  if (phone) {
    const running = jobs.filter((j) => isActive(j) && j.state !== 'queued');
    const queued = jobs.filter((j) => j.state === 'queued');
    const finished = jobs.filter((j) => !isActive(j));
    return (
      <div className="jobs-page is-phone">
        {header('header')}
        <QueuePausedNote queue={queue} />
        <div className="stat-row">
          <StatTiles stats={stats} problemCount={problemCount} />
          <AllTimeTile history={history} />
        </div>
        <JobsHistory history={history} />
        {filterChips}
        {listState}
        {running.length > 0 ? (
          <section className="phone-section" aria-labelledby="jobs-running">
            <SectionHeading id="jobs-running">Running</SectionHeading>
            {running.map((job) => {
              const percent = job.state === 'encoding' ? percentOf(job) : null;
              return (
                <div key={job.id} className="phone-card row-link">
                  <div className="phone-card-head">
                    <Link href={`/jobs/${job.id}`} className="job-name row-link-main">
                      {job.fileName}
                    </Link>
                    {percent !== null ? <span className="mono">{percent}%</span> : null}
                  </div>
                  {percent !== null ? <JobProgress job={job} percent={percent} /> : null}
                  {job.paused || job.dryRun ? <JobStateChip job={job} /> : null}
                  <span className="phone-card-line">{phoneRunningLine(job)}</span>
                  <div className="phone-card-actions">
                    <JobActions job={job} controls={controls} block />
                  </div>
                </div>
              );
            })}
          </section>
        ) : null}
        {queued.length > 0 ? (
          <section className="phone-section" aria-labelledby="jobs-queued">
            <SectionHeading id="jobs-queued">Queued</SectionHeading>
            {queued.map((job) => (
              <div key={job.id} className="phone-card row-link">
                <div className="phone-card-head">
                  <Link href={`/jobs/${job.id}`} className="job-name row-link-main">
                    {job.fileName}
                  </Link>
                </div>
                {job.dryRun ? <JobStateChip job={job} /> : null}
                <span className="phone-card-line">{detailLine(job, { queuePaused })}</span>
                {!job.dryRun && (
                  <span className="phone-card-line">
                    {`${QUEUED_VERSION_NOTE[0]?.toUpperCase()}${QUEUED_VERSION_NOTE.slice(1)}.`}
                  </span>
                )}
                <div className="phone-card-actions">
                  <JobActions job={job} controls={controls} block />
                </div>
              </div>
            ))}
          </section>
        ) : null}
        {finished.length > 0 ? (
          <section className="phone-section" aria-labelledby="jobs-finished">
            <SectionHeading id="jobs-finished">Finished</SectionHeading>
            {finished.map((job) => (
              <Link key={job.id} href={`/jobs/${job.id}`} className="phone-finished">
                <span className={`phone-finished-icon is-${verdictOf(job)}`}>
                  <Icon name={VERDICT_ICON[verdictOf(job)]} size={16} strokeWidth={2.6} />
                </span>
                <span className="phone-finished-text">
                  <b>{job.fileName}</b>
                  <span className={`job-detail-text is-${verdictOf(job)}`}>{phoneLine(job)}</span>
                </span>
              </Link>
            ))}
          </section>
        ) : null}
        {controls.dialog}
      </div>
    );
  }

  const withActions = jobs.some(isActive);
  return (
    <div className="jobs-page">
      {header('div')}
      <QueuePausedNote queue={queue} />
      <div className="stat-row">
        <StatTiles
          stats={stats}
          problemCount={problemCount}
          active={FILTERS[filterIndex]?.label}
          onSelect={(label) => {
            const i = FILTERS.findIndex((f) => f.label === label);
            // Clicking the active tile again clears the filter.
            setFilterIndex((cur) => (cur === i ? 0 : i));
          }}
        />
        <AllTimeTile history={history} />
      </div>
      <JobsHistory history={history} />
      {filterChips}
      {listState}
      {jobs.length > 0 ? (
        <section
          className={withActions ? 'job-list has-actions' : 'job-list'}
          aria-label="Job list"
        >
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              controls={controls}
              queuePaused={queuePaused}
              withActions={withActions}
            />
          ))}
        </section>
      ) : null}
      {controls.dialog}
    </div>
  );
}
