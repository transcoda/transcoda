import { act, render } from '@testing-library/react';
import { type Edge, type Node, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import type { ComponentProps } from 'react';

/** Renders a bare React Flow with the given nodes and edges and waits one act() tick. */
export async function renderFlow(
  nodes: Node[],
  edges: Edge[],
  props: Omit<ComponentProps<typeof ReactFlow>, 'nodes' | 'edges'> = {},
): Promise<ReturnType<typeof render>> {
  const result = render(
    <ReactFlowProvider>
      <div style={{ width: 1200, height: 800 }}>
        <ReactFlow nodes={nodes} edges={edges} {...props} />
      </div>
    </ReactFlowProvider>,
  );
  await act(async () => {});
  return result;
}
