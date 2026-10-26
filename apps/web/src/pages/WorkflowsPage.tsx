import type { WorkflowRef, WorkflowSummary } from '@transcoda/contract';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { api, isDefinedError, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { StatusChip } from '../components/Chips.tsx';
import { Dialog } from '../components/Dialog.tsx';
import { EmptyWorkflows } from '../components/EmptyWorkflows.tsx';
import { Icon } from '../components/Icon.tsx';
import { Loading } from '../components/Loading.tsx';
import { RowMenu, type RowMenuItem } from '../components/RowMenu.tsx';
import { useToast } from '../components/Toast.tsx';
import { ActivateDialog } from '../editor/ui/ActivateDialog.tsx';
import { ActivationPill } from '../editor/ui/ActivationControl.tsx';
import { BUNDLED_EXAMPLES, type BundledExample } from '../examples/bundled.ts';
import { createFromGraph } from '../examples/createExample.ts';
import { useWorkflows } from '../hooks/useWorkflows.ts';
import { runBlocked, useRunOnFile } from '../jobs/useRunOnFile.tsx';
import { useTryOnFile } from '../jobs/useTryOnFile.ts';
import { usePageTitle } from '../lib/pageTitle.ts';
import { fmtAgo } from '../lib/time.ts';

const CANT_RUN_TITLE = "This version can't run; open the workflow to see why";

/**
 * The ACTIVE column (workflows only): the same activation pill as the editor; a button that opens
 * the Activate dialog for the newest version when that one is not active and is valid. A can't-run
 * pill reads "v3 · can't run" here (the header says ACTIVE), so it fits the column (#34).
 */
function ActiveCell({
  w,
  onActivate,
}: {
  w: WorkflowSummary;
  onActivate(button: HTMLElement): void;
}) {
  const active = w.active;
  const reasonId = `wf-cant-run-${w.id}`;
  const cantRun = active !== null && !active.runnable;
  const pill = (
    <ActivationPill
      active={active}
      {...(cantRun ? { title: CANT_RUN_TITLE, text: `v${active.version} · can't run` } : {})}
    >
      {cantRun ? (
        <span className="sr-only" id={reasonId}>
          {CANT_RUN_TITLE}
        </span>
      ) : null}
    </ActivationPill>
  );
  const newer = active !== null && w.currentVersion > active.version;
  const canActivate = w.valid && w.currentVersion !== active?.version;
  return (
    <>
      {canActivate ? (
        <button
          type="button"
          className="chip-button"
          aria-label={`Activate v${w.currentVersion} of ${w.name} (${
            active === null
              ? 'not active'
              : `active: v${active.version}${active.runnable ? '' : " · can't run"}`
          })`}
          {...(cantRun ? { 'aria-describedby': reasonId } : {})}
          onClick={(e) => onActivate(e.currentTarget)}
        >
          {pill}
        </button>
      ) : (
        pill
      )}
      {newer ? <span className="wf-active-newest">{`v${w.currentVersion} newest`}</span> : null}
    </>
  );
}

function StatusCell({ w }: { w: WorkflowSummary }) {
  const needsReview = w.active !== null && !w.active.runnable;
  return (
    <div className="wf-status">
      {w.valid && !needsReview && !w.usesOutdatedSubworkflow ? (
        <StatusChip tone="ok" icon="check">
          Valid
        </StatusChip>
      ) : null}
      {w.errorCount > 0 ? (
        <StatusChip tone="error" icon="alert">
          {w.errorCount === 1 ? '1 error' : `${w.errorCount} errors`}
        </StatusChip>
      ) : null}
      {!w.valid && w.errorCount === 0 ? (
        <StatusChip tone="error" icon="alert">
          Invalid
        </StatusChip>
      ) : null}
      {needsReview ? (
        <StatusChip
          tone="warning"
          icon="alert"
          title={CANT_RUN_TITLE}
          srText={`: ${CANT_RUN_TITLE}`}
        >
          Needs review
        </StatusChip>
      ) : null}
      {w.usesOutdatedSubworkflow ? (
        <StatusChip tone="outdated" icon="workflow">
          Outdated sub-workflow
        </StatusChip>
      ) : null}
    </div>
  );
}

/** The list header's "Examples" menu (shown once the list has workflows). */
function ExamplesMenu({
  busy,
  onBundled,
  onImport,
}: {
  busy: boolean;
  onBundled(example: BundledExample): void;
  onImport(): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    function onDown(e: MouseEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !open) return;
    e.preventDefault();
    setOpen(false);
    button.current?.focus();
  }

  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the menu from any item inside it.
    <div className="row-menu examples-menu" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className="btn btn-secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={busy}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
      >
        Examples
        <Icon name="chevron-down" size={16} />
      </button>
      {open ? (
        <div className="row-menu-list" role="menu" aria-label="Examples">
          {BUNDLED_EXAMPLES.map((ex) => (
            <button
              key={ex.name}
              type="button"
              role="menuitem"
              {...(ex.needs ? { title: ex.needs } : {})}
              onClick={pick(() => onBundled(ex))}
            >
              {`Start from “${ex.name}” example`}
              {ex.needs ? <span className="row-menu-note">{ex.needs}</span> : null}
            </button>
          ))}
          <hr className="row-menu-sep" />
          <button type="button" role="menuitem" onClick={pick(onImport)}>
            <Icon name="download" size={16} />
            Import a workflow file…
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A workflow file's name as a workflow name: "track-cleanup.json" → "Track cleanup". */
export function nameFromFile(file: string): string {
  const base = file
    .replace(/\.json$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'Imported workflow';
}

/** `byKey` is true when Enter or Escape ended the edit (focus then returns to the row). */
function RenameInput({
  w,
  onDone,
}: {
  w: WorkflowSummary;
  onDone(renamed: boolean, byKey: boolean): void;
}) {
  const toast = useToast();
  const [value, setValue] = useState(w.name);
  const [saving, setSaving] = useState(false);
  const [failures, setFailures] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const hintId = useId();

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  // A disabled input loses focus; after a failed save it is enabled again and gets focus back.
  useEffect(() => {
    if (failures > 0) ref.current?.focus();
  }, [failures]);

  async function save() {
    const name = value.trim();
    if (!name || name === w.name) {
      onDone(false, true);
      return;
    }
    setSaving(true);
    const [err] = await safe(api.workflows.rename({ id: w.id, name }));
    setSaving(false);
    if (err) {
      toast.error(`Could not rename ${w.name}: ${describeError(err).message}`);
      setFailures((n) => n + 1);
      return;
    }
    onDone(true, true);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onDone(false, true);
    }
  }

  return (
    <div className="wf-name-line">
      <input
        ref={ref}
        className="input inline-edit"
        aria-label={`New name for ${w.name}`}
        aria-describedby={hintId}
        value={value}
        maxLength={120}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (!saving) onDone(false, false);
        }}
      />
      <span id={hintId} className="inline-edit-hint">
        Enter to save · Esc to cancel
      </span>
    </div>
  );
}

function DeleteDialog({
  target,
  returnFocusTo,
  onClose,
  onDeleted,
}: {
  target: WorkflowSummary | null;
  returnFocusTo: HTMLElement | null;
  onClose(): void;
  onDeleted(w: WorkflowSummary): void;
}) {
  const [usedBy, setUsedBy] = useState<WorkflowRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onConfirm() {
    if (!target) return;
    setError(null);
    setPending(true);
    const [err] = await safe(api.workflows.delete({ id: target.id }));
    setPending(false);
    if (!err) {
      onDeleted(target);
      return;
    }
    if (isDefinedError(err) && err.code === 'IN_USE') setUsedBy(err.data.usedBy);
    else setError(describeError(err).message);
  }

  return (
    <Dialog
      open={target !== null}
      tone="danger"
      title={`Delete ${target?.name ?? ''}?`}
      returnFocusTo={returnFocusTo}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={onConfirm}
            disabled={pending || usedBy !== null}
          >
            <Icon name="trash" size={16} />
            Delete
          </button>
        </>
      }
    >
      {usedBy ? (
        <p role="alert">
          Used by:{' '}
          {usedBy.map((ref, i) => (
            <span key={ref.id}>
              {i > 0 ? ', ' : null}
              <Link href={`/workflows/${ref.id}`}>{ref.name}</Link>
            </span>
          ))}{' '}
          — open them to remove the reference first
        </p>
      ) : (
        <p>This removes the workflow and its versions. Jobs that already ran keep their history.</p>
      )}
      {error ? (
        <div className="alert alert-danger" role="alert">
          <Icon name="cross" strokeWidth={2.4} round />
          <span>{error}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onConfirm}>
            Try again
          </button>
        </div>
      ) : null}
    </Dialog>
  );
}

