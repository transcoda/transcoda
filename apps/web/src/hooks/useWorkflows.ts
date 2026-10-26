import type { WorkflowDetail, WorkflowSummary } from '@transcoda/contract';
import { api } from '../api/client.ts';
import { useAsync } from './useAsync.ts';

export function useWorkflows(): {
  workflows: WorkflowSummary[] | undefined;
  error: unknown;
  loading: boolean;
  reload(): void;
} {
  const { data, error, loading, reload } = useAsync(
    () => api.workflows.list().then((r) => r.workflows),
    [],
  );
  return { workflows: data, error, loading, reload };
}

export function useWorkflow(
  id: string,
  version?: number,
): { workflow: WorkflowDetail | undefined; error: unknown; loading: boolean; reload(): void } {
  const { data, error, loading, reload } = useAsync(
    () => api.workflows.get(version === undefined ? { id } : { id, version }),
    [id, version],
  );
  return { workflow: data, error, loading, reload };
}
