import type { WorkflowSummary } from '@transcoda/contract';
import type { Issue, WorkflowGraph } from '@transcoda/shared';
import type { ReactNode } from 'react';
import { Icon } from '../../components/Icon.tsx';
import type { Catalog } from '../../hooks/useCatalog.ts';
import { GuardedLink } from '../../lib/navigation.tsx';
import { firstError } from '../model/issues.ts';
import type { libraryShift as LibraryShiftFn } from '../model/library-shift.ts';
import { hasActivation } from './ActivationControl.tsx';
import { subjectOf } from './IssuesPanel.tsx';

/** One banner at the top of the canvas (screen 05): icon + text, `role="status"`. */
export function Banner({
  tone,
  live = true,
  children,
}: {
  tone: 'danger' | 'warning' | 'info';
  /** false for text that changes with every edit (not re-announced each time). */
  live?: boolean;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-live={live ? undefined : 'off'} className={`canvas-banner is-${tone}`}>
      <Icon name={tone === 'info' ? 'info' : 'alert'} size={16} strokeWidth={2.4} round />
      {children}
    </div>
  );
}

/** "Needs a setting." → "Needs a setting" so the sentence around it keeps one full stop. */
const sentence = (message: string) => message.replace(/\.\s*$/, '');

/** The error message, led by its node's name when the server's message does not start with it. */
function errorText(issue: Issue, graph?: WorkflowGraph, catalog?: Catalog | null): string {
  const message = sentence(issue.message);
  if (!graph || issue.nodeId === undefined) return message;
  const subject = subjectOf(issue, graph, catalog ?? null);
  return message.startsWith(subject) || message.includes(`“${subject}”`)
    ? message
    : `${subject}: ${message}`;
}

/** The warning while a used sub-workflow has unsaved changes (design: sub-workflow authoring). */
export function pinNotice(users: number): string {
  return users === 1
    ? '1 workflow pins an older version; it keeps running the version it pinned until updated.'
    : `${users} workflows pin older versions; they keep running the version they pinned until updated.`;
}

/** "Real runs still take files from Shows (v3 active). Activate this version to switch to Movies." */
export function libraryShiftText(shift: NonNullable<ReturnType<typeof LibraryShiftFn>>): string {
  const lead = `Real runs still take files from ${shift.from} (v${shift.activeVersion} active).`;
  return shift.to === null
    ? `${lead} Activating this version stops that.`
    : `${lead} Activate this version to switch to ${shift.to}.`;
}

/**
 * The canvas banners (screen 05), one at a time: while the active version can't run, that (the
 * live risk, with "Activate vN" when the shown version is saved and error-free); else the first
 * error of the draft ("Can't activate: … Dry runs still work."; in a sub-workflow, which is never
 * active, "Needs a fix: …"); else, while the draft names another library than the one the active
 * version feeds, where real runs still take files from; else, while a sub-workflow other
 * workflows use has unsaved changes, the pin notice. Null when none applies.
 */
export function CanvasBanner({
  issues,
  workflow,
  activeIssues,
  graph,
  catalog,
  dirty = false,
  activatable,
  libraryShift,
}: {
  issues: Issue[];
  workflow: WorkflowSummary;
  /** The active version's load errors (the detail's `activeIssues`). */
  activeIssues: Issue[];
  /** With the graph (and catalogue) a node's error is prefixed with the node's name. */
  graph?: WorkflowGraph;
  catalog?: Catalog | null;
  /** The draft has unsaved changes (the pin notice shows only then). */
  dirty?: boolean;
  /** The saved, error-free current version: the can't-run banner offers it (null otherwise). */
  activatable: { version: number; onActivate(): void } | null;
  /** The draft's library differs from the one the active version feeds (`libraryShift`). */
  libraryShift?: ReturnType<typeof LibraryShiftFn> | undefined;
}) {
  const active = workflow.active;
  if (hasActivation(workflow) && active !== null && !active.runnable) {
    const reason = sentence(activeIssues[0]?.message ?? 'it has errors');
    return (
      <Banner tone="danger">
        <span>
          Active v{active.version} can't run: {reason}. Real runs are refused until you activate a
          version that runs.
        </span>
        {activatable && (
          <button type="button" className="canvas-banner-action" onClick={activatable.onActivate}>
            Activate v{activatable.version}
          </button>
        )}
      </Banner>
    );
  }
  const error = firstError(issues);
  if (error) {
    return (
      <Banner tone="danger" live={false}>
        {hasActivation(workflow) ? (
          <span>
            {dirty ? "Your unsaved changes can't be activated" : "Can't activate"}:{' '}
            {errorText(error, graph, catalog)}. Dry runs still work.
          </span>
        ) : (
          // A sub-workflow is never active; its errors block the workflows that run it.
          <span>
            Needs a fix: {errorText(error, graph, catalog)}. Workflows that run this version can't
            be activated.
          </span>
        )}
      </Banner>
    );
  }
  if (hasActivation(workflow) && libraryShift) {
    return (
      <Banner tone="info">
        <span>{libraryShiftText(libraryShift)}</span>
      </Banner>
    );
  }
  const users = workflow.kind === 'subworkflow' && dirty ? workflow.usedBy.length : 0;
  if (users === 0) return null;
  return (
    <Banner tone="warning">
      <span>{pinNotice(users)}</span>
    </Banner>
  );
}

/**
 * A past version opened read-only (`?version=N`): "Viewing v3 — current is v7" with "Restore as
 * new version" (busy while the restore saves) and "Activate v3" (the rollback); the active
 * version says "Viewing v3 — active" and offers no Activate. Opened on the current version
 * itself, it says so and links to the editable editor instead.
 */
export function PastVersionBanner({
  viewing,
  current,
  editHref,
  restoring,
  onRestore,
  activate,
  viewingActive = false,
}: {
  viewing: number;
  current: number;
  editHref: string;
  restoring: boolean;
  onRestore(): void;
  /** Rollback entry point: null on the active version or a sub-workflow. */
  activate: { onClick(): void } | null;
  /** The viewed version is the active one. */
  viewingActive?: boolean;
}) {
  const activateButton = activate && (
    <button type="button" className="canvas-banner-action" onClick={activate.onClick}>
      Activate v{viewing}
    </button>
  );
  if (viewing === current) {
    return (
      <Banner tone="info">
        <span>
          Viewing v{viewing} — {viewingActive ? 'active' : 'the current version'}
        </span>
        <div className="canvas-banner-actions">
          <GuardedLink href={editHref} className="canvas-banner-action">
            Edit it
          </GuardedLink>
          {activateButton}
        </div>
      </Banner>
    );
  }
  return (
    <Banner tone="info">
      <span>
        {viewingActive
          ? `Viewing v${viewing} — active`
          : `Viewing v${viewing} — current is v${current}`}
      </span>
      <div className="canvas-banner-actions">
        <button
          type="button"
          className="canvas-banner-action"
          disabled={restoring}
          aria-busy={restoring}
          onClick={onRestore}
        >
          Restore as new version
        </button>
        {activateButton}
      </div>
    </Banner>
  );
}
