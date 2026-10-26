import type { RunDetail } from '@transcoda/contract';
import { useRef } from 'react';
import { Link, useParams } from 'wouter';
import { api } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Icon } from '../components/Icon.tsx';
import { LiveDot } from '../components/LiveDot.tsx';
import { Loading } from '../components/Loading.tsx';
import { NotFound } from '../components/NotFound.tsx';
import { useAsync } from '../hooks/useAsync.ts';
import type { EngineEvent } from '../hooks/useEvents.ts';
import { useRefetchOn } from '../hooks/useRefetchOn.ts';
import { DryRunBadge } from '../jobs/JobStateChip.tsx';
import {
  dependsWord,
  detailsLinkName,
  estimatePercent,
  reasonOf,
  sentence,
  testEncodeLine,
} from '../jobs/jobText.ts';
import { QUEUE_PAUSED_TEXT } from '../jobs/QueueBar.tsx';
import { OutcomeChip, outcomeOf, RunCounts } from '../jobs/RunCounts.tsx';
import { useQueue } from '../jobs/useQueue.ts';
import { fmtBytes, fmtSaving } from '../lib/bytes.ts';
import { usePageTitle } from '../lib/pageTitle.ts';

type RunFile = RunDetail['files'][number];

/** What happened to the original, appended to the reason so no file's fate is left implied. */
function fateNote(f: RunFile): string | null {
  // A dry run's own fate: nothing was written, whatever the plan would have done.
  if (f.state === 'dry_run') return 'no file changed';
  if (f.state === 'done') {
    if (f.replacedTo === 'recycle') return 'original in recycle folder';
    if (f.replacedTo === 'deleted') return 'original deleted';
    return null;
  }
  // The engine never fails or keeps a file after writing to it (a write ends the job as done).
  if (f.state === 'failed' || f.state === 'kept_original') return 'original untouched';
  return null;
}

/** The estimate a dry-run file carries (only a file that would be rewritten has one). */
const estimateOf = (f: RunFile): number | null => (f.state === 'dry_run' ? f.estimatedBytes : null);

/** A test-encode file that would be rewritten: the size its output measured. */
const measuredOf = (f: RunFile): number | null => (f.state === 'dry_run' ? f.afterBytes : null);

/** A test-encode file's measured outcome ("Would replace · 315 MB → 190 MB (−40%)"), else null. */
function measuredLine(f: RunFile): string | null {
  return testEncodeLine({
    state: f.state,
    dryRun: true,
    testEncode: true,
    reason: f.reason,
    result: {
      outcome: f.state,
      beforeBytes: f.beforeBytes,
      afterBytes: f.afterBytes,
      replacedTo: null,
    },
  });
}

function reasonText(f: RunFile, testEncode: boolean): string {
  // A test-encode's measured outcome is its reason, where a plan-only dry run shows its plan.
  const measured = testEncode ? measuredLine(f) : null;
  if (measured) return measured;
  // A dry run's own plan summary is its reason, and says more than "no file changed".
  if (f.state === 'dry_run' && f.planSummary) return sentence(f.planSummary);
  // The plan summary (a dry run's reason) comes first; the first letter is capital, like every value.
  const text = [reasonOf(f), fateNote(f)].filter(Boolean).join(' · ');
  return text ? sentence(text) : '—';
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

function RunBody({ detail }: { detail: RunDetail }) {
  const { run, counts, files } = detail;
  const paused = useQueue().status?.paused ?? false;
  const waiting = counts.queued + counts.in_progress;
  return (
    <>
      <nav aria-label="Breadcrumb" className="job-crumbs">
        <Link href="/jobs" className="job-crumb-link">
          Jobs
        </Link>
        <span aria-hidden="true">/</span>
        <span>{`Run · ${detail.workflowName} v${run.workflowVersion}`}</span>
      </nav>
      <div className="page-head">
        <div className="run-title-row">
          <h1>{`Run · ${detail.workflowName} v${run.workflowVersion} · ${detail.libraryName}`}</h1>
          {run.dryRun ? <DryRunBadge testEncode={run.testEncode} /> : null}
          {counts.in_progress > 0 && !paused ? <LiveDot /> : null}
        </div>
        {run.dryRun && run.note === 'no active version' ? (
          <p className="run-note">Dry run · No active version</p>
        ) : null}
        <p className="mono run-path">{run.requestedPath}</p>
      </div>
      {paused && waiting > 0 ? (
        <p className="alert alert-warning queue-paused" role="status">
          {QUEUE_PAUSED_TEXT}
        </p>
      ) : null}
      <RunCounts counts={counts} dryRun={run.dryRun} planOnly={run.dryRun && !run.testEncode} />
      <p className="run-bytes">
        {counts.done > 0
          ? `${fmtBytes(counts.beforeBytes)} → ${fmtBytes(counts.afterBytes)}, ${fmtSaving(counts.beforeBytes, counts.afterBytes)}`
          : run.dryRun
            ? ['Dry run: no file was changed.', estimatedSaving(files, run.testEncode)]
                .filter(Boolean)
                .join(' ')
            : waiting > 0
              ? 'No file replaced yet.'
              : 'No file replaced.'}
      </p>
      {files.length !== counts.total ? (
        <p className="run-mismatch" role="alert">
          <Icon name="alert" size={16} round />
          {`The list shows ${files.length} of ${counts.total} files.`}
        </p>
      ) : null}
      <section className="panel run-files">
        <table aria-label="Files">
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Outcome</th>
              <th scope="col">Reason</th>
              <th scope="col">Size</th>
              <th scope="col">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.jobId}>
                <td className="run-cell run-file-name" title={f.filePath}>
                  {f.fileName}
                  {f.workflowVersion !== run.workflowVersion ? (
                    <>
                      {' '}
                      <span className="run-file-version">
                        <span className="sr-only">ran on </span>v{f.workflowVersion}
                      </span>
                    </>
                  ) : null}
                </td>
                <td className="run-cell">
                  <OutcomeChip
                    outcome={outcomeOf(f.state)}
                    dryRun={run.dryRun}
                    testEncode={run.testEncode}
                    word={dependsWord({ ...f, dryRun: run.dryRun })}
                    estimate={
                      f.dependsOnSize
                        ? null
                        : estimatePercent(
                            f.beforeBytes,
                            run.testEncode ? measuredOf(f) : estimateOf(f),
                          )
                    }
                  />
                </td>
                <td className="run-cell">{reasonText(f, run.testEncode)}</td>
                <td className="run-cell run-size">{sizeText(f, run.testEncode)}</td>
                <td className="run-cell">
                  <Link
                    className="job-details-link"
                    href={`/jobs/${f.jobId}`}
                    aria-label={detailsLinkName(f.fileName)}
                  >
                    Details
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
