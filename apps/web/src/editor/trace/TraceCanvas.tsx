import { RUN_SUBWORKFLOW_TYPE, type WorkflowGraph } from '@transcoda/shared';
import {
  Background,
  BackgroundVariant,
  Controls,
  getNodesBounds,
  type NodeChangeset,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  useViewportStore,
  type Viewport,
  type ViewportStore,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Catalog } from '../../hooks/use-catalog.ts';
import { usePhone } from '../../lib/use-phone.ts';
import { DEFAULT_EDITOR_ACTIONS, EditorActionsContext } from '../flow/actions-context.ts';
import { ARIA_LABELS, edgeTypes, nodeTypes } from '../flow/node-types.ts';
import { READABLE_ZOOM } from '../flow/open-viewport.ts';
import { toFlow, withViewCollapse } from '../flow/to-flow.ts';
import type { TcFlowEdge, TcFlowNode, TraceOverlay } from '../flow/types.ts';
import { ZoomVar } from '../flow/ZoomVar.tsx';
import { CONTROLS_FIT_VIEW, MIN_ZOOM } from '../ui/Canvas.tsx';
import { TraceActionsContext } from './trace-context.ts';
import { spreadCards, spreadMembers } from './trace-layout.ts';
import { buildTraceOverlay, pathKey, type TraceSource } from './trace-overlay.ts';

type FlowNode = TcFlowNode;

/** A node in a job's workflow: Run-node ids from the top level down, and the node id. */
export type NodeRef = { workflowPath: string[]; nodeId: string };

const NO_SELECTION = { nodes: [], edges: [] };
const NO_NAMES: ReadonlyMap<string, string> = new Map();

/** Space kept around the graph, and below it for the zoom controls in the bottom-right corner. */
const FIT_PAD = 24;
const CONTROLS_ROOM = 64;
/** A flow narrower than this still gets a canvas it can be read and clicked in. */
const FIT_MIN_HEIGHT = 240;
/**
 * The lowest zoom the first fit goes to on a desktop: the readable zoom the editor opens at too
 * (`READABLE_ZOOM`, the full cards). A graph wider than that allows is shown from its left edge
 * (the trigger) and panned; "Fit view" in the controls still shows it whole. A phone cannot pan
 * (a drag scrolls the page), so there the graph is fitted whole down to `MIN_ZOOM`.
 */
const FIT_MIN_ZOOM = READABLE_ZOOM;

/**
 * The viewport that shows the whole graph in a pane `paneWidth` wide (at most `maxZoom`, 100 % by
 * default, never below `minZoom`), and the canvas height the graph needs at that zoom: the pane is
 * sized to the graph, not the graph squeezed into a fixed box. A graph narrower than the pane is
 * centred; one wider than the floor allows starts `FIT_PAD` in from the left.
 */
export function fitTrace(
  bounds: { x: number; y: number; width: number; height: number },
  paneWidth: number,
  minZoom = FIT_MIN_ZOOM,
  maxZoom = 1,
): { viewport: Viewport; height: number } {
  const room = paneWidth - 2 * FIT_PAD;
  const zoom = Math.min(maxZoom, Math.max(minZoom, room / Math.max(bounds.width, 1)));
  const contentWidth = bounds.width * zoom;
  const left = contentWidth <= room ? (paneWidth - contentWidth) / 2 : FIT_PAD;
  return {
    viewport: { x: left - bounds.x * zoom, y: FIT_PAD - bounds.y * zoom, zoom },
    height: Math.max(FIT_MIN_HEIGHT, Math.ceil(bounds.height * zoom + FIT_PAD + CONTROLS_ROOM)),
  };
}

type Fit = ReturnType<typeof fitTrace>;

/** The same viewport, give or take the rounding of React Flow's pan-zoom transform. */
const sameViewport = (a: Viewport, b: Viewport): boolean =>
  Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.zoom - b.zoom) < 1e-6;

