import type { WorkflowSummary } from '@transcoda/contract';
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Dialog } from '../../components/Dialog.tsx';
import { Icon } from '../../components/Icon.tsx';
import { tryLabel } from '../../jobs/useTryOnFile.ts';
import { GuardedLink } from '../../lib/navigation.tsx';
import { fmtAgoLong } from '../../lib/time.ts';
import { hasActivation } from './ActivationControl.tsx';

const NAME_MAX = 120;
const NOTE_MAX = 120;
/** "saved 2 min ago" moves on by itself. */
const PILL_TICK_MS = 30_000;

/**
 * The version pill's text and look: the shown version, what runs on files and when it was saved,
 * one line ("v2 · Not active · saved 8 min ago"). The shown version being the active one reads
 * "Active v2 · …" in lime; an active version that can't run is red. A sub-workflow has no
 * activation. Unsaved changes replace the time.
 */
export function versionPill(
  workflow: Pick<WorkflowSummary, 'kind' | 'active'>,
  savedVersion: number,
  savedAt: string,
  dirty: boolean,
): { text: string; tone: 'neutral' | 'active' | 'danger' } {
  const when = dirty ? 'unsaved changes' : fmtAgoLong(savedAt);
  if (!hasActivation(workflow)) return { text: `v${savedVersion} · ${when}`, tone: 'neutral' };
  const active = workflow.active;
  if (active === null) return { text: `v${savedVersion} · Not active · ${when}`, tone: 'neutral' };
  const state = `Active v${active.version}${active.runnable ? '' : " · can't run"}`;
  const tone = active.runnable
    ? active.version === savedVersion
      ? 'active'
      : 'neutral'
    : 'danger';
  return active.version === savedVersion
    ? { text: `${state} · ${when}`, tone }
    : { text: `v${savedVersion} · ${state} · ${when}`, tone };
}

/** "Used by 1 workflow" / "Used by 3 workflows". */
export function usedByText(n: number): string {
  return `Used by ${n} workflow${n === 1 ? '' : 's'}`;
}

function NameEditor({ name, onDone }: { name: string; onDone(next: string | null): void }) {
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  function commit() {
    const next = value.trim();
    onDone(next && next !== name ? next : null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onDone(null);
    }
  }

  return (
    <input
      ref={ref}
      className="input inline-edit crumb-input"
      aria-label={`New name for ${name}`}
      value={value}
      maxLength={NAME_MAX}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={commit}
    />
  );
}

