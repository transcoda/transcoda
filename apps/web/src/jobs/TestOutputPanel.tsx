import type { JobDetail } from '@transcoda/contract';
import { useEffect, useId, useState } from 'react';
import { api, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Icon } from '../components/Icon.tsx';
import { useToast } from '../components/Toast.tsx';
import { fmtBytes } from '../lib/bytes.ts';
import { previewNotes } from './previewCodecs.ts';

type PanelJob = Pick<JobDetail, 'id' | 'testEncode' | 'testOutput' | 'testOutputNote'> &
  Partial<Pick<JobDetail, 'plan'>>;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const pad = (n: number) => String(n).padStart(2, '0');

/** "14:05" today (local, 24-hour); "Thu 09:15" on another day. */
export function keptUntilText(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? time : `${WEEKDAYS[d.getDay()]} ${time}`;
}

/** The line for a test output that is not (or no longer) kept; null when there is nothing to say. */
function noteLine(note: string | null): string | null {
  return note ? `Test output ${note}` : null;
}

/** `busy`, `scratchLow` and `failed`: the server could not prepare the preview now (Try again). */
type Player = 'closed' | 'open' | 'gone' | 'unplayable' | 'busy' | 'scratchLow' | 'failed';

const RETRY_LINES = {
  busy: 'The server is busy preparing other previews. Try again in a few seconds.',
  scratchLow: 'Not enough scratch space to prepare the preview.',
  failed: 'Could not prepare the preview. Use Download to get the file instead.',
} as const;

/**
 * A test-encode's kept output on the job page: until when it is kept, its size, and Play (an
 * inline player on the `?play=1` URL; for mkv the server builds an mp4 preview on the first play,
 * which can take a minute, so "Preparing preview…" shows until the video has its metadata),
 * Download and Delete now. Above the player it names, from the plan's output tracks, a video or
 * audio codec this browser cannot play, or audio the mkv's preview cannot carry (it copies only,
 * never encodes). Play and Download go at `keptUntil` without a reload. A player error is
 * checked with a HEAD on the play URL: 404 means the output is gone (the page is told); its
 * `x-preview` header tells a busy server, too little scratch space or a failed build (each with
 * Try again) from a preview this browser cannot play (Download instead). Without an output, one
 * line says why (the server's note); nothing when there is no note.
 */
export function TestOutputPanel({ job, onChanged }: { job: PanelJob; onChanged(): void }) {
  const headingId = useId();
  const deleteHintId = useId();
  const toast = useToast();
  const keptUntil = job.testOutput?.keptUntil ?? null;
  const [expired, setExpired] = useState(
    () => keptUntil !== null && Date.parse(keptUntil) <= Date.now(),
  );
  const [player, setPlayer] = useState<Player>('closed');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (keptUntil === null) return;
    const left = Date.parse(keptUntil) - Date.now();
    setExpired(left <= 0);
    if (left <= 0) return;
    const timer = setTimeout(() => setExpired(true), left);
    return () => clearTimeout(timer);
  }, [keptUntil]);

  if (!job.testEncode) return null;

  const url = `/api/v1/jobs/${encodeURIComponent(job.id)}/test-output`;

  async function remove() {
    setBusy(true);
    const [err] = await safe(api.jobs.deleteTestOutput({ id: job.id }));
    setBusy(false);
    if (!err || describeError(err).code === 'NOT_FOUND') onChanged();
    else toast.error("Couldn't delete the test output");
  }

  async function playerFailed() {
    let status = 0;
    let preview: string | null = null;
    try {
      const res = await fetch(`${url}?play=1`, { method: 'HEAD', credentials: 'same-origin' });
      status = res.status;
      preview = res.headers.get('x-preview');
    } catch {
      // Unreachable: treat as not playable; Download says the rest.
    }
    if (status === 404) {
      setPlayer('gone');
      onChanged();
    } else if (preview === 'busy' || preview === 'building') {
      setPlayer('busy');
    } else if (preview === 'scratchLow') {
      setPlayer('scratchLow');
    } else if (preview === 'none') {
      setPlayer('failed');
    } else {
      setPlayer('unplayable');
    }
  }

  const retry = player === 'busy' || player === 'scratchLow' || player === 'failed';

  const output = job.testOutput;
  const notes = output && player !== 'closed' ? previewNotes(job.plan, output.container) : null;
  if (!output || expired) {
    const line = output ? 'Test output expired' : noteLine(job.testOutputNote);
    if (!line) return null;
    return (
      <section className="panel test-output" aria-label="Test output">
        <p className="test-output-note">{line}</p>
      </section>
    );
  }

  if (player === 'gone') {
    return (
      <section className="panel test-output" aria-label="Test output">
        <p className="test-output-note" role="status">
          This test output is gone.
        </p>
      </section>
    );
  }

  return (
    <section className="panel test-output" aria-labelledby={headingId}>
      <div className="test-output-head">
        <h2 id={headingId} className="test-output-title">
          {`Test output kept until ${keptUntilText(output.keptUntil)}`}
        </h2>
        <span className="test-output-size">{fmtBytes(output.sizeBytes)}</span>
      </div>
      <div className="test-output-actions">
        {retry && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setLoaded(false);
              setPlayer('open');
            }}
          >
            <Icon name="play" size={14} />
            Try again
          </button>
        )}
        {player !== 'unplayable' && !retry && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-expanded={player === 'open'}
            onClick={() => {
              setLoaded(false);
              setPlayer(player === 'open' ? 'closed' : 'open');
            }}
          >
            <Icon name="play" size={14} />
            {player === 'open' ? 'Hide player' : 'Play'}
          </button>
        )}
        <a className="btn btn-sm btn-ghost" href={url} download>
          <Icon name="download" size={14} />
          Download
        </a>
        <button
          type="button"
          className="btn btn-sm btn-danger-outline"
          disabled={busy}
          aria-describedby={deleteHintId}
          onClick={() => void remove()}
        >
          <Icon name="trash" size={14} />
          Delete now
        </button>
        <span id={deleteHintId} className="sr-only">
          Removes the kept output; the job result stays
        </span>
      </div>
      {player === 'unplayable' && (
        <p className="test-output-note" role="status">
          {notes?.unplayableVideo
            ? `Could not play the preview: this browser can't play ${notes.unplayableVideo} video. Use Download to get the file instead.`
            : 'Could not play the preview. Use Download to get the file instead.'}
        </p>
      )}
      {retry && (
        <p className="test-output-note" role="status">
          {RETRY_LINES[player]}
        </p>
      )}
      {player === 'open' &&
        notes?.lines.map((line) => (
          <p key={line} className="test-output-note">
            {line}
          </p>
        ))}
      {player === 'open' && !loaded && (
        <p className="test-output-note" role="status">
          Preparing preview…
        </p>
      )}
      {player === 'open' && (
        // biome-ignore lint/a11y/useMediaCaption: a test encode of the user's own file has no captions to offer.
        <video
          className="test-output-video"
          controls
          preload="metadata"
          src={`${url}?play=1`}
          onLoadedMetadata={() => setLoaded(true)}
          onError={() => void playerFailed()}
        />
      )}
    </section>
  );
}
