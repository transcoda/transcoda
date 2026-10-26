import type { Library, WorkflowSummary } from '@transcoda/contract';
import { runHoursSummary } from '@transcoda/shared';
import { type FormEvent, Fragment, useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { api, isDefinedError, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Dialog } from '../components/Dialog.tsx';
import { Disclosure } from '../components/Disclosure.tsx';
import { FolderPicker } from '../components/FolderPicker.tsx';
import { DisabledReason, RequiredMark } from '../components/Form.tsx';
import { Icon } from '../components/Icon.tsx';
import { Loading } from '../components/Loading.tsx';
import { RowMenu } from '../components/RowMenu.tsx';
import { useToast } from '../components/Toast.tsx';
import { ActivateDialog } from '../editor/ui/ActivateDialog.tsx';
import { useAsync } from '../hooks/useAsync.ts';
import { usePageTitle } from '../lib/pageTitle.ts';
import {
  DEFAULT_RUN_HOURS,
  RunHoursCard,
  type ServerClock,
  scanWaitText,
} from '../libraries/RunHoursCard.tsx';

/** The engine's `recycleFolder: null`: every replace recycles into this folder in the root. */
const DEFAULT_RECYCLE = 'Default (.transcoda-recycle in the library)';

type FieldErrors = Partial<Record<'name' | 'path' | 'recycle', string>>;

/** Why Scan now is disabled: nothing feeds the library. */
const NOT_FED = 'No active workflow takes files from this library';
/** The way to feed a library (the Feeds cell's link and the disabled Dry run…'s hint). */
const ADD_INPUT = 'Add a Library input to a workflow';

/**
 * With no feeder: why, when a workflow's newest version names the library but is not active
 * ("Movie cleanup (+2 more) has a Library input but isn't active"); else ADD_INPUT.
 */
function notFedText(library: Library): string {
  const [first, ...rest] = library.namedByInactive;
  if (!first) return ADD_INPUT;
  const more = rest.length > 0 ? ` (+${rest.length} more)` : '';
  return `${first.name}${more} has a Library input but isn't active`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A path that may wrap after any slash, so it breaks between folders and never inside a name. */
function BreakablePath({ path }: { path: string }) {
  const parts = path.split('/');
  return (
    <>
      {parts.map((part, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a path's parts are static and may repeat.
        <Fragment key={i}>
          {i > 0 ? '/' : null}
          {i > 0 ? <wbr /> : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}

function ErrorAlert({ children }: { children: string }) {
  return (
    <div className="alert alert-danger" role="alert">
      <Icon name="cross" strokeWidth={2.4} round />
      <span>{children}</span>
    </div>
  );
}

/** A labelled on/off switch row (a real button with role switch; the row is the 44 px target). */
function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  /** Visible explanation under the row, announced as the switch's description. */
  hint?: string;
  checked: boolean;
  onChange(on: boolean): void;
}) {
  const id = useId();
  return (
    <div className="lib-switch-field">
      <div className="lib-switch-row">
        <span id={id} className="lib-switch-label">
          {label}
        </span>
        <button
          type="button"
          role="switch"
          className="tc-switch"
          aria-checked={checked}
          aria-labelledby={id}
          {...(hint ? { 'aria-describedby': `${id}-hint` } : {})}
          onClick={() => onChange(!checked)}
        >
          <span className="tc-switch-knob" />
        </button>
      </div>
      {hint ? (
        <span id={`${id}-hint`} className="field-hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

const HARDLINK_HINT =
  'Off: files with more than one hard link (a download still seeding, say) are skipped. ' +
  'On: they are processed, which breaks the link, so both copies use disk space.';

const FULL_DECODE_HINT =
  'Off: a new file is checked at its start, its end and about ten spots before it replaces the ' +
  'original. On: the whole file is decoded, which catches more but takes about as long as playing it.';

/**
 * Create (`library` null) or edit one library. The root path cannot change after create (the
 * engine has no such update); errors stay inside the dialog, next to the field they concern.
 */
function LibraryDialog({
  open,
  library,
  existingRoots,
  clock,
  onClose,
  onSaved,
}: {
  open: boolean;
  library: Library | null;
  /** The server's clock from the list (run hours are in its time zone); null when unknown. */
  clock: ServerClock | null;
  /** The libraries' root paths: the folder picker starts beside the first one. */
  existingRoots: string[];
  onClose(): void;
  onSaved(saved: Library, created: boolean): void;
}) {
  const id = useId();
  const [name, setName] = useState(library?.name ?? '');
  const [path, setPath] = useState(library?.path ?? '');
  const [customRecycle, setCustomRecycle] = useState(library?.recycleFolder != null);
  const [recycle, setRecycle] = useState(library?.recycleFolder ?? '');
  const [hardlinked, setHardlinked] = useState(library?.processHardlinked ?? false);
  const [fullDecode, setFullDecode] = useState(library?.verifyFullDecode ?? false);
  const [runHours, setRunHours] = useState(library?.runHours ?? DEFAULT_RUN_HOURS);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [picking, setPicking] = useState(false);

  const editing = library !== null;
  const describedBy = (field: keyof FieldErrors, hint?: string) =>
    [hint, errors[field] ? `${id}-${field}-error` : undefined].filter(Boolean).join(' ') ||
    undefined;

  /** What still blocks Save or Create (the one-line reason under the disabled button). */
  function missingText(
    nameValue: string,
    pathValue: string | null,
    recycleValue: string | null,
  ): string | null {
    const needs: string[] = [];
    if (!nameValue.trim()) needs.push('a name');
    if (pathValue !== null) {
      if (!pathValue.trim()) needs.push('a path');
      else if (!pathValue.trim().startsWith('/')) needs.push('an absolute path (it starts with /)');
    }
    if (recycleValue !== null && !recycleValue.trim()) needs.push('a recycle folder');
    if (needs.length === 0) return null;
    const last = needs.pop();
    return `Enter ${needs.length > 0 ? `${needs.join(', ')} and ` : ''}${last}`;
  }

  function check(): FieldErrors {
    const found: FieldErrors = {};
    if (!name.trim()) found.name = 'Enter a name';
    if (!editing) {
      if (!path.trim()) found.path = 'Enter a path';
      else if (!path.trim().startsWith('/')) {
        found.path = 'Enter an absolute path (it starts with /)';
      }
    }
    if (customRecycle && !recycle.trim()) {
      found.recycle = 'Enter a folder, or keep the default';
    }
    return found;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    setFailure(null);
    const found = check();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const options = {
      name: name.trim(),
      recycleFolder: customRecycle ? recycle.trim() : null,
      processHardlinked: hardlinked,
      verifyFullDecode: fullDecode,
      // Sent once set: a library that never had run hours and still has none sends nothing.
      ...(library?.runHours != null || runHours.enabled ? { runHours } : {}),
    };
    setPending(true);
    const [err, saved] = library
      ? await safe(api.libraries.update({ id: library.id, ...options }))
      : await safe(api.libraries.create({ ...options, path: path.trim() }));
    setPending(false);
    if (!err && saved) {
      onSaved(saved, !editing);
      return;
    }
    if (isDefinedError(err) && err.code === 'LIBRARY_PATH_INVALID') {
      const { reason } = err.data;
      // The root cannot change on edit, so there the reason is always the recycle folder's.
      if (editing || /recycle folder/i.test(reason)) setErrors({ recycle: capitalise(reason) });
      else setErrors({ path: `This path cannot be used: ${reason}` });
    } else if (isDefinedError(err) && err.code === 'NOT_FOUND') {
      setFailure('This library no longer exists. Close and reload the list.');
    } else {
      setFailure(describeError(err).message);
    }
  }

  const typed = path.trim();
  const first = existingRoots[0];
  const pickerStart = typed.startsWith('/')
    ? typed
    : first
      ? first.slice(0, first.lastIndexOf('/')) || '/'
      : '/';
  const formId = `${id}-form`;
  const missing = missingText(name, editing ? null : path, customRecycle ? recycle : null);
  const reasonId = `${id}-reason`;
  // Advanced: how many of its options are off their default. A library being edited that has some
  // opens with it open, so its own choices are in view.
  const changed = [customRecycle, hardlinked, fullDecode].filter(Boolean).length;
  return (
    <Dialog
      open={open}
      title={library ? `Edit ${library.name}` : 'New library'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className="btn btn-primary"
            // Disabled until every required field is valid; the reason shows under the button.
            disabled={pending || missing !== null}
            {...(missing ? { 'aria-describedby': reasonId } : {})}
          >
            {editing ? 'Save' : 'Create library'}
          </button>
          {missing ? <DisabledReason id={reasonId}>{missing}</DisabledReason> : null}
        </>
      }
    >
      <form id={formId} className="lib-form" noValidate onSubmit={onSubmit}>
        {failure ? <ErrorAlert>{failure}</ErrorAlert> : null}
        <div className="field">
          <label htmlFor={`${id}-name`}>
            Name
            <RequiredMark />
          </label>
          <input
            id={`${id}-name`}
            aria-required
            className="input"
            maxLength={120}
            value={name}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={describedBy('name')}
            onChange={(e) => setName(e.target.value)}
          />
          {errors.name ? (
            <span id={`${id}-name-error`} className="lib-field-error">
              {errors.name}
            </span>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor={`${id}-path`}>
            Path
            {editing ? null : <RequiredMark />}
          </label>
          <div className="lib-path-row">
            <input
              id={`${id}-path`}
              aria-required={editing ? undefined : true}
              className="input mono"
              value={path}
              disabled={editing}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={errors.path ? true : undefined}
              aria-describedby={describedBy('path', `${id}-path-hint`)}
              onChange={(e) => setPath(e.target.value)}
            />
            {editing ? null : (
              <button
                type="button"
                className="btn btn-secondary lib-path-browse"
                aria-label="Browse folders"
                title="Browse folders"
                onClick={() => setPicking(true)}
              >
                <Icon name="folder" size={16} />
              </button>
            )}
          </div>
          <span id={`${id}-path-hint`} className="field-hint">
            {editing
              ? 'The path cannot change. Create another library for a different folder.'
              : 'An absolute folder on the server'}
          </span>
          {errors.path ? (
            <span id={`${id}-path-error`} className="lib-field-error">
              {errors.path}
            </span>
          ) : null}
        </div>
        <RunHoursCard value={runHours} onChange={setRunHours} clock={clock} />
        {/* Set once and rarely changed: closed unless a value is off its default or has a problem. */}
        <Disclosure
          title="Advanced"
          className="lib-advanced"
          meta={changed > 0 ? `${changed} changed` : null}
          defaultOpen={editing && changed > 0}
          reveal={errors.recycle !== undefined}
        >
          <fieldset className="lib-recycle">
            <legend>Recycle folder</legend>
            <label className="lib-radio">
              <input
                type="radio"
                name={`${id}-recycle`}
                checked={!customRecycle}
                onChange={() => {
                  setCustomRecycle(false);
                  setErrors(({ recycle: _, ...rest }) => rest);
                }}
              />
              <span>In the library (default)</span>
            </label>
            <label className="lib-radio">
              <input
                type="radio"
                name={`${id}-recycle`}
                checked={customRecycle}
                onChange={() => setCustomRecycle(true)}
              />
              <span>Custom path</span>
            </label>
            {customRecycle ? (
              <>
                <input
                  className="input mono"
                  aria-label="Custom recycle folder"
                  value={recycle}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={errors.recycle ? true : undefined}
                  aria-describedby={describedBy('recycle', `${id}-recycle-hint`)}
                  onChange={(e) => setRecycle(e.target.value)}
                />
                <span id={`${id}-recycle-hint`} className="field-hint">
                  A folder inside the library. A relative path starts at the library folder.
                </span>
              </>
            ) : null}
            {errors.recycle ? (
              <span id={`${id}-recycle-error`} className="lib-field-error">
                {errors.recycle}
              </span>
            ) : null}
          </fieldset>
          <SwitchRow
            label="Process hardlinked files"
            hint={HARDLINK_HINT}
            checked={hardlinked}
            onChange={setHardlinked}
          />
          <SwitchRow
            label="Verify by decoding the whole file (slower)"
            hint={FULL_DECODE_HINT}
            checked={fullDecode}
            onChange={setFullDecode}
          />
        </Disclosure>
      </form>
      {editing ? null : (
        <FolderPicker
          open={picking}
          start={pickerStart}
          onChoose={(chosen) => {
            setPath(chosen);
            setErrors(({ path: _, ...rest }) => rest);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </Dialog>
  );
}

function DeleteDialog({
  target,
  returnFocusTo,
  onClose,
  onDeleted,
}: {
  target: Library | null;
  returnFocusTo: HTMLElement | null;
  onClose(): void;
  onDeleted(library: Library): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function close() {
    setError(null);
    onClose();
  }

  async function onConfirm() {
    if (!target || pending) return;
    setError(null);
    setPending(true);
    const [err] = await safe(api.libraries.delete({ id: target.id }));
    setPending(false);
    if (!err) {
      setError(null);
      onDeleted(target);
    } else if (isDefinedError(err) && err.code === 'LIBRARY_BUSY') {
      setError('Jobs are still running in this library');
    } else setError(describeError(err).message);
  }

  return (
    <Dialog
      open={target !== null}
      tone="danger"
      title={`Delete ${target?.name ?? ''}?`}
      returnFocusTo={returnFocusTo}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={pending}>
            <Icon name="trash" size={16} />
            Delete
          </button>
        </>
      }
    >
      <p>Files on disk are not touched.</p>
      {target?.feeds ? (
        <p>{`${target.feeds.name} v${target.feeds.version} will stop receiving files.`}</p>
      ) : null}
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
    </Dialog>
  );
}

/**
 * What the upgrade to library triggers changed (migration 0008), until someone dismisses it for
 * everyone. Dismiss failing keeps the list and says so inline.
 */
function UpgradeNotices({ notices, onDismissed }: { notices: string[]; onDismissed(): void }) {
  const id = useId();
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);

  async function dismiss() {
    if (pending) return;
    setFailed(false);
    setPending(true);
    const [err] = await safe(api.libraries.dismissNotices());
    setPending(false);
    if (err) setFailed(true);
    else onDismissed();
  }

  return (
    <section className="alert alert-warning lib-notices" aria-labelledby={`${id}-title`}>
      <span className="lib-notices-icon">
        <Icon name="alert" size={16} round />
      </span>
      <div className="lib-notices-body">
        <h2 id={`${id}-title`} className="lib-notices-title">
          Libraries changed when Transcoda was updated
        </h2>
        <ul>
          {notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
        {failed ? <p role="alert">Could not dismiss, try again</p> : null}
      </div>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={pending}
        onClick={() => void dismiss()}
      >
        Dismiss
      </button>
    </section>
  );
}

/** The "Test-encode" box of a dialog that starts a dry run (a real scan never test-encodes). */
function TestEncodeField({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="lib-radio">
        <input
          type="checkbox"
          checked={checked}
          aria-describedby={`${id}-hint`}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>Test-encode</span>
      </label>
      <span id={`${id}-hint`} className="field-hint">
        Encode, verify and measure every file for real, then stop before anything is written.
        Outputs are kept for playing.
      </span>
    </div>
  );
}

/** "Dry run…": the workflows whose newest version's Library input names the library. */
function DryRunDialog({
  library,
  choices,
  returnFocusTo,
  onPick,
  onClose,
}: {
  library: Library | null;
  choices: WorkflowSummary[];
  returnFocusTo: HTMLElement | null;
  onPick(workflow: WorkflowSummary, force: boolean, testEncode: boolean): void;
  onClose(): void;
}) {
  // "Also plan files the newest version already finished" (`force`) and "Test-encode": off every
  // time it opens; the first workflow is picked.
  const [force, setForce] = useState(false);
  const [testEncode, setTestEncode] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const groupId = useId();
  useEffect(() => {
    if (library) {
      setForce(false);
      setTestEncode(false);
      setPicked(null);
    }
  }, [library]);
  const chosen = choices.find((w) => w.id === picked) ?? choices[0] ?? null;
  return (
    <Dialog
      open={library !== null}
      title={`Dry run on ${library?.name ?? ''}`}
      returnFocusTo={returnFocusTo}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={chosen === null}
            onClick={() => chosen && onPick(chosen, force, testEncode)}
          >
            {testEncode ? 'Start test encode' : 'Start dry run'}
          </button>
        </>
      }
    >
      <p>
        {testEncode
          ? `Encodes every file in ${library?.path ?? ''} with the newest version of the workflow you pick and keeps each output to compare. The originals are not changed.`
          : `Plans every file in ${library?.path ?? ''} with the newest version of the workflow you pick. Nothing on disk changes.`}
      </p>
      <fieldset className="lib-dry-list" aria-labelledby={`${groupId}-legend`}>
        <span id={`${groupId}-legend`} className="field-label">
          Workflow
        </span>
        {choices.map((w) => (
          <label key={w.id} className="lib-radio">
            <input
              type="radio"
              name={groupId}
              checked={chosen?.id === w.id}
              onChange={() => setPicked(w.id)}
            />
            <span>{`${w.name} v${w.currentVersion}`}</span>
          </label>
        ))}
      </fieldset>
      <label className="lib-check">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
        <span>Also plan files the newest version already finished</span>
      </label>
      <TestEncodeField checked={testEncode} onChange={setTestEncode} />
    </Dialog>
  );
}

type Editing = { library: Library | null; key: number };

export function LibrariesPage() {
  usePageTitle('Libraries');
  const libraries = useAsync(() => api.libraries.list(), []);
  const workflows = useAsync(() => api.workflows.list(), []);
  const toast = useToast();
  const [, navigate] = useLocation();
  const [scanning, setScanning] = useState<string | null>(null);
  const [confirmScan, setConfirmScan] = useState<Library | null>(null);
  const [dryRun, setDryRun] = useState<{ library: Library; menu: HTMLElement | null } | null>(null);
  // "Also re-run files this version already finished" (`force`): off every time the dialog opens.
  // The blocked dialog's "Test-encode" (for its dry run instead): off every time it opens.
  const [testEncode, setTestEncode] = useState(false);
  const [force, setForce] = useState(false);
  useEffect(() => {
    if (confirmScan) {
      setForce(false);
      setTestEncode(false);
    }
  }, [confirmScan]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<{ library: Library; menu: HTMLElement | null } | null>(
    null,
  );
  // Focus goes back to the row's actions button, or to "New library" once that row is gone.
  const [deleted, setDeleted] = useState(false);
  const [noticesDismissed, setNoticesDismissed] = useState(false);
  /** The workflow version "Activate vN…" in the Feeds column confirms. */
  const [activating, setActivating] = useState<{
    workflow: WorkflowSummary;
    version: number;
  } | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const opened = useRef(0);

  const list = libraries.data?.libraries;
  const notices = noticesDismissed ? [] : (libraries.data?.notices ?? []);
  const allWorkflows = workflows.data?.workflows ?? [];

  /** The workflows whose newest version's Library input names the library, by name. */
  const dryRunChoices = (library: Library) =>
    allWorkflows
      .filter((w) => w.kind === 'workflow' && w.libraryInput?.id === library.id)
      .sort((a, b) => a.name.localeCompare(b.name));

  /**
   * Queues a run over the whole root. A real scan names no workflow: the server runs the
   * library's feeder (its active version). A dry run names the workflow and plans its newest
   * version; with `testEncode` it encodes and measures for real (a real scan never sends it).
   * `force` also takes files that version already finished; without it the request omits `force`.
   */
  async function scan(
    library: Library,
    dry: { workflowId: string; testEncode: boolean } | null = null,
    force = false,
  ) {
    if (scanning) return;
    setScanning(library.id);
    const [err, queued] = await safe(
      api.jobs.queue({
        ...(dry
          ? {
              path: library.path,
              workflowId: dry.workflowId,
              dryRun: true,
              testEncode: dry.testEncode,
            }
          : { path: library.path, dryRun: false }),
        ...(force ? { force: true } : {}),
      }),
    );
    setScanning(null);
    if (!err && queued) navigate(`/runs/${queued.runId}`);
    else if (isDefinedError(err) && err.code === 'NO_FEEDING_WORKFLOW') {
      // The feeder was deactivated (or moved) since the list loaded.
      toast.error(
        `${library.name} isn't fed by an active workflow. Set it in a workflow's Library input and activate it.`,
      );
      libraries.reload();
      workflows.reload();
    } else if (isDefinedError(err) && err.code === 'WORKFLOW_INVALID') {
      toast.error(
        dry
          ? `The newest version of ${library.name}'s workflow can't run. Fix it in the editor first.`
          : `The active version of ${library.name}'s workflow can't run. Activate a version that runs first.`,
      );
    } else if (isDefinedError(err) && err.code === 'PATH_REJECTED') {
      toast.error(`Couldn't scan ${library.name}: ${err.data.reason}`);
    } else toast.error(`Couldn't scan ${library.name}: ${describeError(err).message}`);
  }

  /** The feeder of the library being confirmed, when the workflow list has it. */
  const scanTarget = confirmScan?.feeds
    ? allWorkflows.find((x) => x.id === confirmScan.feeds?.workflowId)
    : undefined;
  const blocked = scanTarget?.active != null && !scanTarget.active.runnable;
  const blockedId = blocked ? scanTarget.id : null;
  const [blockedIssue, setBlockedIssue] = useState<{ id: string; message: string } | null>(null);
  // The first load error of the active version, for the blocked text; the dialog works without it.
  useEffect(() => {
    setBlockedIssue(null);
    if (blockedId === null) return;
    let live = true;
    api.workflows.get({ id: blockedId }).then(
      (detail) => {
        const first = detail.activeIssues[0];
        if (live && first) setBlockedIssue({ id: blockedId, message: first.message });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [blockedId]);

  /** What the dialog will do: the feeder's active version over the whole root. */
  function scanText(library: Library): string {
    const feeds = library.feeds;
    if (!feeds) return '';
    if (blocked && scanTarget) {
      const why = blockedIssue?.id === scanTarget.id ? blockedIssue.message : 'it has errors';
      return `${feeds.name} v${feeds.version} is active but can't run: ${why}. Activate a version that runs first, or dry run the newest version instead.`;
    }
    return `Applies ${feeds.name} v${feeds.version} (active) to every file in ${library.path}. Files that need changes are rewritten.`;
  }

  /** A real scan held back by the library's run hours says when its files start. */
  const scanWait =
    confirmScan && !blocked ? scanWaitText(confirmScan, libraries.data?.clock ?? null) : null;

  /** The force checkbox of Scan now: a real run of the feeder's active version may rewrite files. */
  const forceLabel = `Also re-run files v${confirmScan?.feeds?.version ?? ''} already finished (they may be rewritten)`;

  function openForm(library: Library | null) {
    opened.current += 1;
    // A fresh key per opening, so the form starts from the row (or empty) every time.
    setEditing({ library, key: opened.current });
  }

  return (
    <div className="page">
      <div className="page-head page-head-row">
        <h1>Libraries</h1>
        <div className="page-actions">
          <button
            ref={newButton}
            type="button"
            className="btn btn-primary"
            onClick={() => openForm(null)}
          >
            <Icon name="plus" size={16} strokeWidth={2.6} />
            New library
          </button>
        </div>
      </div>

      {libraries.error ? (
        <div className="alert alert-danger" role="alert">
          <Icon name="cross" strokeWidth={2.4} round />
          <span>Could not load the libraries: {describeError(libraries.error).message}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={libraries.reload}>
            Try again
          </button>
        </div>
      ) : null}

      {notices.length > 0 ? (
        <UpgradeNotices notices={notices} onDismissed={() => setNoticesDismissed(true)} />
      ) : null}

      {libraries.loading && !list ? <Loading /> : null}

      {list && list.length === 0 ? (
        <section className="panel lib-empty-state" aria-labelledby="lib-empty-title">
          <Icon name="libraries" size={28} />
          <h2 id="lib-empty-title">Add your first library</h2>
          <p>
            A library is a folder Transcoda watches. A workflow with a Library input picks up its
            files, and you can scan it or dry-run a workflow on it from this page.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => openForm(null)}>
            <Icon name="plus" size={16} strokeWidth={2.6} />
            Add a library
          </button>
        </section>
      ) : null}

      {list && list.length > 0 ? (
        <section className="panel lib-table" aria-label="Libraries">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Path</th>
                <th scope="col">Recycle folder</th>
                <th scope="col">Process hardlinked files</th>
                <th scope="col">Feeds</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((l) => {
                const choices = dryRunChoices(l);
                const hintId = `lib-${l.id}-not-fed`;
                // No feeder, but a workflow's newest version names this library: offer to activate it.
                const waiting = l.feeds ? undefined : l.namedByInactive[0];
                const waitingSummary = waiting
                  ? allWorkflows.find((w) => w.id === waiting.workflowId)
                  : undefined;
                return (
                  <tr key={l.id}>
                    <td className="lib-cell lib-name">
                      {l.name}
                      {l.runHours?.enabled ? (
                        <span className="lib-run-hours">
                          <Icon name="clock" size={13} />
                          {runHoursSummary(l.runHours)}
                        </span>
                      ) : null}
                    </td>
                    <td data-label="Path" className="lib-cell">
                      <span className="mono">
                        <BreakablePath path={l.path} />
                      </span>
                    </td>
                    <td data-label="Recycle folder" className="lib-cell">
                      {l.recycleFolder === null ? (
                        <span>{DEFAULT_RECYCLE}</span>
                      ) : (
                        <span className="mono">
                          <BreakablePath path={l.recycleFolder} />
                        </span>
                      )}
                    </td>
                    <td data-label="Process hardlinked files" className="lib-cell">
                      {l.processHardlinked ? 'Yes' : 'No'}
                    </td>
                    {l.feeds ? (
                      <td
                        data-label="Feeds"
                        className="lib-cell"
                      >{`${l.feeds.name} v${l.feeds.version}, active`}</td>
                    ) : waiting ? (
                      <td data-label="Feeds" className="lib-cell lib-feeds-waiting">
                        <span
                          title={`Library inputs naming ${l.name}: ${l.namedByInactive
                            .map((w) => `${w.name} v${w.version}`)
                            .join(', ')}`}
                        >
                          {notFedText(l)}
                        </span>{' '}
                        {waitingSummary ? (
                          <button
                            type="button"
                            className="lib-activate"
                            onClick={() =>
                              setActivating({ workflow: waitingSummary, version: waiting.version })
                            }
                          >
                            {`Activate v${waiting.version}…`}
                          </button>
                        ) : (
                          // The workflow list has not loaded: the editor has the same Activate.
                          <Link href={`/workflows/${waiting.workflowId}`}>
                            {`Activate v${waiting.version}…`}
                          </Link>
                        )}
                      </td>
                    ) : (
                      <td data-label="Feeds" className="lib-cell lib-feeds-none">
                        <span>—</span> <Link href="/">{ADD_INPUT}</Link>
                      </td>
                    )}
                    <td className="lib-cell lib-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        aria-label={`Scan ${l.name} now`}
                        disabled={scanning !== null || l.feeds === null}
                        {...(l.feeds === null
                          ? { title: NOT_FED, 'aria-describedby': hintId }
                          : {})}
                        onClick={() => setConfirmScan(l)}
                      >
                        {scanning === l.id ? 'Scanning…' : 'Scan now'}
                      </button>
                      {l.feeds === null ? (
                        <span id={hintId} className="sr-only">
                          {NOT_FED}
                        </span>
                      ) : null}
                      <RowMenu
                        name={l.name}
                        items={[
                          {
                            label: 'Dry run…',
                            icon: 'play',
                            disabled: choices.length === 0,
                            hint: notFedText(l),
                            onSelect: (menu) => setDryRun({ library: l, menu }),
                          },
                          { label: 'Edit', icon: 'pencil', onSelect: () => openForm(l) },
                          {
                            label: 'Delete',
                            icon: 'trash',
                            danger: true,
                            onSelect: (menu) => {
                              setDeleted(false);
                              setDeleting({ library: l, menu });
                            },
                          },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : null}

      {editing ? (
        <LibraryDialog
          key={editing.key}
          open
          library={editing.library}
          existingRoots={(list ?? []).map((l) => l.path)}
          clock={libraries.data?.clock ?? null}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => {
            setEditing(null);
            toast.success(
              created ? `Library ${saved.name} created` : `Library ${saved.name} saved`,
            );
            libraries.reload();
          }}
        />
      ) : null}

      <Dialog
        open={confirmScan !== null}
        title={`Scan ${confirmScan?.name ?? ''} now?`}
        onClose={() => setConfirmScan(null)}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              data-autofocus
              onClick={() => setConfirmScan(null)}
            >
              Cancel
            </button>
            {blocked && scanTarget ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  const library = confirmScan;
                  setConfirmScan(null);
                  if (library) void scan(library, { workflowId: scanTarget.id, testEncode });
                }}
              >
                Dry run v{scanTarget.currentVersion} instead
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              disabled={blocked}
              onClick={() => {
                const library = confirmScan;
                setConfirmScan(null);
                if (library) void scan(library, null, force);
              }}
            >
              Scan now
            </button>
          </>
        }
      >
        <p>{confirmScan ? scanText(confirmScan) : null}</p>
        {scanWait ? <p>{scanWait}</p> : null}
        {blocked ? (
          // Only the dry run it offers instead can test-encode: a real scan never does.
          scanTarget ? (
            <TestEncodeField checked={testEncode} onChange={setTestEncode} />
          ) : null
        ) : (
          <label className="lib-check">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            <span>{forceLabel}</span>
          </label>
        )}
      </Dialog>

      <DryRunDialog
        library={dryRun?.library ?? null}
        choices={dryRun ? dryRunChoices(dryRun.library) : []}
        returnFocusTo={dryRun?.menu ?? null}
        onClose={() => setDryRun(null)}
        onPick={(w, force, testEncode) => {
          const library = dryRun?.library;
          setDryRun(null);
          if (library) void scan(library, { workflowId: w.id, testEncode }, force);
        }}
      />

      {activating ? (
        <ActivateDialog
          open
          workflow={activating.workflow}
          version={activating.version}
          issues={null}
          onClose={() => setActivating(null)}
          onActivated={() => {
            setActivating(null);
            // The library now has a feeder: Feeds and Scan now follow.
            libraries.reload();
            workflows.reload();
          }}
        />
      ) : null}

      {/* Keyed by target: closing unmounts it, so focus returns to the row's actions button. */}
      <DeleteDialog
        key={deleting?.library.id ?? 'none'}
        target={deleting?.library ?? null}
        returnFocusTo={deleted ? newButton.current : (deleting?.menu ?? null)}
        onClose={() => setDeleting(null)}
        onDeleted={(l) => {
          setDeleted(true);
          setDeleting(null);
          toast.success(`Library ${l.name} deleted`);
          libraries.reload();
        }}
      />
    </div>
  );
}
