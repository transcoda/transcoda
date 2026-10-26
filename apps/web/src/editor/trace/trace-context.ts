import { createContext, useContext } from 'react';

/** What a node card in the trace view may ask its canvas to do (Task 23). */
export interface TraceActions {
  /** Opens (or, when it is open, closes) a Run node's sub-workflow below the canvas. */
  toggleRun(runNodeId: string): void;
}

export const TraceActionsContext = createContext<TraceActions>({ toggleRun: () => {} });

export function useTraceActions(): TraceActions {
  return useContext(TraceActionsContext);
}
