import {
  type AnyNodeDefinition,
  defineNode,
  type NodeDefinition,
  type NodeMigration,
} from '@transcoda/sdk';
import {
  type Edge,
  emptyGraph,
  type JsonValue,
  type NodeInstance,
  type WorkflowGraph,
  type WorkflowKind,
} from '@transcoda/shared';
import { z } from 'zod';
import { filePort } from '../nodes/core/common.ts';
import { createCoreRegistry, NodeRegistry, type RegisteredNode } from '../nodes/registry.ts';
import { remoteNodeDefinition } from '../nodes/remote.ts';

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
  'core:size-gate': 2,
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

export function mainGraph(nodes: NodeInstance[], edges: Edge[] = []): WorkflowGraph {
  return { formatVersion: 1, kind: 'workflow', nodes, edges, groups: [] };
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
