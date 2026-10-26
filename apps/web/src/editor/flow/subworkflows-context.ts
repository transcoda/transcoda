import type { WorkflowSummary } from '@transcoda/contract';
import { createContext, useContext } from 'react';

/**
 * The page's one `workflows.list` (`useWorkflows`), for the Run sub-workflow cards' names.
 * `undefined` while it loads, when it failed, or without a provider (unit tests, previews): the
 * card then shows the pinned version only and never calls a sub-workflow missing.
 */
export const SubworkflowsContext = createContext<WorkflowSummary[] | undefined>(undefined);

export function useSubworkflowList(): WorkflowSummary[] | undefined {
  return useContext(SubworkflowsContext);
}
