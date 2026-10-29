// Plugins: a toolbar (search, what to show, the catalog's state), the plugins workflows need, the
// installed plugins with their settings inline, the catalog grouped by purpose, and the catalogs'
// details (addresses, keys, blocklist, adding one) collapsed at the end.

import type { PluginSummary } from '@transcoda/contract';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useSearch } from 'wouter';
import { api, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Icon } from '../components/Icon.tsx';
import { Loading } from '../components/Loading.tsx';
import { useToast } from '../components/Toast.tsx';
import { useCatalog } from '../hooks/useCatalog.ts';
import { usePageTitle } from '../lib/pageTitle.ts';
import { fmtAgo } from '../lib/time.ts';
import {
  BLOCKLIST_UNAVAILABLE,
  CATALOG_UNAVAILABLE,
  CATALOG_UNREADABLE,
  CatalogDetails,
} from '../plugins/CatalogDetails.tsx';
import {
  CatalogGroups,
  catalogCards,
  latestVersion,
  matchesQuery,
} from '../plugins/CatalogSection.tsx';
import { pluginFailure } from '../plugins/errors.ts';
import { type Entry, InstallDialog, type Target } from '../plugins/InstallDialog.tsx';
import { PluginRow } from '../plugins/PluginRow.tsx';
import type { NodeChip } from '../plugins/PluginTile.tsx';
import { testEffect, updateNeedsLook } from '../plugins/pluginText.ts';
import { type CatalogView, usePlugins } from '../plugins/usePlugins.ts';

type Show = 'all' | 'installed' | 'updates';

/** The tab a link asks for (`/plugins?show=updates`: the menu, when updates wait), else All. */
function showOf(search: string): Show {
  const asked = new URLSearchParams(search).get('show');
  return asked === 'installed' || asked === 'updates' ? asked : 'all';
}

/** What Update all did, for its closing line. */
interface UpdateAllResult {
  updated: number;
  /** Updates that would touch a workflow: left for their own dialog. */
  changes: string[];
  /** Updates whose effect on workflows could not be checked. */
  unchecked: string[];
  failed: Array<{ title: string; reason: string }>;
}

/**
 * "Updated 2; Sonarr needs a look: it changes a node your workflows use."; null when everything
 * was updated (a toast says so).
 */
export function updateAllSummary(r: UpdateAllResult): string | null {
  if (r.changes.length === 0 && r.unchecked.length === 0 && r.failed.length === 0) return null;
  const one = (list: readonly string[]) => list.length === 1;
  const parts = [r.updated > 0 ? `Updated ${r.updated}` : 'Nothing updated'];
  if (r.changes.length > 0) {
    parts.push(
      one(r.changes)
        ? `${r.changes[0]} needs a look: it changes a node your workflows use`
        : `${joinAnd(r.changes)} need a look: they change nodes your workflows use`,
    );
  }
  if (r.unchecked.length > 0) {
    parts.push(
      one(r.unchecked)
        ? `${r.unchecked[0]} needs a look: it can't be checked against your workflows`
        : `${joinAnd(r.unchecked)} need a look: they can't be checked against your workflows`,
    );
  }
  for (const f of r.failed) parts.push(`${f.title} failed: ${f.reason}`);
  return `${parts.join('; ')}.`;
}

