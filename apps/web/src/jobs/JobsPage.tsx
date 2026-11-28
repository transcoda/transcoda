// Jobs (screens 07, 08): the live job list with filters, per-job pause/resume/cancel and the
// whole-queue controls (pause, cancel all); below 640 px the phone layout of screen 08. One header
// row (title, lanes line, queue actions), today's tiles, four half-height history cards, then the
// list: the list stays above the fold.
import type { JobState } from '@transcoda/shared';
import { useState } from 'react';
import { Link } from 'wouter';
import { api } from '../api/client.ts';
import { SectionHeading } from '../components/Headings.tsx';
import { Icon } from '../components/Icon.tsx';
import { ListboxSelect } from '../components/ListboxSelect.tsx';
import { LiveDot } from '../components/LiveDot.tsx';
import { Loading } from '../components/Loading.tsx';
import { useAsync } from '../hooks/use-async.ts';
import { usePageTitle } from '../lib/page-title.ts';
import { usePhone } from '../lib/use-phone.ts';
import { CancelAll, RetryFailed } from './BulkActions.tsx';
import { TitleSub } from './JobCells.tsx';
import { JobProgress } from './JobProgress.tsx';
import { JobStateChip, VERDICT_ICON } from './JobStateChip.tsx';
import { AllTimeTile, JobsHistory, useJobsHistory } from './JobsHistory.tsx';
import { isActive, JobActions, JobTable, TitleLink } from './JobTable.tsx';
import {
  detailLine,
  FILTERS,
  percentOf,
  phoneLine,
  phoneRunningLine,
  QUEUED_VERSION_NOTE,
  verdictOf,
} from './job-text.ts';
import { jobTitle } from './media-text.ts';
import { QueueLanes, QueuePausedNote, QueueToggle } from './QueueBar.tsx';
import { StatTiles, useTodayStats } from './StatTiles.tsx';
import { useCancelCounts } from './use-cancel-counts.ts';
import { useJobControls } from './use-job-controls.tsx';
import { useJobsList, useProblemCount } from './use-jobs-list.ts';
import { encodeStopped, useQueue } from './use-queue.ts';

const num = new Intl.NumberFormat('en-US');

/** The dry-run facet: a scope like the library, so the outcome chips' counts add up within it. */
type RunKind = '' | 'real' | 'dry';
const RUN_KINDS: Array<{ value: RunKind; label: string }> = [
  { value: '', label: 'Real and dry runs' },
  { value: 'real', label: 'Real runs' },
  { value: 'dry', label: 'Dry runs' },
];

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

export function JobsPage() {
  usePageTitle('Jobs');
  const phone = usePhone();
  const [filterIndex, setFilterIndex] = useState(0);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [runKind, setRunKind] = useState<RunKind>('');
  const dryRun = runKind === '' ? null : runKind === 'dry';
  const filter = FILTERS[filterIndex] ?? FILTERS[0];
  const states = filter && filter.states.length > 0 ? filter.states : null;
  const list = useJobsList({
    libraryId,
    states,
    problems: filter?.problems === true,
    dependsOnSize: filter?.dependsOnSize === true,
    dryRun,
  });
  const stats = useTodayStats();
  const history = useJobsHistory();
  const problemCount = useProblemCount();
  const libraries = useAsync(async () => (await api.libraries.list()).libraries, []);
  const controls = useJobControls(list.reload);
  const queue = useQueue();
  const queuePaused = queue.status?.paused ?? false;

  const jobs = filter?.paused ? list.jobs.filter((j) => j.paused) : list.jobs;
  const cancelCounts = useCancelCounts(libraryId, list, dryRun !== null);
  const afterCancelAll = () => {
    list.reload();
    if (dryRun !== null) cancelCounts.reload();
  };
  const cancelAll = (
    <CancelAll
      counts={cancelCounts.counts}
      libraryId={libraryId}
      libraryName={(libraries.data ?? []).find((l) => l.id === libraryId)?.name ?? null}
      statusFiltered={filterIndex !== 0 || dryRun !== null}
      onDone={afterCancelAll}
    />
  );
  const fileNameOf = (id: string) => {
    const job = list.jobs.find((j) => j.id === id);
    return job ? jobTitle(job) : null;
  };
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
      filtered={filterIndex !== 0 || libraryId !== null || dryRun !== null}
      onRetry={list.reload}
      onShowAll={() => {
        setFilterIndex(0);
        setLibraryId(null);
        setRunKind('');
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
      <ListboxSelect
        label="Runs"
        value={runKind}
        options={RUN_KINDS}
        onChange={(v) => setRunKind(v as RunKind)}
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
                    <TitleLink job={job} className="job-name row-link-main" />
                    {percent !== null ? <span className="mono">{percent}%</span> : null}
                  </div>
                  <TitleSub media={job.media} />
                  {percent !== null ? <JobProgress job={job} percent={percent} /> : null}
                  {job.paused || job.dryRun ? (
                    <JobStateChip job={job} frozen={encodeStopped(queue.status, job)} />
                  ) : null}
                  <span className="phone-card-line">{phoneRunningLine(job)}</span>
                  <div className="phone-card-actions">
                    <JobActions job={job} controls={controls} queuePaused={queuePaused} block />
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
                  <TitleLink job={job} className="job-name row-link-main" />
                </div>
                <TitleSub media={job.media} />
                {job.dryRun ? <JobStateChip job={job} /> : null}
                <span className="phone-card-line">{detailLine(job, { queuePaused })}</span>
                {!job.dryRun && (
                  <span className="phone-card-line">
                    {`${QUEUED_VERSION_NOTE[0]?.toUpperCase()}${QUEUED_VERSION_NOTE.slice(1)}.`}
                  </span>
                )}
                <div className="phone-card-actions">
                  <JobActions job={job} controls={controls} queuePaused={queuePaused} block />
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
                  <Icon name={VERDICT_ICON[verdictOf(job)]} size={16} />
                </span>
                <span className="phone-finished-text">
                  <b>{jobTitle(job)}</b>
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

  return (
    <div className="jobs-page">
      {header('div')}
      <QueuePausedNote queue={queue} />
      {/* Sized by the space beside the sidebar, not the window: the tiles and cards wrap there. */}
      <div className="jobs-overview">
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
      </div>
      {filterChips}
      {listState}
      {jobs.length > 0 ? (
        <JobTable
          jobs={jobs}
          controls={controls}
          queuePaused={queuePaused}
          queueStatus={queue.status}
        />
      ) : null}
      {controls.dialog}
    </div>
  );
}
