import type { RunDetail } from '@transcoda/contract';
import { useRef } from 'react';
import { Link, useParams } from 'wouter';
import { api } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { SectionHeading } from '../components/Headings.tsx';
import { Icon } from '../components/Icon.tsx';
import { LiveDot } from '../components/LiveDot.tsx';
import { Loading } from '../components/Loading.tsx';
import { NotFound } from '../components/NotFound.tsx';
import { useAsync } from '../hooks/useAsync.ts';
import type { EngineEvent } from '../hooks/useEvents.ts';
import { useRefetchOn } from '../hooks/useRefetchOn.ts';
import { DryRunBadge, VERDICT_ICON } from '../jobs/JobStateChip.tsx';
import {
  dependsWord,
  estimatePercent,
  queuedWait,
  reasonOf,
  sentence,
  testEncodeOutcome,
} from '../jobs/jobText.ts';
import { QUEUE_PAUSED_TEXT } from '../jobs/QueueBar.tsx';
import {
  OutcomeChip,
  outcomeOf,
  outcomeVerdict,
  outcomeWord,
  RunCounts,
} from '../jobs/RunCounts.tsx';
import { RunProcessAgain } from '../jobs/RunProcessAgain.tsx';
import { useQueue } from '../jobs/useQueue.ts';
import { fmtBytes } from '../lib/bytes.ts';
import { usePageTitle } from '../lib/pageTitle.ts';
import { fmtFull, fmtStamp } from '../lib/time.ts';
import { usePhone } from '../lib/usePhone.ts';

type RunFile = RunDetail['files'][number];

/** The estimate a dry-run file carries (only a file that would be rewritten has one). */
const estimateOf = (f: RunFile): number | null => (f.state === 'dry_run' ? f.estimatedBytes : null);

/** A test-encode file that would be rewritten: the size its output measured. */
const measuredOf = (f: RunFile): number | null => (f.state === 'dry_run' ? f.afterBytes : null);

/** A test-encode file's measured outcome ("Would replace", "315 MB → 190 MB (−40%)"), else null. */
function measuredOutcome(f: RunFile): { word: string; detail: string } | null {
  return testEncodeOutcome({
    state: f.state,
    dryRun: true,
    testEncode: true,
    reason: f.reason,
    result: {
      outcome: f.state,
      beforeBytes: f.beforeBytes,
      afterBytes: f.afterBytes,
      replacedTo: null,
      sourceDamaged: false,
    },
  });
}

/**
 * The muted line under a file's name: why it waits or ended as it did, when there is more to say
 * than its chip and size. The chip has the outcome and the Size column the sizes, so the note never
 * repeats them: a test-encode that would replace has nothing to add, one that would keep the
 * original says why ("Saved only 3% (gate ≥ 10%)"). A dry run's plan, otherwise the reason in the
 * Jobs list's words ("Already complies with every rule"). A replaced file's sizes say it all.
 */
function noteText(f: RunFile, testEncode: boolean, queuePaused: boolean): string | null {
  // A queued file says why it waits, as the Jobs list does ("Queue paused").
  const wait = queuedWait(f, queuePaused);
  if (wait) return wait;
  const measured = testEncode ? measuredOutcome(f) : null;
  if (measured) return f.state === 'dry_run' ? null : sentence(measured.detail);
  if (f.state === 'dry_run' && f.planSummary) return sentence(f.planSummary);
  if (f.state === 'done') return null;
  const reason = reasonOf(f);
  return reason ? sentence(reason) : null;
}

/** "2.41 GB → 1.62 GB" for a replaced file; otherwise the original's size (it is unchanged). */
function sizeText(f: RunFile, testEncode: boolean): string {
  if (f.beforeBytes === null) return '—';
  const measured = testEncode ? measuredOf(f) : null;
  if (measured !== null) return `${fmtBytes(f.beforeBytes)} → ${fmtBytes(measured)}`;
  const estimated = testEncode ? null : estimateOf(f);
  if (estimated !== null) return `${fmtBytes(f.beforeBytes)} → ≈${fmtBytes(estimated)}`;
  if (f.state === 'done' && f.afterBytes !== null) {
    return `${fmtBytes(f.beforeBytes)} → ${fmtBytes(f.afterBytes)}`;
  }
  return fmtBytes(f.beforeBytes);
}

