import type { Capabilities } from '@transcoda/contract';
import type { Issue, WorkflowGraph } from '@transcoda/shared';
import type { NodeRegistry } from '../../nodes/registry.ts';
import { bumpV1, chain, node, testRegistry } from '../testing.ts';
import type { SubworkflowRef, ValidationContext } from './types.ts';

// Shared setup for the validate*.test.ts files: capabilities, a validation context, issue helpers.

export const caps: Extract<Capabilities, { available: true }> = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '7.1',
  encoders: ['aac', 'libx265'],
  hwaccels: [],
  filters: ['pan'],
};

export function ctx(
  over: {
    registry?: NodeRegistry;
    capabilities?: Capabilities;
    subs?: Map<string, SubworkflowRef>;
    self?: { id: string };
    outputRoots?: string[];
  } = {},
): ValidationContext {
  const subs = over.subs ?? new Map<string, SubworkflowRef>();
  return {
    registry: over.registry ?? testRegistry(bumpV1()),
    capabilities: over.capabilities ?? caps,
    outputRoots: over.outputRoots ?? ['/out'],
    resolveSubworkflow: (id, version) => subs.get(`${id}@${version}`) ?? null,
    ...(over.self ? { self: over.self } : {}),
  };
}

export const codes = (issues: Issue[]) => issues.map((i) => `${i.severity}:${i.code}`).sort();
export const find = (issues: Issue[], code: Issue['code']) => issues.filter((i) => i.code === code);

/** in → <middle> → replace-original */
export function mainWith(...middle: ReturnType<typeof node>[]): WorkflowGraph {
  return chain(
    'workflow',
    node('in', 'core:input-manual'),
    ...middle,
    node('ro', 'core:replace-original'),
  );
}

export function runNode(id: string, subworkflowId: string, version: number, overrides = {}) {
  return node(id, 'core:run-subworkflow', { subworkflowId, version, overrides });
}
