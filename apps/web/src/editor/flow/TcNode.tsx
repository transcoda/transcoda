import type { NodeInfo } from '@transcoda/contract';
import { portShown, RUN_SUBWORKFLOW_TYPE, SUBWORKFLOW_START_TYPE } from '@transcoda/shared';
import {
  Handle,
  type NodeProps,
  Position,
  type ReactFlowState,
  useNodeConnections,
  useStore,
} from '@xyflow/react';
import { type CSSProperties, useCallback, useMemo } from 'react';
import { KIND_WORD } from '../../components/Chips.tsx';
import { Icon } from '../../components/Icon.tsx';
import { NodeIcon } from '../../components/NodeIcon.tsx';
import type { PortSpec } from '../../hooks/useCatalog.ts';
import { DEFAULT_GROUP_NAME } from '../model/graph-ops.ts';
import type { NodeState } from '../model/issues.ts';
import { onNodeControlKeys } from '../model/schema-fields.ts';
import { useTraceActions } from '../trace/trace-context.ts';
import { OnNodeRow } from '../ui/OnNodeRow.tsx';
import { OnNodeSubworkflow, runSummary } from '../ui/OnNodeSubworkflow.tsx';
import { useEditorActions } from './actions-context.ts';
import { BADGE_ICON } from './badges.ts';
import { connectionFit, type Fit, type HandleRef, nodeFaded } from './connectionFit.ts';
import { useSubworkflowList } from './subworkflows-context.ts';
import { branchClass, branchType, dragFromOf, portLabel, TcHandle } from './TcHandle.tsx';
import { TcSelectionToolbar, TcToolbar } from './TcToolbar.tsx';
import { VALUE_LINK_HANDLE } from './toFlow.ts';
import type { TcNode as TcNodeType, TraceNodeData } from './types.ts';
import { useIconScale, useZoomLevel } from './useZoomLevel.ts';

/** The card's colour class: its kind, Start/End as trigger/finish, `kind-unknown` without a def. */
export function kindClassOf(def: NodeInfo | null): string {
  if (!def) return 'kind-unknown';
  if (def.kind === 'subworkflow-io') {
    return def.type === SUBWORKFLOW_START_TYPE ? 'kind-start' : 'kind-end';
  }
  return `kind-${def.kind}`;
}

/** `glyphOnly`: the icon tile (zoom level "icon") keeps the glyph; the word is in its name. */
function Badge({ state, glyphOnly = false }: { state: NodeState; glyphOnly?: boolean }) {
  if (state.word === null) return null;
  // A word without a badge kind (NODE_OUTDATED reported as an error) reads as an error.
  const glyph = state.badge === null ? 'alert' : BADGE_ICON[state.badge];
  return (
    <span className={`tc-badge tone-${state.border ?? 'red'}${glyphOnly ? ' is-glyph' : ''}`}>
      {glyph === '!' ? (
        <span className="tc-badge-bang" aria-hidden="true">
          !
        </span>
      ) : (
        glyph && <Icon name={glyph} size={12} strokeWidth={2.6} round />
      )}
      {glyphOnly ? null : state.word}
    </span>
  );
}

const noop = (): void => {};

/** The selected cards' ids in store order, newline-joined (a string, so the store compares by value). */
function selectedCardIds(s: ReactFlowState): string {
  const ids: string[] = [];
  for (const n of s.nodes) if (n.selected && n.type === 'tc-node') ids.push(n.id);
  return ids.join('\n');
}

function portsFrom(ids: ReadonlySet<string>): PortSpec[] {
  return [...ids]
    .filter((id) => id !== '')
    .sort()
    .map((id) => ({ id, label: id, type: 'file' }));
}

/** One handle's N5 fit, looked up by side and port id. */
type FitOf = (direction: 'in' | 'out', portId: string) => Fit;

/**
 * N5 while a connection is dragged: each handle's fit, newline-joined in `refs` order (a string,
 * so the store compares by value and the card re-renders only when a fit changes); '' otherwise.
 */
function fitsKey(s: ReactFlowState, refs: readonly HandleRef[]): string {
  const from = dragFromOf(s);
  return from ? refs.map((h) => connectionFit(from, h)).join('\n') : '';
}

/** Trace view: the output the file left by is lit, the node's other file outputs dimmed. */
type PortTrace = { taken: string | null; dimOthers: boolean };