/**
 * "≈ −1.12 GB estimated" over the dry-run files that have an estimate (with "(2 of 3 files)" when
 * some have none); null when none has one: nothing is claimed without an estimate.
 */
function estimatedSaving(files: RunFile[], testEncode: boolean): string | null {
  // A test-encode measured each file; it claims no estimate.
  if (testEncode) return null;
  const dry = files.filter((f) => f.state === 'dry_run');
  const sized = dry.filter((f) => f.beforeBytes !== null && estimateOf(f) !== null);
  if (sized.length === 0) return null;
  const change = sized.reduce((n, f) => n + ((estimateOf(f) ?? 0) - (f.beforeBytes ?? 0)), 0);
  const amount = `${change < 0 ? '−' : '+'}${fmtBytes(Math.abs(change))}`;
  const covers = sized.length < dry.length ? ` (${sized.length} of ${dry.length} files)` : '';
  return `≈ ${amount} estimated${covers}.`;
}

function FileChip({ f, run }: { f: RunFile; run: RunDetail['run'] }) {
  return (
    <OutcomeChip
      outcome={outcomeOf(f.state)}
      dryRun={run.dryRun}
      testEncode={run.testEncode}
      // The heading carries the run's "Dry run" badge once; no row repeats it.
      badge={false}
      paused={f.paused}
      word={dependsWord({ ...f, dryRun: run.dryRun })}
      estimate={
        f.dependsOnSize
          ? null
          : estimatePercent(f.beforeBytes, run.testEncode ? measuredOf(f) : estimateOf(f))
      }
    />
  );
}

/** "ran on v6" after the name when a file ran on another version than the run's. */
function VersionNote({ f, run }: { f: RunFile; run: RunDetail['run'] }) {
  if (f.workflowVersion === run.workflowVersion) return null;
  return (
    <>
      {' '}
      <span className="run-file-version">
        <span className="sr-only">ran on </span>v{f.workflowVersion}
      </span>
    </>
  );
}