/**
 * The fit again after the layout changed under the last one (`fitted`), or null to leave it. The
 * first fit is taken from the full cards; zoomed out that far they turn into icon tiles, which
 * are spread again and can reach below the first fit's canvas. The refit never zooms in past the
 * last fit (so the cards keep their level and the layout settles), and is skipped once the
 * viewer has panned or zoomed (`current` is no longer the viewport the fit set).
 */
export function refitTrace(
  fitted: Fit,
  current: Viewport,
  bounds: { x: number; y: number; width: number; height: number },
  paneWidth: number,
  minZoom = FIT_MIN_ZOOM,
): Fit | null {
  if (!sameViewport(current, fitted.viewport)) return null;
  const next = fitTrace(bounds, paneWidth, minZoom, fitted.viewport.zoom);
  return sameViewport(next.viewport, fitted.viewport) && next.height === fitted.height
    ? null
    : next;
}

const paneWidth = (s: ViewportStore) => s.width;

/**
 * The first fit, once the cards are measured and spread (`laidOut`), and the pane has a size (a
 * page opened in a background tab has none yet): the whole graph across the pane's width
 * (`fitTrace`), and the canvas height that goes with it, reported through `onHeight`. When the
 * fit's zoom re-lays the cards (the icon tiles), it fits again to the new layout (`refitTrace`)
 * until the viewer pans or zooms.
 */
