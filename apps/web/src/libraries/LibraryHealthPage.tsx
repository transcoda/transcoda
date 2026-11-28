import type { LibraryFile, LibraryGetOutput } from '@transcoda/contract';
import { useState } from 'react';
import { Link, useParams } from 'wouter';
import { api, isDefinedError, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Dialog } from '../components/Dialog.tsx';
import { Icon } from '../components/Icon.tsx';
import { Loading } from '../components/Loading.tsx';
import { NotFound } from '../components/NotFound.tsx';
import { useToast } from '../components/Toast.tsx';
import { useAsync } from '../hooks/use-async.ts';
import { useCatalog } from '../hooks/use-catalog.ts';
import { TitleSub } from '../jobs/JobCells.tsx';
import { jobTitle } from '../jobs/media-text.ts';
import { usePageTitle } from '../lib/page-title.ts';
import { fmtFull, fmtStamp } from '../lib/time.ts';
import { usePhone } from '../lib/use-phone.ts';
import { Crumbs } from './Crumbs.tsx';
import { Pager } from './LibraryFileTable.tsx';
import { useLibraryFiles, useLibraryRefetch } from './use-library-listing.ts';

const PAGE = 100;

/**
 * What is wrong with the source, from the job's reason: without the "source is damaged:" lead-in
 * and the "nothing was replaced" tail the whole page already says, starting with a capital.
 */
export function damageText(reason: string | null): string {
  const text = (reason ?? '')
    .replace(/^source is damaged:\s*/i, '')
    .replace(/;\s*nothing was replaced$/i, '')
    .trim();
  if (text === '') return 'Damaged';
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** "Radarr" from "Replace damaged file (Radarr)"; the plugin's title names its media manager. */
export function managerOf(stepTitle: string): string {
  return /\(([^)]+)\)\s*$/.exec(stepTitle)?.[1] ?? 'the media manager';
}

const and = (words: string[]) =>
  words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;

const fileHref = (libraryId: string, fileId: string) =>
  `/libraries/${encodeURIComponent(libraryId)}/files/${encodeURIComponent(fileId)}`;

/** When the check found it: the job's finish (its queue time while it has none). */
const foundAt = (file: LibraryFile) => file.latest.finishedAt ?? file.latest.queuedAt;

type Replace = { workflowId: string; workflowName: string; steps: string[] } | null;

/**
 * A library's damaged files: the present files whose latest job found the source damaged
 * (Check source's Damaged output, or Render's decode check), newest first, each with what is wrong,
 * when, its job and its file page. When the workflow that feeds the library has a Replace damaged
 * file step (a Sonarr or Radarr plugin), each row can run it again on the file: the step then asks
 * the media manager for a new copy. Without one the page says where to add it, or which plugin
 * brings it. Cards on a phone.
 */
