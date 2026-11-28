// Test support for workflows/ and the tests elsewhere that build workflows: node definitions that
// migrate, graph and registry builders, and the shared setup for the WorkflowService tests
// (service*.test.ts): a fresh database, a quiet log and a service per test, and helpers to make,
// save and activate workflows over it.
import type { Capabilities } from '@transcoda/contract';
import {
  type AnyNodeDefinition,
  defineNode,
  type NodeDefinition,
  type NodeMigration,
} from '@transcoda/sdk';
import {
  type Edge,
  emptyGraph,
  type Issue,
  type JsonValue,
  type NodeInstance,
  upgradeGraphJson,
  type WorkflowGraph,
  type WorkflowKind,
} from '@transcoda/shared';
import { beforeEach, type Mock, vi } from 'vitest';
import { z } from 'zod';
import type { Database } from '../db/open.ts';
import { createTestDb } from '../db/testing.ts';
import { filePort } from '../nodes/core/common.ts';
import { createCoreRegistry, NodeRegistry, type RegisteredNode } from '../nodes/registry.ts';
import { remoteNodeDefinition } from '../nodes/remote.ts';
import type { Logger } from '../platform/logger.ts';
import { WorkflowService } from './service.ts';

function obj(s: JsonValue): Record<string, JsonValue> {
  return s !== null && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

export const bumpSettingsV1 = z.object({
  level: z.number().int().default(1).describe('Level'),
});

const bumpSettingsV2 = bumpSettingsV1.extend({
  label: z.string().default('').describe('Label'),
});

const bumpBase: Pick<
  NodeDefinition,
  'type' | 'kind' | 'title' | 'description' | 'icon' | 'inputs' | 'outputs'
> = {
  type: 'test:bump',
  kind: 'action',
  title: 'Bump',
  description: 'Test node with migrations.',
  icon: 'test',
  inputs: [filePort],
  outputs: [filePort],
};

const migrateV1toV2: NodeMigration = {
  from: 1,
  to: 2,
  risk: 'safe',
  note: 'label added',
  migrate: (s) => ({ ...obj(s), label: '' }),
};

export function bumpV1(): AnyNodeDefinition {
  return defineNode({ ...bumpBase, version: 1, settings: bumpSettingsV1 });
}

export function bumpV2(): AnyNodeDefinition {
  return defineNode({
    ...bumpBase,
    version: 2,
    settings: bumpSettingsV2,
    migrations: [migrateV1toV2],
  });
}

export function bumpV3(): AnyNodeDefinition {
  return defineNode({
    ...bumpBase,
    version: 3,
    settings: bumpSettingsV2.extend({ strict: z.boolean().default(true).describe('Strict') }),
    migrations: [
      migrateV1toV2,
      {
        from: 2,
        to: 3,
        risk: 'behaviour',
        note: 'strict mode on by default',
        migrate: (s) => ({ ...obj(s), strict: true }),
      },
    ],
  });
}

export function bumpNoPath(): AnyNodeDefinition {
  return defineNode({ ...bumpBase, version: 2, settings: bumpSettingsV2 });
}

export function bumpThrowing(): AnyNodeDefinition {
  return defineNode({
    ...bumpBase,
    version: 2,
    settings: bumpSettingsV2,
    migrations: [
      {
        from: 1,
        to: 2,
        risk: 'safe',
        note: 'label added',
        migrate: () => {
          throw new Error('boom');
        },
      },
    ],
  });
}

export const dataLanguage: AnyNodeDefinition = defineNode({
  type: 'test:data-language',
  version: 1,
  kind: 'data',
  title: 'Language',
  description: 'Test node producing a language.',
  icon: 'test',
  inputs: [],
  outputs: [{ id: 'language', label: 'Language', type: 'data:language' }],
  settings: z.object({}),
});

/** A data node that passes a language through (data input and data output). */
export const dataLanguagePass: AnyNodeDefinition = defineNode({
  type: 'test:data-language-pass',
  version: 1,
  kind: 'data',
  title: 'Language pass',
  description: 'Test data node with a data input and a data output.',
  icon: 'test',
  inputs: [{ id: 'language', label: 'Language', type: 'data:language' }],
  outputs: [{ id: 'language', label: 'Language', type: 'data:language' }],
  settings: z.object({}),
});

/** Core registry + dataLanguage + dataLanguagePass + defs; a def whose type is already present replaces it. */
export function testRegistry(...defs: AnyNodeDefinition[]): NodeRegistry {
  const byType = new Map(
    createCoreRegistry()
      .list()
      .map((entry) => [entry.def.type, entry] as const),
  );
  for (const def of [dataLanguage, dataLanguagePass, ...defs]) {
    byType.set(def.type, { def, source: { kind: 'core' } });
  }
  return new NodeRegistry([...byType.values()]);
}

const VERSIONS: Record<string, number> = {
  'core:size-gate': 3,
  'core:encode-video': 2,
  'core:encode-audio': 3,
};

export function node(
  id: string,
  type: string,
  settings: JsonValue = {},
  opts: Partial<
    Pick<NodeInstance, 'typeVersion' | 'label' | 'position' | 'bypassed' | 'groupId' | 'links'>
  > = {},
): NodeInstance {
  // The size gate (pass/else outputs) and Encode video (source bitrate cap) are at version 2,
  // Encode audio (track titles) at 3; every other test node starts at 1.
  const typeVersion = VERSIONS[type] ?? 1;
  return { id, type, typeVersion, settings, position: { x: 0, y: 0 }, ...opts };
}

export function edge(from: string, to: string, ports: { from?: string; to?: string } = {}): Edge {
  return {
    id: `${from}-${to}`,
    from: { node: from, port: ports.from ?? 'file' },
    to: { node: to, port: ports.to ?? 'file' },
  };
}

const CORE = createCoreRegistry();

/**
 * A workflow graph as a format-1 graph of `nodes` and `edges` reads today: a Render inserted on
 * every output that leads from a non-finish node into core finish nodes (`upgradeGraphJson`), so
 * tests written before Render keep their meaning. `bareGraph` leaves the graph as given.
 */
export function mainGraph(nodes: NodeInstance[], edges: Edge[] = []): WorkflowGraph {
  const v1 = { formatVersion: 1, kind: 'workflow', nodes, edges, groups: [] };
  return upgradeGraphJson(v1, (t) => CORE.get(t)?.def) as WorkflowGraph;
}

/** A workflow graph exactly as given (no Render inserted). */
export function bareGraph(nodes: NodeInstance[], edges: Edge[] = []): WorkflowGraph {
  return { formatVersion: 2, kind: 'workflow', nodes, edges, groups: [] };
}

export function subGraph(nodes: NodeInstance[], edges: Edge[] = []): WorkflowGraph {
  const base = emptyGraph('subworkflow');
  return { ...base, nodes: [...base.nodes, ...nodes], edges };
}

/** The output a chain leaves a node by: the size gate's is `pass`, everything else's `file`. */
const chainPort = (n: NodeInstance): string => (n.type === 'core:size-gate' ? 'pass' : 'file');

export function chain(kind: WorkflowKind, ...nodes: NodeInstance[]): WorkflowGraph {
  if (kind === 'workflow') {
    return mainGraph(
      nodes,
      nodes.slice(1).map((n, i) => {
        const from = nodes[i] as NodeInstance;
        return edge(from.id, n.id, { from: chainPort(from) });
      }),
    );
  }
  const ids = ['start', ...nodes.map((n) => n.id), 'end'];
  return subGraph(
    nodes,
    ids.slice(1).map((id, i) => edge(ids[i] as string, id)),
  );
}

export function childGraph(): WorkflowGraph {
  return chain(
    'subworkflow',
    node('kl', 'core:keep-languages', { languages: ['en', 'de'] }, { label: 'Keep EN/DE' }),
  );
}

export function moveNodes(g: WorkflowGraph): WorkflowGraph {
  return {
    ...g,
    nodes: g.nodes.map((n) => ({
      ...n,
      position: { x: n.position.x + 10, y: n.position.y + 10 },
      label: `${n.label ?? n.id} (moved)`,
      groupId: 'g1',
    })),
    groups: [
      {
        id: 'g1',
        name: 'Group',
        collapsed: false,
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
      },
    ],
  };
}

export function withSetting(
  g: WorkflowGraph,
  nodeId: string,
  settings: JsonValue,
  typeVersion?: number,
): WorkflowGraph {
  return {
    ...g,
    nodes: g.nodes.map((n) =>
      n.id === nodeId
        ? { ...n, settings, ...(typeVersion === undefined ? {} : { typeVersion }) }
        : n,
    ),
  };
}

export function withExtraNode(g: WorkflowGraph, n: NodeInstance): WorkflowGraph {
  return { ...g, nodes: [...g.nodes, n] };
}

/** The migration links a plugin announces: 1→2 safe, 2→3 behaviour. */
export const PLUGIN_LINKS = [
  { from: 1, to: 2, risk: 'safe' as const, note: 'value added' },
  { from: 2, to: 3, risk: 'behaviour' as const, note: 'value is now required' },
];

/**
 * A plugin node `x:a` ("A", node version `version`) as the registry holds it: a remote definition
 * built from announced metadata, its settings schema the new version's (`value` required).
 */
export function remoteA(
  version: number,
  migrations: Array<{ from: number; to: number; risk: 'safe' | 'behaviour'; note: string }>,
  pluginName = 'x',
): RegisteredNode {
  const source = { kind: 'plugin', name: pluginName, version: '1.0.0' } as const;
  const def = remoteNodeDefinition(
    {
      type: 'x:a',
      version,
      kind: 'action',
      title: 'A',
      description: 'A plugin node.',
      icon: 'plug',
      inputs: [filePort],
      outputs: [filePort],
      settingsSchema: z.toJSONSchema(z.object({ value: z.string() }), { io: 'input' }) as JsonValue,
      onNodeSettings: [],
      requires: {},
      migrations,
      finishPhase: null,
      hooks: [],
    },
    source,
    { call: async () => ({ ok: true, result: null }) },
    { callTimeoutMs: 1000, finishRunTimeoutMs: 1000 },
  );
  return { def, source };
}

/** The core test registry plus the plugin's registered nodes. */
export function registryWithPlugin(...entries: RegisteredNode[]): NodeRegistry {
  const registry = testRegistry();
  registry.add(entries);
  return registry;
}

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

/** Replaces the service the shared helpers use (a test over another registry). */
export function setSvc(next: WorkflowService): void {
  svc = next;
}

/** Registers the setup and teardown every test in these files shares. */
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
