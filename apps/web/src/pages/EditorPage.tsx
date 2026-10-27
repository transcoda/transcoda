import { ORPCError } from '@orpc/client';
import type { NodeInfo, WorkflowDetail, WorkflowSummary } from '@transcoda/contract';
import {
  hasErrors,
  type Issue,
  RUN_SUBWORKFLOW_TYPE,
  SUBWORKFLOW_END_TYPE,
  shortId,
  type WorkflowGraph,
} from '@transcoda/shared';
import { getViewportForBounds, ReactFlowProvider, useReactFlow, useStoreApi } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import { api, isDefinedError, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Icon } from '../components/Icon.tsx';
import { Loading } from '../components/Loading.tsx';
import { NotFound } from '../components/NotFound.tsx';
import { useToast } from '../components/Toast.tsx';
import { type EditorActions, EditorActionsContext } from '../editor/flow/actions-context.ts';
import { SubworkflowsContext } from '../editor/flow/subworkflows-context.ts';
import { TRY_BLOCKED } from '../editor/flow/TcToolbar.tsx';
import { withViewCollapse } from '../editor/flow/toFlow.ts';
import { freeOutputs, nextNodeRule } from '../editor/model/connection.ts';
import {
  type EditorAction,
  editorReducer,
  initialEditorState,
} from '../editor/model/editor-state.ts';
import { graphEquals } from '../editor/model/equality.ts';
import {
  addNode,
  connect,
  createGroup,
  duplicateNode,
  joinGroup,
  NODE_SIZE,
  type Position,
  removeNodes,
  removeSelection,
  type Size,
  setGroupCollapsed,
  setSettings,
  toggleBypass,
} from '../editor/model/graph-ops.ts';
import { dropHiddenPortEdges, removedNotice } from '../editor/model/hidden-ports.ts';
import { libraryShift } from '../editor/model/library-shift.ts';
import { addNote, addValuesCard } from '../editor/model/notes-values.ts';
import { freeSpot, type ViewRect } from '../editor/model/placement.ts';
import { saveNoteFor } from '../editor/model/save-note.ts';
import { ActivateDialog } from '../editor/ui/ActivateDialog.tsx';
import {
  ActivationControl,
  activateBlocked,
  hasActivation,
} from '../editor/ui/ActivationControl.tsx';
import { type ApplyOptions, Canvas, FIT_VIEW, type GraphOp } from '../editor/ui/Canvas.tsx';
import { Banner, CanvasBanner, PastVersionBanner } from '../editor/ui/CanvasBanner.tsx';
import { ConflictDialog } from '../editor/ui/ConflictDialog.tsx';
import { EditorHeader } from '../editor/ui/EditorHeader.tsx';
import { Inspector } from '../editor/ui/Inspector.tsx';
import { IssuesPanel, type IssueTarget, subjectOf } from '../editor/ui/IssuesPanel.tsx';
import { LeaveDialog } from '../editor/ui/LeaveDialog.tsx';
import { NodeSearch } from '../editor/ui/NodeSearch.tsx';
import { Palette, type PaletteItem } from '../editor/ui/Palette.tsx';
import { useEditorKeys } from '../editor/ui/useEditorKeys.ts';
import { useLeaveGuard } from '../editor/ui/useLeaveGuard.ts';
import { useValidation } from '../editor/ui/useValidation.ts';
import { useViewportMemory } from '../editor/ui/useViewportMemory.ts';
import { useVersionList, VersionsPanel } from '../editor/ui/VersionsPanel.tsx';
import { type Catalog, type PortSpec, useCatalog } from '../hooks/useCatalog.ts';
import { useLibraries } from '../hooks/useLibraries.ts';
import { useWorkflows } from '../hooks/useWorkflows.ts';
import { runBlocked, useRunOnFile } from '../jobs/useRunOnFile.tsx';
import { useTryOnFile } from '../jobs/useTryOnFile.ts';
import { usePageTitle } from '../lib/pageTitle.ts';

/** Horizontal step between a node and the one added after it. */
const NEXT_STEP_X = NODE_SIZE.width + 70;

function versionParam(search: string): number | undefined {
  const raw = new URLSearchParams(search).get('version');
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** Below this width the editor is read-only (design: desktop-only, minimum 1024 px). */
const NARROW_QUERY = '(max-width: 1023px)';
const NARROW_NOTICE = 'The editor needs a wider window (1024 px). You can look, not edit.';
const CATALOG_UNAVAILABLE = 'Node catalogue unavailable';
/** The key, zoom controls and minimap sit along the canvas bottom (44 px controls + 16 px margin + gap). */
const BOTTOM_OVERLAYS = 72;

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return narrow;
}