/** Desktop: File / Outcome / Size; the row is the link to the job. */
function FilesTable({
  files,
  run,
  queuePaused,
}: {
  files: RunFile[];
  run: RunDetail['run'];
  queuePaused: boolean;
}) {
  return (
    <section className="panel run-files">
      <table aria-label="Files">
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Outcome</th>
            <th scope="col">Size</th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => {
            const note = noteText(f, run.testEncode, queuePaused);
            return (
              <tr key={f.jobId} className="row-link">
                <td className="run-cell run-file-name">
                  <Link
                    href={`/jobs/${f.jobId}`}
                    className="job-name row-link-main"
                    title={f.filePath}
                  >
                    {f.fileName}
                  </Link>
                  <VersionNote f={f} run={run} />
                  {note ? <span className="run-file-note">{note}</span> : null}
                </td>
                <td className="run-cell">
                  <FileChip f={f} run={run} />
                </td>
                <td className="run-cell run-size">{sizeText(f, run.testEncode)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** Phone: the Jobs phone list's stacked cards (icon, name, "Replaced · 4.37 GB → 1.00 GB"). */
function FilesCards({
  files,
  run,
  queuePaused,
}: {
  files: RunFile[];
  run: RunDetail['run'];
  queuePaused: boolean;
}) {
  return (
    <div className="run-cards">
      {files.map((f) => {
        const outcome = outcomeOf(f.state);
        const verdict = outcomeVerdict(outcome, run.dryRun);
        const word = dependsWord({ ...f, dryRun: run.dryRun }) ?? outcomeWord(outcome, run.dryRun);
        const size = sizeText(f, run.testEncode);
        // "Queued · Queue paused", "In progress · Paused": the Jobs list's words for a wait.
        const wait = queuedWait(f, queuePaused) ?? (f.paused ? 'Paused' : null);
        const text = [word, wait, size === '—' ? null : size].filter(Boolean).join(' · ');
        return (
          <Link key={f.jobId} href={`/jobs/${f.jobId}`} className="phone-finished">
            <span className={`phone-finished-icon is-${verdict}`}>
              <Icon name={VERDICT_ICON[outcomeVerdict(outcome)]} size={16} strokeWidth={2.6} />
            </span>
            <span className="phone-finished-text">
              <b>
                {f.fileName}
                <VersionNote f={f} run={run} />
              </b>
              <span className={`job-detail-text is-${verdict}`}>{text}</span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}

function RunBody({ detail }: { detail: RunDetail }) {
  const { run, counts, files } = detail;
  const paused = useQueue().status?.paused ?? false;
  const phone = usePhone();
  const waiting = counts.queued + counts.in_progress;
  return (
    <>
      <nav aria-label="Breadcrumb" className="job-crumbs">
        <Link href="/jobs" className="job-crumb-link">
          Jobs
        </Link>
        <span aria-hidden="true">/</span>
      </nav>
      <div className="page-head">
        <div className="head-row run-head-row">
          <div className="run-title-row">
            <h1>{`${detail.workflowName} v${run.workflowVersion}`}</h1>
            {run.dryRun ? <DryRunBadge testEncode={run.testEncode} /> : null}
            {counts.in_progress > 0 && !paused ? <LiveDot /> : null}
          </div>
          {counts.already_processed > 0 ? (
            <div className="head-actions">
              <RunProcessAgain detail={detail} />
            </div>
          ) : null}
        </div>
        <p className="head-sub">
          {'Run on '}
          <span title={run.requestedPath}>{detail.libraryName}</span>
          {' · '}
          <time dateTime={run.createdAt} title={fmtFull(run.createdAt)}>
            {fmtStamp(run.createdAt)}
          </time>
        </p>
        {run.dryRun && run.note === 'no active version' ? (
          <p className="run-note">Dry run · No active version</p>
        ) : null}
      </div>
      {paused && waiting > 0 ? (
        <p className="alert alert-warning queue-paused" role="status">
          {QUEUE_PAUSED_TEXT}
        </p>
      ) : null}
      <RunCounts counts={counts} dryRun={run.dryRun} planOnly={run.dryRun && !run.testEncode} />
      {run.dryRun ? (
        <p className="run-bytes">
          {['Dry run: no file was changed.', estimatedSaving(files, run.testEncode)]
            .filter(Boolean)
            .join(' ')}
        </p>
      ) : null}
      {files.length !== counts.total ? (
        <p className="run-mismatch" role="alert">
          <Icon name="alert" size={16} round />
          {`The list shows ${files.length} of ${counts.total} files.`}
        </p>
      ) : null}
      <section className="run-list" aria-labelledby="run-files-title">
        <SectionHeading id="run-files-title" count={files.length}>
          Files
        </SectionHeading>
        {phone ? (
          <FilesCards files={files} run={run} queuePaused={paused} />
        ) : (
          <FilesTable files={files} run={run} queuePaused={paused} />
        )}
      </section>
    </>
  );
}

export function RunPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { data, error, reload } = useAsync(() => api.runs.get({ id }), [id]);
  useRefetchOn(
    (e: EngineEvent) => (e.type === 'run.changed' || e.type === 'job.changed') && e.runId === id,
    reload,
  );

  // A failed refetch keeps the last counts on screen (with a note) instead of blanking the page.
  const last = useRef<{ id: string; detail: RunDetail } | null>(null);
  if (data) last.current = { id, detail: data };
  const shown = data ?? (last.current?.id === id ? last.current.detail : undefined);
  usePageTitle(shown ? `Run · ${shown.workflowName}` : 'Run');

  if (!shown) {
    if (!error) {
      return (
        <div className="page">
          <Loading label="Loading run…" />
        </div>
      );
    }
    if (describeError(error).code === 'NOT_FOUND') {
      return <NotFound what="run" backHref="/jobs" backLabel="Back to jobs" />;
    }
    return (
      <div className="page">
        <p className="run-error" role="alert">
          <Icon name="alert" size={16} round />
          {describeError(error).message}
        </p>
        <p>
          <Link href="/jobs">Back to jobs</Link>
        </p>
      </div>
    );
  }
  return (
    <div className="page run-page">
      {error ? (
        <p className="run-error" role="alert">
          <Icon name="alert" size={16} round />
          {`Could not refresh: ${describeError(error).message} — showing the last counts.`}
        </p>
      ) : null}
      <RunBody detail={shown} />
    </div>
  );
}