export function LibraryHealthPage() {
  const { id } = useParams<{ id: string }>();
  const library = useAsync(() => api.libraries.get({ id }), [id]);
  useLibraryRefetch(id, library.reload);
  usePageTitle(library.data ? `Damaged files · ${library.data.name}` : 'Damaged files');

  if (!library.data) {
    if (library.error) {
      const failure = describeError(library.error);
      if (failure.code === 'NOT_FOUND') {
        return <NotFound what="library" backHref="/libraries" backLabel="Back to libraries" />;
      }
      return (
        <div className="page">
          <div className="alert alert-danger" role="alert">
            <Icon name="cross" round />
            <span>{`Could not load the library: ${failure.message}`}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={library.reload}>
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
  const lib = library.data;
  const replace: Replace =
    lib.feeds !== null && lib.replaceDamaged.length > 0
      ? {
          workflowId: lib.feeds.workflowId,
          workflowName: lib.feeds.name,
          steps: lib.replaceDamaged,
        }
      : null;

  return (
    <div className="page health-page">
      <header className="library-head">
        <Crumbs
          crumbs={[
            { label: 'Libraries', href: '/libraries' },
            { label: lib.name, href: `/libraries/${encodeURIComponent(lib.id)}` },
            { label: 'Damaged files', href: null },
          ]}
        />
        <div className="page-head">
          <h1>Damaged files</h1>
          <p>Files whose latest check found the source damaged. Transcoda kept them as they are.</p>
        </div>
      </header>
      <ReplaceNote library={lib} replace={replace} />
      <DamagedList library={lib} replace={replace} />
    </div>
  );
}

/** How a damaged file gets replaced here, or what it takes. */
function ReplaceNote({ library, replace }: { library: LibraryGetOutput; replace: Replace }) {
  const { catalog } = useCatalog();
  if (replace) {
    const managers = [...new Set(replace.steps.map(managerOf))];
    return (
      <p className="health-note">
        {`Replace runs ${replace.workflowName} on the file again. If it is still damaged, ${and(replace.steps)} asks ${and(managers)} for a new copy.`}
      </p>
    );
  }
  const ready = (catalog?.nodes ?? []).filter(
    (n) => n.damagedOnly === true && n.availability.available,
  );
  const first = ready[0];
  if (first) {
    return (
      <p className="health-note">
        {`${first.title} can ask ${managerOf(first.title)} for a new copy. Add it after Check source's Damaged output in `}
        {library.feeds ? (
          <Link href={`/workflows/${encodeURIComponent(library.feeds.workflowId)}`}>
            {library.feeds.name}
          </Link>
        ) : (
          'the workflow that feeds this library'
        )}
        .
      </p>
    );
  }
  return (
    <p className="health-note">
      {'With the Sonarr or Radarr plugin, a Replace damaged file step can ask for a new copy ('}
      <Link href="/plugins">Plugins</Link>
      {').'}
    </p>
  );
}

function DamagedList({ library, replace }: { library: LibraryGetOutput; replace: Replace }) {
  const phone = usePhone();
  const [offset, setOffset] = useState(0);
  const files = useLibraryFiles(library.id, {
    damaged: true,
    sort: 'lastRun',
    desc: true,
    offset,
    limit: PAGE,
  });
  if (!files.data) {
    if (files.error) {
      return (
        <div className="alert alert-danger" role="alert">
          <Icon name="cross" round />
          <span>{`Could not load the damaged files: ${describeError(files.error).message}`}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={files.reload}>
            Try again
          </button>
        </div>
      );
    }
    return <Loading label="Loading damaged files…" />;
  }
  const { files: rows, total } = files.data;
  // A refresh shrank the list below this page: go back to its last page.
  if (offset > 0 && offset >= total) setOffset(Math.max(0, Math.ceil(total / PAGE) - 1) * PAGE);
  if (total === 0) {
    return (
      <p className="library-empty">{`No damaged files in ${library.name}. Files a Check source step finds damaged are listed here.`}</p>
    );
  }
  const pager = (
    <Pager total={total} count={rows.length} offset={offset} limit={PAGE} onPage={setOffset} />
  );

  if (phone) {
    return (
      <div className="library-files">
        <section className="phone-section" aria-label="Damaged files">
          {rows.map((file) => (
            <div key={file.id} className="phone-card">
              <div className="phone-card-head">
                <FileLink libraryId={library.id} file={file} />
              </div>
              <TitleSub media={file.latest.media} />
              <span className="health-reason">{damageText(file.latest.reason)}</span>
              <span className="phone-card-line">
                <Found file={file} />
                {' · '}
                <Link href={`/jobs/${encodeURIComponent(file.latest.id)}`}>Job</Link>
              </span>
              {replace ? (
                <div className="phone-card-actions">
                  <ReplaceButton file={file} replace={replace} onQueued={files.reload} />
                </div>
              ) : null}
            </div>
          ))}
        </section>
        {pager}
      </div>
    );
  }

  return (
    <div className="library-files">
      <section className="panel health-table">
        <table aria-label="Damaged files">
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">What's wrong</th>
              <th scope="col">Found</th>
              <th scope="col">Job</th>
              {replace ? (
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((file) => (
              <tr key={file.id}>
                <td className="health-cell">
                  <div className="health-file">
                    <FileLink libraryId={library.id} file={file} />
                    <TitleSub media={file.latest.media} />
                  </div>
                </td>
                <td className="health-cell health-reason">{damageText(file.latest.reason)}</td>
                <td className="health-cell health-when">
                  <Found file={file} />
                </td>
                <td className="health-cell">
                  <Link
                    href={`/jobs/${encodeURIComponent(file.latest.id)}`}
                    className="text-target"
                  >
                    Job
                  </Link>
                  <span className="health-workflow">{file.latest.workflowName}</span>
                </td>
                {replace ? (
                  <td className="health-cell health-actions">
                    <ReplaceButton file={file} replace={replace} onQueued={files.reload} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {pager}
    </div>
  );
}

function FileLink({ libraryId, file }: { libraryId: string; file: LibraryFile }) {
  return (
    <Link
      href={fileHref(libraryId, file.id)}
      className="job-name health-title"
      aria-label={jobTitle(file.latest)}
      title={file.fileName}
    >
      {file.latest.media.title}
    </Link>
  );
}

function Found({ file }: { file: LibraryFile }) {
  const when = foundAt(file);
  return (
    <time dateTime={when} title={fmtFull(when)}>
      {fmtStamp(when)}
    </time>
  );
}

/**
 * Replace: asks first, then runs the feeding workflow's active version on the file again (a real
 * run, even if that version already processed it). Its Replace damaged file step runs if the file
 * is still damaged. The page stays: the file leaves the list while its new job runs.
 */
function ReplaceButton({
  file,
  replace,
  onQueued,
}: {
  file: LibraryFile;
  replace: NonNullable<Replace>;
  onQueued(): void;
}) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = file.latest.media.title;
  const managers = and([...new Set(replace.steps.map(managerOf))]);

  async function queue(): Promise<void> {
    setConfirm(false);
    setBusy(true);
    const [err, out] = await safe(
      api.jobs.queue({
        path: file.path,
        workflowId: replace.workflowId,
        dryRun: false,
        force: true,
        fileOnly: true,
      }),
    );
    setBusy(false);
    const failed = `Couldn't queue ${title}`;
    if (err) {
      if (isDefinedError(err) && err.code === 'PATH_REJECTED') {
        toast.error(`${failed}: ${err.data.reason}`);
      } else if (isDefinedError(err) && err.code === 'WORKFLOW_INVALID') {
        toast.error(`${failed}: the workflow version can't run`);
      } else toast.error(`${failed}: ${describeError(err).message}`);
      return;
    }
    if (out.jobIds.length === 0) toast.error(`${failed}: the file is no longer there`);
    else if (out.dryRun) toast.info(`${replace.workflowName} has no active version: dry run`);
    else toast.success(`Queued ${title}: ${replace.workflowName} checks it again`);
    onQueued();
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        disabled={busy}
        aria-label={`Replace ${title}`}
        onClick={() => setConfirm(true)}
      >
        <Icon name="replace" size={14} />
        Replace
      </button>
      <Dialog
        open={confirm}
        title={`Replace ${title}?`}
        onClose={() => setConfirm(false)}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              data-autofocus
              onClick={() => setConfirm(false)}
            >
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void queue()}>
              Replace
            </button>
          </>
        }
      >
        <p>
          {`${replace.workflowName} runs on this file again. If it is still damaged, ${and(replace.steps)} asks ${managers} to delete it and search for a new copy.`}
        </p>
      </Dialog>
    </>
  );
}