/** "Run on a file" in a workflow's row menu: disabled with the reason it cannot run for real. */
function runMenuItem(w: WorkflowSummary, onSelect: () => void): RowMenuItem {
  const blocked = runBlocked(w);
  return {
    label: 'Run on a file',
    icon: 'play',
    onSelect,
    ...(blocked ? { disabled: true, hint: blocked.reason } : {}),
  };
}

/** The row menu's "Dry run on a file": like Run on a file, a plan of the newest version. */
function DryRunOnFile({ workflow }: { workflow: WorkflowSummary }) {
  const dry = useTryOnFile(
    { id: workflow.id, name: workflow.name },
    { dirty: false, save: async () => true },
  );
  const { open } = dry;
  useEffect(() => open(), [open]);
  return dry.element;
}

/** The row menu's "Run on a file": mounted per pick (keyed), it opens the picker at once. */
function RunOnFile({ workflow, onStale }: { workflow: WorkflowSummary; onStale(): void }) {
  const run = useRunOnFile(workflow, onStale);
  const { open } = run;
  useEffect(() => open(), [open]);
  return run.element;
}

export function WorkflowsPage() {
  usePageTitle('Workflows');
  const { workflows, error, loading, reload } = useWorkflows();
  const [, navigate] = useLocation();
  const toast = useToast();
  const [renaming, setRenaming] = useState<{ id: string; menu: HTMLElement | null } | null>(null);
  const [deleting, setDeleting] = useState<{
    w: WorkflowSummary;
    menu: HTMLElement | null;
  } | null>(null);
  const [activating, setActivating] = useState<WorkflowSummary | null>(null);
  const [running, setRunning] = useState<{ w: WorkflowSummary; n: number } | null>(null);
  const [dryRunning, setDryRunning] = useState<{ w: WorkflowSummary; n: number } | null>(null);

  async function onDuplicate(w: WorkflowSummary) {
    const [err] = await safe(api.workflows.duplicate({ id: w.id, name: `${w.name} copy` }));
    if (err) {
      toast.error(`Could not duplicate ${w.name}: ${describeError(err).message}`);
      return;
    }
    toast.success(`Duplicated ${w.name} as ${w.name} copy`);
    reload();
  }
  const activateOpener = useRef<HTMLElement | null>(null);
  const [creating, setCreating] = useState(false);
  const [refocus, setRefocus] = useState<{ el: HTMLElement | null } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // After an inline rename ends by key, focus goes back to the row's actions button (a new
  // object each time, so renaming the same row twice refocuses twice); after a delete, to the
  // list heading (the row and its actions button are gone).
  useEffect(() => {
    if (refocus?.el?.isConnected) refocus.el.focus();
  }, [refocus]);

  async function onAddTrigger() {
    if (creating) return;
    setCreating(true);
    const [err, out] = await safe(
      api.workflows.create({ name: 'Untitled workflow', kind: 'workflow' }),
    );
    setCreating(false);
    if (err || !out) {
      toast.error(`Could not create the workflow: ${describeError(err).message}`);
      return;
    }
    navigate(`/workflows/${out.id}?focus=palette`);
  }

  /** A bundled example, or an imported file, becomes a new workflow whose version 1 is its graph. */
  async function onGraph(name: string, graph: unknown, what: string) {
    if (creating) return;
    setCreating(true);
    const [err, out] = await safe(createFromGraph(api, name, graph));
    setCreating(false);
    if (err || !out) {
      toast.error(`Could not create ${what}: ${describeError(err).message}`);
      return;
    }
    navigate(`/workflows/${out.id}`);
  }

  const importInput = useRef<HTMLInputElement>(null);
  async function onImportFile(file: File) {
    let graph: unknown;
    try {
      graph = JSON.parse(await file.text());
    } catch {
      toast.error(`${file.name} is not a JSON file.`);
      return;
    }
    await onGraph(nameFromFile(file.name), graph, file.name);
  }

  const plain = (workflows ?? []).filter((w) => w.kind !== 'subworkflow');
  const subs = (workflows ?? []).filter((w) => w.kind === 'subworkflow');

  /** One table per kind: workflows first, then sub-workflows, each under its own heading with a count. */
  function renderSection(title: string, headingId: string, list: WorkflowSummary[], sub = false) {
    return (
      <section className="wf-section" aria-labelledby={headingId}>
        <h2 id={headingId} className="wf-section-head">
          {title} <span className="wf-count">{list.length}</span>
        </h2>
        <div className="panel wf-table">
          <table aria-labelledby={headingId}>
            <colgroup>
              <col className="wf-col-name" />
              <col className="wf-col-second" />
              <col className="wf-col-status" />
              <col className="wf-col-version" />
              <col className="wf-col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">{sub ? 'Used by' : 'Active'}</th>
                <th scope="col">Status</th>
                <th scope="col">Version</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((w) => (
                <tr key={w.id}>
                  <td className="wf-cell wf-name">
                    {renaming?.id === w.id ? (
                      <RenameInput
                        w={w}
                        onDone={(renamed, byKey) => {
                          if (byKey) setRefocus({ el: renaming.menu });
                          setRenaming(null);
                          if (renamed) reload();
                        }}
                      />
                    ) : (
                      <Link href={`/workflows/${w.id}`} className="wf-link">
                        {w.name}
                      </Link>
                    )}
                  </td>
                  <td data-label={sub ? undefined : 'Active'} className="wf-cell">
                    {sub ? (
                      <span title={w.usedBy.map((r) => r.name).join(', ')}>
                        {`Used by ${w.usedBy.length}`}
                      </span>
                    ) : (
                      <ActiveCell
                        w={w}
                        onActivate={(button) => {
                          activateOpener.current = button;
                          setActivating(w);
                        }}
                      />
                    )}
                  </td>
                  <td data-label="Status" className="wf-cell">
                    <StatusCell w={w} />
                  </td>
                  <td data-label="Version" className="wf-cell wf-version">
                    <span title={new Date(w.updatedAt).toLocaleString()}>
                      {`v${w.currentVersion} · ${fmtAgo(w.updatedAt)}`}
                    </span>
                  </td>
                  <td className="wf-cell">
                    <RowMenu
                      name={w.name}
                      items={[
                        ...(sub
                          ? []
                          : [
                              runMenuItem(w, () => setRunning((r) => ({ w, n: (r?.n ?? 0) + 1 }))),
                              {
                                label: 'Dry run on a file',
                                icon: 'eye',
                                onSelect: () => setDryRunning((r) => ({ w, n: (r?.n ?? 0) + 1 })),
                              } satisfies RowMenuItem,
                            ]),
                        {
                          label: 'Duplicate',
                          icon: 'copy',
                          onSelect: () => void onDuplicate(w),
                        },
                        {
                          label: 'Rename',
                          icon: 'pencil',
                          onSelect: (menu) => setRenaming({ id: w.id, menu }),
                        },
                        {
                          label: 'Delete',
                          icon: 'trash',
                          danger: true,
                          onSelect: (menu) => setDeleting({ w, menu }),
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  return (
    <div className="page">
      <div className="page-head page-head-row">
        <h1 ref={heading} tabIndex={-1}>
          Workflows
        </h1>
        <div className="page-actions">
          <Link href="/workflows/new?kind=workflow" className="btn btn-primary">
            <Icon name="plus" size={16} strokeWidth={2.6} />
            New workflow
          </Link>
          {workflows && workflows.length > 0 ? (
            <ExamplesMenu
              busy={creating}
              onBundled={(ex) => void onGraph(ex.name, ex.graph, `the ${ex.name} example`)}
              onImport={() => importInput.current?.click()}
            />
          ) : null}
          <input
            ref={importInput}
            type="file"
            accept="application/json,.json"
            hidden
            aria-label="Workflow file to import"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (file) void onImportFile(file);
            }}
          />
        </div>
      </div>

      {error ? (
        <div className="alert alert-danger" role="alert">
          <Icon name="cross" strokeWidth={2.4} round />
          <span>Could not load the workflows: {describeError(error).message}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={reload}>
            Try again
          </button>
        </div>
      ) : null}

      {loading && !workflows ? <Loading /> : null}

      {workflows && workflows.length === 0 ? (
        <EmptyWorkflows
          examples={BUNDLED_EXAMPLES.filter((ex) => ex.needs === null)}
          onAddTrigger={() => void onAddTrigger()}
          onExample={(ex) => void onGraph(ex.name, ex.graph, `the ${ex.name} example`)}
          busy={creating}
        />
      ) : null}

      {workflows && workflows.length > 0 ? (
        <>
          {plain.length > 0 ? renderSection('Workflows', 'wf-section-workflows', plain) : null}
          {subs.length > 0
            ? renderSection('Sub-workflows', 'wf-section-subworkflows', subs, true)
            : null}
        </>
      ) : null}

      {activating ? (
        <ActivateDialog
          key={activating.id}
          open
          workflow={activating}
          version={activating.currentVersion}
          issues={null}
          returnFocusTo={activateOpener}
          onClose={() => setActivating(null)}
          onActivated={() => {
            setActivating(null);
            reload();
          }}
        />
      ) : null}

      {running ? (
        <RunOnFile key={`${running.w.id}:${running.n}`} workflow={running.w} onStale={reload} />
      ) : null}
      {dryRunning ? (
        <DryRunOnFile key={`${dryRunning.w.id}:${dryRunning.n}`} workflow={dryRunning.w} />
      ) : null}

      {/* Keyed by target so each delete starts from the confirmation text again. */}
      <DeleteDialog
        key={deleting?.w.id ?? 'none'}
        target={deleting?.w ?? null}
        returnFocusTo={deleting?.menu ?? null}
        onClose={() => setDeleting(null)}
        onDeleted={(w) => {
          setDeleting(null);
          setRefocus({ el: heading.current });
          toast.success(`Deleted ${w.name}`);
          reload();
        }}
      />
    </div>
  );
}
