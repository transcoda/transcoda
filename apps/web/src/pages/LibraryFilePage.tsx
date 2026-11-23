import type { Job, LibraryFileDetail } from '@transcoda/contract';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'wouter';
import { api } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { StatusChip } from '../components/Chips.tsx';
import { Disclosure } from '../components/Disclosure.tsx';
import { Fact } from '../components/Fact.tsx';
import { FilePath } from '../components/FilePath.tsx';
import { Icon } from '../components/Icon.tsx';
import { Loading } from '../components/Loading.tsx';
import { NotFound } from '../components/NotFound.tsx';
import { useAsync } from '../hooks/useAsync.ts';
import { TitleSub } from '../jobs/JobCells.tsx';
import { jobTitle } from '../jobs/mediaText.ts';
import { Poster } from '../jobs/Poster.tsx';
import { fmtBytes } from '../lib/bytes.ts';
import { usePageTitle } from '../lib/pageTitle.ts';
import { fmtFull } from '../lib/time.ts';
import { type Crumb, Crumbs, seasonLabel } from '../libraries/Crumbs.tsx';
import { type ProbeFacts, probeFacts } from '../libraries/probeFacts.ts';
import { RunFilesDialog } from '../libraries/RunFilesDialog.tsx';
import { useLibraryRefetch } from '../libraries/useLibraryListing.ts';
import { JobHistoryTable } from './JobsPage.tsx';

/** Jobs per request; "Show older jobs" asks for the page after the ones on screen. */
const JOBS_PAGE = 50;

/** `Libraries › <Library> › <Show> › Season N`; a movie has the library only. */
function fileCrumbs(libraryId: string, detail: LibraryFileDetail, showTitle: string): Crumb[] {
  const base = `/libraries/${encodeURIComponent(libraryId)}`;
  const crumbs: Crumb[] = [
    { label: 'Libraries', href: '/libraries' },
    { label: detail.file.latest.libraryName, href: base },
  ];
  // The server names the show page and season the titles list files this episode under.
  if (detail.showKey !== null && detail.season !== null) {
    const show = `${base}/shows/${encodeURIComponent(detail.showKey)}`;
    crumbs.push({ label: showTitle, href: show });
    crumbs.push({
      label: seasonLabel(String(detail.season)),
      href: `${show}/seasons/${detail.season}`,
    });
  }
  return crumbs;
}

function TrackFacts({ facts }: { facts: ProbeFacts }) {
  const list = (items: string[]) =>
    items.length === 0 ? (
      'None'
    ) : (
      <ul className="file-tracks">
        {items.map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: tracks are listed in file order and never reordered.
          <li key={`${i}:${t}`}>{t}</li>
        ))}
      </ul>
    );
  return (
    <>
      <Fact term="Container">{facts.container}</Fact>
      <Fact term="Length">{facts.length}</Fact>
      <Fact term="Video">{facts.video ?? 'None'}</Fact>
      <Fact term="Audio">{list(facts.audio)}</Fact>
      <Fact term="Subtitles">{list(facts.subtitles)}</Fact>
    </>
  );
}

