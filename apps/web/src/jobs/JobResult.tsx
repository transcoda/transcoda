import type { JobDetail } from '@transcoda/contract';
import { type ReactNode, useId } from 'react';
import { Icon } from '../components/Icon.tsx';
import { fmtBytes, fmtPercent } from '../lib/bytes.ts';
import { VERDICT_ICON } from './JobStateChip.tsx';
import {
  dependsWord,
  reasonOf,
  sentence,
  stateWord,
  testEncodeOutcome,
  verdictOf,
} from './jobText.ts';

/**
 * The job's outcome: the word with its icon, "<before> → <after>" with the percent (the estimate
 * on a plan-only dry run: "Size (est.)"; a test-encode's measured size), where the original went,
 * the reason and warnings. The word is only the outcome ("Would replace", "Would keep the
 * original"): the sizes are said once, in the size cell. Only a `done` job says where the original
 * went; a job still replacing never reads as replaced (anti-goal 5).
 */
export function JobResult({
  job,
  testEncodeAction = null,
}: {
  job: Pick<JobDetail, 'state' | 'dryRun' | 'reason' | 'result'> &
    Partial<Pick<JobDetail, 'problems' | 'testEncode' | 'dependsOnSize'>>;
  /** Shown in the size tile of a dry run its size gate decides ("Test-encode this file"). */
  testEncodeAction?: ReactNode;
}) {
  const headingId = useId();
  const { result } = job;
  const verdict = verdictOf(job);
  const testEncode = job.testEncode === true;
  const measured = testEncodeOutcome({ ...job, testEncode });
  // A test-encode says its own detail where the reason would be: a kept one the saving against its
  // gate in words (not the engine's reason); one that would replace nothing (its sizes are the size cell).
  const reason = measured
    ? job.state === 'kept_original'
      ? sentence(measured.detail)
      : null
    : reasonOf(job);
  const before = result?.beforeBytes ?? null;
  // A test-encode measured its output: the real size, not the estimate.
  const estimated = job.dryRun && !testEncode;
  const after = estimated ? (result?.estimatedBytes ?? null) : (result?.afterBytes ?? null);
  // The size gate decides after encoding (#41): the size is unknown until a test-encode measures it.
  const depends = dependsWord(job) !== null;
  let where: string | null = null;
  if (job.state === 'done' && result?.replacedTo === 'recycle')
    where = 'Original in recycle folder';
  if (job.state === 'done' && result?.replacedTo === 'deleted') where = 'Original replaced';
  return (
    <section className={`panel job-result v-${verdict}`} aria-labelledby={headingId}>
      <h2 id={headingId} className="sr-only">
        Result
      </h2>
      <div className="job-result-cell">
        <span className="job-result-label">Result</span>
        <span className="job-result-word">
          <Icon name={VERDICT_ICON[verdict]} size={18} />
          {measured?.word ?? stateWord(job)}
        </span>
      </div>
      {depends && (
        <div className="job-result-cell">
          <span className="job-result-label">Size</span>
          <span className="job-result-size">
            {`${before === null ? '?' : fmtBytes(before)} → ? · decided after encoding`}
          </span>
          {testEncodeAction}
        </div>
      )}
      {!depends && before !== null && after !== null && (
        <>
          <div className="job-result-cell">
            <span className="job-result-label">{estimated ? 'Size (est.)' : 'Size'}</span>
            <span className="job-result-size">{`${fmtBytes(before)} → ${fmtBytes(after)}`}</span>
          </div>
          <div className="job-result-pct">{fmtPercent(before, after)}</div>
        </>
      )}
      {(where || reason) && (
        <div className="job-result-notes">
          {where && <p>{where}</p>}
          {reason && <p>{sentence(reason)}</p>}
        </div>
      )}
      {result && result.problems.length > 0 && (
        <ul className="job-result-warnings job-result-problems" aria-label="Problems">
          {result.problems.map((p) => (
            <li key={p}>
              <Icon name="alert" size={14} />
              {p}
            </li>
          ))}
        </ul>
      )}
      {result && result.warnings.length > 0 && (
        <ul className="job-result-warnings" aria-label="Warnings">
          {result.warnings.map((w) => (
            <li key={w}>
              <Icon name="alert" size={14} />
              {w}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