function PortRow({
  input,
  output,
  connectedIn,
  connectedOut,
  onPlus,
  labelOf,
  showLabels,
  traced,
  fitOf,
  ghost = false,
}: {
  input: PortSpec | undefined;
  output: PortSpec | undefined;
  connectedIn: ReadonlySet<string>;
  connectedOut: ReadonlySet<string>;
  onPlus: ((port: PortSpec) => void) | undefined;
  labelOf(port: PortSpec): string;
  showLabels: boolean;
  traced: PortTrace | null;
  fitOf: FitOf;
  /** The progress fill's inverted copy: the labels only, no handles. */
  ghost?: boolean;
}) {
  const data = (input ?? output)?.type !== 'file';
  let outClass = 'tc-port-out';
  const branch = output ? branchClass(output) : null;
  const outType = output ? branchType(output) : null;
  if (branch) outClass += ` ${branch}`;
  if (traced && output?.type === 'file') {
    if (output.id === traced.taken) outClass += ' is-taken';
    else if (traced.dimOthers) outClass += ' is-dimmed';
  }
  return (
    <div className={`tc-port${data ? ' is-data' : ''}`}>
      {input && (
        <>
          {showLabels && <span className="tc-port-in">{labelOf(input)}</span>}
          {!ghost && (
            <TcHandle
              port={input}
              direction="in"
              connected={connectedIn.has(input.id)}
              fit={fitOf('in', input.id)}
            />
          )}
        </>
      )}
      {output && (
        <>
          {showLabels && (
            <span className={outClass}>
              {labelOf(output)}
              {outType && <BranchType type={outType} />}
            </span>
          )}
          {!ghost && (
            <TcHandle
              port={output}
              direction="out"
              connected={connectedOut.has(output.id)}
              fit={fitOf('out', output.id)}
              {...(onPlus && { onPlus })}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The type a branch output passes, after its Yes / No: "Yes · file" on screen (the stylesheet
 * draws the dot, hidden from assistive tech), "Yes, file" read aloud.
 */
function BranchType({ type }: { type: 'file' | 'data' }) {
  return (
    <span className="tc-port-type">
      <span className="sr-only">, </span>
      {type}
    </span>
  );
}

const TRACE_WORD: Record<TraceNodeData['status'], string | null> = {
  current: 'running',
  failed: 'failed',
  untaken: 'not taken',
  done: null,
  pending: null,
};

/** Trace view: the node's reason (or, while it runs, its activity) and a Run node's Open button. */
function TraceRow({
  id,
  title,
  trace,
  ghost = false,
}: {
  id: string;
  title: string;
  trace: TraceNodeData;
  /** The progress fill's inverted copy: same layout, but the button is only a hidden spacer. */
  ghost?: boolean;
}) {
  const { toggleRun } = useTraceActions();
  const text = trace.status === 'current' ? (trace.activity ?? trace.reason) : trace.reason;
  return (
    <div className={`tc-node-row tc-trace-row is-${trace.status}`}>
      <span className="tc-trace-reason" title={text ?? undefined}>
        {trace.plugin && (
          <>
            <span className="tc-trace-plug">
              <Icon name="plug" size={12} />
            </span>
            <span className="sr-only">Plugin: </span>
          </>
        )}
        {text}
      </span>
      {trace.expandable && (
        <button
          type="button"
          className="tc-trace-open nodrag nopan"
          aria-label={`Expand sub-workflow ${title}`}
          aria-expanded={trace.expanded === true}
          tabIndex={ghost ? -1 : undefined}
          onClick={(e) => {
            e.stopPropagation();
            toggleRun(id);
          }}
        >
          {trace.expanded ? 'Close' : 'Open'}
        </button>
      )}
    </div>
  );
}

/**
 * A node card (screen 05): kind header, port rows (N2) with handles (N4/N5), the on-node row
 * (N12, `OnNodeRow`), the state badge and border (N6) and the selection toolbar (N8; with two or
 * more cards selected, the first one draws the selection's toolbar). Read-only canvases get no
 * "+" buttons and no toolbar. N9: at zoom level `compact` the port labels go and the on-node row
 * shrinks to its summary text; at `icon` the card is a 48 px icon tile that keeps every handle so
 * the edges still draw.
 */
export function TcNode({ id, data, selected }: NodeProps<TcNodeType>) {
  const { instance, def, state } = data;
  const actions = useEditorActions();
  const zoom = useZoomLevel();
  const iconScale = useIconScale();
  const incoming = useNodeConnections({ handleType: 'target' });
  const outgoing = useNodeConnections({ handleType: 'source' });
  const connectedIn = new Set(incoming.map((c) => c.targetHandle ?? ''));
  const connectedOut = new Set(outgoing.map((c) => c.sourceHandle ?? ''));
  // Only a selected card looks at the rest of the selection (cheap for the unselected ones).
  const selectedCards = useStore(
    useCallback((s: ReactFlowState) => (selected ? selectedCardIds(s) : ''), [selected]),
  );
  const selection = selectedCards === '' ? [] : selectedCards.split('\n');
  const hasOnNode = useMemo(() => def !== null && onNodeControlKeys(def).length > 0, [def]);
  const workflows = useSubworkflowList();
  const run =
    instance.type === RUN_SUBWORKFLOW_TYPE ? runSummary(instance, state, workflows) : null;

  const word = def ? KIND_WORD[def.kind] : 'Unknown';
  const title = instance.label ?? def?.title ?? instance.type;
  const trace = data.trace;
  const progress =
    trace?.status === 'current' && typeof trace.progress === 'number'
      ? Math.min(100, Math.max(0, trace.progress))
      : null;
  const runWord = progress === null ? 'running' : `running ${Math.round(progress)}%`;
  const traceWord = trace?.paused
    ? 'paused'
    : trace
      ? trace.status === 'current'
        ? runWord
        : TRACE_WORD[trace.status]
      : null;
  const stateWords = [state.word, instance.bypassed ? 'skipped here' : null, traceWord].filter(
    Boolean,
  );
  const stateSuffix = stateWords.length ? `, ${stateWords.join(', ')}` : '';
  // A Run card's name says which sub-workflow it runs (two Run cards are told apart).
  const runSuffix = run ? `, ${run.text}` : '';
  const classes = ['tc-node', kindClassOf(def)];
  if (zoom !== 'full') classes.push(`zoom-${zoom}`);
  if (state.border) classes.push(`border-${state.border}`);
  if (instance.bypassed) classes.push('is-bypassed');
  if (trace?.status === 'current') classes.push('is-running');
  if (trace?.paused) classes.push('is-paused');
  if (trace?.status === 'untaken') classes.push('is-untaken');
  if (trace?.status === 'failed') classes.push('is-failed');
  const reached = trace !== undefined && trace.status !== 'pending' && trace.status !== 'untaken';

  // An unknown node still gets a handle per connected port, so the edges into it draw (red
  // dashed, N6) instead of vanishing; labelled with the raw port id.
  const inputs = def?.inputs ?? portsFrom(connectedIn);
  // An output the settings hide (Render's Damaged while Quality check is off) has no handle; one
  // that still has an edge keeps it until the save removes that edge, so the edge still draws.
  const outputs = def
    ? def.outputs.filter((p) => portShown(p, instance.settings) || connectedOut.has(p.id))
    : portsFrom(connectedOut);
  const labelOf = def ? portLabel : (port: PortSpec) => port.id;
  // N5: an unknown node's stand-in ports have no type (`portType: null`), so nothing glows there.
  const refOf = (direction: 'in' | 'out', p: PortSpec): HandleRef => ({
    nodeId: id,
    portId: p.id,
    direction,
    portType: def ? p.type : null,
    occupied: direction === 'in' && connectedIn.has(p.id),
  });
  const handleRefs = [...inputs.map((p) => refOf('in', p)), ...outputs.map((p) => refOf('out', p))];
  const fitKey = useStore((s) => fitsKey(s, handleRefs));
  const fits = fitKey === '' ? [] : (fitKey.split('\n') as Fit[]);
  const fitOf: FitOf = (direction, portId) =>
    fits[handleRefs.findIndex((h) => h.direction === direction && h.portId === portId)] ?? null;
  const faded = nodeFaded(fits);
  if (faded) classes.push('is-faded');
  const rows = Array.from({ length: Math.max(inputs.length, outputs.length) }, (_, i) => i);
  const portTrace: PortTrace | null =
    reached && trace
      ? { taken: trace.port, dimOthers: outputs.filter((p) => p.type === 'file').length > 1 }
      : null;
  const hasTraceRow = reached && trace !== undefined;
  const onPlus =
    actions.readOnly || zoom === 'icon'
      ? undefined
      : (port: PortSpec) => actions.startConnectFrom(id, port);
  // Counter-scaled when zoomed out (`iconScale`), so the glyph stays recognisable.
  const iconSize = Math.round((zoom === 'icon' ? 28 : 11) * iconScale);
  const icon = def ? (
    <NodeIcon name={def.icon} kind={def.kind} size={iconSize} />
  ) : (
    <Icon name="plug-off" size={iconSize} strokeWidth={2.6} round />
  );
  // Where a shared value's dotted line ends; not a port (nothing connects to it).
  const valueHandle = instance.links ? (
    <Handle
      type="target"
      position={Position.Top}
      id={VALUE_LINK_HANDLE}
      className="tc-value-handle"
      isConnectable={false}
    />
  ) : null;
  const toolbar = (
    <>
      {selection.length > 1 && selection[0] === id && (
        <TcSelectionToolbar
          nodeIds={selection}
          readOnly={actions.readOnly}
          onGroup={() => actions.groupSelection(DEFAULT_GROUP_NAME)}
          onDelete={() => actions.remove(selection)}
        />
      )}
      <TcToolbar
        nodeId={id}
        readOnly={actions.readOnly}
        canTry={actions.tryNode !== null}
        onTry={() => actions.tryNode?.(id)}
        onDuplicate={() => actions.duplicate(id)}
        onBypass={() => actions.toggleBypass(id)}
        bypassed={instance.bypassed === true}
        onDelete={() => actions.remove([id])}
      />
    </>
  );
  // A faded card (N5) is faded once: `.is-faded` sets the opacity, the dim (N6) steps aside.
  const dim = faded ? null : state.dim;
  const style: CSSProperties | undefined =
    dim === null && progress === null
      ? undefined
      : {
          ...(dim !== null && { opacity: dim }),
          ...(progress !== null && { '--tc-progress': `${progress}%` }),
        };
  const onNodeRow = run ? (
    <OnNodeSubworkflow
      summary={run}
      zoom={zoom}
      plain={trace !== undefined}
      onFocus={(key) => actions.focusField(id, key)}
    />
  ) : def && hasOnNode ? (
    <OnNodeRow
      def={def}
      instance={instance}
      state={state}
      zoom={zoom}
      readOnly={actions.readOnly}
      onChange={(settings) => actions.setSettings(id, settings)}
      onFocus={(key) => actions.focusField(id, key)}
    />
  ) : null;

  if (zoom === 'icon') {
    const handles = (ports: PortSpec[], direction: 'in' | 'out', connected: ReadonlySet<string>) =>
      ports.map((port) => (
        <TcHandle
          key={`${direction}-${port.id}`}
          port={port}
          direction={direction}
          connected={connected.has(port.id)}
          fit={fitOf(direction, port.id)}
        />
      ));
    return (
      // biome-ignore lint/a11y/useSemanticElements: a card, not a form fieldset.
      <div
        role="group"
        aria-label={`${title}${runSuffix}${stateSuffix}`}
        data-testid={`tc-node-${id}`}
        className={classes.join(' ')}
        style={style}
      >
        {progress !== null && (
          <div className="tc-node-fill" aria-hidden="true">
            <span className="tc-node-icon">{icon}</span>
          </div>
        )}
        {toolbar}
        {valueHandle}
        <Badge state={state} glyphOnly />
        <span className="tc-node-icon">{icon}</span>
        {handles(inputs, 'in', connectedIn)}
        {handles(outputs, 'out', connectedOut)}
      </div>
    );
  }

  // The card's words and rows. The progress fill (`.tc-node-fill`) draws them a second time, in
  // the on-accent ink, clipped to the filled part: text stays readable on both the raised
  // background and the lime fill (a mix-blend inversion cannot promise AA on either).
  const body = (ghost: boolean) => (
    <>
      <div className="tc-node-head">
        <div className="tc-node-eyebrow">
          {icon}
          {def?.source.kind === 'plugin' ? `${word} · plugin` : word}
          {instance.bypassed && <span className="tc-node-skipped">Skipped here</span>}
        </div>
        <div className="tc-node-title">{title}</div>
      </div>
      {rows.map((i) => (
        <PortRow
          key={i}
          input={inputs[i]}
          output={outputs[i]}
          connectedIn={connectedIn}
          connectedOut={connectedOut}
          onPlus={ghost ? undefined : onPlus}
          labelOf={labelOf}
          showLabels={zoom === 'full'}
          traced={portTrace}
          fitOf={fitOf}
          ghost={ghost}
        />
      ))}
      {reached && trace && run && (
        <OnNodeSubworkflow summary={run} zoom={zoom} plain onFocus={noop} />
      )}
      {reached && trace && <TraceRow id={id} title={title} trace={trace} ghost={ghost} />}
    </>
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: a card of labelled rows, not a form fieldset.
    <div
      role="group"
      aria-label={`${word} ${title}${runSuffix}${stateSuffix}`}
      data-testid={`tc-node-${id}`}
      className={classes.join(' ')}
      style={style}
    >
      {progress !== null && (
        <div className="tc-node-fill" aria-hidden="true">
          {body(true)}
        </div>
      )}
      {toolbar}
      {valueHandle}
      <Badge state={state} />
      {body(false)}
      {!hasTraceRow && zoom === 'full' && (
        <div className="tc-node-row">
          {onNodeRow ?? (state.badge === 'needs-setting' ? 'needs a setting' : null)}
        </div>
      )}
      {!hasTraceRow && zoom === 'compact' && onNodeRow}
    </div>
  );
}