/** "Sonarr", "Sonarr and Jellyfin", "Sonarr, Radarr and Jellyfin". */
export function joinAnd(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** A plugin's entry: from the catalog it was installed from when that one lists it, else official first. */
function entryOf(
  catalogs: readonly CatalogView[],
  name: string,
  catalogUrl: string | null = null,
): { catalog: CatalogView; entry: Entry } | null {
  const ordered = [...catalogs].sort(
    (a, b) =>
      Number(b.catalogUrl === catalogUrl) - Number(a.catalogUrl === catalogUrl) ||
      Number(b.official) - Number(a.official),
  );
  for (const catalog of ordered) {
    const entry = catalog.plugins.find((p) => p.name === name);
    if (entry) return { catalog, entry };
  }
  return null;
}

const ARROW_STEP: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/** All / Installed / Updates: one tab stop, arrow keys move the choice. */
function ShowSwitch({
  value,
  counts,
  onChange,
}: {
  value: Show;
  counts: { installed: number; updates: number };
  onChange(v: Show): void;
}) {
  const options: Array<{ id: Show; label: string; count: number | null }> = [
    { id: 'all', label: 'All', count: null },
    { id: 'installed', label: 'Installed', count: counts.installed },
    { id: 'updates', label: 'Updates', count: counts.updates },
  ];
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = ARROW_STEP[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = (index + step + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onChange(option.id);
    const group = e.currentTarget.parentElement;
    group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }
  return (
    <div role="radiogroup" aria-label="Show" className="plugins-show">
      {options.map((o, i) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control of buttons with a roving tab stop and arrow keys.
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          tabIndex={o.id === value ? 0 : -1}
          onClick={() => onChange(o.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {o.label}
          {o.count === null ? null : (
            <>
              {' '}
              <span className="plugins-show-count">{o.count}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}

/** The catalog's state as separate items that wrap whole: source, when checked, blocked, Refresh. */
function CatalogStatus({
  catalogs,
  blocked,
  checking,
  onRefresh,
}: {
  catalogs: readonly CatalogView[] | undefined;
  blocked: number | null;
  checking: boolean;
  onRefresh(): void;
}) {
  const official = catalogs?.find((c) => c.official);
  const custom = catalogs?.filter((c) => !c.official).length ?? 0;
  const checked = checking
    ? 'checking now'
    : official?.fetchedAt
      ? `checked ${fmtAgo(official.fetchedAt)}`
      : null;
  return (
    <div className="plugins-source">
      {official ? (
        <span className="plugins-source-badge" title={official.catalogUrl}>
          <Icon name="check" size={11} strokeWidth={2.8} round />
          Official catalog
        </span>
      ) : null}
      {custom > 0 ? (
        <span className="plugins-source-item">
          {`${custom} custom ${custom === 1 ? 'catalog' : 'catalogs'}`}
        </span>
      ) : null}
      {checked ? <span className="plugins-source-item">{checked}</span> : null}
      {blocked !== null ? (
        <span className="plugins-source-item">{`${blocked} blocked`}</span>
      ) : null}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-label="Refresh the catalog"
        disabled={checking}
        onClick={onRefresh}
      >
        Refresh
      </button>
    </div>
  );
}

/** The plugins workflows use but nobody installed, with one button that installs them in turn. */
function NeedCard({
  missing,
  catalogs,
  onInstall,
}: {
  missing: NonNullable<ReturnType<typeof usePlugins>['missing']>;
  catalogs: readonly CatalogView[];
  onInstall(targets: Target[], opener: HTMLElement): void;
}) {
  const id = useId();
  const found = missing.map((m) => {
    const hit = entryOf(catalogs, m.name);
    const version = hit ? latestVersion(hit.entry) : null;
    const target: Target | null =
      hit && version && version.blocked === null
        ? { catalog: hit.catalog, entry: hit.entry, version }
        : null;
    return { ...m, title: hit?.entry.title ?? m.name, target };
  });
  // Each workflow with the plugins it misses, in the order the server named them.
  const workflows = new Map<string, { id: string; name: string; plugins: string[] }>();
  for (const m of found) {
    for (const w of m.workflows) {
      const known = workflows.get(w.id) ?? { id: w.id, name: w.name, plugins: [] };
      known.plugins.push(m.title);
      workflows.set(w.id, known);
    }
  }
  const named = [...workflows.values()].slice(0, 3);
  const more = workflows.size - named.length;
  const installable = found.flatMap((f) => (f.target ? [f.target] : []));
  const unlisted = found.filter((f) => !f.target).map((f) => f.title);
  return (
    <section className="plugins-need" aria-labelledby={`${id}-title`}>
      <span className="plugins-need-icon" aria-hidden="true">
        <Icon name="plug" size={20} strokeWidth={2.2} />
      </span>
      <div className="plugins-need-text">
        <h2 id={`${id}-title`}>
          {`Your workflows need ${found.length} ${found.length === 1 ? 'plugin' : 'plugins'}`}
        </h2>
        <p>
          {named.map((w) => (
            <span key={w.id}>
              <b className="plugins-need-workflow">{w.name}</b>
              {` uses ${joinAnd(w.plugins)}. `}
            </span>
          ))}
          {more > 0
            ? `${more} more ${more === 1 ? 'workflow uses' : 'workflows use'} them. `
            : null}
          {found.length === 1
            ? "Its nodes can't run until it is installed."
            : "Their nodes can't run until they are installed."}
          {unlisted.length > 0
            ? ` No catalog lists ${joinAnd(unlisted)}: add the catalog that has it in Catalog details.`
            : null}
        </p>
      </div>
      {installable.length > 0 ? (
        <button
          type="button"
          className="btn btn-primary"
          onClick={(e) => onInstall(installable, e.currentTarget)}
        >
          {`Install ${joinAnd(installable.map((t) => t.entry.title))}`}
        </button>
      ) : null}
    </section>
  );
}

export function PluginsPage() {
  usePageTitle('Plugins');
  const state = usePlugins();
  const toast = useToast();
  const { catalog: nodeCatalog } = useCatalog();
  const searchId = useId();
  const [query, setQuery] = useState('');
  const search = useSearch();
  const [show, setShow] = useState<Show>(() => showOf(search));
  // The menu's link can point here again while the page is open.
  useEffect(() => setShow(showOf(search)), [search]);
  // Update all: "1 of 3" while it runs, then what it left for a person.
  const [updatingAll, setUpdatingAll] = useState<{ at: number; of: number } | null>(null);
  const [allSummary, setAllSummary] = useState<string | null>(null);
  // A freshly installed plugin's row takes focus once it is listed.
  const [focusName, setFocusName] = useState<string | null>(null);
  // Builds to install, one confirmation dialog after the other; the first one's is open.
  const [queue, setQueue] = useState<Target[]>([]);
  const opener = useRef<HTMLElement | null>(null);
  const { plugins, missing, blocklist } = state;
  const catalogs = state.catalogs ?? [];

  function install(targets: Target[], from: HTMLElement) {
    opener.current = from;
    setQueue(targets);
  }

  /** An installed plugin's nodes as the server's node list knows them (kind, title, phase). */
  function nodesOf(p: PluginSummary) {
    return p.nodes.map((type) => ({ type, info: nodeCatalog?.byType.get(type) ?? null }));
  }

  const titleOf = (p: PluginSummary) =>
    entryOf(catalogs, p.name, p.catalogUrl)?.entry.title ?? p.name;
  const updates = plugins?.filter((p) => p.updateAvailable !== null) ?? [];
  const rows = (show === 'updates' ? updates : (plugins ?? [])).filter((p) =>
    matchesQuery(query, [titleOf(p), p.name]),
  );
  const groups = show === 'all' ? catalogCards(catalogs, query) : [];
  // Nothing to pick from: the catalog request failed, or every catalog it returned failed.
  const catalogFailed =
    Boolean(state.catalogError) ||
    (state.catalogs !== undefined &&
      state.catalogs.length > 0 &&
      state.catalogs.every((c) => c.error));
  const catalogEmpty =
    state.catalogs !== undefined && !catalogFailed && catalogs.every((c) => c.plugins.length === 0);
  const searching = query.trim() !== '';

  /**
   * Updates every plugin with an update, one after another, each through the same check as its
   * Update button: one that would touch a workflow is skipped and named at the end, so its own
   * dialog can be opened from its card.
   */
  async function updateAll() {
    if (updatingAll) return;
    const targets = updates.map((p) => ({
      name: p.name,
      version: p.updateAvailable ?? '',
      title: titleOf(p),
    }));
    const result: UpdateAllResult = { updated: 0, changes: [], unchecked: [], failed: [] };
    setAllSummary(null);
    for (const [i, t] of targets.entries()) {
      setUpdatingAll({ at: i + 1, of: targets.length });
      const [checkErr, check] = await safe(
        api.plugins.updateCheck({ name: t.name, version: t.version }),
      );
      if (checkErr || !check) {
        result.failed.push({ title: t.title, reason: pluginFailure(checkErr) });
        continue;
      }
      if (updateNeedsLook(check)) {
        (check.unknown && check.wouldBreak.length === 0 && check.needsReview.length === 0
          ? result.unchecked
          : result.changes
        ).push(t.title);
        continue;
      }
      const [err] = await safe(api.plugins.update({ name: t.name, version: t.version }));
      if (err) result.failed.push({ title: t.title, reason: pluginFailure(err) });
      else result.updated += 1;
    }
    setUpdatingAll(null);
    const summary = updateAllSummary(result);
    setAllSummary(summary);
    if (summary === null) {
      toast.success(`Updated ${result.updated} ${result.updated === 1 ? 'plugin' : 'plugins'}`);
    }
    state.reload();
  }
  const needed = show === 'all' && missing !== undefined && missing.length > 0;
  const retry = () => void state.checkForUpdates();

  return (
    <div className="page plugins-page">
      <div className="page-head">
        <h1>Plugins</h1>
        <p>
          Connect Transcoda to your media server, *arr apps and notifications. Plugins add nodes to
          the editor.
        </p>
      </div>

      <div className="plugins-toolbar">
        <div className="plugins-search">
          <label htmlFor={searchId} className="sr-only">
            Search plugins
          </label>
          <span className="plugins-search-icon" aria-hidden="true">
            <Icon name="search" size={16} strokeWidth={2.4} />
          </span>
          <input
            id={searchId}
            type="search"
            className="input"
            placeholder="Search plugins"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <ShowSwitch
          value={show}
          counts={{ installed: plugins?.length ?? 0, updates: updates.length }}
          onChange={setShow}
        />
        <CatalogStatus
          catalogs={state.catalogs}
          blocked={blocklist && !blocklist.error ? blocklist.entries : null}
          checking={state.checking}
          onRefresh={retry}
        />
      </div>

      {state.pluginsError && !plugins ? (
        <div className="alert alert-danger" role="alert">
          <Icon name="cross" strokeWidth={2.4} round />
          <span>{`Could not load the plugins: ${describeError(state.pluginsError).message}`}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={state.reload}>
            Try again
          </button>
        </div>
      ) : null}
      {state.catalogError || state.checkError ? (
        <div
          className="alert alert-danger"
          role="alert"
          title={describeError(state.checkError ?? state.catalogError).message}
        >
          <Icon name="cross" strokeWidth={2.4} round />
          <span>{CATALOG_UNAVAILABLE}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={state.checking}
            onClick={retry}
          >
            Try again
          </button>
        </div>
      ) : null}
      {catalogs
        .filter((c) => c.error)
        .map((c) => (
          <div key={c.catalogUrl} className="alert alert-danger" role="alert" title={c.error ?? ''}>
            <Icon name="cross" strokeWidth={2.4} round />
            <span>
              {CATALOG_UNREADABLE}
              {c.official ? null : (
                <>
                  {' '}
                  <span className="mono catalog-url">{c.catalogUrl}</span>
                </>
              )}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={state.checking}
              onClick={retry}
            >
              Try again
            </button>
          </div>
        ))}
      {blocklist?.error ? (
        <p className="field-hint" title={blocklist.error}>
          {BLOCKLIST_UNAVAILABLE}{' '}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={state.checking}
            onClick={retry}
          >
            Try again
          </button>
        </p>
      ) : null}

      {needed && missing ? (
        <NeedCard missing={missing} catalogs={catalogs} onInstall={install} />
      ) : null}

      {state.loading && !plugins ? <Loading /> : null}
      {plugins && (plugins.length > 0 || show !== 'all' || !needed) ? (
        <section className="plugins-section" aria-labelledby="plugins-installed">
          <div className="plugins-section-head">
            <h2 id="plugins-installed">{show === 'updates' ? 'Updates' : 'Installed'}</h2>
            {show === 'updates' && (updates.length >= 2 || updatingAll) ? (
              <button
                type="button"
                className="btn btn-update"
                disabled={updatingAll !== null}
                onClick={() => void updateAll()}
              >
                {updatingAll ? `Updating ${updatingAll.at} of ${updatingAll.of}…` : 'Update all'}
              </button>
            ) : null}
          </div>
          {show === 'updates' && allSummary ? (
            <div className="alert alert-warning" role="status">
              <Icon name="alert" size={16} round />
              <span>{allSummary}</span>
            </div>
          ) : null}
          {rows.length > 0 ? (
            <ul className="plugin-rows">
              {rows.map((p) => {
                const hit = entryOf(catalogs, p.name, p.catalogUrl);
                const title = hit?.entry.title ?? p.name;
                const nodes = nodesOf(p);
                const chips: NodeChip[] = nodes.map((n) => ({
                  type: n.type,
                  kind: n.info?.kind ?? null,
                  title: n.info?.title ?? null,
                }));
                const infos = nodes.flatMap((n) => (n.info ? [n.info] : []));
                return (
                  <PluginRow
                    key={p.name}
                    plugin={p}
                    title={title}
                    entry={hit?.entry ?? null}
                    nodes={chips}
                    effect={testEffect(title, infos)}
                    onChanged={state.reload}
                    focusHeading={p.name === focusName}
                    onFocused={() => setFocusName(null)}
                  />
                );
              })}
            </ul>
          ) : (
            <p className="muted">
              {searching
                ? `No installed plugin matches “${query.trim()}”.`
                : show === 'updates'
                  ? 'Every installed plugin is up to date.'
                  : catalogFailed
                    ? "No plugins installed. The catalog couldn't be loaded, so there is nothing to pick from yet."
                    : 'No plugins installed yet. Pick one from the catalog below.'}
            </p>
          )}
        </section>
      ) : null}

      {show === 'all' ? (
        <>
          {state.loading && !state.catalogs ? <Loading /> : null}
          <CatalogGroups groups={groups} onInstall={(t, el) => install([t], el)} />
          {catalogEmpty ? <p className="muted">The catalog lists no plugins.</p> : null}
          {searching && groups.length === 0 && !catalogEmpty ? (
            <p className="muted">{`No plugin in the catalog matches “${query.trim()}”.`}</p>
          ) : null}
        </>
      ) : null}

      <CatalogDetails
        catalogs={state.catalogs}
        blocklist={blocklist}
        onCatalogs={state.setCatalogs}
      />

      <InstallDialog
        target={queue[0] ?? null}
        returnFocusTo={opener.current}
        onClose={() => setQueue([])}
        onInstalled={(name) => {
          toast.success(`Installed ${name}`);
          const rest = queue.slice(1);
          setQueue(rest);
          if (rest.length === 0) setFocusName(name);
          state.reload();
        }}
      />
    </div>
  );
}
