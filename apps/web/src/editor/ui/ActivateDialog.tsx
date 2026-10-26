import { JOBS_LIST_MAX, type Library, type WorkflowSummary } from '@transcoda/contract';
import {
  type Issue,
  libraryInputOf,
  type NodeInstance,
  RUNNING_JOB_STATES,
  type WorkflowGraph,
} from '@transcoda/shared';
import { type RefObject, useContext, useEffect, useMemo, useState } from 'react';
import { api, isDefinedError, safe } from '../../api/client.ts';
import { AuthContext } from '../../auth/AuthProvider.tsx';
import { Dialog } from '../../components/Dialog.tsx';
import { Icon } from '../../components/Icon.tsx';
import { useToast } from '../../components/Toast.tsx';
import { useCatalog } from '../../hooks/useCatalog.ts';
import { fmtAgo } from '../../lib/time.ts';
import { changeLines, diffVersions } from '../model/version-diff.ts';
import { activatedByText, versionAuthor } from '../model/version-text.ts';

export const ACTIVATE_FAILED = 'Could not activate, try again';

/** "Shows is fed by Archive v2. Deactivate it or point this Library input elsewhere." */
export function libraryTakenText(library: string, workflow: string, version: number): string {
  return `${library} is fed by ${workflow} v${version}. Deactivate it or point this Library input elsewhere.`;
}

export const LIBRARY_MISSING_TEXT =
  'The Library input names a library that no longer exists. Pick a library first.';

/**
 * What activating means for files, from the version's Library input: the library it takes files
 * from (and who feeds it now), or none. Unknown (null) while loading or when a fetch failed.
 */
type Binding =
  | { kind: 'none' }
  | { kind: 'library'; name: string; feeds: Library['feeds'] }
  /** The Library input names a library the list does not have: the server decides. */
  | { kind: 'unknown' };

const errorsOf = (issues: Issue[] | null): Issue[] | null => {
  const errors = issues?.filter((i) => i.severity === 'error') ?? [];
  return errors.length > 0 ? errors : null;
};

type VersionRow = { version: number; note: string | null; createdBy: string };

interface Loaded {
  versions: VersionRow[];
  /** The active version's graph and this version's; null when nothing is active or a fetch failed. */
  graphs: [WorkflowGraph, WorkflowGraph] | null;
}

interface WaitingJobs {
  waiting: number;
  /** The page came back full: `waiting` is a lower bound. */
  atLeast: boolean;
  running: boolean;
}

/**
 * The activation confirmation (screen 06's structure, the activation spec's words): a person
 * always activates, by this deliberate step. It shows what changes against the active version
 * (the versions in between and the node changes), what activating means for files, and the jobs
 * waiting. "Activate" sends `workflows.activate({ confirm: true })`. `WORKFLOW_INVALID` (or
 * `issues` with errors from the caller) replaces the body with the errors and keeps the primary
 * disabled; any other failure is an inline alert. The summary and the jobs lookup are
 * conveniences: if they fail they are left out and activation stays possible.
 */
