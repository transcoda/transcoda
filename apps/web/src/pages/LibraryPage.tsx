import type { Library } from '@transcoda/contract';
import { useEffect, useId, useState } from 'react';
import { Link, useParams } from 'wouter';
import { api } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Icon } from '../components/Icon.tsx';
import { Loading } from '../components/Loading.tsx';
import { NotFound } from '../components/NotFound.tsx';
import { SegmentedSwitch } from '../components/SegmentedSwitch.tsx';
import { useAsync } from '../hooks/useAsync.ts';
import { usePageTitle } from '../lib/pageTitle.ts';
import {
  useLibraryFiles,
  useLibrarySeasons,
  useLibraryTitles,
} from '../libraries/useLibraryListing.ts';
import { useScanNow } from '../libraries/useScanNow.tsx';
import { type LibraryView, readLibraryView, writeLibraryView } from '../libraries/viewPref.ts';

/** How long the search box waits after the last keystroke before asking the server. */
const SEARCH_DEBOUNCE_MS = 250;
/** Titles per page (Task 9's "Show more" adds this much each time). */
const TITLES_PAGE = 60;
const FILES_PAGE = 100;

const VIEW_OPTIONS: ReadonlyArray<{ id: LibraryView; label: string }> = [
  { id: 'posters', label: 'Posters' },
  { id: 'table', label: 'Table' },
];

const fileCount = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'file' : 'files'}`;

/** `value`, once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

const seasonLabel = (season: string) => (season === 'none' ? 'No season' : `Season ${season}`);

// The three bodies below are shells: the poster grid, the season grid and the file table fill them.

function TitlesBody({ id, search }: { id: string; search: string }) {
  useLibraryTitles(id, { search, limit: TITLES_PAGE, offset: 0 });
  return <section aria-label="Titles" />;
}

function SeasonsBody() {
  return <section aria-label="Seasons" />;
}

function FilesBody({
  id,
  show,
  season,
  search,
}: {
  id: string;
  show: string | undefined;
  season: string | undefined;
  search: string;
}) {
  useLibraryFiles(id, {
    ...(show !== undefined ? { show } : {}),
    ...(season !== undefined ? { season } : {}),
    ...(search ? { search } : {}),
    sort: 'title',
    desc: false,
    offset: 0,
    limit: FILES_PAGE,
  });
  return (
    <table aria-label="Files">
      <thead>
        <tr>
          <th scope="col">File</th>
        </tr>
      </thead>
    </table>
  );
}

/** `Libraries › <Library> › <Show> › Season N`; the last crumb is the current page. */
function Breadcrumbs({
  library,
  show,
  showTitle,
  season,
}: {
  library: Library;
  show: string | undefined;
  showTitle: string | undefined;
  season: string | undefined;
}) {
  const base = `/libraries/${encodeURIComponent(library.id)}`;
  const showHref = show === undefined ? null : `${base}/shows/${encodeURIComponent(show)}`;
  const crumbs: Array<{ label: string; href: string | null }> = [
    { label: 'Libraries', href: '/libraries' },
    { label: library.name, href: show === undefined ? null : base },
  ];
  if (showHref)
    crumbs.push({ label: showTitle ?? 'Show', href: season === undefined ? null : showHref });
  if (season !== undefined) crumbs.push({ label: seasonLabel(season), href: null });
  return (
    <nav aria-label="Breadcrumb" className="job-crumbs">
      {crumbs.map((c, i) => (
        <span key={c.label} className="library-crumb">
          {i > 0 ? <span aria-hidden="true">›</span> : null}
          {c.href ? (
            <Link href={c.href} className="job-crumb-link">
              {c.label}
            </Link>
          ) : (
            <span aria-current="page">{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** The breadcrumbs of a show or season page: the show's title comes from its seasons request. */
function ShowBreadcrumbs({
  library,
  show,
  season,
}: {
  library: Library;
  show: string;
  season: string | undefined;
}) {
  const seasons = useLibrarySeasons(library.id, show);
  return (
    <Breadcrumbs library={library} show={show} showTitle={seasons.data?.title} season={season} />
  );
}

export function LibraryPage() {
  const params = useParams<{ id: string; show?: string; season?: string }>();
  const { id, show, season } = params;
  const library = useAsync(() => api.libraries.get({ id }), [id]);
  const workflows = useAsync(() => api.workflows.list(), []);
  // The unfiltered total: the header's count, and what tells an empty library from an empty search.
  const total = useLibraryFiles(id, { sort: 'title', desc: false, offset: 0, limit: 1 });
  const scan = useScanNow({
    clock: null,
    workflows: workflows.data?.workflows ?? [],
    onFeederGone: () => {
      library.reload();
      workflows.reload();
    },
  });
  const [view, setView] = useState<LibraryView>(readLibraryView);
  const [query, setQuery] = useState('');
  const search = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const searchId = useId();
  usePageTitle(library.data?.name ?? 'Library');

  if (!library.data) {
    if (library.error) {
      const failure = describeError(library.error);
      if (failure.code === 'NOT_FOUND') {
        return <NotFound what="library" backHref="/libraries" backLabel="Back to libraries" />;
      }
      return (
        <div className="page">
          <div className="alert alert-danger" role="alert">
            <Icon name="cross" strokeWidth={2.4} round />
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
  const count = total.data?.total;
  const empty = count === 0;

  function choose(next: LibraryView) {
    setView(next);
    writeLibraryView(next);
  }

  // A season is a list of episodes, so it is a table in either view.
  const body = empty ? (
    <p className="library-empty">Scan now to list its files.</p>
  ) : season !== undefined || view === 'table' ? (
    <FilesBody id={id} show={show} season={season} search={search} />
  ) : show !== undefined ? (
    <SeasonsBody />
  ) : (
    <TitlesBody id={id} search={search} />
  );

  return (
    <div className="page library-page">
      <header className="library-head">
        {show === undefined ? (
          <Breadcrumbs library={lib} show={undefined} showTitle={undefined} season={undefined} />
        ) : (
          <ShowBreadcrumbs library={lib} show={show} season={season} />
        )}
        <div className="page-head page-head-row">
          <div className="page-head">
            <h1>{lib.name}</h1>
            <p>
              <span className="mono">{lib.path}</span>
              {count === undefined ? null : (
                <span className="library-count">{fileCount(count)}</span>
              )}
            </p>
          </div>
          <div className="page-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={scan.scanning !== null || lib.feeds === null}
              onClick={() => scan.requestScan(lib)}
            >
              {scan.scanning === lib.id ? 'Scanning…' : 'Scan now'}
            </button>
          </div>
        </div>
      </header>

      <div className="plugins-toolbar library-toolbar">
        <div className="plugins-search">
          <label htmlFor={searchId} className="sr-only">
            Search this library
          </label>
          <span className="plugins-search-icon" aria-hidden="true">
            <Icon name="search" size={16} strokeWidth={2.4} />
          </span>
          <input
            id={searchId}
            type="search"
            className="input"
            placeholder="Search this library"
            aria-label="Search this library"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <SegmentedSwitch
          label="View"
          className="plugins-show"
          value={view}
          options={VIEW_OPTIONS}
          onChange={choose}
        />
      </div>

      {body}
      {scan.dialogs}
    </div>
  );
}