function FitOnce({
  nodes,
  laidOut,
  onHeight,
  minZoom,
}: {
  nodes: FlowNode[];
  laidOut: boolean;
  onHeight(height: number): void;
  minZoom: number;
}) {
  const flow = useReactFlow();
  const ready = useNodesInitialized();
  const width = useViewportStore(paneWidth);
  const fitted = useRef<Fit | null>(null);
  useEffect(() => {
    if (!ready || !laidOut || width === 0) return;
    // Top-level cards from `nodes` (the spread positions, which the store may not have taken
    // yet); a group's members lie inside their group.
    const shown = nodes.filter((n) => !n.hidden && n.parentId === undefined);
    if (shown.length === 0) return;
    const bounds = getNodesBounds(shown);
    const fit = fitted.current
      ? refitTrace(fitted.current, flow.getViewport(), bounds, width, minZoom)
      : fitTrace(bounds, width, minZoom);
    if (!fit) return;
    fitted.current = fit;
    onHeight(fit.height);
    void flow.setViewport(fit.viewport);
  }, [ready, laidOut, width, flow, nodes, onHeight, minZoom]);
  return null;
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The Run node opened at `path`, when `expanded` (the chain of opened Run nodes) goes through it. */
function expandedAt(expanded: readonly string[], path: readonly string[]): string | null {
  if (expanded.length <= path.length || !path.every((x, i) => x === expanded[i])) return null;
  return expanded[path.length] ?? null;
}

/**
 * The editor's canvas components in read-only trace mode (Task 23): the current node runs (moving
 * border and its activity), done nodes show their reason, conditions light the taken output, the
 * taken path is the moving dash, untaken nodes fade once the job is final, data edges carry their
 * values. A Run node the file entered has "Open": its sub-workflow (from `subgraphs`, keyed by
 * `pathKey`; null when it cannot be read) is drawn below as a nested trace canvas. React Flow state
 * (measurements, viewport, group collapse) stays here and never touches the graph.
 */
export function TraceCanvas({
  graph,
  source,
  workflowPath = [],
  catalog,
  selected,
  onSelect,
  expanded,
  onExpand,
  subgraphs,
  names = NO_NAMES,
  activity,
  progress = null,
  paused = false,
}: {
  graph: WorkflowGraph;
  source: TraceSource;
  /** Run-node ids down to this graph; [] for the job's own workflow. */
  workflowPath?: string[];
  catalog: Catalog | null;
  selected: NodeRef | null;
  onSelect(ref: NodeRef | null): void;
  /** The chain of opened Run nodes from the top level ([] = none open). */
  expanded: string[];
  onExpand(chain: string[]): void;
  subgraphs: ReadonlyMap<string, WorkflowGraph | null>;
  /** The sub-workflows' names by `pathKey` of their Run node (the child canvas's heading). */
  names?: ReadonlyMap<string, string>;
  /** The current node's activity line ("Encoding · 42%"). */
  activity?: string | undefined;
  /** The job's progress in percent (0-100); the current node fills in proportion. null: none. */
  progress?: number | null;
  /** The job is paused: its current node stays lit but does not move. */
  paused?: boolean;
}) {
  const phone = usePhone();
  // Stable across renders while the level is the same (ids never contain "/").
  const key = pathKey(workflowPath);
  const path = useMemo(() => (key === '' ? [] : key.split('/')), [key]);
  const openRun = expandedAt(expanded, path);
  // The canvas height the first fit asked for; null until then (the stylesheet's default).
  const [height, setHeight] = useState<number | null>(null);
  const [collapse, setCollapse] = useState<ReadonlyMap<string, boolean>>(new Map());

  const overlay = useMemo((): TraceOverlay => {
    const base = buildTraceOverlay(graph, source, path);
    const nodes = new Map(base.nodes);
    for (const n of graph.nodes) {
      const t = nodes.get(n.id);
      if (!t) continue;
      const reached =
        t.status === 'done' ||
        t.status === 'current' ||
        t.status === 'failed' ||
        t.status === 'cancelled';
      if (n.type === RUN_SUBWORKFLOW_TYPE && reached) {
        nodes.set(n.id, { ...t, expandable: true, expanded: openRun === n.id });
      }
      if (t.status === 'current' && (activity || paused || progress !== null)) {
        nodes.set(n.id, {
          ...(nodes.get(n.id) ?? t),
          ...(activity && { activity }),
          ...(progress !== null && { progress }),
          ...(paused && { paused }),
        });
      }
    }
    return { ...base, nodes };
  }, [graph, source, path, openRun, activity, progress, paused]);

  const selectedHere = selected && samePath(selected.workflowPath, path) ? selected.nodeId : null;
  const selection = useMemo(
    () => (selectedHere ? { nodes: [selectedHere], edges: [] } : NO_SELECTION),
    [selectedHere],
  );
  const derived = useMemo(
    () => toFlow(withViewCollapse(graph, collapse), catalog, [], selection, overlay),
    [graph, collapse, catalog, selection, overlay],
  );

  // React Flow's measurements, carried onto every new derivation so cards are not re-measured
  // (and hidden) on each trace update. View state only.
  const measured = useRef(new Map<string, { width: number; height: number }>());
  const [tick, setTick] = useState(0);
  // Cards grown by their trace rows (or drawn as the large icon tiles) are moved apart (#36) once
  // measured: a group's members inside their group first, then the top-level cards.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick re-reads the measurements ref
  const { nodes, laidOut } = useMemo(() => {
    const withSizes = derived.nodes.map((n) => {
      const m = measured.current.get(n.id);
      return m ? ({ ...n, measured: m } as FlowNode) : n;
    });
    return {
      nodes: spreadCards(spreadMembers(withSizes)),
      laidOut: withSizes.every((n) => n.hidden || n.measured !== undefined),
    };
  }, [derived.nodes, tick]);
  const onNodesChange = useCallback((changes: NodeChangeset<FlowNode>) => {
    let changed = false;
    for (const c of changes) {
      if (c.type === 'dimensions' && c.dimensions) {
        measured.current.set(c.id, c.dimensions);
        changed = true;
      }
    }
    if (changed) setTick((t) => t + 1);
  }, []);

  const actions = useMemo(
    () => ({
      ...DEFAULT_EDITOR_ACTIONS,
      setGroupCollapsed(groupId: string, collapsed: boolean) {
        setCollapse((m) => new Map(m).set(groupId, collapsed));
      },
    }),
    [],
  );
  const traceActions = useMemo(
    () => ({
      bigIcons: true,
      toggleRun(runNodeId: string) {
        onExpand(openRun === runNodeId ? [...path] : [...path, runNodeId]);
      },
    }),
    [onExpand, openRun, path],
  );

  const runNode = openRun ? graph.nodes.find((n) => n.id === openRun) : undefined;
  const childPath = openRun ? [...path, openRun] : null;
  // The Run node's label, else the sub-workflow's name, else the node type's title.
  const runTitle =
    runNode?.label ??
    (childPath && names.get(pathKey(childPath))) ??
    (runNode && catalog?.byType.get(runNode.type)?.title) ??
    openRun ??
    '';
  const child = childPath ? subgraphs.get(pathKey(childPath)) : undefined;

  return (
    <div className="trace-level">
      <EditorActionsContext.Provider value={actions}>
        <TraceActionsContext.Provider value={traceActions}>
          <ReactFlowProvider>
            <div className="canvas trace-canvas" {...(height !== null && { style: { height } })}>
              <ReactFlow<FlowNode, TcFlowEdge>
                nodes={nodes}
                edges={derived.edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={onNodesChange}
                onNodeClick={(_e, n) => {
                  if (n.type === 'tc-node') onSelect({ workflowPath: [...path], nodeId: n.id });
                }}
                onPaneClick={() => onSelect(null)}
                nodesDraggable={false}
                nodesConnectable={false}
                edgesFocusable={false}
                edgesReconnectable={false}
                deleteKeyCode={null}
                // The job page scrolls: the wheel scrolls it; zoom with the controls or a pinch.
                // On a phone a drag or pinch on the canvas scrolls the page too (no pan trap):
                // the graph is fitted and the controls zoom.
                zoomOnScroll={false}
                preventScrolling={false}
                panOnDrag={!phone}
                zoomOnPinch={!phone}
                zoomOnDoubleClick={!phone}
                minZoom={MIN_ZOOM}
                ariaLabelConfig={ARIA_LABELS}
                // The editor canvas's React Flow settings (see Canvas.tsx).
                forceColorMode="dark"
                elevateEdgesOnSelect={false}
                paneDragThreshold={0}
                // No attribution link on the job page (React Flow is MIT licensed).
                proOptions={{ hideAttribution: true }}
              >
                <ZoomVar />
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={22}
                  size={2.4}
                  color="var(--canvas-dot)"
                  bgColor="var(--surface)"
                />
                <Controls
                  position="bottom-right"
                  orientation="horizontal"
                  showInteractive={false}
                  fitViewOptions={CONTROLS_FIT_VIEW}
                />
                {/* A phone cannot pan the graph (a drag scrolls the page), so it fits whole at any zoom. */}
                <FitOnce
                  nodes={nodes}
                  laidOut={laidOut}
                  onHeight={setHeight}
                  minZoom={phone ? MIN_ZOOM : FIT_MIN_ZOOM}
                />
              </ReactFlow>
            </div>
          </ReactFlowProvider>
        </TraceActionsContext.Provider>
      </EditorActionsContext.Provider>
      {childPath && (
        <section className="trace-child" aria-label={`Inside ${runTitle}`}>
          <h3 className="trace-child-title">Inside {runTitle}</h3>
          {child ? (
            <TraceCanvas
              graph={child}
              source={source}
              workflowPath={childPath}
              catalog={catalog}
              selected={selected}
              onSelect={onSelect}
              expanded={expanded}
              onExpand={onExpand}
              subgraphs={subgraphs}
              names={names}
              activity={activity}
              progress={progress}
              paused={paused}
            />
          ) : (
            <p className="trace-child-note" role="status">
              {child === null
                ? 'This sub-workflow version can no longer be read.'
                : 'Loading the sub-workflow…'}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
