// The jobs list's table and phone cards, shared by the Jobs page (with Pause / Cancel) and a
// library file's page (its job history, read-only).
import { isFinalState } from '@transcoda/shared';
import { Link } from 'wouter';
import { Icon } from '../components/Icon.tsx';
import { fmtFull, fmtStamp, jobLastTime } from '../lib/time.ts';
import { usePhone } from '../lib/use-phone.ts';
import { ResultCell, TitleSub, WorkflowText } from './JobCells.tsx';
import { JobProgress } from './JobProgress.tsx';
import { JobStateChip, VERDICT_ICON } from './JobStateChip.tsx';
import {
  detailLine,
  type Job,
  percentOf,
  phoneLine,
  phoneRunningLine,
  verdictOf,
  versionText,
} from './job-text.ts';
import { jobTitle } from './media-text.ts';
import { Poster } from './Poster.tsx';
import { encodeStopped, useQueue } from './use-queue.ts';

export const isActive = (j: Job) => !isFinalState(j.state);

/** Pause / Resume / Cancel for one job (the Jobs page's `useJobControls`). */
export interface JobControls {
  pause(job: Job): void;
  resume(job: Job): void;
  askCancel(job: Job): void;
}

/** "Pause" alone is ambiguous in a list of rows: the accessible name adds the job's title. */
const named = (word: string, job: Job) => `${word} ${jobTitle(job)}`;

/**
 * Pause / Resume and Cancel. While the whole queue is paused a job's own Pause would change
 * nothing you can see, so only Cancel (and Resume for a job that is paused itself) is offered.
 */
