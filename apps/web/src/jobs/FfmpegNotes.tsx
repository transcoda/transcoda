import type { JobDetail } from '@transcoda/contract';
import { isFinalState } from '@transcoda/shared';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Icon } from '../components/Icon.tsx';
import { useToast } from '../components/Toast.tsx';
import { copyShortcut, copyText } from '../lib/clipboard.ts';
import { CommandBlock } from './CommandBlock.tsx';
import { ffmpegNotes, logLineCount, shownLog } from './logNotes.ts';

/** Where the whole log downloads from (the server's `JOB_LOG_PATH`). */
export const jobLogDownloadUrl = (id: string) =>
  `/api/v1/jobs/${encodeURIComponent(id)}/log/download`;

/** The job's log as {@link useJobLog} reads it: shared by the notes and the raw output. */
export type JobLog = ReturnType<typeof useJobLog>;

/**
 * The job's ffmpeg log (its tail, `jobs.log`): read when the page opens, again when the job moves
 * to another state (so a running job's notes catch up and a finished one's log has its end), and
 * when the raw output is opened while the job runs. `state` null (the job not loaded yet): not read.
 */
export function useJobLog(id: string, state: JobDetail['state'] | null) {
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
    if (state !== null) void load();
  }, [load, state]);
  return { log, error, loading, load };
}

/**
 * Screen 06b "Notes from ffmpeg": the known warnings in the job's log as plain cards (tagged
 * warning or expected). Only when there is something to note (or the log could not be read):
 * an empty section is not shown. `raw` adds the raw output under the notes, for a job that has
 * no Result card to carry it (one still running). Warnings that are not known stay in the raw
 * output only.
 */
export function FfmpegNotes({
  job,
  jobLog,
  raw = false,
}: {
  job: JobDetail;
  jobLog: JobLog;
  raw?: boolean;
}) {
  const headingId = useId();
  const { log, error, loading, load } = jobLog;
  const notes = useMemo(() => (log ? ffmpegNotes(log, job.probe) : []), [log, job.probe]);
  const command = job.result?.command ?? null;
  const withRaw = raw && Boolean(log || command);
  if (notes.length === 0 && !error && !withRaw) return null;
  const n = notes.length;
  const summary =
    n === 0
      ? null
      : `${n} ${n === 1 ? 'note' : 'notes'}${job.state === 'failed' ? '' : ', nothing blocking'}`;
  return (
    <section className="panel ffmpeg-notes" aria-labelledby={headingId}>
      <div className="ffmpeg-notes-head">
        <h2 id={headingId} className="section-h2">
          Notes from ffmpeg
        </h2>
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
      {notes.length > 0 && (
        <ul className="ffmpeg-note-cards">
          {notes.map((note) => (
            <li key={note.key} className="ffmpeg-note">
              <div className="ffmpeg-note-head">
                <span className={`ffmpeg-note-tag is-${note.tag}`}>
                  {note.tag === 'warning' ? 'Warning' : 'Expected'}
                </span>
                <b>{note.title}</b>
              </div>
              <p>{note.text}</p>
            </li>
          ))}
        </ul>
      )}
      {withRaw && <RawOutput job={job} jobLog={jobLog} />}
    </section>
  );
}

/** "Show command and log", "Show command, error and log", "Show log" … */
function rawLabel(parts: string[]): string {
  if (parts.length <= 1) return `Show ${parts[0] ?? 'output'}`;
  return `Show ${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/**
 * The raw output behind one collapsed disclosure: the ffmpeg command with Copy, a failed job's
 * error exactly as the engine wrote it (`error`), and ffmpeg's log (its tail) with Copy and
 * "Download full log" (the whole file). Nothing when there is none of them.
 */
export function RawOutput({
  job,
  jobLog,
  error = null,
}: {
  job: JobDetail;
  jobLog: JobLog;
  error?: string | null;
}) {
  const toast = useToast();
  const pre = useRef<HTMLPreElement>(null);
  const { log, loading, load } = jobLog;
  const final = isFinalState(job.state);
  const shown = useMemo(() => (log ? shownLog(log) : ''), [log]);
  const planOnly = job.dryRun && !job.testEncode;
  const command = job.result?.command ?? null;
  if (!command && !error && !log) return null;
  const parts = [
    ...(command ? ['command'] : []),
    ...(error ? ['error'] : []),
    ...(log ? ['log'] : []),
  ];

  async function copy() {
    const result = await copyText(shown, pre.current);
    if (result === 'copied') toast.success('Copied');
    else if (result === 'selected') toast.info(`Selected. Press ${copyShortcut()} to copy.`);
    else toast.info(`Select the output and press ${copyShortcut()} to copy.`);
  }

  return (
    <details
      className="ffmpeg-raw"
      onToggle={(e) => {
        if (e.currentTarget.open && !final && !loading) void load();
      }}
    >
      <summary>
        <Icon name="chevron-right" size={12} strokeWidth={2.6} />
        {rawLabel(parts)}
        {log ? (
          <span className="ffmpeg-raw-count">{`${logLineCount(log).toLocaleString('en')} ${
            logLineCount(log) === 1 ? 'line' : 'lines'
          }`}</span>
        ) : null}
      </summary>
      <div className="ffmpeg-raw-body">
        {command && <CommandBlock command={command} notRun={planOnly} level={3} />}
        {error && (
          <>
            <h3 className="ffmpeg-raw-label">Error</h3>
            <pre className="job-log-text">{error}</pre>
          </>
        )}
        {log && (
          <>
            <h3 className="ffmpeg-raw-label">Log</h3>
            <pre ref={pre} className="job-log-text">
              {shown}
            </pre>
            <div className="ffmpeg-raw-actions">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => void copy()}>
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
  );
}
