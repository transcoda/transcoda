import type { FileSort, Library, LibraryTitle, LibraryTitlesOutput } from '@transcoda/contract';
import { useEffect, useId, useState } from 'react';
import { useParams } from 'wouter';
import { api } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Icon } from '../components/Icon.tsx';
import { Loading } from '../components/Loading.tsx';
import { NotFound } from '../components/NotFound.tsx';
import { SegmentedSwitch } from '../components/SegmentedSwitch.tsx';
import { useAsync } from '../hooks/useAsync.ts';
import { usePageTitle } from '../lib/pageTitle.ts';
import { type Crumb, Crumbs, seasonLabel } from '../libraries/Crumbs.tsx';
import { LibraryFileTable } from '../libraries/LibraryFileTable.tsx';
import { SeasonGrid, TitleGrid } from '../libraries/TitleGrid.tsx';
import {
  useLibraryFiles,
  useLibrarySeasons,
  useLibraryTitles,
} from '../libraries/useLibraryListing.ts';
import { useScanNow } from '../libraries/useScanNow.tsx';
import { type LibraryView, readLibraryView, writeLibraryView } from '../libraries/viewPref.ts';

/** How long the search box waits after the last keystroke before asking the server. */
const SEARCH_DEBOUNCE_MS = 250;
/** Titles per page; "Show more" adds this much each time. */
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

function LoadError({ what, onRetry, error }: { what: string; onRetry(): void; error: unknown }) {
  return (
    <div className="alert alert-danger" role="alert">
      <Icon name="cross" strokeWidth={2.4} round />
      <span>{`Could not load ${what}: ${describeError(error).message}`}</span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/** Shows and movies, a page at a time: "Show more" appends the next page below. */
function TitlesBody({ id, search }: { id: string; search: string }) {
  const [more, setMore] = useState<{
    offset: number;
    earlier: LibraryTitle[];
    /** The page before this one: `useAsync` keeps it until the new page arrives. */
    prev: LibraryTitlesOutput | null;
  }>({ offset: 0, earlier: [], prev: null });
  const titles = useLibraryTitles(id, { search, limit: TITLES_PAGE, offset: more.offset });
  const page = titles.data && titles.data !== more.prev ? titles.data : undefined;
  const total = page?.total ?? more.prev?.total;
  if (total === undefined) {
    return titles.error ? (
      <LoadError what="the titles" error={titles.error} onRetry={titles.reload} />
    ) : (
      <Loading label="Loading titles…" />
    );
  }
  const items = [...more.earlier, ...(page?.items ?? [])];
  return (
    <section aria-label="Titles">
      {items.length === 0 ? (
        <p className="library-empty">Nothing matches.</p>
      ) : (
        <TitleGrid libraryId={id} items={items} />
      )}
      {page === undefined ? (
        titles.error ? (
          <LoadError what="more titles" error={titles.error} onRetry={titles.reload} />
        ) : (
          <Loading label="Loading titles…" />
        )
      ) : items.length < total ? (
        <div className="library-more">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() =>
              setMore({ offset: more.offset + TITLES_PAGE, earlier: items, prev: page })
            }
          >
            Show more
          </button>
        </div>
      ) : null}
    </section>
  );
}

function SeasonsBody({ id, show }: { id: string; show: string }) {
  const seasons = useLibrarySeasons(id, show);
  if (!seasons.data) {
    return seasons.error ? (
      <LoadError what="the seasons" error={seasons.error} onRetry={seasons.reload} />
    ) : (
      <Loading label="Loading seasons…" />
    );
  }
  return (
    <section aria-label="Seasons">
      <SeasonGrid libraryId={id} showKey={show} seasons={seasons.data.seasons} />
    </section>
  );
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
  const [sort, setSort] = useState<FileSort>('title');
  const [desc, setDesc] = useState(false);
  // The offset belongs to the list it was chosen on: another search, show, season or sort starts
  // again at the first page.
  const scope = JSON.stringify([id, show, season, search, sort, desc]);
  const [paged, setPaged] = useState({ scope, offset: 0 });
  const offset = paged.scope === scope ? paged.offset : 0;
  const files = useLibraryFiles(id, {
    ...(show !== undefined ? { show } : {}),
    ...(season !== undefined ? { season } : {}),
    ...(search ? { search } : {}),
    sort,
    desc,
    offset,
    limit: FILES_PAGE,
  });
  if (!files.data) {
    if (files.error) {
      return (
        <div className="alert alert-danger" role="alert">
          <Icon name="cross" strokeWidth={2.4} round />
          <span>{`Could not load the files: ${describeError(files.error).message}`}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={files.reload}>
            Try again
          </button>
        </div>
      );
    }
    return <Loading label="Loading files…" />;
  }
  return (
    <LibraryFileTable
      libraryId={id}
      files={files.data.files}
      total={files.data.total}
      sort={sort}
      desc={desc}
      onSort={(next, nextDesc) => {
        setSort(next);
        setDesc(nextDesc);
      }}
      offset={offset}
      limit={FILES_PAGE}
      onPage={(next) => setPaged({ scope, offset: next })}
    />
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
  const crumbs: Crumb[] = [
    { label: 'Libraries', href: '/libraries' },
    { label: library.name, href: show === undefined ? null : base },
  ];
  if (showHref)
    crumbs.push({ label: showTitle ?? 'Show', href: season === undefined ? null : showHref });
  if (season !== undefined) crumbs.push({ label: seasonLabel(season), href: null });
  return <Crumbs crumbs={crumbs} />;
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
    clock: library.data?.clock ?? null,
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

  // A season is a list of episodes, so it is a table in either view. On a show's page a search
  // replaces the season cards with the show's matching episodes.
  const body = empty ? (
    <p className="library-empty">Scan now to list its files.</p>
  ) : season !== undefined || view === 'table' || (show !== undefined && search !== '') ? (
    <FilesBody id={id} show={show} season={season} search={search} />
  ) : show !== undefined ? (
    <SeasonsBody id={id} show={show} />
  ) : (
    <TitlesBody key={`${id}\n${search}`} id={id} search={search} />
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
        {season === undefined ? (
          <SegmentedSwitch
            label="View"
            className="plugins-show"
            value={view}
            options={VIEW_OPTIONS}
            onChange={choose}
          />
        ) : null}
      </div>

      {body}
      {scan.dialogs}
    </div>
  );
}
