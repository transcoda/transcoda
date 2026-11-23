import {
  type ConnectionStore,
  type EdgesStore,
  type NodesStore,
  useReactFlowStoreApi,
  type ViewportStore,
} from '@xyflow/react';
import { useCallback, useSyncExternalStore } from 'react';

/** React Flow's node, edge, viewport and connection state, read as one object. */
export type FlowState = NodesStore & EdgesStore & ViewportStore & ConnectionStore;

type Part = 'nodes' | 'edges' | 'viewport' | 'connection';

/**
 * A value worked out from more than one of React Flow's stores (React Flow 13 splits its state
 * into a nodes, an edges, a viewport and a connection store; `useNodesStore` and the like read
 * one each). `select` runs again whenever one of the `parts` it reads changes, and the component
 * re-renders only when its result changes, so it returns a string, number or boolean.
 */
export function useFlowState<T extends string | number | boolean>(
  parts: readonly Part[],
  select: (s: FlowState) => T,
): T {
  const api = useReactFlowStoreApi();
  const key = parts.join(',');
  const subscribe = useCallback(
    (onChange: () => void) => {
      const stores = {
        nodes: api.nodesStore,
        edges: api.edgesStore,
        viewport: api.viewportStore,
        connection: api.connectionStore,
      };
      const off = key.split(',').map((part) => stores[part as Part].subscribe(onChange));
      return () => {
        for (const unsubscribe of off) unsubscribe();
      };
    },
    [api, key],
  );
  const snapshot = () =>
    select({
      ...api.nodesStore.getState(),
      ...api.edgesStore.getState(),
      ...api.viewportStore.getState(),
      ...api.connectionStore.getState(),
    });
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