const nodeElement = (id: string) =>
  document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);

function chain(steps: GraphOp[]): GraphOp {
  return (g) => {
    let graph = g;
    for (const step of steps) {
      const r = step(graph);
      if (!r.ok) return r;
      graph = r.graph;
    }
    return { ok: true, graph };
  };
}

/** The graph op that adds a palette item at `pos`. */
function addItem(
  item: PaletteItem,
  pos: Position,
  catalog: Catalog,
  view: ViewRect | undefined,
): GraphOp {
  if (item.kind === 'node')
    return (g) => addNode(g, item.def.type, freeSpot(g, pos, view), catalog);
  if (item.kind === 'end')
    return (g) => addNode(g, SUBWORKFLOW_END_TYPE, freeSpot(g, pos, view), catalog);
  if (item.kind === 'note') return (g) => addNote(g, pos, shortId());
  if (item.kind === 'values') return (g) => addValuesCard(g, pos);
  const id = shortId();
  const { workflow } = item;
  return chain([
    (g) => addNode(g, RUN_SUBWORKFLOW_TYPE, freeSpot(g, pos, view), catalog, { id }),
    (g) =>
      setSettings(g, id, {
        subworkflowId: workflow.id,
        version: workflow.currentVersion,
        overrides: {},
      }),
  ]);
}

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
function hiddenUrlText(nodeIds: string[], graph: WorkflowGraph, catalog: Catalog | null): string {
  const names = nodeIds.map((nodeId) => subjectOf({ nodeId } as Issue, graph, catalog));
  return `A hidden webhook URL could not be matched to a saved one. Enter the URL again in ${names.join(', ')}.`;
}

function loadedAction(w: WorkflowDetail, readOnly: boolean): EditorAction {
  const { version, graph, issues, settings: _settings, activeIssues, ...workflow } = w;
  return { type: 'loaded', workflow, version, graph, issues, activeIssues, readOnly };
}

type SearchState = { from: { nodeId: string; port: PortSpec } | null };

