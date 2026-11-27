// The cells of a job row that other pages reuse: detail line, title sub-line, workflow, result.

import type { JobMedia } from '@transcoda/contract';
import type { ReactNode } from 'react';
import { JobProgress } from './JobProgress.tsx';
import {
  detailLine,
  type Job,
  percentOf,
  QUEUED_VERSION_NOTE,
  verdictOf,
  versionText,
} from './job-text.ts';
import { mediaSub, resultLines } from './media-text.ts';

/**
 * The row's detail line, clamped to two lines so a long reason cannot stretch the row; the whole
 * line is its tooltip (and stays in the text for screen readers).
 */
export function DetailText({ job, queuePaused }: { job: Job; queuePaused: boolean }) {
  const text = detailLine(job, { queuePaused });
  return (
    <span className={`job-detail-text job-detail-clamp is-${verdictOf(job)}`} title={text}>
      {text}
    </span>
  );
}

/** The muted line under a title: the episode code in bold, then its name; or a movie's year. */
export function TitleSub({ media }: { media: JobMedia }) {
  const { code, text } = mediaSub(media);
  if (!code && !text) return null;
  return (
    <span className="job-title-sub">
      {code ? <b className="job-title-code">{code}</b> : null}
      {code && text ? ' · ' : null}
      {text}
    </span>
  );
}

/** "TV cleanup v7"; a queued real job's version says it can still change. */
export function WorkflowText({ job }: { job: Job }) {
  if (job.state !== 'queued' || job.dryRun) return <>{`${job.workflowName} ${versionText(job)}`}</>;
  return (
    <>
      {`${job.workflowName} `}
      <span title={QUEUED_VERSION_NOTE} aria-describedby={`queued-version-${job.id}`}>
        {versionText(job)}
      </span>
      <span id={`queued-version-${job.id}`} className="sr-only">
        {QUEUED_VERSION_NOTE}
      </span>
    </>
  );
}

/**
 * The Result cell: a running job's progress; a finished encode's sizes over its saving (a kept
 * original's reason over its sizes); otherwise the detail line. A replaced job with problems keeps
 * its "needs attention" line.
 */
export function ResultCell({ job, queuePaused }: { job: Job; queuePaused: boolean }) {
  const percent = job.state === 'encoding' || job.state === 'verifying' ? percentOf(job) : null;
  const lines = percent === null && verdictOf(job) !== 'attention' ? resultLines(job) : null;
  let body: ReactNode;
  if (percent !== null) {
    body = (
      <>
        <DetailText job={job} queuePaused={queuePaused} />
        <JobProgress job={job} percent={percent} />
      </>
    );
  } else if (lines && job.state === 'kept_original') {
    body = (
      <>
        {detailLine(job, { queuePaused }) ? (
          <DetailText job={job} queuePaused={queuePaused} />
        ) : null}
        <span className="job-outcome-sub">{lines.sizes}</span>
      </>
    );
  } else if (lines) {
    body = (
      <>
        <span className="job-outcome-sizes">{lines.sizes}</span>
        <span className={`job-outcome-change is-${lines.tone}`}>{lines.change}</span>
      </>
    );
  } else {
    body = <DetailText job={job} queuePaused={queuePaused} />;
  }
  return <td className="job-outcome">{body}</td>;
}
