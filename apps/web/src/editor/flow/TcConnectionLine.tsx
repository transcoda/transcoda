import { type ConnectionLineComponentProps, getBezierPath } from '@xyflow/react';
import type { TcFlowNode, TcNodeData } from './types.ts';

/**
 * The line being dragged (N5), drawn in the style of the edge it will become: a file edge solid,
 * a data edge dotted yellow (`edge-file` for a node without a catalogue entry). `is-valid` while
 * it is over a handle that accepts the drop.
 */
export function TcConnectionLine({
  fromNode,
  fromHandle,
  fromX,
  fromY,
  fromPosition,
  toX,
  toY,
  toPosition,
  connectionStatus,
}: ConnectionLineComponentProps<TcFlowNode>) {
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  });
  const def = (fromNode.data as Partial<TcNodeData>).def;
  const ports = fromHandle.type === 'source' ? def?.outputs : def?.inputs;
  const type = ports?.find((p) => p.id === fromHandle.id)?.type;
  const classes = ['tc-connection-line', type && type !== 'file' ? 'edge-data' : 'edge-file'];
  if (connectionStatus === 'valid') classes.push('is-valid');
  return <path className={classes.join(' ')} d={path} fill="none" />;
}
