import type { PortType } from '../../hooks/useCatalog.ts';

/** One handle on the canvas, as the N5 drag feedback sees it. */
export type HandleRef = {
  nodeId: string;
  portId: string;
  direction: 'in' | 'out';
  /** `null`: the node has no catalogue entry (an unknown node), so nothing can connect to it. */
  portType: PortType | null;
  /** An input with an edge already (an output may fan out, so false for outputs). */
  occupied: boolean;
};

/** `source`: the handle being dragged from. */
export type Fit = 'source' | 'compatible' | 'incompatible' | null;

/**
 * How `me` takes the edge dragged from `from` (N5); `null` when nothing is dragged. Mirrors
 * `checkConnection` exactly, so a handle glows only where the drop is accepted: not on the
 * dragged node, not on the same side, not for another port type, not on an occupied input.
 */
export function connectionFit(from: HandleRef | null, me: HandleRef): Fit {
  if (from === null) return null;
  if (from.nodeId === me.nodeId) {
    return from.portId === me.portId && from.direction === me.direction ? 'source' : 'incompatible';
  }
  if (from.direction === me.direction) return 'incompatible';
  if (from.portType === null || from.portType !== me.portType) return 'incompatible';
  const input = me.direction === 'in' ? me : from;
  return input.occupied ? 'incompatible' : 'compatible';
}

/** True while dragging when none of the node's fits is 'compatible' or 'source'. */
export function nodeFaded(fits: readonly Fit[]): boolean {
  return fits.length > 0 && fits.every((f) => f === 'incompatible');
}