export function JobActions({
  job,
  controls,
  queuePaused,
  block,
}: {
  job: Job;
  controls: JobControls;
  queuePaused: boolean;
  block?: boolean;
}) {
  const cls = block ? 'btn btn-ghost btn-sm btn-block' : 'btn btn-ghost btn-sm';
  return (
    <>
      {job.paused || !queuePaused ? (
        <button
          type="button"
          className={cls}
          aria-label={named(job.paused ? 'Resume' : 'Pause', job)}
          onClick={() => (job.paused ? controls.resume(job) : controls.pause(job))}
        >
          {job.paused ? 'Resume' : 'Pause'}
        </button>
      ) : null}
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
 * The job's title as the row's link: the show or movie title, named for screen readers as the
 * buttons are ("Maple Lane S01E03"), the file name on hover.
 */
export function TitleLink({ job, className }: { job: Job; className: string }) {
  return (
    <Link
      href={`/jobs/${job.id}`}
      className={className}
      aria-label={jobTitle(job)}
      title={job.fileName}
    >
      {job.media.title}
    </Link>
  );
}

function JobRow({
  job,
  controls,
  queuePaused,
  frozen,
  withActions,
}: {
  job: Job;
  /** Null: a read-only row without Pause / Cancel. */
  controls: JobControls | null;
  queuePaused: boolean;
  /** An encode that stands still (paused queue, or waiting for a lane); its icon stays still. */
  frozen: boolean;
  /** The list has a column for Pause / Cancel (some job on it is still active). */
  withActions: boolean;
}) {
  const when = jobLastTime(job);
  // The row is the link (convention 9): the title's hit area covers the row; the row's buttons
  // sit above it.
  return (
    <tr className="row-link">
      <td>
        <div className="job-title">
          <Poster job={job} size="row" />
          <div className="job-title-main">
            <TitleLink job={job} className="job-name job-title-text row-link-main" />
            <TitleSub media={job.media} />
          </div>
        </div>
      </td>
      <td className="job-cell-clip job-optional" title={job.libraryName}>
        {job.libraryName}
      </td>
      <td className="job-cell-clip job-optional" title={`${job.workflowName} ${versionText(job)}`}>
        <WorkflowText job={job} />
      </td>
      <td>
        <JobStateChip job={job} frozen={frozen} />
      </td>
      <ResultCell job={job} queuePaused={queuePaused} />
      <td className="job-when">
        <time dateTime={when} title={fmtFull(when)}>
          {fmtStamp(when)}
        </time>
      </td>
      {withActions ? (
        <td>
          {controls && isActive(job) ? (
            <div className="job-actions">
              <JobActions job={job} controls={controls} queuePaused={queuePaused} />
            </div>
          ) : null}
        </td>
      ) : null}
    </tr>
  );
}

/** Desktop: the list as a table (screen 07). */
export function JobTable({
  jobs,
  controls,
  queuePaused,
  queueStatus,
  label = 'Job list',
}: {
  jobs: Job[];
  /** Null: no Actions column and no Pause / Cancel (the history of one file). */
  controls: JobControls | null;
  queuePaused: boolean;
  queueStatus: Parameters<typeof encodeStopped>[0];
  label?: string;
}) {
  const withActions = controls !== null && jobs.some(isActive);
  return (
    <div className="job-list">
      <table className={withActions ? 'job-table has-actions' : 'job-table'} aria-label={label}>
        <colgroup>
          <col />
          {/* Library and Workflow give way first when the table is narrow (styles/jobs.css). */}
          <col className="job-col-library job-optional" />
          <col className="job-col-workflow job-optional" />
          <col className="job-col-status" />
          <col className="job-col-result" />
          <col className="job-col-when" />
          {withActions ? <col className="job-col-actions" /> : null}
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col" className="job-optional">
              Library
            </th>
            <th scope="col" className="job-optional">
              Workflow
            </th>
            <th scope="col">Status</th>
            <th scope="col">Result</th>
            <th scope="col" className="job-when">
              When
            </th>
            {withActions ? (
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              controls={controls}
              queuePaused={queuePaused}
              frozen={encodeStopped(queueStatus, job)}
              withActions={withActions}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A phone card of the Jobs page's own markup, without Pause / Cancel (one file's history). */
function HistoryCard({
  job,
  queuePaused,
  frozen,
}: {
  job: Job;
  queuePaused: boolean;
  frozen: boolean;
}) {
  if (!isActive(job)) {
    return (
      <Link href={`/jobs/${job.id}`} className="phone-finished">
        <span className={`phone-finished-icon is-${verdictOf(job)}`}>
          <Icon name={VERDICT_ICON[verdictOf(job)]} size={16} />
        </span>
        <span className="phone-finished-text">
          <b>{jobTitle(job)}</b>
          <span className={`job-detail-text is-${verdictOf(job)}`}>{phoneLine(job)}</span>
        </span>
      </Link>
    );
  }
  const running = job.state !== 'queued';
  const percent = running && job.state === 'encoding' ? percentOf(job) : null;
  return (
    <div className="phone-card row-link">
      <div className="phone-card-head">
        <TitleLink job={job} className="job-name row-link-main" />
        {percent !== null ? <span className="mono">{percent}%</span> : null}
      </div>
      <TitleSub media={job.media} />
      {percent !== null ? <JobProgress job={job} percent={percent} /> : null}
      {job.paused || job.dryRun ? <JobStateChip job={job} frozen={frozen} /> : null}
      <span className="phone-card-line">
        {running ? phoneRunningLine(job) : detailLine(job, { queuePaused })}
      </span>
    </div>
  );
}

/**
 * The jobs of one file, without Pause / Cancel: the Jobs page's table on a desktop, its phone
 * cards (same markup and classes) on a phone, newest first.
 */
export function JobHistoryTable({ jobs, label }: { jobs: Job[]; label: string }) {
  const queue = useQueue();
  const phone = usePhone();
  const queuePaused = queue.status?.paused ?? false;
  if (phone) {
    return (
      <section className="phone-section" aria-label={label}>
        {jobs.map((job) => (
          <HistoryCard
            key={job.id}
            job={job}
            queuePaused={queuePaused}
            frozen={encodeStopped(queue.status, job)}
          />
        ))}
      </section>
    );
  }
  return (
    <JobTable
      jobs={jobs}
      controls={null}
      queuePaused={queuePaused}
      queueStatus={queue.status}
      label={label}
    />
  );
}
