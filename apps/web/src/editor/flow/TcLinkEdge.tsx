import { BaseEdge, type EdgeProps, getBezierPath } from '@xyflow/react';
import type { TcLinkEdge as TcLinkEdgeType } from './types.ts';

/** The faint dotted line from the values card to a node that follows one of its values. */
export function TcLinkEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps<TcLinkEdgeType>) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return <BaseEdge id={id} path={path} className="tc-link-edge" interactionWidth={0} />;
}
