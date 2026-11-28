// Where a finish action came from: the walk tags core actions with their node; plugin ones carry it.
import type { EngineFinishAction } from '../../nodes/core/approval.ts';

/** The node a finish action came from (core actions are tagged by the walk, plugin ones carry it). */
export interface ActionNode {
  nodeId: string;
  workflowPath: string[];
}

/** Where `action` came from; null for an action built before the walk tagged them. */
export function actionNode(action: EngineFinishAction): ActionNode | null {
  const a = action as Partial<ActionNode>;
  return typeof a.nodeId === 'string' && Array.isArray(a.workflowPath)
    ? { nodeId: a.nodeId, workflowPath: [...a.workflowPath] }
    : null;
}
