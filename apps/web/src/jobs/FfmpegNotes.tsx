import type { JobDetail } from '@transcoda/contract';
import { isFinalState } from '@transcoda/shared';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Icon } from '../components/Icon.tsx';
import { Loading } from '../components/Loading.tsx';
import { useToast } from '../components/Toast.tsx';
import { copyShortcut, copyText } from '../lib/clipboard.ts';
import { CommandBlock } from './CommandBlock.tsx';
import { ffmpegNotes, logLineCount, shownLog } from './logNotes.ts';

/** Where the whole log downloads from (the server's `JOB_LOG_PATH`). */
export const jobLogDownloadUrl = (id: string) =>
  `/api/v1/jobs/${encodeURIComponent(id)}/log/download`;

/**
 * The job's ffmpeg log (its tail, `jobs.log`): read when the page opens, again when the job moves
 * to another state (so a running job's notes catch up and a finished one's log has its end), and
 * when the raw output is opened while the job runs.
 */
function useJobLog(id: string, state: JobDetail['state']) {
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    const [err, out] = await safe(api.jobs.log({ id }));
    if (n !== seq.current) return;
    setLoading(false);
    if (err) setError(describeError(err).message);
    else {
      setError(null);
      setLog(out.log);
    }
  }, [id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `state` is the trigger to read again.
  useEffect(() => {
    void load();
  }, [load, state]);
  return { log, error, loading, load };
}

/**
 * Screen 06b "Notes from ffmpeg": the known warnings in the job's log as plain cards (tagged
 * warning or expected), and the raw output collapsed below them with the ffmpeg command, Copy and
 * "Download full log" (the whole file; the page reads only its tail). Warnings that are not known
 * stay in the raw output only.
 */
export function FfmpegNotes({ job }: { job: JobDetail }) {
  const headingId = useId();
  const toast = useToast();
  const pre = useRef<HTMLPreElement>(null);
  const final = isFinalState(job.state);
  const { log, error, loading, load } = useJobLog(job.id, job.state);
  const notes = useMemo(() => (log ? ffmpegNotes(log, job.probe) : []), [log, job.probe]);
  const shown = useMemo(() => (log ? shownLog(log) : ''), [log]);
  const planOnly = job.dryRun && !job.testEncode;
  const command = job.result?.command ?? null;

  let summary: string | null = null;
  if (log === '') {
    if (planOnly) summary = "ffmpeg doesn't run in a plan-only dry run.";
    else summary = final ? 'ffmpeg wrote no log for this job.' : 'No log output yet.';
  } else if (log !== null) {
    const n = notes.length;
    summary =
      n === 0
        ? 'Nothing to note.'
        : `${n} ${n === 1 ? 'note' : 'notes'}${job.state === 'failed' ? '' : ', nothing blocking'}`;
  }

  async function copy() {
    const result = await copyText(shown, pre.current);
    if (result === 'copied') toast.success('Copied');
    else if (result === 'selected') toast.info(`Selected. Press ${copyShortcut()} to copy.`);
    else toast.info(`Select the output and press ${copyShortcut()} to copy.`);
  }

  return (
    <section className="panel ffmpeg-notes" aria-labelledby={headingId}>
      <div className="ffmpeg-notes-head">
        <h2 id={headingId}>Notes from ffmpeg</h2>
        {summary && <span className="ffmpeg-notes-summary">{summary}</span>}
      </div>
      {error && (
        <div className="ffmpeg-notes-error" role="alert">
          <p>{`Couldn't load the log: ${error}`}</p>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={loading}
            onClick={() => void load()}
          >
            Try again
          </button>
        </div>
      )}
      {log === null && loading && !error && <Loading inline label="Reading the log…" />}
      {notes.length > 0 && (
        <ul className="ffmpeg-note-cards">
          {notes.map((n) => (
            <li key={n.key} className="ffmpeg-note">
              <div className="ffmpeg-note-head">
                <span className={`ffmpeg-note-tag is-${n.tag}`}>
                  {n.tag === 'warning' ? 'Warning' : 'Expected'}
                </span>
                <b>{n.title}</b>
              </div>
              <p>{n.text}</p>
            </li>
          ))}
        </ul>
      )}
      {(log || command) && (
        <details
          className="ffmpeg-raw"
          onToggle={(e) => {
            if (e.currentTarget.open && !final && !loading) void load();
          }}
        >
          <summary>
            <Icon name="chevron-right" size={12} strokeWidth={2.6} />
            Raw ffmpeg output
            {log ? (
              <span className="ffmpeg-raw-count">{`${logLineCount(log).toLocaleString('en')} ${
                logLineCount(log) === 1 ? 'line' : 'lines'
              }`}</span>
            ) : null}
          </summary>
          <div className="ffmpeg-raw-body">
            {command && <CommandBlock command={command} notRun={planOnly} level={3} />}
            {log && (
              <>
                <h3 className="ffmpeg-raw-label">Log</h3>
                <pre ref={pre} className="job-log-text">
                  {shown}
                </pre>
                <div className="ffmpeg-raw-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => void copy()}
                  >
                    <Icon name="copy" size={14} />
                    Copy
                  </button>
                  <a className="btn btn-sm btn-ghost" href={jobLogDownloadUrl(job.id)} download>
                    <Icon name="download" size={14} />
                    Download full log
                  </a>
                </div>
              </>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
