import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getBezierPath } from '@xyflow/react';
import { ARROWED, edgeStyle } from './edge-style.ts';
import type { TcEdge as TcEdgeType } from './types.ts';

/** Arrowhead size in px, the same on every edge whatever its stroke width (`userSpaceOnUse`). */
export const ARROW_SIZE = 12;

export function TcEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<TcEdgeType>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const style = edgeStyle(data);
  const arrow = ARROWED.has(style);
  // One marker per edge, coloured by the edge's class (markers do not inherit stroke colour).
  const markerId = `tc-arrow-${id.replace(/[^\w-]/g, '_')}`;
  return (
    <>
      {arrow && (
        <defs>
          <marker
            id={markerId}
            className={`tc-arrow ${style}`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerUnits="userSpaceOnUse"
            markerWidth={ARROW_SIZE}
            markerHeight={ARROW_SIZE}
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 Z" />
          </marker>
        </defs>
      )}
      <BaseEdge
        id={id}
        path={path}
        className={`tc-edge ${style}`}
        {...(arrow && { markerEnd: `url(#${markerId})` })}
      />
      {style === 'edge-data' && data?.value && (
        <EdgeLabelRenderer>
          <div
            className="tc-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.value}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