function NoteDialog({
  open,
  nextVersion,
  onSave,
  onClose,
  returnFocusTo,
}: {
  open: boolean;
  nextVersion: number;
  onSave(note: string): void;
  onClose(): void;
  returnFocusTo: RefObject<HTMLElement | null>;
}) {
  const [note, setNote] = useState('');
  const inputId = useId();
  useEffect(() => {
    if (open) setNote('');
  }, [open]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    onSave(note.trim());
  }

  return (
    <Dialog open={open} title="Save with a note" onClose={onClose} returnFocusTo={returnFocusTo}>
      <form className="note-form" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor={inputId}>Note</label>
          <input
            id={inputId}
            className="input"
            maxLength={NOTE_MAX}
            value={note}
            data-autofocus
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Save v{nextVersion}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export type OverflowItem = {
  label: string;
  onSelect?: (() => void) | undefined;
  /** Why it is unavailable (also its tooltip); absent: available. */
  blockedReason?: string | undefined;
  disabled?: boolean;
};

/**
 * The header's "More actions" menu: a button (`aria-haspopup="menu"`) opening a list of
 * items. A blocked item stays in the list, `aria-disabled` with its reason as the tooltip.
 * Escape, a press outside or picking an item closes it; Escape returns focus to the button, arrow
 * keys move between the items and the first item takes focus on open.
 */
function OverflowMenu({
  items,
  buttonRef,
}: {
  items: OverflowItem[];
  /** The menu button, for a dialog an item opened to return focus to. */
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const button = buttonRef;
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !wrap.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
      const at = all.indexOf(document.activeElement as HTMLElement);
      const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length;
      all[next]?.focus();
    }
  }

  if (items.length === 0) return null;
  return (
    <div className="row-menu" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="btn btn-secondary row-menu-button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="more" size={18} strokeWidth={2.4} round />
      </button>
      {open && (
        <div
          ref={list}
          role="menu"
          aria-label="More actions"
          className="row-menu-list"
          onKeyDown={onKeyDown}
        >
          {items.map((item) => {
            const blocked = item.disabled || item.blockedReason !== undefined || !item.onSelect;
            return (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                aria-disabled={blocked || undefined}
                title={item.blockedReason}
                onClick={() => {
                  if (blocked) return;
                  setOpen(false);
                  item.onSelect?.();
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The editor's header (screen 05): breadcrumb with an inline rename, the version pill (what is
 * shown, whether it runs on files and when it was saved; opens the versions panel, Task 18), then
 * undo/redo (Task 19), "Dry run on a file" (Task 24), Save (lime while there is something to save)
 * and a "More actions" menu: "Run on a file" (a real run of the active version; workflows only),
 * the page's activation items and "Save with a note…" (`noteMenu`, once the contract takes a note).
 * `versionsPanel` renders under the pill; `versionsOpen` is its state for `aria-expanded`.
 */
export function EditorHeader({
  workflow,
  savedVersion,
  savedAt,
  dirty,
  readOnly,
  saving,
  onSave,
  onRename,
  onOpenVersions,
  versionsOpen = false,
  versionsPanel,
  pillRef,
  activeIssue,
  activationItems = [],
  noteMenu = false,
  saveBlockedReason,
  showSave = true,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  onTry,
  tryBlockedReason,
  onRun,
  runBlockedReason,
  compact = false,
}: {
  workflow: WorkflowSummary;
  savedVersion: number;
  /** When `savedVersion` was saved (not the workflow's `updatedAt`, which a rename moves). */
  savedAt: string;
  dirty: boolean;
  readOnly: boolean;
  saving: boolean;
  onSave(note?: string): void;
  onRename(name: string): void;
  onOpenVersions?(): void;
  versionsOpen?: boolean;
  versionsPanel?: ReactNode;
  /** The version pill: the page's dialogs return focus here. */
  pillRef?: RefObject<HTMLButtonElement | null>;
  /** The first active issue's message: the can't-run pill's tooltip. */
  activeIssue?: string | undefined;
  /** "Activate vN" / "Deactivate" (`useActivation`), in the "More actions" menu. */
  activationItems?: OverflowItem[];
  noteMenu?: boolean;
  /** Why the editor cannot save at all (no catalogue, narrow window): Save's tooltip. */
  saveBlockedReason?: string | undefined;
  /** false on a past version, which is restored, not saved (no Save button at all). */
  showSave?: boolean;
  /** The undo/redo stacks have a step (and the editor can edit). */
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?(): void;
  onRedo?(): void;
  /** "Dry run on a file" (Task 24; reads "Save, then try" while dirty); absent: disabled. */
  onTry?: (() => void) | undefined;
  /** Why it cannot be tried here: the disabled button's tooltip. */
  tryBlockedReason?: string | undefined;
  /** "Run on a file": a real run of the active version (workflows only); absent: disabled. */
  onRun?: (() => void) | undefined;
  /** Why it cannot run for real ("Activate a version to run for real"): its tooltip. */
  runBlockedReason?: string | undefined;
  /**
   * A narrow window (the editor only looks there): undo, redo and Try join the "More actions"
   * menu, Save (which cannot apply read-only) is not drawn, and the pill becomes a muted status
   * line under the name.
   */
  compact?: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [, setTick] = useState(0);
  const nameButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const focusName = useRef(false);
  const reasonBaseId = useId();

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), PILL_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!renaming && focusName.current) {
      focusName.current = false;
      nameButton.current?.focus();
    }
  }, [renaming]);

  const canSave = dirty && !readOnly && !saving;
  const runShown = workflow.kind === 'workflow';
  const runAvailable = runShown && onRun !== undefined && runBlockedReason === undefined;
  // A disabled button's title is not read out: its reason is also a hidden description.
  const tryReasonId = `${reasonBaseId}-try-reason`;
  const tryReason = (!onTry || saving) && tryBlockedReason ? tryBlockedReason : null;
  const nextVersion = savedVersion + 1;
  const pill = versionPill(workflow, savedVersion, savedAt, dirty);

  const runItem: OverflowItem[] = runShown
    ? [
        {
          label: 'Run on a file',
          onSelect: runAvailable ? onRun : undefined,
          blockedReason: runBlockedReason,
        },
      ]
    : [];
  const menuItems: OverflowItem[] = compact
    ? [
        ...(onUndo && onRedo
          ? [
              { label: 'Undo', onSelect: onUndo, disabled: !canUndo },
              { label: 'Redo', onSelect: onRedo, disabled: !canRedo },
            ]
          : []),
        {
          label: tryLabel(dirty),
          onSelect: saving ? undefined : onTry,
          blockedReason: tryBlockedReason,
        },
        ...runItem,
        ...activationItems,
      ]
    : [
        ...runItem,
        ...activationItems,
        ...(noteMenu && showSave
          ? [{ label: 'Save with a note…', onSelect: () => setNoteOpen(true), disabled: !canSave }]
          : []),
      ];

  const pillWrap = (
    <div className="version-pill-wrap">
      <button
        ref={pillRef}
        type="button"
        className={`version-pill-btn${pill.tone === 'neutral' ? '' : ` is-${pill.tone}`}`}
        aria-haspopup="dialog"
        aria-expanded={versionsOpen}
        title={pill.tone === 'danger' ? activeIssue : undefined}
        onClick={() => onOpenVersions?.()}
      >
        {pill.tone === 'active' && <Icon name="check" size={12} strokeWidth={2.4} />}
        {pill.tone === 'danger' && <Icon name="alert" size={12} strokeWidth={2.4} />}
        {pill.text}
        <Icon name="chevron-down" size={12} strokeWidth={2.4} />
      </button>
      {versionsPanel}
    </div>
  );

  return (
    <header className={compact ? 'editor-head is-compact' : 'editor-head'}>
      <nav aria-label="Breadcrumb" className="crumb">
        <GuardedLink href="/" className="crumb-link">
          Workflows
        </GuardedLink>
        <span className="crumb-sep" aria-hidden="true">
          /
        </span>
        {renaming ? (
          <NameEditor
            name={workflow.name}
            onDone={(next) => {
              focusName.current = true;
              setRenaming(false);
              if (next) onRename(next);
            }}
          />
        ) : (
          <button
            ref={nameButton}
            type="button"
            className="crumb-name"
            title="Rename"
            disabled={readOnly}
            onClick={() => setRenaming(true)}
          >
            {workflow.name}
          </button>
        )}
      </nav>
      {/* Compact: the name and the menu share the first row, the pill is the line below. */}
      {!compact && pillWrap}
      {workflow.kind === 'subworkflow' && workflow.usedBy.length > 0 && (
        <span className="used-by" title={workflow.usedBy.map((r) => r.name).join(', ')}>
          {usedByText(workflow.usedBy.length)}
        </span>
      )}
      <div className="editor-head-end">
        {!compact && onUndo && onRedo && (
          <div className="history-group">
            <button
              type="button"
              className="btn btn-secondary history-btn"
              aria-label="Undo"
              title="Undo (⌘Z)"
              disabled={!canUndo}
              onClick={onUndo}
            >
              <Icon name="undo" size={16} strokeWidth={2.4} />
            </button>
            <button
              type="button"
              className="btn btn-secondary history-btn"
              aria-label="Redo"
              title="Redo (⇧⌘Z)"
              disabled={!canRedo}
              onClick={onRedo}
            >
              <Icon name="redo" size={16} strokeWidth={2.4} />
            </button>
          </div>
        )}
        {!compact && (
          <button
            type="button"
            className="btn btn-secondary editor-try"
            disabled={!onTry || saving}
            title={tryBlockedReason}
            {...(tryReason ? { 'aria-describedby': tryReasonId } : {})}
            onClick={() => onTry?.()}
          >
            <Icon name="eye" size={15} strokeWidth={2.4} />
            {tryLabel(dirty)}
          </button>
        )}
        {!compact && tryReason ? (
          <span id={tryReasonId} className="sr-only">
            {tryReason}
          </span>
        ) : null}
        {showSave && !compact && (
          <button
            type="button"
            className={canSave ? 'btn btn-primary editor-save' : 'btn btn-secondary editor-save'}
            disabled={!canSave}
            title={saveBlockedReason}
            aria-busy={saving}
            onClick={() => onSave()}
          >
            Save v{nextVersion}
          </button>
        )}
        <OverflowMenu items={menuItems} buttonRef={moreButton} />
      </div>
      {compact && pillWrap}
      {noteMenu && showSave && (
        <NoteDialog
          open={noteOpen}
          nextVersion={nextVersion}
          returnFocusTo={moreButton}
          onClose={() => setNoteOpen(false)}
          onSave={(note) => {
            setNoteOpen(false);
            onSave(note || undefined);
          }}
        />
      )}
    </header>
  );
}