function Editor({
  id,
  version,
  focusPalette,
}: {
  id: string;
  version: number | undefined;
  focusPalette: boolean;
}) {
  const toast = useToast();
  const rf = useReactFlow();
  const store = useStoreApi();
  const { catalog, error: catalogError, reload: reloadCatalog } = useCatalog();
  const { libraries } = useLibraries();
  const narrow = useNarrow();
  const viewportMemory = useViewportMemory(id);
  const { workflows } = useWorkflows();
  const [state, dispatch] = useReducer(editorReducer, initialEditorState());
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loadTick, setLoadTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  /** The version the Activate dialog is open for (the past-version banner, the can't-run banner). */
  const [activating, setActivating] = useState<number | null>(null);
  /** The header pill: focus returns here when the page's Activate dialog closes. */
  const pillRef = useRef<HTMLSpanElement>(null);
  /** The nodes whose hidden webhook URL the last save could not match (HIDDEN_URL_UNKNOWN). */
  const [hiddenUrl, setHiddenUrl] = useState<string[] | null>(null);
  const [, navigate] = useLocation();
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
  const [search, setSearch] = useState<SearchState | null>(null);
  const [collapse, setCollapse] = useState<ReadonlyMap<string, boolean>>(new Map());
  /**
   * A field the inspector focuses once its target is the selection: a node's setting (issues
   * panel, on-node row) or a new group's `name`.
   */
  const [focusRequest, setFocusRequest] = useState<{ targetId: string; key: string } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const paletteFocused = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadTick is the reload trigger.
  useEffect(() => {
    let live = true;
    setLoadError(null);
    setCollapse(new Map());
    setHiddenUrl(null);
    const input = version === undefined ? { id } : { id, version };
    api.workflows.get(input).then(
      (w: WorkflowDetail) => {
        if (live) dispatch(loadedAction(w, version !== undefined));
      },
      (e: unknown) => {
        if (live) setLoadError(e);
      },
    );
    return () => {
      live = false;
    };
  }, [id, version, loadTick]);

  const ready = state !== null && state.workflow.id === id;
  const shownVersion = ready ? state.savedVersion : null;

  // One `workflows.versions` list for the pill and the versions panel, fetched again when the
  // shown or the current version moves. The pill's time is the shown version's own `createdAt` (a
  // rename moves `updatedAt`); until this answers, and if it fails, the time from the load or the
  // save stands.
  const versionList = useVersionList(
    id,
    shownVersion === null ? null : `${shownVersion}/${state?.workflow.currentVersion}`,
  );
  const versionTimes = useMemo(
    () =>
      new Map(
        versionList.load.status === 'ok'
          ? versionList.load.versions.map((v) => [v.version, v.createdAt])
          : [],
      ),
    [versionList.load],
  );
  const editable = ready && !state.readOnly && catalog !== null && !narrow;

  // `?focus=palette` ("Add a trigger" on the empty list): once the palette is drawn, focus its
  // search and bring the Trigger section into view.
  useEffect(() => {
    if (!focusPalette || paletteFocused.current || !ready || !catalog) return;
    const input = searchRef.current;
    if (!input) return;
    paletteFocused.current = true;
    input.focus();
    input
      .closest('.palette')
      ?.querySelector<HTMLElement>('[role="group"][aria-label="Trigger"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [focusPalette, ready, catalog]);

  // Latest values for callbacks that outlive a render (async save, React Flow handlers). `draft`
  // also moves synchronously with each applied op, so two ops in one tick build on each other.
  const latest = useRef({ state, editable, catalog, draft: state?.draft ?? null });
  if (latest.current.state !== state) latest.current.draft = state?.draft ?? null;
  latest.current.state = state;
  latest.current.editable = editable;
  latest.current.catalog = catalog;
  const savingRef = useRef(false);
  /** The save that is running, for "Save, then try" to wait for. */
  const inFlight = useRef<Promise<SaveOutcome> | null>(null);
  // A save answered after leaving the page (or a "Try again" toast clicked later) does nothing.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useValidation({
    id,
    draft: state?.draft ?? EMPTY_GRAPH,
    enabled: editable,
    dispatch,
  });

  const refuse = useCallback((reason: string) => toast.error(reason), [toast]);

  const apply = useCallback(
    (op: GraphOp, opts?: ApplyOptions) => {
      const { draft, editable: canEdit } = latest.current;
      if (!draft || !canEdit) return false;
      const result = op(draft);
      if (!result.ok) {
        refuse(result.refusal.reason);
        return false;
      }
      latest.current.draft = result.graph;
      dispatch({ type: 'apply', result, ...opts });
      return true;
    },
    [refuse],
  );

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
    [id, toast],
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
    [runSave, toast],
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
  }, [save]);

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
    [id, toast, navigate],
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
  }, [id]);

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
    [runSave],
  );

  async function rename(name: string) {
    const [error, data] = await safe(api.workflows.rename({ id, name }));
    if (error) {
      toast.error(`Could not rename: ${describeError(error).message}`);
      return;
    }
    // The workflow's updatedAt moves; the pill keeps the version's own saved time.
    dispatch({ type: 'workflow', patch: { name: data.name, updatedAt: data.updatedAt } });
  }

  function saveOverFor(c: ConflictState) {
    if (c.for.kind === 'restore') void restore(c.version);
    else void saveOver(c.version, c.for.note);
  }

  /** The visible part of the canvas in flow coordinates; undefined before layout. */
  /**
   * The canvas area cards can be seen in, on screen: the canvas less the banners on top and the
   * key, zoom controls and minimap row at the bottom. Null before layout.
   */
  const clearBox = useCallback((): {
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null => {
    const wrap = canvasRef.current;
    const box = wrap?.getBoundingClientRect();
    if (!wrap || !box || box.width === 0 || box.height === 0) return null;
    const banners = wrap.querySelector('.canvas-banners');
    const bannerBottom =
      banners && banners.childElementCount > 0
        ? banners.getBoundingClientRect().bottom + 8
        : box.top;
    const top = Math.min(Math.max(box.top, bannerBottom), box.bottom);
    const bottom = Math.max(top, box.bottom - BOTTOM_OVERLAYS);
    return { left: box.left, top, right: box.right, bottom };
  }, []);

  /** The visible part of the canvas in flow coordinates; undefined before layout. */
  const viewRect = useCallback((): ViewRect | undefined => {
    const box = clearBox();
    if (!box) return undefined;
    const a = rf.screenToFlowPosition({ x: box.left, y: box.top });
    const b = rf.screenToFlowPosition({ x: box.right, y: box.bottom });
    return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
  }, [rf, clearBox]);

  /** The flow position of the canvas centre, less half a card so the card is centred. */
  const centre = useCallback((): Position => {
    const box = clearBox();
    const p = rf.screenToFlowPosition({
      x: box ? (box.left + box.right) / 2 : 0,
      y: box ? (box.top + box.bottom) / 2 : 0,
    });
    return {
      x: Math.round(p.x - NODE_SIZE.width / 2),
      y: Math.round(p.y - NODE_SIZE.height / 2),
    };
  }, [rf, clearBox]);

  const addFromPalette = useCallback(
    (item: PaletteItem, pos: Position) => {
      const cat = latest.current.catalog;
      if (cat) apply(addItem(item, pos, cat, viewRect()));
    },
    [apply, viewRect],
  );

  /** `workflow`: a named sub-workflow was picked; the new Run node pins its current version. */
  function pickFromSearch(def: NodeInfo, workflow?: WorkflowSummary) {
    const cat = latest.current.catalog;
    const from = search?.from ?? null;
    setSearch(null);
    if (!cat) return;
    const view = viewRect();
    const newId = shortId();
    const pinned: GraphOp = (g) =>
      workflow
        ? setSettings(g, newId, {
            subworkflowId: workflow.id,
            version: workflow.currentVersion,
            overrides: {},
          })
        : { ok: true, graph: g };
    if (!from) {
      apply(
        chain([
          (g) => addNode(g, def.type, freeSpot(g, centre(), view), cat, { id: newId }),
          pinned,
        ]),
      );
      return;
    }
    const input = def.inputs.find((p) => p.type === from.port.type);
    apply(
      chain([
        (g) => {
          const origin = g.nodes.find((n) => n.id === from.nodeId);
          const pos = origin
            ? { x: origin.position.x + NEXT_STEP_X, y: origin.position.y }
            : centre();
          return addNode(g, def.type, freeSpot(g, pos, view), cat, { id: newId });
        },
        pinned,
        (g) =>
          input
            ? connect(
                g,
                { node: from.nodeId, port: from.port.id },
                { node: newId, port: input.id },
                cat,
              )
            : { ok: true, graph: g },
      ]),
    );
  }

  const measuredSizes = useCallback(
    (ids: string[]): Map<string, Size> => {
      const sizes = new Map<string, Size>();
      for (const nodeId of ids) {
        const m = rf.getInternalNode(nodeId)?.measured;
        if (m?.width && m.height) sizes.set(nodeId, { width: m.width, height: m.height });
      }
      return sizes;
    },
    [rf],
  );

  // "Dry run on a file" / "Try this node" (Task 24): a workflow only (a sub-workflow runs inside
  // one). On a past version the dry run plans that version.
  const tryBlockedReason = !ready
    ? undefined
    : state.workflow.kind !== 'workflow'
      ? TRY_BLOCKED
      : version === undefined && state.dirty && !editable
        ? 'This draft cannot be saved here'
        : undefined;
  const canTry = ready && tryBlockedReason === undefined;
  usePageTitle(ready ? state.workflow.name : 'Workflow');
  const tryOnFile = useTryOnFile(
    { id, name: ready ? state.workflow.name : '', ...(version !== undefined ? { version } : {}) },
    { dirty: ready && state.dirty, save: saveForTry },
  );
  const openTry = tryOnFile.open;
  // "Run on a file": a real run of the active version, whatever the draft or the version shown.
  // The server ran it dry (deactivated elsewhere): refresh the summary so the header says why.
  const refreshSummary = useCallback(() => {
    void safe(api.workflows.get({ id })).then(([err, w]) => {
      if (err || !w) return;
      const { version: _v, graph: _g, issues: _i, activeIssues: _a, settings: _s, ...summary } = w;
      dispatch({ type: 'workflow', patch: summary });
    });
  }, [id]);
  const runOnFile = useRunOnFile(ready ? state.workflow : null, refreshSummary);
  const runBlockedReason =
    ready && state.workflow.kind === 'workflow' ? runBlocked(state.workflow)?.reason : undefined;

  const actions = useMemo<EditorActions>(() => {
    const withCatalog = (fn: (c: Catalog) => GraphOp) => {
      const cat = latest.current.catalog;
      if (cat) apply(fn(cat));
    };
    return {
      readOnly: !editable,
      duplicate: (nodeId) => withCatalog((c) => (g) => duplicateNode(g, nodeId, c)),
      toggleBypass: (nodeId) => apply((g) => toggleBypass(g, nodeId)),
      remove: (ids) => apply((g) => removeNodes(g, ids)),
      tryNode: canTry ? (nodeId) => openTry(nodeId) : null,
      startConnectFrom: (nodeId, port) => setSearch({ from: { nodeId, port } }),
      setSettings: (nodeId, settings) =>
        apply((g) => setSettings(g, nodeId, settings), { coalesce: 'settings', key: nodeId }),
      focusField: (nodeId, key) => {
        dispatch({ type: 'select', nodes: [nodeId], edges: [] });
        setFocusRequest({ targetId: nodeId, key });
      },
      groupSelection: (name) => {
        const ids = latest.current.state?.selection.nodes ?? [];
        let groupId: string | undefined;
        const made = apply((g) => {
          // Sized from the measured cards, so the header at the box's bottom stays clear of them.
          const r = createGroup(g, name, ids, measuredSizes(ids));
          if (r.ok) groupId = r.graph.groups.at(-1)?.id;
          return r;
        });
        if (!made || groupId === undefined) return;
        // The new group is the selection, its inspector open with the name ready to type.
        dispatch({ type: 'select', nodes: [], edges: [], group: groupId });
        setFocusRequest({ targetId: groupId, key: 'name' });
      },
      setGroupCollapsed: (groupId, collapsed) => {
        if (latest.current.editable) apply((g) => setGroupCollapsed(g, groupId, collapsed));
        else setCollapse((m) => new Map(m).set(groupId, collapsed));
      },
      // The box grows around the card's measured size (cards grow with their port rows).
      joinGroup: (nodeId, groupId) =>
        apply((g) => joinGroup(g, nodeId, groupId, measuredSizes([nodeId]).get(nodeId))),
    };
  }, [editable, apply, measuredSizes, canTry, openTry]);

  const onSelect = useCallback(
    (next: { nodes: string[]; edges: string[]; group?: string }) =>
      dispatch({ type: 'select', ...next }),
    [],
  );

  /** Select one node and move keyboard focus to it (React Flow pans to a focused node). */
  const selectNode = useCallback((nodeId: string) => {
    dispatch({ type: 'select', nodes: [nodeId], edges: [] });
    nodeElement(nodeId)?.focus();
  }, []);

  const removeSelected = useCallback(() => {
    const sel = latest.current.state?.selection;
    if (sel) apply((g) => removeSelection(g, sel));
  }, [apply]);

  const connectFrom = useCallback(
    (nodeId: string) => {
      const { draft, catalog: cat, editable: canEdit } = latest.current;
      if (!draft || !cat || !canEdit) return;
      // A connection dragged with the mouse wins over the key.
      if (store.getState().connection.inProgress) return;
      const port = freeOutputs(draft, nodeId, cat)[0];
      if (!port) {
        refuse('This node has no free output');
        return;
      }
      setSearch({ from: { nodeId, port } });
    },
    [store, refuse],
  );

  const undo = useCallback(() => {
    if (latest.current.editable) dispatch({ type: 'undo' });
  }, []);
  const redo = useCallback(() => {
    if (latest.current.editable) dispatch({ type: 'redo' });
  }, []);

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
  }, [runSave]);
  const leave = useLeaveGuard({ dirty: ready && state.dirty, save: saveForLeave });
  cancelLeaveRef.current = leave.cancelLeave;

  useEditorKeys({
    enabled: ready && search === null && conflict === null && leave.pending === null,
    graph: state?.draft ?? EMPTY_GRAPH,
    selection: state?.selection ?? NO_SELECTION,
    catalog,
    actions: {
      selectNode,
      undo,
      redo,
      remove: () => {
        if (latest.current.editable) removeSelected();
      },
      save: () => {
        if (latest.current.editable && latest.current.state?.dirty) void save();
      },
      openSearch: () => {
        if (latest.current.editable) setSearch({ from: null });
      },
      connectFrom,
    },
  });

  /** An issues panel entry: select and centre its node or edge (and focus the setting). */
  const focusIssue = useCallback(
    (target: IssueTarget) => {
      const g = latest.current.state?.draft;
      if (!g) return;
      const visible = (nodeId: string) => {
        const node = g.nodes.find((n) => n.id === nodeId);
        const group = g.groups.find((gr) => gr.id === node?.groupId);
        return group?.collapsed ? group.id : nodeId;
      };
      // Direct viewport math: React Flow's fitView is queued until the next node update.
      const centreOn = (ids: string[]) => {
        const { width, height, minZoom } = store.getState();
        if (ids.length === 0 || width === 0 || height === 0) return;
        // Fit into the part of the canvas the banners and bottom controls leave clear.
        const wrapTop = canvasRef.current?.getBoundingClientRect().top ?? 0;
        const box = clearBox();
        const insetTop = box ? box.top - wrapTop : 0;
        const clearHeight = box ? box.bottom - box.top : height;
        const bounds = rf.getNodesBounds(ids);
        const viewport = getViewportForBounds(
          bounds,
          width,
          clearHeight > 0 ? clearHeight : height,
          minZoom,
          FIT_VIEW.maxZoom,
          0.4,
        );
        void rf.setViewport({ ...viewport, y: viewport.y + insetTop }, { duration: 200 });
      };
      if (target.nodeId !== undefined && g.nodes.some((n) => n.id === target.nodeId)) {
        if (target.settingPath !== undefined) actions.focusField(target.nodeId, target.settingPath);
        else dispatch({ type: 'select', nodes: [target.nodeId], edges: [] });
        centreOn([visible(target.nodeId)]);
        return;
      }
      const edge = g.edges.find((e) => e.id === target.edgeId);
      if (edge) {
        dispatch({ type: 'select', nodes: [], edges: [edge.id] });
        centreOn([visible(edge.from.node), visible(edge.to.node)]);
        return;
      }
      centreOn([...new Set(g.nodes.map((n) => visible(n.id)))]);
    },
    [rf, store, actions, clearBox],
  );

  const onFocused = useCallback(() => setFocusRequest(null), []);
  const sel = state?.selection;
  const [onlySelected] = sel?.nodes ?? [];
  const focusTarget =
    focusRequest !== null &&
    sel !== undefined &&
    (sel.nodes.length === 1
      ? onlySelected === focusRequest.targetId
      : sel.nodes.length === 0 && sel.group === focusRequest.targetId)
      ? focusRequest.key
      : null;
  // A request for a target that is no longer the selection is dropped, not kept for later.
  useEffect(() => {
    if (focusRequest !== null && focusTarget === null) setFocusRequest(null);
  }, [focusRequest, focusTarget]);

  if (!ready) {
    if (loadError)
      return (
        <LoadFailed
          error={loadError}
          id={id}
          version={version}
          onRetry={() => setLoadTick((t) => t + 1)}
        />
      );
    return (
      <main className="app-loading">
        <Loading />
      </main>
    );
  }

  // Below 1024 px the inspector is a bottom sheet, there only while something is selected.
  const inspectorShown =
    !narrow || state.selection.nodes.length > 0 || state.selection.group !== undefined;
  const view = editable ? state.draft : withViewCollapse(state.draft, collapse);
  // Spec N4: the "+" button's name; the search adds its count and a line saying what it lists.
  const searchTitle = search?.from ? 'Add the next node' : 'Add a node';

  return (
    <EditorActionsContext.Provider value={actions}>
      <SubworkflowsContext.Provider value={workflows}>
        <div className="editor">
          <EditorHeader
            workflow={state.workflow}
            savedVersion={state.savedVersion}
            savedAt={versionTimes.get(state.savedVersion) ?? state.savedAt}
            dirty={state.dirty}
            readOnly={!editable}
            saving={saving}
            onSave={(note) => void save(note)}
            onRename={(name) => void rename(name)}
            noteMenu
            onOpenVersions={() => {
              // A list that failed to load is asked for again; a loaded one is reused.
              if (!versionsOpen && versionList.load.status === 'failed') versionList.reload();
              setVersionsOpen((o) => !o);
            }}
            versionsOpen={versionsOpen}
            versionsPanel={
              <VersionsPanel
                open={versionsOpen}
                workflowId={id}
                currentVersion={state.workflow.currentVersion}
                viewing={state.savedVersion}
                activeVersion={state.workflow.active?.version ?? null}
                load={versionList.load}
                onRetry={versionList.reload}
                onClose={() => setVersionsOpen(false)}
              />
            }
            saveBlockedReason={
              catalogError ? CATALOG_UNAVAILABLE : narrow ? 'Needs a wider window' : undefined
            }
            showSave={version === undefined}
            canUndo={editable && state.history.past.length > 0}
            canRedo={editable && state.history.future.length > 0}
            onUndo={undo}
            onRedo={redo}
            onTry={canTry ? () => openTry() : undefined}
            tryBlockedReason={tryBlockedReason}
            onRun={ready && runBlockedReason === undefined ? runOnFile.open : undefined}
            runBlockedReason={runBlockedReason}
            compact={narrow}
          >
            <ActivationControl
              workflow={state.workflow}
              shown={{
                version: state.savedVersion,
                // A past version is blocked by its own errors, like the banner says; the newest
                // by the saved version's, whatever the unsaved draft holds.
                blocked: activateBlocked(
                  version === undefined && state.dirty,
                  state.issues,
                  version === undefined
                    ? { valid: state.workflow.valid, errorCount: state.workflow.errorCount }
                    : null,
                ),
              }}
              {...(state.activeIssues[0] ? { activeIssue: state.activeIssues[0].message } : {})}
              readOnly={!editable}
              onChanged={(summary) => dispatch({ type: 'workflow', patch: summary })}
              pillRef={pillRef}
            />
          </EditorHeader>
          <div className="editor-body">
            {catalog ? (
              <Palette
                catalog={catalog}
                graphKind={state.draft.kind}
                selfId={id}
                subworkflows={workflows ?? []}
                readOnly={!editable}
                hasValues={state.draft.values !== undefined}
                onAdd={(item) => addFromPalette(item, centre())}
                onDragStart={() => {}}
                searchRef={searchRef}
              />
            ) : (
              <aside aria-label="Node palette" className="palette" />
            )}
            <div ref={canvasRef} className="editor-canvas-wrap">
              <div className="canvas-banners">
                {version !== undefined && (
                  <PastVersionBanner
                    viewing={state.savedVersion}
                    current={state.workflow.currentVersion}
                    editHref={`/workflows/${id}`}
                    restoring={restoring}
                    onRestore={() => void restore(state.workflow.currentVersion)}
                    viewingActive={state.workflow.active?.version === state.savedVersion}
                    activate={
                      hasActivation(state.workflow) &&
                      state.workflow.active?.version !== state.savedVersion
                        ? { onClick: () => setActivating(state.savedVersion) }
                        : null
                    }
                  />
                )}
                {hiddenUrl !== null && (
                  <div role="alert" className="canvas-banner is-danger">
                    <Icon name="alert" size={16} strokeWidth={2.4} round />
                    <span>{hiddenUrlText(hiddenUrl, state.draft, catalog)}</span>
                    {hiddenUrl
                      .filter((nodeId) => state.draft.nodes.some((n) => n.id === nodeId))
                      .map((nodeId) => {
                        const name = subjectOf({ nodeId } as Issue, state.draft, catalog);
                        return (
                          <button
                            key={nodeId}
                            type="button"
                            className="canvas-banner-action"
                            onClick={() => focusIssue({ nodeId })}
                          >
                            Show {name}
                          </button>
                        );
                      })}
                  </div>
                )}
                {narrow && <Banner tone="info">{NARROW_NOTICE}</Banner>}
                {Boolean(catalogError) && (
                  <Banner tone="danger">
                    <span>{CATALOG_UNAVAILABLE} — reload</span>
                    <button type="button" className="canvas-banner-action" onClick={reloadCatalog}>
                      Reload
                    </button>
                  </Banner>
                )}
                <CanvasBanner
                  issues={state.issues}
                  workflow={state.workflow}
                  graph={state.draft}
                  catalog={catalog}
                  dirty={state.dirty}
                  activeIssues={state.activeIssues}
                  libraryShift={
                    version === undefined
                      ? libraryShift(state.workflow, state.draft, libraries)
                      : null
                  }
                  activatable={
                    version === undefined &&
                    !state.dirty &&
                    !hasErrors(state.issues) &&
                    state.workflow.active?.version !== state.savedVersion
                      ? {
                          version: state.savedVersion,
                          onActivate: () => setActivating(state.savedVersion),
                        }
                      : null
                  }
                />
                {state.lastChanges.length > 0 && (
                  <Banner tone="info" live={false}>
                    <span>This version: {state.lastChanges.join('; ')}</span>
                  </Banner>
                )}
              </div>
              <Canvas
                graph={view}
                issues={state.issues}
                selection={state.selection}
                catalog={catalog}
                readOnly={!editable}
                apply={apply}
                onSelect={onSelect}
                onRefuse={refuse}
                onDropItem={addFromPalette}
                defaultViewport={viewportMemory.defaultViewport}
                onMoveEnd={viewportMemory.onMoveEnd}
              />
            </div>
            {inspectorShown && (
              <aside
                aria-label="Inspector"
                className={narrow ? 'inspector-col is-sheet' : 'inspector-col'}
              >
                {narrow && (
                  <div className="sheet-head">
                    <button
                      type="button"
                      className="panel-close"
                      aria-label="Close inspector"
                      onClick={() => onSelect(NO_SELECTION)}
                    >
                      <Icon name="cross" size={16} strokeWidth={2.4} />
                    </button>
                  </div>
                )}
                <Inspector
                  state={state}
                  catalog={catalog}
                  dispatch={apply}
                  readOnly={!editable}
                  focusField={focusTarget}
                  onFocused={onFocused}
                  subworkflows={workflows ?? []}
                  joinGroup={actions.joinGroup}
                  groupSelection={actions.groupSelection}
                />
                <section aria-label="Issues" className="inspector-issues-region">
                  <IssuesPanel
                    issues={state.issues}
                    catalog={catalog}
                    graph={state.draft}
                    onFocus={focusIssue}
                  />
                </section>
              </aside>
            )}
          </div>
          {catalog && (
            <NodeSearch
              open={search !== null}
              catalog={catalog}
              graphKind={state.draft.kind}
              filter={
                search?.from
                  ? {
                      portType: search.from.port.type,
                      label: search.from.port.label,
                      rule: nextNodeRule(
                        state.draft,
                        search.from.nodeId,
                        search.from.port.id,
                        catalog,
                      ),
                    }
                  : null
              }
              title={searchTitle}
              subworkflows={workflows ?? []}
              selfId={id}
              onPick={pickFromSearch}
              onClose={() => setSearch(null)}
            />
          )}
          {tryOnFile.element}
          {runOnFile.element}
          <LeaveDialog
            open={leave.pending !== null}
            saving={saving}
            error={leaveError}
            onSaveAndLeave={() => void leave.saveAndLeave()}
            onLeave={() => {
              setLeaveError(null);
              leave.confirmLeave();
            }}
            onStay={() => {
              setLeaveError(null);
              leave.cancelLeave();
            }}
          />
          <ActivateDialog
            open={activating !== null}
            workflow={state.workflow}
            version={activating ?? state.savedVersion}
            issues={state.issues}
            returnFocusTo={pillRef}
            onClose={() => setActivating(null)}
            onActivated={(summary) => {
              setActivating(null);
              dispatch({ type: 'workflow', patch: summary });
            }}
          />
          <ConflictDialog
            open={conflict !== null}
            currentVersion={conflict?.version ?? 0}
            restoring={conflict?.for.kind === 'restore' ? conflict.for.viewing : undefined}
            busy={conflict?.busy ?? null}
            error={conflict?.error ?? null}
            onClose={() => setConflict(null)}
            onReload={() => {
              // A restore's "reload" is the current version itself: the plain editor route. Raw
              // navigate: a restore conflict comes from a read-only past version, never a dirty draft.
              if (conflict?.for.kind === 'restore') navigate(`/workflows/${id}`);
              else void reloadLatest();
            }}
            onSaveOver={() => {
              if (conflict) saveOverFor(conflict);
            }}
            onRetry={() => {
              if (conflict?.failed === 'reload') void reloadLatest();
              else if (conflict?.failed === 'save') saveOverFor(conflict);
            }}
          />
        </div>
      </SubworkflowsContext.Provider>
    </EditorActionsContext.Provider>
  );
}

