import type { Issue, PortRef, WorkflowGraph } from '@transcoda/shared';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  ControlButton,
  Controls,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
  ReactFlow,
  useReactFlow,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Icon } from '../../components/Icon.tsx';
import type { Catalog } from '../../hooks/useCatalog.ts';
import { type FlowChangeResult, fromEdgeChanges, fromNodeChanges } from '../flow/fromFlow.ts';
import { edgeTypes, nodeTypes } from '../flow/nodeTypes.ts';
import { TcConnectionLine } from '../flow/TcConnectionLine.tsx';
import { TcMiniMap } from '../flow/TcMiniMap.tsx';
import { COLLAPSED_GROUP_SIZE, toFlow } from '../flow/toFlow.ts';
import type { TcFlowEdge, TcFlowNode } from '../flow/types.ts';
import { checkConnection } from '../model/connection.ts';
import type { EditorState } from '../model/editor-state.ts';
import { connect, NODE_SIZE, type OpResult, type Position } from '../model/graph-ops.ts';
import { tidyUp } from '../model/layout.ts';
import { CanvasLegend } from './CanvasLegend.tsx';
import { PALETTE_DRAG_TYPE, type PaletteItem } from './Palette.tsx';

type FlowNode = TcFlowNode;
type Selection = EditorState['selection'];
export type GraphOp = (g: WorkflowGraph) => OpResult;
export type ApplyOptions = { coalesce?: 'move' | 'settings'; key?: string };

/** Zoom-out limit: below 0.4 the cards become icon tiles (N9), so it must be reachable. */
export const MIN_ZOOM = 0.1;

/** A small graph is fitted at 100 %, never blown up. */
export const FIT_VIEW = { maxZoom: 1, padding: 0.2 };

/** Keys that add a clicked card to the selection: React Flow's Meta/Control plus Shift. */
const MULTI_SELECT_KEYS = ['Meta', 'Control', 'Shift'];
/** No "React Flow" link on the canvas (a stable object: React Flow compares props by reference). */
const PRO_OPTIONS = { hideAttribution: true };

/** How close (px) a dragged connection snaps to a handle; the handles' own hit area is 26 px. */
const CONNECTION_RADIUS = 30;

type HandleEnd = { nodeId: string; handleId: string | null; type: 'source' | 'target' };

/** The ports of a connection attempt, output first; null when both ends are the same side. */
function portsOf(a: HandleEnd, b: HandleEnd): { from: PortRef; to: PortRef } | null {
  if (a.type === b.type || a.handleId === null || b.handleId === null) return null;
  const [out, inp] = a.type === 'source' ? [a, b] : [b, a];
  return {
    from: { node: out.nodeId, port: out.handleId ?? '' },
    to: { node: inp.nodeId, port: inp.handleId ?? '' },
  };
}

/**
 * Derived flow nodes for a new draft: React Flow's measurements carry over (so cards are not
 * re-measured and hidden on every edit), and a card being dragged keeps its live position.
 */
function carryOver(
  derived: FlowNode[],
  previous: FlowNode[],
  measured: ReadonlyMap<string, { width: number; height: number }>,
): FlowNode[] {
  const dragging = new Map(previous.filter((n) => n.dragging).map((n) => [n.id, n] as const));
  return derived.map((n) => {
    const m = measured.get(n.id);
    const live = dragging.get(n.id);
    if (!m && !live) return n;
    const next = { ...n } as FlowNode;
    if (m) next.measured = m;
    if (live) {
      next.position = live.position;
      next.dragging = true;
    }
    return next;
  });
}

function focusToolbar(nodeId: string, tries = 10): void {
  const toolbar = document.querySelector<HTMLElement>(
    `.tc-toolbar[data-node-id="${CSS.escape(nodeId)}"]`,
  );
  const first = toolbar?.querySelector<HTMLButtonElement>('button:not(:disabled)');
  if (first) first.focus();
  else if (tries > 0) setTimeout(() => focusToolbar(nodeId, tries - 1), 16);
}

