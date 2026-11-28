import type { WorkflowDetail } from '@transcoda/contract';
import { hasErrors, type Issue, type WorkflowGraph } from '@transcoda/shared';
import { ReactFlowProvider, useReactFlowStoreApi } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useLocation, useParams, useSearch } from 'wouter';
import { api, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Icon } from '../components/Icon.tsx';
import { Loading } from '../components/Loading.tsx';
import { useToast } from '../components/Toast.tsx';
import { type Catalog, useCatalog } from '../hooks/use-catalog.ts';
import { useLibraries } from '../hooks/use-libraries.ts';
import { useWorkflows } from '../hooks/use-workflows.ts';
import { runBlocked, useRunOnFile } from '../jobs/use-run-on-file.tsx';
import { useTryOnFile } from '../jobs/use-try-on-file.ts';
import { usePageTitle } from '../lib/page-title.ts';
import { ActivateDialog } from '../workflows/ActivateDialog.tsx';
import { activateBlocked, hasActivation, useActivation } from '../workflows/ActivationControl.tsx';
import { type EditorActions, EditorActionsContext } from './flow/actions-context.ts';
import { SubworkflowsContext } from './flow/subworkflows-context.ts';
import { TRY_BLOCKED } from './flow/TcToolbar.tsx';
import { withViewCollapse } from './flow/to-flow.ts';
import { LoadFailed } from './LoadFailed.tsx';
import { freeOutputs, nextNodeRule } from './model/connection.ts';
import { editorReducer, initialEditorState } from './model/editor-state.ts';
import {
  createGroup,
  duplicateNode,
  joinGroup,
  removeNodes,
  setGroupCollapsed,
  setSettings,
  toggleBypass,
} from './model/graph-ops.ts';
import { libraryShift } from './model/library-shift.ts';
import { type ApplyOptions, Canvas, type GraphOp } from './ui/Canvas.tsx';
import { Banner, CanvasBanner, PastVersionBanner } from './ui/CanvasBanner.tsx';
import { ConflictDialog } from './ui/ConflictDialog.tsx';
import { EditorHeader } from './ui/EditorHeader.tsx';
import { Inspector } from './ui/Inspector.tsx';
import { IssuesPanel, subjectOf } from './ui/IssuesPanel.tsx';
import { LeaveDialog } from './ui/LeaveDialog.tsx';
import { NodeSearch } from './ui/NodeSearch.tsx';
import { Palette } from './ui/Palette.tsx';
import { useEditorKeys } from './ui/use-editor-keys.ts';
import { useLeaveGuard } from './ui/use-leave-guard.ts';
import { useValidation } from './ui/use-validation.ts';
import { useViewportMemory } from './ui/use-viewport-memory.ts';
import { useVersionList, VersionsPanel } from './ui/VersionsPanel.tsx';
import { hiddenUrlText, loadedAction, useEditorSave } from './use-editor-save.ts';
import { useEditorSelection } from './use-editor-selection.ts';
import { type SearchState, usePaletteAdd } from './use-palette-add.ts';

function versionParam(search: string): number | undefined {
  const raw = new URLSearchParams(search).get('version');
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** Below this width the editor is read-only (design: desktop-only, minimum 1024 px). */
const NARROW_QUERY = '(max-width: 1023px)';
const NARROW_NOTICE = 'The editor needs a wider window (1024 px). You can look, not edit.';
const CATALOG_UNAVAILABLE = 'Node catalog unavailable';

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
  const store = useReactFlowStoreApi();
  const { catalog, error: catalogError, reload: reloadCatalog } = useCatalog();
  const { libraries } = useLibraries();
  const narrow = useNarrow();
  const viewportMemory = useViewportMemory(id);
  const { workflows } = useWorkflows();
  const [state, dispatch] = useReducer(editorReducer, initialEditorState());
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loadTick, setLoadTick] = useState(0);
  const [versionsOpen, setVersionsOpen] = useState(false);
  /** The version the Activate dialog is open for (the past-version banner, the can't-run banner). */
  const [activating, setActivating] = useState<number | null>(null);
  /** The header's version pill: focus returns here when an Activate dialog closes. */
  const pillRef = useRef<HTMLButtonElement>(null);
  /** The nodes whose hidden webhook URL the last save could not match (HIDDEN_URL_UNKNOWN). */
  const [hiddenUrl, setHiddenUrl] = useState<string[] | null>(null);
  const [, navigate] = useLocation();
  const [search, setSearch] = useState<SearchState | null>(null);
  const [collapse, setCollapse] = useState<ReadonlyMap<string, boolean>>(new Map());
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

  const {
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
  } = useEditorSave({ id, latest, alive, dispatch, setHiddenUrl });

  async function rename(name: string) {
    const [error, data] = await safe(api.workflows.rename({ id, name }));
    if (error) {
      toast.error(`Could not rename: ${describeError(error).message}`);
      return;
    }
    // The workflow's updatedAt moves; the pill keeps the version's own saved time.
    dispatch({ type: 'workflow', patch: { name: data.name, updatedAt: data.updatedAt } });
  }

  const { clearBox, centre, addFromPalette, pickFromSearch, measuredSizes } = usePaletteAdd({
    canvasRef,
    latest,
    apply,
    dispatch,
    search,
    setSearch,
  });
  const {
    focusTarget,
    onFocused,
    focusField,
    setFocusRequest,
    onSelect,
    selectNode,
    removeSelected,
    focusIssue,
  } = useEditorSelection({
    selection: state?.selection,
    latest,
    apply,
    dispatch,
    canvasRef,
    clearBox,
  });

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
      focusField,
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
  }, [editable, apply, measuredSizes, canTry, openTry, focusField, setFocusRequest]);

  const connectFrom = useCallback(
    (nodeId: string) => {
      const { draft, catalog: cat, editable: canEdit } = latest.current;
      if (!draft || !cat || !canEdit) return;
      // A connection dragged with the mouse wins over the key.
      if (store.connectionStore.getState().connection.inProgress) return;
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

  const activation = useActivation({
    workflow: ready ? state.workflow : null,
    shown: {
      version: state?.savedVersion ?? 0,
      // A past version is blocked by its own errors, like the banner says; the newest by the
      // saved version's, whatever the unsaved draft holds.
      blocked: ready
        ? activateBlocked(
            version === undefined && state.dirty,
            state.issues,
            version === undefined
              ? { valid: state.workflow.valid, errorCount: state.workflow.errorCount }
              : null,
          )
        : null,
    },
    readOnly: !editable,
    onChanged: (summary) => dispatch({ type: 'workflow', patch: summary }),
    returnFocusTo: pillRef,
  });

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
            pillRef={pillRef}
            activeIssue={state.activeIssues[0]?.message}
            activationItems={activation.items}
          />
          {activation.dialog}
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
                        ? {
                            active: state.workflow.active,
                            // The past version's own errors, as the banner below names them.
                            blockedReason: activateBlocked(false, state.issues)?.reason,
                            onClick: () => setActivating(state.savedVersion),
                          }
                        : null
                    }
                  />
                )}
                {hiddenUrl !== null && (
                  <div role="alert" className="canvas-banner is-danger">
                    <Icon name="alert" size={16} round />
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
                      <Icon name="cross" size={16} />
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