const NO_SELECTION = { nodes: [], edges: [] };

const EMPTY_GRAPH: WorkflowGraph = {
  formatVersion: 2,
  kind: 'workflow',
  nodes: [],
  edges: [],
  groups: [],
};

function LoadFailed({
  error,
  id,
  version,
  onRetry,
}: {
  error: unknown;
  id: string;
  version: number | undefined;
  onRetry(): void;
}) {
  const notFound = describeError(error).code === 'NOT_FOUND';
  if (notFound && version !== undefined) {
    return (
      <div className="page editor-load-failed">
        <p role="alert" className="alert alert-danger">
          Version {version} doesn't exist
        </p>
        <p>
          <Link href={`/workflows/${id}`}>Open the current version</Link>
        </p>
      </div>
    );
  }
  if (notFound) return <NotFound what="workflow" />;
  return (
    <div className="page editor-load-failed">
      <p role="alert" className="alert alert-danger">
        {describeError(error).message}
      </p>
      <p>
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          Try again
        </button>{' '}
        <Link href="/">Back to workflows</Link>
      </p>
    </div>
  );
}

/**
 * "/workflows/:id" (+ `?version=N`: that version read-only, with "Restore as new version";
 * + `?focus=palette` focuses the palette search).
 */
export function EditorPage() {
  const { id = '' } = useParams<{ id: string }>();
  const search = useSearch();
  const version = versionParam(search);
  const focusPalette = new URLSearchParams(search).get('focus') === 'palette';
  return (
    // A new workflow or version starts from a fresh editor and viewport.
    <ReactFlowProvider key={`${id}@${version ?? 'current'}`}>
      <Editor id={id} version={version} focusPalette={focusPalette} />
    </ReactFlowProvider>
  );
}
