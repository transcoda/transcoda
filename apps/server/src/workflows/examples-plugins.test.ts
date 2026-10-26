// The plugin example cannot run in engine/examples.test.ts (core has no plugin bundles): it is
// validated structurally here, against stub definitions built from the plugins' announced
// metadata, and against the real definitions in the M3 gate.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Capabilities } from '@transcoda/contract';
import type { NodeMetadata } from '@transcoda/sdk';
import { type JsonValue, type WorkflowGraph, WorkflowGraphSchema } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { filePort } from '../nodes/core/common.ts';
import { createCoreRegistry, NodeRegistry, type RegisteredNode } from '../nodes/registry.ts';
import { remoteNodeDefinition } from '../nodes/remote.ts';
import { validateWorkflow } from './validate.ts';

const FILE = fileURLToPath(
  new URL('../../../../examples/workflows/keep-my-languages-plugins.json', import.meta.url),
);

const caps: Capabilities = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '7.1',
  encoders: ['aac', 'libx265'],
  hwaccels: [],
  filters: ['pan'],
};

type Meta = Pick<NodeMetadata, 'type' | 'kind' | 'finishPhase' | 'inputs' | 'outputs'>;

const emptySettings = z.toJSONSchema(z.object({}), { io: 'input' }) as JsonValue;

function stub(plugin: string, m: Meta): RegisteredNode {
  const source = { kind: 'plugin', name: plugin, version: '1.0.0' } as const;
  const def = remoteNodeDefinition(
    {
      ...m,
      version: 1,
      title: m.type,
      description: 'Stub of a plugin node.',
      icon: 'plug',
      settingsSchema: emptySettings,
      onNodeSettings: [],
      requires: {},
      migrations: [],
      hooks: [],
    },
    source,
    { call: async () => ({ ok: true, result: null }) },
    { callTimeoutMs: 1000, finishRunTimeoutMs: 1000 },
  );
  return { def, source };
}

const finishNode = (type: string, phase: NonNullable<Meta['finishPhase']>): Meta => ({
  type,
  kind: 'finish',
  finishPhase: phase,
  inputs: [filePort],
  outputs: [],
});

/** `notifyOutputs`: the real ntfy:notify has none; the order case needs a path through it. */
function registry(notifyOutputs: Meta['outputs'] = []): NodeRegistry {
  const reg = new NodeRegistry(createCoreRegistry().list());
  reg.add([
    stub('sonarr', {
      type: 'sonarr:original-language',
      kind: 'data',
      finishPhase: null,
      inputs: [],
      outputs: [
        { id: 'language', label: 'Original language', type: 'data:language' },
        { id: 'title', label: 'Series title', type: 'data:text' },
        { id: 'ids', label: 'Ids', type: 'data:ids' },
      ],
    }),
    stub('sonarr', finishNode('sonarr:rescan', 'library-manager')),
    stub('jellyfin', finishNode('jellyfin:refresh', 'media-server')),
    stub('ntfy', { ...finishNode('ntfy:notify', 'notify'), outputs: notifyOutputs }),
  ]);
  return reg;
}

async function load(): Promise<WorkflowGraph> {
  return WorkflowGraphSchema.parse(JSON.parse(await readFile(FILE, 'utf8')));
}

const ctx = (reg: NodeRegistry = registry()) => ({
  registry: reg,
  capabilities: caps,
  outputRoots: ['/out'],
  resolveSubworkflow: () => null,
});

describe('examples/workflows/keep-my-languages-plugins.json', () => {
  it('validates with no errors and the finish phases in order', async () => {
    const issues = validateWorkflow(await load(), ctx());
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.filter((i) => i.code === 'FINISH_ORDER')).toEqual([]);
  });

  it('uses the plugin nodes the guide describes', async () => {
    const g = await load();
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get('rescan')?.settings).toEqual({ timeoutSeconds: 240 });
    expect(byId.get('refresh')?.settings).toEqual({ scope: 'file' });
    expect(byId.get('notify')?.settings).toEqual({ topic: 'transcoda-CHANGE-ME', events: 'done' });
    expect(
      g.edges.some(
        (e) =>
          e.from.node === 'orig' &&
          e.from.port === 'language' &&
          e.to.node === 'languages' &&
          e.to.port === 'language',
      ),
    ).toBe(true);
  });

  it('FINISH_ORDER when ntfy:notify runs before core:replace-original', async () => {
    const g = await load();
    // extras → notify → replace: a notify step ahead of the write (the stub gets a file output
    // for this case only; the real node ends a path).
    const moved: WorkflowGraph = {
      ...g,
      edges: [
        ...g.edges.filter((e) => e.id !== 'extras-replace' && e.id !== 'replace-notify'),
        {
          id: 'extras-notify',
          from: { node: 'extras', port: 'file' },
          to: { node: 'notify', port: 'file' },
        },
        {
          id: 'notify-replace',
          from: { node: 'notify', port: 'file' },
          to: { node: 'replace', port: 'file' },
        },
      ],
    };
    const issues = validateWorkflow(moved, ctx(registry([filePort])));
    expect(issues.filter((i) => i.code === 'FINISH_ORDER').map((i) => i.nodeId)).toContain(
      'replace',
    );
  });
});