/** The jobs on this file: the newest page comes with the file; older pages are asked for. */
function FileJobs({ id, fileId, head }: { id: string; fileId: string; head: LibraryFileDetail }) {
  const [older, setOlder] = useState<{ jobs: Job[]; offset: number }>({ jobs: [], offset: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The older pages were read against the head as it was. When the refreshed head holds other jobs
  // (one arrived or went away), they no longer line up with it: a job at the boundary would go
  // missing and the next page would repeat one. Drop them; "Show older jobs" reads them again.
  const headIds = head.jobs.map((j) => j.id).join('\n');
  const [pagedAgainst, setPagedAgainst] = useState(headIds);
  const headNow = useRef(headIds);
  useEffect(() => {
    headNow.current = headIds;
  }, [headIds]);
  if (pagedAgainst !== headIds) {
    setPagedAgainst(headIds);
    setOlder({ jobs: [], offset: 0 });
  }
  // Show each job once, whatever the pages hold.
  const seen = new Set(head.jobs.map((j) => j.id));
  const jobs = [...head.jobs, ...older.jobs.filter((j) => !seen.has(j.id))];

  async function showOlder() {
    const offset = older.offset + JOBS_PAGE;
    const against = headIds;
    setLoading(true);
    setError(null);
    try {
      const page = await api.libraries.file({
        id,
        fileId,
        jobsOffset: offset,
        jobsLimit: JOBS_PAGE,
      });
      // The head changed while this page was on its way: it was cut from the old list.
      if (headNow.current === against) {
        setOlder((o) => ({ jobs: [...o.jobs, ...page.jobs], offset }));
      }
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section aria-label="Jobs" className="file-jobs">
      <h2 className="file-jobs-title">Jobs</h2>
      {jobs.length === 0 ? (
        <p className="library-empty">No job has run on this file yet.</p>
      ) : (
        <JobHistoryTable jobs={jobs} label="Jobs on this file" />
      )}
      {error ? (
        <div className="alert alert-danger" role="alert">
          <Icon name="cross" strokeWidth={2.4} round />
          <span>{`Could not load older jobs: ${describeError(error).message}`}</span>
        </div>
      ) : null}
      {jobs.length < head.jobsTotal ? (
        <div className="library-more">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={loading}
            onClick={() => void showOlder()}
          >
            Show older jobs
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** `/libraries/:id/files/:fileId`: what one file is now, what it was, and every job that ran on it. */
export function LibraryFilePage() {
  const { id = '', fileId = '' } = useParams<{ id: string; fileId: string }>();
  const detail = useAsync(
    () => api.libraries.file({ id, fileId, jobsOffset: 0, jobsLimit: JOBS_PAGE }),
    [id, fileId],
  );
  useLibraryRefetch(id, detail.reload);
  // The run dialog needs the library's run hours, feeder and recycle folder.
  const library = useAsync(() => api.libraries.get({ id }), [id]);
  const [running, setRunning] = useState<HTMLElement | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const data = detail.data;
  // Title and poster come from the same stored media (the latest job's, else the newest job's that
  // has some); the file name stands in when no job has any.
  const media = data?.file.poster?.media;
  usePageTitle(data ? (media ? jobTitle({ media }) : data.file.fileName) : 'File');

  if (!data) {
    if (detail.error) {
      const failure = describeError(detail.error);
      if (failure.code === 'NOT_FOUND') {
        return (
          <NotFound
            what="file"
            backHref={`/libraries/${encodeURIComponent(id)}`}
            backLabel="Back to library"
          />
        );
      }
      return (
        <div className="page">
          <div className="alert alert-danger" role="alert">
            <Icon name="cross" strokeWidth={2.4} round />
            <span>{`Could not load the file: ${failure.message}`}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={detail.reload}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="page">
        <Loading />
      </div>
    );
  }

  const { file, now, before } = data;
  return (
    <div className="page job-page">
      <header className="job-head">
        <Crumbs crumbs={fileCrumbs(id, data, media?.title ?? file.fileName)} />
        <div className="job-head-body">
          <Poster job={file.poster ?? file.latest} size="page" />
          <div className="job-head-main">
            {file.gone ? (
              <div className="job-head-chips">
                <StatusChip tone="warning" icon="alert">
                  No longer on disk
                </StatusChip>
              </div>
            ) : null}
            <div className="job-title-line">
              <h1>{media?.title ?? file.fileName}</h1>
              {media?.kind === 'movie' && media.year !== null && (
                <span className="job-year">{media.year}</span>
              )}
            </div>
            {media?.kind === 'episode' ? <TitleSub media={media} /> : null}
            <FilePath path={file.path} />
            <dl className="job-facts">
              <Fact term="Size">
                {fmtBytes(file.sizeBytes)}
                {file.originalBytes !== null ? (
                  <span className="file-was">{`was ${fmtBytes(file.originalBytes)}`}</span>
                ) : null}
              </Fact>
              <Fact term="Changed">{fmtFull(file.mtime)}</Fact>
              {now ? (
                <TrackFacts facts={probeFacts(now)} />
              ) : file.gone ? null : (
                <Fact term="Tracks">Not probed yet</Fact>
              )}
            </dl>
            {file.gone ? null : (
              <div className="file-head-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={!library.data}
                  onClick={(e) => {
                    setRunning(e.currentTarget);
                    setRunOpen(true);
                  }}
                >
                  Run a workflow
                </button>
              </div>
            )}
            {file.gone || !library.error || library.data ? null : (
              <div className="alert alert-danger" role="alert">
                <Icon name="cross" strokeWidth={2.4} round />
                <span>{`Could not load the library: ${describeError(library.error).message}`}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={library.reload}>
                  Try again
                </button>
              </div>
            )}
            {before ? (
              <Disclosure title="Before" className="file-before">
                <dl className="job-facts">
                  <Fact term="Size">{fmtBytes(before.sizeBytes)}</Fact>
                  <TrackFacts facts={probeFacts(before)} />
                </dl>
              </Disclosure>
            ) : null}
          </div>
        </div>
      </header>
      {runOpen && library.data ? (
        <RunFilesDialog
          open
          library={library.data}
          selection={{ kind: 'files', fileIds: [file.id] }}
          label="1 file"
          returnFocusTo={running}
          onClose={() => setRunOpen(false)}
        />
      ) : null}
      <FileJobs key={`${id}\n${fileId}`} id={id} fileId={fileId} head={data} />
    </div>
  );
}
