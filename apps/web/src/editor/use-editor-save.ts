// The editor page's saving: save, "Save, then try", "Save and leave", "Restore as new version",
// and the conflict dialog's reload and "Save over it".
import { ORPCError } from '@orpc/client';
import type { WorkflowDetail } from '@transcoda/contract';
import type { Issue, WorkflowGraph } from '@transcoda/shared';
import { type Dispatch, type RefObject, useCallback, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { api, isDefinedError, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { useToast } from '../components/Toast.tsx';
import type { Catalog } from '../hooks/use-catalog.ts';
import type { EditorAction, EditorState } from './model/editor-state.ts';
import { graphEquals } from './model/equality.ts';
import { dropHiddenPortEdges, removedNotice } from './model/hidden-ports.ts';
import { saveNoteFor } from './model/save-note.ts';
import { subjectOf } from './ui/IssuesPanel.tsx';

type SaveOutcome =
  | { kind: 'saved'; graph: WorkflowGraph }
  | { kind: 'conflict'; currentVersion: number }
  /** `hiddenUrl`: the nodes whose redacted webhook URL the server could not match (I4). */
  | { kind: 'failed'; message: string; hiddenUrl?: string[] }
  | { kind: 'skipped' };
const SKIPPED: SaveOutcome = { kind: 'skipped' };

/**
 * The conflict dialog: the newer version, what runs, and the inline failure to retry. `for` is
 * what hit the conflict: the draft's save (with the user's note, kept for "Save over it") or the
 * restore of a past version.
 */
type ConflictState = {
  version: number;
  busy: 'reload' | 'save' | null;
  error: string | null;
  failed: 'reload' | 'save' | null;
  for: { kind: 'draft'; note: string | undefined } | { kind: 'restore'; viewing: number };
};

/** HIDDEN_URL_UNKNOWN's nodes, or undefined for any other error. */
function hiddenUrlNodes(error: unknown): string[] | undefined {
  if (!(error instanceof ORPCError) || !error.defined || error.code !== 'HIDDEN_URL_UNKNOWN') {
    return undefined;
  }
  const nodeIds = (error.data as { nodeIds?: unknown } | undefined)?.nodeIds;
  return Array.isArray(nodeIds) ? nodeIds.filter((n): n is string => typeof n === 'string') : [];
}

/** What the editor says for HIDDEN_URL_UNKNOWN: the nodes to enter the URL again in. */
export function hiddenUrlText(
  nodeIds: string[],
  graph: WorkflowGraph,
  catalog: Catalog | null,
): string {
  const names = nodeIds.map((nodeId) => subjectOf({ nodeId } as Issue, graph, catalog));
  return `A hidden webhook URL could not be matched to a saved one. Enter the URL again in ${names.join(', ')}.`;
}

export function loadedAction(w: WorkflowDetail, readOnly: boolean): EditorAction {
  const { version, graph, issues, settings: _settings, activeIssues, ...workflow } = w;
  return { type: 'loaded', workflow, version, graph, issues, activeIssues, readOnly };
}

/**
 * Latest values for callbacks that outlive a render (async save, React Flow handlers). `draft`
 * also moves synchronously with each applied op, so two ops in one tick build on each other.
 */
export interface EditorLatest {
  state: EditorState | null;
  editable: boolean;
  catalog: Catalog | null;
  draft: WorkflowGraph | null;
}

export function useEditorSave({
  id,
  latest,
  alive,
  dispatch,
  setHiddenUrl,
}: {
  id: string;
  latest: RefObject<EditorLatest>;
  /** False once the page is gone: a save answered after leaving does nothing. */
  alive: RefObject<boolean>;
  dispatch: Dispatch<EditorAction>;
  /** The nodes whose hidden webhook URL the last save could not match (HIDDEN_URL_UNKNOWN). */
  setHiddenUrl(nodeIds: string[] | null): void;
}) {
  const toast = useToast();
  const [, navigate] = useLocation();
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [restoring, setRestoring] = useState(false);
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
  const savingRef = useRef(false);
  /** The save that is running, for "Save, then try" to wait for. */
  const inFlight = useRef<Promise<SaveOutcome> | null>(null);

  /**
   * One save of the current draft. Skipped when nothing would be saved (not dirty, unless a
   * `baseVersion` override saves over a newer version), while another save runs, or after the
   * page is gone; the outcome tells the caller what to show.
   */
  const runSave = useCallback(
    async (
      opts: { baseVersion?: number; note?: string | undefined } = {},
    ): Promise<SaveOutcome> => {
      const { state: cur, draft, editable: canEdit } = latest.current;
      if (!alive.current || !cur || !draft || !canEdit || savingRef.current) return SKIPPED;
      if (opts.baseVersion === undefined && !cur.dirty) return SKIPPED;
      // An edge from an output the settings now hide (Damaged, Quality check turned off) would be
      // refused: the save removes it first, as an undoable change, and says so.
      let graph = draft;
      const cat = latest.current.catalog;
      if (cat) {
        const pruned = dropHiddenPortEdges(draft, cat);
        if (pruned.removed.length > 0) {
          graph = pruned.graph;
          latest.current.draft = graph;
          dispatch({ type: 'apply', result: { ok: true, graph } });
          toast.info(removedNotice(pruned.removed, draft, cat));
        }
      }
      const baseVersion = opts.baseVersion ?? cur.savedVersion;
      // "Save over it" saves on top of someone else's version: "Layout only" against the version
      // this draft was loaded from would describe the wrong change, so only the user's note goes.
      const note =
        opts.baseVersion !== undefined
          ? opts.note?.trim() || undefined
          : saveNoteFor(cur.saved, graph, opts.note);
      savingRef.current = true;
      setSaving(true);
      const request = safe(
        api.workflows.save({ id, baseVersion, graph, ...(note !== undefined ? { note } : {}) }),
      );
      const outcome = (async (): Promise<SaveOutcome> => {
        const [error, data] = await request;
        savingRef.current = false;
        if (!alive.current) return SKIPPED;
        setSaving(false);
        if (error) {
          if (isDefinedError(error) && error.code === 'VERSION_CONFLICT') {
            return { kind: 'conflict', currentVersion: error.data.currentVersion };
          }
          const hidden = hiddenUrlNodes(error);
          if (hidden) {
            const message = hiddenUrlText(hidden, graph, latest.current.catalog);
            return { kind: 'failed', message, hiddenUrl: hidden };
          }
          return { kind: 'failed', message: describeError(error).message };
        }
        setHiddenUrl(null);
        dispatch({
          type: 'saved',
          graph,
          version: data.version,
          issues: data.issues,
          active: data.active,
          changes: data.changes,
          // Client clock (the response has no timestamp); "saved just now" tolerates the skew.
          savedAt: new Date().toISOString(),
        });
        toast.info(
          `Saved v${data.version}${data.active ? ` · v${data.active.version} stays active` : ''}`,
        );
        return { kind: 'saved', graph };
      })();
      inFlight.current = outcome;
      void outcome.finally(() => {
        if (inFlight.current === outcome) inFlight.current = null;
      });
      return outcome;
    },
    [id, toast, latest, alive, dispatch, setHiddenUrl],
  );

  /**
   * Save from the header, ⌘S, a "Try again" toast or "Save, then try": a conflict opens the
   * dialog. True once nothing unsaved is left.
   */
  const save = useCallback(
    async (note?: string): Promise<boolean> => {
      const out = await runSave({ note });
      if (!alive.current) return false;
      if (out.kind === 'saved') return true;
      if (out.kind === 'conflict') {
        setConflict({
          version: out.currentVersion,
          busy: null,
          error: null,
          failed: null,
          for: { kind: 'draft', note },
        });
      } else if (out.kind === 'failed') {
        if (out.hiddenUrl) setHiddenUrl(out.hiddenUrl);
        else toast.error(out.message, { label: 'Try again', onClick: () => void save(note) });
      }
      return out.kind === 'skipped' && !latest.current.state?.dirty;
    },
    [runSave, toast, alive, latest, setHiddenUrl],
  );

  /**
   * "Save, then try": a save already running is waited for (its outcome is shown by whoever
   * started it); when it saved the draft as it is now, nothing is left to save.
   */
  const saveForTry = useCallback(async (): Promise<boolean> => {
    const running = inFlight.current;
    if (running) {
      const out = await running;
      if (!alive.current || out.kind !== 'saved') return false;
      const now = latest.current.draft;
      if (now === null || now === out.graph || graphEquals(now, out.graph)) return true;
    }
    return save();
  }, [save, alive, latest]);

  /**
   * "Restore as new version": the viewed past version's graph saved on top of `baseVersion` (the
   * current one, or the newer one from a conflict), then the editor on the current route.
   */
  const restore = useCallback(
    async (baseVersion: number) => {
      const cur = latest.current.state;
      if (!alive.current || !cur || savingRef.current) return;
      const viewing = cur.savedVersion;
      savingRef.current = true;
      setRestoring(true);
      setConflict((c) => c && { ...c, busy: 'save', error: null });
      const [error, data] = await safe(
        api.workflows.save({
          id,
          baseVersion,
          graph: cur.saved,
          note: `Restored from v${viewing}`,
          // Its webhook URLs are the ones this version had (they arrive redacted).
          restoredFrom: viewing,
        }),
      );
      savingRef.current = false;
      if (!alive.current) return;
      setRestoring(false);
      if (!error) {
        toast.success(`Restored v${viewing} as v${data.version}`);
        // Raw navigate, not the guarded one: a restore runs from a past version, which is
        // read-only and so never dirty; there is no draft for the leave guard to protect.
        navigate(`/workflows/${id}`);
        return;
      }
      if (isDefinedError(error) && error.code === 'VERSION_CONFLICT') {
        const version = error.data.currentVersion;
        setConflict({
          version,
          busy: null,
          error: null,
          failed: null,
          for: { kind: 'restore', viewing },
        });
        return;
      }
      const hidden = hiddenUrlNodes(error);
      const message = hidden
        ? hiddenUrlText(hidden, cur.saved, latest.current.catalog)
        : describeError(error).message;
      // Inside the dialog the failure stays there; from the banner it is a toast to retry.
      if (conflictRef.current) {
        setConflict((c) => c && { ...c, busy: null, error: message, failed: 'save' });
      } else if (hidden) {
        setHiddenUrl(hidden);
      } else {
        toast.error(message, { label: 'Try again', onClick: () => void restore(baseVersion) });
      }
    },
    [id, toast, navigate, latest, alive, setHiddenUrl],
  );

  /** "Reload the latest version": the dialog stays (busy) until the load answers. */
  const reloadLatest = useCallback(async () => {
    setConflict((c) => c && { ...c, busy: 'reload', error: null });
    const [error, w] = await safe(api.workflows.get({ id }));
    if (!alive.current) return;
    if (error) {
      setConflict(
        (c) => c && { ...c, busy: null, error: describeError(error).message, failed: 'reload' },
      );
      return;
    }
    dispatch(loadedAction(w, false));
    setConflict(null);
  }, [id, alive, dispatch]);

  /** "Save over it": a new version on top of the one someone else saved. */
  const saveOver = useCallback(
    async (version: number, note: string | undefined) => {
      setConflict((c) => c && { ...c, busy: 'save', error: null });
      dispatch({ type: 'rebase', version });
      const out = await runSave({ baseVersion: version, note });
      if (!alive.current) return;
      if (out.kind === 'saved') setConflict(null);
      else if (out.kind === 'conflict') {
        // Someone saved again meanwhile: the same choice against the newer version.
        setConflict({
          version: out.currentVersion,
          busy: null,
          error: null,
          failed: null,
          for: { kind: 'draft', note },
        });
      } else if (out.kind === 'failed') {
        setConflict((c) => c && { ...c, busy: null, error: out.message, failed: 'save' });
      } else setConflict((c) => c && { ...c, busy: null });
    },
    [runSave, alive, dispatch],
  );

  function saveOverFor(c: ConflictState) {
    if (c.for.kind === 'restore') void restore(c.version);
    else void saveOver(c.version, c.for.note);
  }

  /** Why "Save and leave" failed, shown inside the leave dialog. */
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const cancelLeaveRef = useRef(() => {});
  /**
   * "Save and leave": true once nothing unsaved is left. A conflict closes the leave dialog for
   * the conflict dialog (a different decision); any other failure stays in the leave dialog.
   */
  const saveForLeave = useCallback(async (): Promise<boolean> => {
    setLeaveError(null);
    const out = await runSave();
    if (!alive.current) return false;
    if (out.kind === 'saved') {
      // Edited while the save ran: those edits are not saved, so leaving would drop them.
      const now = latest.current.draft;
      if (now === null || now === out.graph || graphEquals(now, out.graph)) return true;
      setLeaveError('It changed while saving. Save again to keep the new changes.');
      return false;
    }
    if (out.kind === 'conflict') {
      cancelLeaveRef.current();
      setConflict({
        version: out.currentVersion,
        busy: null,
        error: null,
        failed: null,
        for: { kind: 'draft', note: undefined },
      });
      return false;
    }
    if (out.kind === 'failed') {
      setLeaveError(out.message);
      return false;
    }
    const { state: cur, editable: canEdit } = latest.current;
    if (!cur?.dirty) return true;
    setLeaveError(
      savingRef.current
        ? 'A save is still running. Try again in a moment.'
        : canEdit
          ? 'Could not save. Try again.'
          : 'This draft cannot be saved here.',
    );
    return false;
  }, [runSave, alive, latest]);

  return {
    saving,
    conflict,
    setConflict,
    restoring,
    save,
    saveForTry,
    restore,
    reloadLatest,
    saveOverFor,
    saveForLeave,
    leaveError,
    setLeaveError,
    cancelLeaveRef,
  };
}