export function ActivateDialog({
  open,
  workflow,
  version,
  issues,
  onClose,
  onActivated,
  returnFocusTo,
}: {
  open: boolean;
  workflow: WorkflowSummary;
  version: number;
  issues: Issue[] | null;
  onClose(): void;
  onActivated(summary: WorkflowSummary): void;
  /** Where focus goes on close (the opener may unmount once activation changes the header). */
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const toast = useToast();
  const me = useContext(AuthContext)?.user ?? null;
  const { catalog } = useCatalog();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refused, setRefused] = useState<Issue[] | null>(null);
  const [settled, setSettled] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [jobs, setJobs] = useState<WaitingJobs | null>(null);
  const [binding, setBinding] = useState<Binding | null>(null);
  /** The server's LIBRARY_TAKEN / LIBRARY_MISSING, as the sentence that replaces the library line. */
  const [libraryRefused, setLibraryRefused] = useState<string | null>(null);

  const { id, name } = workflow;
  const active = workflow.active;
  const activeVersion = active?.version ?? null;
  const rollback = activeVersion !== null && version < activeVersion;

  // Every opening starts fresh, without the last attempt's outcome, and fetches what it shows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `open` is the trigger; the rest is read at that moment (the catalogue only names nodes, see `titleOf`).
  useEffect(() => {
    if (!open) return;
    let live = true;
    setPending(false);
    setFailed(false);
    setRefused(null);
    setSettled(false);
    setLoaded(null);
    setJobs(null);
    setBinding(null);
    setLibraryRefused(null);
    // This version's graph names its library and, with the active one, feeds the diff.
    const own = safe(api.workflows.get({ id, version }));
    void (async () => {
      const [vErr, list] = await safe(api.workflows.versions({ id }));
      let graphs: [WorkflowGraph, WorkflowGraph] | null = null;
      if (!vErr && activeVersion !== null && activeVersion !== version) {
        const [a, b] = await Promise.all([
          safe(api.workflows.get({ id, version: activeVersion })),
          own,
        ]);
        if (!a[0] && !b[0]) graphs = [a[1].graph, b[1].graph];
      }
      if (!live) return;
      if (!vErr) setLoaded({ versions: list.versions, graphs });
      setSettled(true);
    })();
    void (async () => {
      const [[gErr, detail], [lErr, libs]] = await Promise.all([own, safe(api.libraries.list())]);
      if (!live || gErr) return;
      const input = libraryInputOf(detail.graph);
      if (!input) {
        setBinding({ kind: 'none' });
        return;
      }
      if (lErr) return;
      const lib = libs.libraries.find((l) => l.id === input.libraryId);
      setBinding(lib ? { kind: 'library', name: lib.name, feeds: lib.feeds } : { kind: 'unknown' });
    })();
    void (async () => {
      const [qErr, queued] = await safe(api.jobs.list({ state: 'queued', limit: JOBS_LIST_MAX }));
      const [rErr, running] = await safe(
        api.jobs.list({ state: [...RUNNING_JOB_STATES], limit: JOBS_LIST_MAX }),
      );
      if (!live) return;
      setJobs({
        waiting: qErr ? 0 : queued.jobs.filter((j) => j.workflowId === id && !j.dryRun).length,
        atLeast: !qErr && queued.jobs.length === JOBS_LIST_MAX,
        running: !rErr && running.jobs.some((j) => j.workflowId === id),
      });
    })();
    return () => {
      live = false;
    };
  }, [open]);

  const summary = useMemo(() => {
    if (!loaded) return null;
    const titleOf = (n: NodeInstance) => n.label ?? catalog?.byType.get(n.type)?.title ?? n.type;
    const from = activeVersion ?? version;
    const lo = Math.min(from, version);
    const hi = Math.max(from, version);
    const between = loaded.versions
      .filter((v) => activeVersion !== null && v.version > lo && v.version < hi)
      .sort((x, y) => (rollback ? y.version - x.version : x.version - y.version));
    return {
      between,
      changes: loaded.graphs
        ? changeLines(diffVersions(loaded.graphs[0], loaded.graphs[1], titleOf))
        : null,
      own: loaded.versions.find((v) => v.version === version) ?? null,
    };
  }, [loaded, catalog, activeVersion, version, rollback]);

  const errors = refused ?? errorsOf(issues);
  const n = errors?.length ?? 0;
  const feeds = binding?.kind === 'library' ? binding.feeds : null;
  const takenBy =
    binding?.kind === 'library' && feeds !== null && feeds.workflowId !== id
      ? libraryTakenText(binding.name, feeds.name, feeds.version)
      : null;
  const libraryBlock = libraryRefused ?? takenBy;
  const blocked = errors !== null || libraryBlock !== null;

  async function activate() {
    if (!settled || pending || blocked) return;
    setPending(true);
    setFailed(false);
    const [err, result] = await safe(api.workflows.activate({ id, version, confirm: true }));
    setPending(false);
    if (err) {
      if (isDefinedError(err) && err.code === 'LIBRARY_TAKEN') {
        const { library, workflow: feeder } = err.data;
        setLibraryRefused(libraryTakenText(library.name, feeder.name, feeder.version));
        return;
      }
      if (isDefinedError(err) && err.code === 'LIBRARY_MISSING') {
        setLibraryRefused(LIBRARY_MISSING_TEXT);
        return;
      }
      const invalid = isDefinedError(err) && err.code === 'WORKFLOW_INVALID' ? err.data.issues : [];
      if (invalid.length > 0) setRefused(errorsOf(invalid) ?? invalid);
      else setFailed(true);
      return;
    }
    toast.success(`${result.name}: v${version} is active`);
    onActivated(result);
  }

  const title = rollback ? `Roll back ${name} to v${version}?` : `Activate v${version} of ${name}?`;
  const rowText = (v: VersionRow) =>
    `v${v.version} · ${v.note || 'saved'} · ${versionAuthor(v.createdBy, me)}`;
  const waitingLine =
    jobs && jobs.waiting > 0
      ? `${jobs.atLeast ? 'At least ' : ''}${jobs.waiting} waiting job${jobs.waiting === 1 ? '' : 's'} will run on v${version} when ${jobs.waiting === 1 ? 'it starts' : 'they start'}.`
      : null;

  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      {...(returnFocusTo ? { returnFocusTo } : {})}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-autofocus onClick={onClose}>
            {active === null ? 'Cancel' : `Keep v${active.version}${rollback ? '' : ' active'}`}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!settled || pending || blocked}
            aria-busy={pending}
            onClick={() => void activate()}
          >
            {rollback ? `Roll back to v${version}` : `Activate v${version}`}
          </button>
        </>
      }
    >
      {errors ? (
        <div className="activate-refused">
          <p className="activate-refused-title">
            <Icon name="alert" size={16} strokeWidth={2.4} round />
            Can't activate: {n === 1 ? '1 error' : `${n} errors`}
          </p>
          <ul>
            {errors.map((issue, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: issues have no id; the list never reorders.
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <p>
            {active
              ? `From now on, real runs use v${version}. v${active.version} is active now (activated ${fmtAgo(active.activatedAt)} by ${activatedByText(active.activatedBy, me)}).`
              : `No version is active now; ${name} only runs dry runs.`}
          </p>
          {summary && (
            <section className="activate-summary" aria-labelledby="activate-summary-title">
              <h3 id="activate-summary-title">What changes</h3>
              {active === null && summary.own && <p>{rowText(summary.own)}</p>}
              {summary.between.length > 0 && (
                <ul className="activate-summary-versions">
                  {summary.between.map((v) => (
                    <li key={v.version}>{rowText(v)}</li>
                  ))}
                </ul>
              )}
              {active !== null && summary.changes && (
                <>
                  <p>
                    {rollback
                      ? `v${version} vs v${active.version}:`
                      : `This version vs v${active.version}:`}
                  </p>
                  <ul className="activate-summary-changes">
                    {summary.changes.length === 0 ? (
                      <li>No changes</li>
                    ) : (
                      summary.changes.map((line) => <li key={line}>{line}</li>)
                    )}
                  </ul>
                </>
              )}
            </section>
          )}
          {libraryBlock !== null ? (
            <p className="activate-library-refused" role="alert">
              <Icon name="alert" size={16} strokeWidth={2.4} round />
              <span>{libraryBlock}</span>
            </p>
          ) : binding?.kind === 'library' ? (
            <p>
              {/* Screen 06 says 14 days; the engine keeps recycled originals 7 days by default
                  (recycle.retentionDays) and sooner removes them when the disk runs short. */}
              From now on, Scan now on {binding.name} runs v{version}. Each original moves to the
              recycle folder and is kept there for up to 7 days.
            </p>
          ) : binding?.kind === 'none' ? (
            <p>No library sends files to v{version}; it runs only when you use Run on a file.</p>
          ) : null}
          {(waitingLine || jobs?.running) && (
            <div className="activate-jobs">
              {waitingLine && <p>{waitingLine}</p>}
              {jobs?.running && <p>Jobs already running finish on their version.</p>}
            </div>
          )}
        </>
      )}
      {failed && (
        <div className="alert alert-danger" role="alert">
          <Icon name="cross" strokeWidth={2.4} round />
          <span>{ACTIVATE_FAILED}</span>
        </div>
      )}
    </Dialog>
  );
}