/**
 * The editor canvas: the draft drawn through `toFlow`, React Flow's changes mapped back through
 * `fromFlow` to graph ops (`apply`) and selections (`onSelect`). React Flow's own state never
 * reaches the graph: positions in a drag live in a local overlay until the drop, measurements are
 * kept here. Refused connections and deletions are reported through `onRefuse` (a toast).
 */
export function Canvas({
  graph,
  issues,
  selection,
  catalog,
  readOnly,
  apply,
  onSelect,
  onRefuse,
  onDropItem,
  defaultViewport,
  onMoveEnd,
}: {
  graph: WorkflowGraph;
  issues: Issue[];
  selection: Selection;
  catalog: Catalog | null;
  readOnly: boolean;
  /** Applies `op` to the draft; false when the graph refused it (the page shows the toast). */
  apply(op: GraphOp, opts?: ApplyOptions): boolean;
  onSelect(next: Selection): void;
  onRefuse(reason: string): void;
  onDropItem(item: PaletteItem, position: Position): void;
  /** The remembered viewport; undefined → fit the loaded graph. */
  defaultViewport?: Viewport | undefined;
  onMoveEnd?(e: unknown, viewport: Viewport): void;
}) {
  const rf = useReactFlow();
  // The overview is on by default and can be switched off to give a small canvas its room back.
  // The minimap would cover most of a small canvas: it starts hidden below 768 px.
  const [showMap, setShowMap] = useState(() => !window.matchMedia('(max-width: 767px)').matches);
  // Fit the loaded graph once unless a viewport is remembered; an empty graph starts at 100 %
  // instead of fitting its first node.
  const [fitOnLoad] = useState(() => defaultViewport === undefined && graph.nodes.length > 0);
  const derived = useMemo(
    () => toFlow(graph, catalog, issues, selection),
    [graph, catalog, issues, selection],
  );

  const measured = useRef(new Map<string, { width: number; height: number }>());
  const shown = useRef<FlowNode[]>([]);
  const [overlay, setOverlay] = useState<{ base: FlowNode[]; nodes: FlowNode[] } | null>(null);
  // Refs are read at derive time on purpose: only a new derivation re-merges.
  const fresh = useMemo(
    () => carryOver(derived.nodes, shown.current, measured.current),
    [derived.nodes],
  );
  const nodes = overlay && overlay.base === derived.nodes ? overlay.nodes : fresh;
  shown.current = nodes;

  const latest = useRef({ graph, derived, catalog, readOnly });
  latest.current = { graph, derived, catalog, readOnly };

  // React Flow reports node and edge selection in two calls of one tick: merge each by kind
  // against the selection already sent, not the (not yet re-rendered) prop.
  const sel = useRef({ prop: selection, current: selection });
  if (sel.current.prop !== selection) sel.current = { prop: selection, current: selection };
  const select = useCallback(
    (part: Partial<Selection>, kind: 'nodes' | 'edges') => {
      const cur = sel.current.current;
      const next: Selection =
        kind === 'nodes'
          ? {
              nodes: part.nodes ?? [],
              edges: cur.edges,
              ...(part.group ? { group: part.group } : {}),
            }
          : {
              nodes: cur.nodes,
              edges: part.edges ?? [],
              ...(cur.group ? { group: cur.group } : {}),
            };
      sel.current.current = next;
      onSelect(next);
    },
    [onSelect],
  );

  const dragSeq = useRef(0);
  const run = useCallback(
    /** False when an op was refused. */
    (results: FlowChangeResult[], kind: 'nodes' | 'edges', key: string): boolean => {
      let ok = true;
      for (const r of results) {
        if (!r) continue;
        if ('op' in r) {
          if (!apply(r.op, r.coalesce ? { coalesce: r.coalesce, key } : undefined)) ok = false;
        } else select(r.select, kind);
      }
      return ok;
    },
    [apply, select],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const before = shown.current;
      const after = applyNodeChanges(changes, before);
      for (const c of changes) {
        if (c.type === 'dimensions' && c.dimensions) measured.current.set(c.id, c.dimensions);
      }
      shown.current = after;
      setOverlay({ base: latest.current.derived.nodes, nodes: after });
      const ids = [...new Set(changes.map((c) => ('id' in c ? c.id : '')))].sort().join(',');
      // Live React Flow nodes (with `measured`), before this batch removed any.
      const ok = run(
        fromNodeChanges(changes, latest.current.graph, before),
        'nodes',
        `${dragSeq.current}:${ids}`,
      );
      if (!ok) {
        // A refused move or resize: the cards go back to where the graph has them.
        const base = latest.current.derived.nodes;
        const reverted = carryOver(base, [], measured.current);
        shown.current = reverted;
        setOverlay({ base, nodes: reverted });
      }
    },
    [run],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<TcFlowEdge>[]) => {
      run(fromEdgeChanges(changes, latest.current.derived.edges), 'edges', '');
    },
    [run],
  );

  const portCheck = useCallback((from: PortRef, to: PortRef) => {
    const { graph: g, catalog: c } = latest.current;
    return c ? checkConnection(g, from, to, c) : ({ ok: false, reason: '' } as const);
  }, []);

  const isValidConnection = useCallback(
    (c: Connection | Edge) =>
      c.sourceHandle != null &&
      c.targetHandle != null &&
      portCheck({ node: c.source, port: c.sourceHandle }, { node: c.target, port: c.targetHandle })
        .ok,
    [portCheck],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const cat = latest.current.catalog;
      if (!cat || c.sourceHandle == null || c.targetHandle == null) return;
      const from = { node: c.source, port: c.sourceHandle };
      const to = { node: c.target, port: c.targetHandle };
      apply((g) => connect(g, from, to, cat));
    },
    [apply],
  );

  /** A connection dropped on a port that does not fit says why (never a silent no-op). */
  const refuseIfInvalid = useCallback(
    (a: HandleEnd, b: HandleEnd) => {
      const ports = portsOf(a, b);
      if (!ports) return;
      const check = portCheck(ports.from, ports.to);
      if (!check.ok && check.reason) onRefuse(check.reason);
    },
    [portCheck, onRefuse],
  );

  const onConnectEnd = useCallback(
    (_e: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid !== false || !state.fromHandle || !state.toHandle) return;
      const end = (h: NonNullable<FinalConnectionState['toHandle']>): HandleEnd => ({
        nodeId: h.nodeId,
        handleId: h.id ?? null,
        type: h.type,
      });
      refuseIfInvalid(end(state.fromHandle), end(state.toHandle));
    },
    [refuseIfInvalid],
  );

  const clickStart = useRef<HandleEnd | null>(null);
  const onClickConnectStart = useCallback(
    (
      _e: unknown,
      p: { nodeId: string | null; handleId: string | null; handleType: 'source' | 'target' | null },
    ) => {
      clickStart.current =
        p.nodeId && p.handleType
          ? { nodeId: p.nodeId, handleId: p.handleId, type: p.handleType }
          : null;
    },
    [],
  );
  const onClickConnectEnd = useCallback(
    (e: MouseEvent | TouchEvent) => {
      const start = clickStart.current;
      clickStart.current = null;
      const el = (e.target as Element | null)?.closest?.('.react-flow__handle');
      const nodeId = el?.getAttribute('data-nodeid');
      if (!start || !el || !nodeId) return;
      const type = el.classList.contains('source') ? 'source' : 'target';
      refuseIfInvalid(start, { nodeId, handleId: el.getAttribute('data-handleid'), type });
    },
    [refuseIfInvalid],
  );

  // "Tidy up" fits the view once the rearranged cards are on the canvas (React Flow has synced
  // its nodes in its own effects, which run before this one).
  const [fitPending, setFitPending] = useState(false);
  useEffect(() => {
    if (!fitPending || nodes.length === 0) return;
    setFitPending(false);
    void rf.fitView({ ...FIT_VIEW, duration: 200 });
  }, [fitPending, nodes, rf]);

  /** One plain apply: its own undo step, and the draft becomes unsaved like after any move. */
  function tidy() {
    const { catalog: cat, readOnly: ro } = latest.current;
    if (ro) return;
    const sizes = measured.current;
    const done = apply((g) =>
      tidyUp(g, { catalog: cat, sizes, collapsedGroupSize: COLLAPSED_GROUP_SIZE }),
    );
    if (done) setFitPending(true);
  }

  function onDragOver(e: DragEvent) {
    if (readOnly || !e.dataTransfer.types.includes(PALETTE_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  function onDrop(e: DragEvent) {
    const raw = e.dataTransfer.getData(PALETTE_DRAG_TYPE);
    if (readOnly || !raw) return;
    e.preventDefault();
    let item: PaletteItem;
    try {
      item = JSON.parse(raw) as PaletteItem;
    } catch {
      return;
    }
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    // The card's header lands under the pointer.
    onDropItem(item, { x: Math.round(p.x - NODE_SIZE.width / 2), y: Math.round(p.y - 25) });
  }

  /** Keyboard path into the node toolbar (N8): Enter or "." on a node (Escape out: TcToolbar). */
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if ((e.key === 'Enter' || e.key === '.') && target.classList.contains('react-flow__node')) {
      const id = target.dataset.id;
      if (!id) return;
      // Without this the same key press (its keypress) would activate the toolbar button that
      // just took focus: Enter would duplicate the node.
      e.preventDefault();
      focusToolbar(id);
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: forwards keys from the focused node/toolbar.
    <div className="canvas editor-canvas" onKeyDown={onKeyDown}>
      <ReactFlow<FlowNode, TcFlowEdge>
        nodes={nodes}
        edges={derived.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onClickConnectStart={onClickConnectStart}
        onClickConnectEnd={onClickConnectEnd}
        isValidConnection={isValidConnection}
        connectionLineComponent={TcConnectionLine}
        onNodeDragStart={() => {
          dragSeq.current++;
        }}
        onDragOver={onDragOver}
        onDrop={onDrop}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        edgesReconnectable={false}
        // Delete/Backspace belong to useEditorKeys → `removeSelection` (one binding, undoable,
        // ignored on buttons). Nothing calls React Flow's deleteElements, so no onBeforeDelete.
        deleteKeyCode={null}
        connectionRadius={CONNECTION_RADIUS}
        // Shift-click adds a card to the selection too (Shift-drag on the pane still box-selects).
        multiSelectionKeyCode={MULTI_SELECT_KEYS}
        minZoom={MIN_ZOOM}
        fitView={fitOnLoad}
        {...(defaultViewport ? { defaultViewport } : {})}
        {...(onMoveEnd ? { onMoveEnd } : {})}
        fitViewOptions={FIT_VIEW}
        colorMode="dark"
        // React Flow is MIT; the credit stays on Settings → About → Open-source licences.
        proOptions={PRO_OPTIONS}
      >
        {/* Dots of 1.2px radius every 22px (React Flow's `size` is the dot diameter). */}
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={2.4}
          color="var(--canvas-dot)"
          bgColor="var(--surface)"
        />
        <Controls position="bottom-right" orientation="horizontal" showInteractive={false}>
          <ControlButton
            aria-label="Tidy up"
            title="Tidy up: line the nodes up left to right"
            disabled={readOnly || graph.nodes.length === 0}
            onClick={tidy}
          >
            <Icon name="tidy" size={14} />
          </ControlButton>
          <ControlButton
            aria-label={showMap ? 'Hide minimap' : 'Show minimap'}
            aria-pressed={showMap}
            title={showMap ? 'Hide minimap' : 'Show minimap'}
            onClick={() => setShowMap((v) => !v)}
          >
            <Icon name="map" size={14} />
          </ControlButton>
        </Controls>
        {showMap && <TcMiniMap />}
      </ReactFlow>
      <CanvasLegend />
    </div>
  );
}
