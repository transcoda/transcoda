import { RUN_SUBWORKFLOW_TYPE, type WorkflowGraph } from '@transcoda/shared';
import {
  Background,
  BackgroundVariant,
  Controls,
  getNodesBounds,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  type ReactFlowState,
  useNodesInitialized,
  useReactFlow,
  useStore,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Catalog } from '../../hooks/useCatalog.ts';
import { usePhone } from '../../lib/usePhone.ts';
import { DEFAULT_EDITOR_ACTIONS, EditorActionsContext } from '../flow/actions-context.ts';
import { edgeTypes, nodeTypes } from '../flow/nodeTypes.ts';
import { toFlow, withViewCollapse } from '../flow/toFlow.ts';
import type { TcFlowEdge, TcFlowNode, TraceOverlay } from '../flow/types.ts';
import { MIN_ZOOM } from '../ui/Canvas.tsx';
import { TraceActionsContext } from './trace-context.ts';
import { spreadCards } from './traceLayout.ts';
import { buildTraceOverlay, pathKey, type TraceSource } from './traceOverlay.ts';

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
 * The lowest zoom the first fit goes to. Below 40 % the cards are icon tiles (N9, with the icons
 * counter-scaled), so a long workflow still fits the pane whole instead of being cut off; past
 * this floor it is shown from its left edge (the trigger) and panned.
 */
const FIT_MIN_ZOOM = 0.2;

/**
 * The viewport that shows the whole graph in a pane `paneWidth` wide (at most 100 %, never below
 * `minZoom`), and the canvas height the graph needs at that zoom: the pane is sized to the
 * graph, not the graph squeezed into a fixed box. A graph narrower than the pane is centred; one
 * wider than the floor allows starts `FIT_PAD` in from the left.
 */
export function fitTrace(
  bounds: { x: number; y: number; width: number; height: number },
  paneWidth: number,
  minZoom = FIT_MIN_ZOOM,
): { viewport: Viewport; height: number } {
  const room = paneWidth - 2 * FIT_PAD;
  const zoom = Math.min(1, Math.max(minZoom, room / Math.max(bounds.width, 1)));
  const contentWidth = bounds.width * zoom;
  const left = contentWidth <= room ? (paneWidth - contentWidth) / 2 : FIT_PAD;
  return {
    viewport: { x: left - bounds.x * zoom, y: FIT_PAD - bounds.y * zoom, zoom },
    height: Math.max(FIT_MIN_HEIGHT, Math.ceil(bounds.height * zoom + FIT_PAD + CONTROLS_ROOM)),
  };
}

const paneWidth = (s: ReactFlowState) => s.width;

/**
 * The first fit, once the cards are measured and spread (`laidOut`), and the pane has a size (a
 * page opened in a background tab has none yet): the whole graph across the pane's width
 * (`fitTrace`), and the canvas height that goes with it, reported through `onHeight`.
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
  const width = useStore(paneWidth);
  const done = useRef(false);
  useEffect(() => {
    if (!ready || !laidOut || width === 0 || done.current) return;
    // Top-level cards from `nodes` (the spread positions, which the store may not have taken
    // yet); a group's members lie inside their group.
    const shown = nodes.filter((n) => !n.hidden && n.parentId === undefined);
    if (shown.length === 0) return;
    done.current = true;
    const fit = fitTrace(getNodesBounds(shown), width, minZoom);
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
      const reached = t.status === 'done' || t.status === 'current' || t.status === 'failed';
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
  // Cards grown by their trace rows are moved apart (#36) once measured.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick re-reads the measurements ref
  const { nodes, laidOut } = useMemo(() => {
    const withSizes = derived.nodes.map((n) => {
      const m = measured.current.get(n.id);
      return m ? ({ ...n, measured: m } as FlowNode) : n;
    });
    return {
      nodes: spreadCards(withSizes),
      laidOut: withSizes.every((n) => n.hidden || n.measured !== undefined),
    };
  }, [derived.nodes, tick]);
  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
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
                colorMode="dark"
                // No attribution link on the job page (React Flow is MIT licensed).
                proOptions={{ hideAttribution: true }}
              >
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
