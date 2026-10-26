import { branchPortLabel, branchWord } from '@transcoda/shared';
import { Handle, Position, type ReactFlowState } from '@xyflow/react';
import { Icon } from '../../components/Icon.tsx';
import type { PortSpec } from '../../hooks/useCatalog.ts';
import type { Fit, HandleRef } from './connectionFit.ts';
import type { TcNodeData } from './types.ts';

/**
 * The text beside a handle: file ports read "file", a branch output reads "Yes" (the `pass` port)
 * or "No" (the `else` port). The stored ids stay `pass` and `else`; a plugin's own words for such
 * a port are kept (see `branchPortLabel`).
 */
export function portLabel(port: PortSpec): string {
  if (branchWord(port.id) !== null) return branchPortLabel(port);
  return port.type === 'file' ? 'file' : port.label;
}

/**
 * The type word a two-way branch output names beside its Yes / No ("Yes · file", "No · data");
 * `null` on every other port.
 */
export function branchType(port: PortSpec): 'file' | 'data' | null {
  if (branchWord(port.id) === null) return null;
  return port.type === 'file' ? 'file' : 'data';
}

/**
 * The class that colours a branch output (N2): `is-branch-pass` on the `pass` (Yes) port,
 * `is-branch-else` on the `else` (No) port, `null` on every other port. Only the colour comes from
 * it; the words Yes / No (or the plugin's own) stay the meaning.
 */
export function branchClass(port: PortSpec): 'is-branch-pass' | 'is-branch-else' | null {
  const word = branchWord(port.id);
  if (word === 'Yes') return 'is-branch-pass';
  if (word === 'No') return 'is-branch-else';
  return null;
}

/**
 * The handle a connection is being dragged from (N5), read from React Flow's connection state, or
 * `null` when nothing is dragged. Its port type comes from the dragged node's catalogue entry
 * (`null` for an unknown node); a dragged input is occupied when an edge already ends on it.
 */
export function dragFromOf(s: ReactFlowState): HandleRef | null {
  const c = s.connection;
  if (!c.inProgress) return null;
  const { nodeId } = c.fromHandle;
  const portId = c.fromHandle.id ?? '';
  const direction = c.fromHandle.type === 'source' ? 'out' : 'in';
  const def = (c.fromNode.data as Partial<TcNodeData>).def;
  const ports = direction === 'out' ? def?.outputs : def?.inputs;
  return {
    nodeId,
    portId,
    direction,
    portType: ports?.find((p) => p.id === portId)?.type ?? null,
    occupied:
      direction === 'in' &&
      s.edges.some((e) => e.target === nodeId && (e.targetHandle ?? '') === portId),
  };
}

/**
 * One port's handle (N2) and, on a free output, its "+" (N4). `fit` is the card's N5 drag feedback
 * for this handle (`TcNode` works it out for all its handles at once, see `connectionFit`).
 */
export function TcHandle({
  port,
  direction,
  connected,
  fit = null,
  onPlus,
}: {
  port: PortSpec;
  direction: 'in' | 'out';
  connected: boolean;
  fit?: Fit | undefined;
  onPlus?(port: PortSpec): void;
}) {
  const shape = `tc-handle-${port.type === 'file' ? 'file' : 'data'}-${direction}`;
  const classes = ['tc-handle', shape];
  const branch = direction === 'out' ? branchClass(port) : null;
  if (branch) classes.push(branch);
  // The dragged handle itself ('source') gets no class: nothing styles it.
  if (fit === 'compatible' || fit === 'incompatible') classes.push(`is-${fit}`);
  const type = direction === 'out' ? branchType(port) : null;
  const label = type ? `${portLabel(port)}, ${type}` : portLabel(port);
  return (
    <>
      <Handle
        type={direction === 'in' ? 'target' : 'source'}
        position={direction === 'in' ? Position.Left : Position.Right}
        id={port.id}
        className={classes.join(' ')}
        title={`${label} ${direction}`}
      />
      {direction === 'out' && !connected && onPlus && (
        <button
          type="button"
          className="tc-plus nodrag nopan"
          aria-label={`Connect from ${branchPortLabel(port)}`}
          onClick={(e) => {
            e.stopPropagation();
            onPlus(port);
          }}
        >
          <span className="tc-plus-dot">
            <Icon name="plus" size={12} strokeWidth={3} />
          </span>
        </button>
      )}
    </>
  );
}
