// Shared setup for the WorkflowService tests (service*.test.ts): a fresh database, a quiet log and
// a service per test, and helpers to make, save and activate workflows over it. Graph and registry
// builders are in test-helpers.ts.
import type { Capabilities } from '@transcoda/contract';
import { type AnyNodeDefinition, defineNode } from '@transcoda/sdk';
import type { Issue, JsonValue, NodeInstance, WorkflowGraph } from '@transcoda/shared';
import { beforeEach, type Mock, vi } from 'vitest';
import { z } from 'zod';
import type { Database } from '../db/open.ts';
import { createTestDb } from '../db/test-db.ts';
import { filePort } from '../nodes/core/common.ts';
import type { Logger } from '../platform/logger.ts';
import { WorkflowService } from './service.ts';
import { bumpV1, chain, node, testRegistry } from './test-helpers.ts';

export const caps: Extract<Capabilities, { available: true }> = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '7.1',
  encoders: ['aac'],
  hwaccels: [],
  filters: ['pan'],
};

export const NOW = new Date('2026-10-16T20:00:00.000Z');
export const USER = 'user-1';

export let db: Database;
export let log: { [K in keyof Logger]: Mock<NonNullable<Logger[K]>> };
export let svc: WorkflowService;

export function makeSvc(
  defs: AnyNodeDefinition[],
  capabilities: Capabilities = caps,
): WorkflowService {
  return new WorkflowService({
    db,
    registry: testRegistry(...defs),
    capabilities: () => capabilities,
    now: () => NOW,
    log,
  });
}

/** A service over the same db with a different registry (a restart with bumped definitions). */
export function svcWith(...defs: AnyNodeDefinition[]): WorkflowService {
  return makeSvc(defs);
}

export const codes = (issues: Issue[]) => issues.map((i) => `${i.severity}:${i.code}`).sort();

/** in → <middle> → replace-original */
export function mainWith(...middle: NodeInstance[]): WorkflowGraph {
  return chain(
    'workflow',
    node('in', 'core:input-manual'),
    ...middle,
    node('ro', 'core:replace-original'),
  );
}

export function run(
  id: string,
  subworkflowId: string,
  version: number,
  overrides: Record<string, JsonValue> = {},
): NodeInstance {
  return node(id, 'core:run-subworkflow', { subworkflowId, version, overrides });
}

/** Creates a workflow and saves `graphs` in order; returns its id. */
export function make(
  name: string,
  kind: 'workflow' | 'subworkflow',
  ...graphs: WorkflowGraph[]
): string {
  const created = svc.create({ name, kind }, USER);
  let version = created.version;
  for (const graph of graphs) {
    version = svc.save({ id: created.id, baseVersion: version, graph }, USER).version;
  }
  return created.id;
}

export function current(id: string): number {
  return svc.get(id)?.currentVersion ?? -1;
}

export function save(id: string, graph: WorkflowGraph) {
  return svc.save({ id, baseVersion: current(id), graph }, USER);
}

/** Activates `version` (default: the current one); throws when the service refuses. */
export function activate(id: string, version: number = current(id)): void {
  const r = svc.activate(id, version, USER);
  if (r.kind !== 'ok') throw new Error(`could not activate ${id}: ${JSON.stringify(r)}`);
}

export const activeOf = (id: string) => svc.get(id)?.active ?? null;

export function corrupt(id: string): void {
  db.prepare('UPDATE workflow_versions SET graph = ? WHERE workflow_id = ? AND version = ?').run(
    '{"formatVersion":1',
    id,
    current(id),
  );
}

export function summary(id: string) {
  const s = svc.list().find((w) => w.id === id);
  if (!s) throw new Error(`no summary for ${id}`);
  return s;
}

/** A second migrating node type, so one workflow can upgrade while another fails. */
export function otherDef(version: 1 | 2): AnyNodeDefinition {
  return defineNode({
    type: 'test:other',
    version,
    kind: 'action',
    title: 'Other',
    description: 'Second test node with a migration.',
    icon: 'test',
    inputs: [filePort],
    outputs: [filePort],
    settings: z.object({ n: z.number().default(0).describe('N') }),
    migrations: [{ from: 1, to: 2, risk: 'safe', note: 'n kept', migrate: (s) => s }],
  });
}

/** Registers the setup and teardown every test in these files shares. */
/** Replaces the service the shared helpers use (a test over another registry). */
export function setSvc(next: WorkflowService): void {
  svc = next;
}

export function useServiceDb(): void {
  beforeEach(() => {
    db = createTestDb();
    log = {
      info: vi.fn<Logger['info']>(),
      warn: vi.fn<Logger['warn']>(),
      error: vi.fn<Logger['error']>(),
    };
    svc = svcWith(bumpV1());
  });
}
