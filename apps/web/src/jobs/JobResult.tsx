import type { JobDetail } from '@transcoda/contract';
import { type ReactNode, useId } from 'react';
import { Icon, type IconName } from '../components/Icon.tsx';
import { fmtBytes, fmtPercent } from '../lib/bytes.ts';
import { VERDICT_ICON } from './JobStateChip.tsx';
import { failureCause, RESULT_TONE } from './jobOutcome.ts';
import {
  dependsWord,
  reasonOf,
  sentence,
  stateWord,
  testEncodeOutcome,
  type Verdict,
  verdictOf,
} from './jobText.ts';

/** The icon in the card's tinted circle: an outcome that changed nothing is a plain minus. */
const RESULT_ICON: Record<Verdict, IconName> = {
  ...VERDICT_ICON,
  kept: 'minus',
  noop: 'minus',
  skipped: 'minus',
  already: 'minus',
};

type ResultJob = Pick<JobDetail, 'state' | 'dryRun' | 'reason' | 'result'> &
  Partial<Pick<JobDetail, 'problems' | 'testEncode' | 'dependsOnSize'>>;

interface Lines {
  headline: ReactNode;
  text: string | null;
  meta: string[];
}

/** "472 kB → 118 kB  −75%": the sizes as the headline, the percent in the outcome's colour. */
function sizesHeadline(before: number, after: number, estimated: boolean): ReactNode {
  return (
    <>
      <span>{`${fmtBytes(before)} → ${fmtBytes(after)}${estimated ? ' (est.)' : ''}`}</span>
      <span className="job-result-pct">{fmtPercent(before, after)}</span>
    </>
  );
}

/** Where a replaced file's original went (only a `done` job says it). */
function whereOf(job: ResultJob): string[] {
  if (job.state !== 'done') return [];
  if (job.result?.replacedTo === 'recycle') return ['Original in recycle folder'];
  if (job.result?.replacedTo === 'deleted') return ['Original replaced'];
  return [];
}

/**
 * What the card says: the headline (the sizes for an outcome that wrote or would write a file;
 * the cause of a failure; the reason a file was left alone), an optional sentence under it and
 * muted meta lines. The state chip in the header already says the outcome's word, so the card
 * says it only when there is nothing better.
 */
function linesOf(job: ResultJob): Lines {
  const { result } = job;
  const verdict = verdictOf(job);
  const testEncode = job.testEncode === true;
  const measured = testEncodeOutcome({ ...job, testEncode });
  const before = result?.beforeBytes ?? null;
  // A plan-only dry run estimates its output; a test-encode measured it.
  const estimated = job.dryRun && !testEncode;
  const after = estimated ? (result?.estimatedBytes ?? null) : (result?.afterBytes ?? null);
  const sizesLine =
    before !== null && after !== null
      ? `${fmtBytes(before)} → ${fmtBytes(after)}${estimated ? ' (est.)' : ''}`
      : null;

  // The size gate decides after encoding (#41): the size is unknown until a test-encode measures it.
  if (dependsWord(job) !== null) {
    return {
      headline: stateWord(job),
      text: null,
      meta: [`${before === null ? '?' : fmtBytes(before)} → ? · decided after encoding`],
    };
  }
  if (verdict === 'failed') {
    const cause = failureCause(job.reason);
    return { headline: cause.headline, text: cause.text, meta: [] };
  }
  const writes = verdict === 'replaced' || verdict === 'attention' || verdict === 'dry';
  if (writes && before !== null && after !== null) {
    // A dry run says what would happen first: its chip's word is not an outcome.
    const would = verdict === 'dry' ? [measured?.word ?? stateWord(job)] : [];
    return {
      headline: sizesHeadline(before, after, estimated),
      text: null,
      meta: [...would, ...whereOf(job)],
    };
  }
  if (writes) return { headline: stateWord(job), text: null, meta: whereOf(job) };
  // Left alone (kept, nothing to do, skipped, damaged, already processed…): the reason leads.
  const reason = measured
    ? job.state === 'kept_original'
      ? measured.detail
      : null
    : reasonOf(job);
  const sizes = sizesLine && verdict !== 'noop' ? [sizesLine] : [];
  if (reason) return { headline: sentence(reason), text: null, meta: sizes };
  return { headline: measured?.word ?? stateWord(job), text: null, meta: sizes };
}

/**
 * The job's outcome, right under the header: a neutral panel with the outcome's icon in a softly
 * tinted circle (the state chip's colour; no coloured slab or edge), then the headline: the sizes
 * with the percent for a replaced file ("472 kB → 118 kB −75%", estimated on a plan-only dry run),
 * the cause in plain words for a failure ("The file could not be read"), the reason a file was
 * left alone. Where the original went is a muted line; problems and warnings are listed; `raw`
 * (the command, the raw error and the log behind a collapsed disclosure) comes last. Only a `done`
 * job says where the original went; a job still replacing never reads as replaced (anti-goal 5).
 */
export function JobResult({
  job,
  testEncodeAction = null,
  raw = null,
}: {
  job: ResultJob;
  /** Shown under a dry run its size gate decides ("Test-encode this file"). */
  testEncodeAction?: ReactNode;
  /** The collapsed raw output (command, error, log). */
  raw?: ReactNode;
}) {
  const headingId = useId();
  const { result } = job;
  const verdict = verdictOf(job);
  const { headline, text, meta } = linesOf(job);
  const depends = dependsWord(job) !== null;
  const problems = job.problems ?? result?.problems ?? [];
  return (
    <section
      className={`panel job-result is-${RESULT_TONE[verdict]} v-${verdict}`}
      aria-labelledby={headingId}
    >
      <h2 id={headingId} className="sr-only">
        Result
      </h2>
      <span className="job-result-icon" aria-hidden="true">
        <Icon name={RESULT_ICON[verdict]} size={15} strokeWidth={2.8} />
      </span>
      <p className="job-result-head">{headline}</p>
      {text && <p className="job-result-text">{text}</p>}
      {meta.map((m) => (
        <p key={m} className="job-result-meta">
          {m}
        </p>
      ))}
      {depends && testEncodeAction}
      {problems.length > 0 && (
        <ul className="job-result-warnings job-result-problems" aria-label="Problems">
          {problems.map((p) => (
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
      {raw}
    </section>
  );
}
