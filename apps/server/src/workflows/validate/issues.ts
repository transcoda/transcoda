import type { AnyNodeDefinition } from '@transcoda/sdk';
import type { Issue, NodeInstance } from '@transcoda/shared';
import type { NodeState } from './types.ts';

// Building issues: a node's name in messages, an error or a warning at a node, edge or setting.

export function title(n: NodeInstance, def: AnyNodeDefinition | undefined): string {
  return n.label ?? def?.title ?? n.type;
}

export function error(
  code: Issue['code'],
  message: string,
  at: Omit<Issue, 'severity' | 'code' | 'message'>,
): Issue {
  return { severity: 'error', code, message, ...at };
}

export function warning(
  code: Issue['code'],
  message: string,
  at: Omit<Issue, 'severity' | 'code' | 'message'>,
): Issue {
  return { severity: 'warning', code, message, ...at };
}

export function defOf(state: NodeState | undefined): AnyNodeDefinition | undefined {
  return state && state.status !== 'unknown' ? state.def : undefined;
}
