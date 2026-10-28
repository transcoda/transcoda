// Every example in examples/workflows walked through the engine (walkDecide, then walkBuild, as
// the pipeline runs them) with the real core nodes and fake plugin nodes: validation alone did not
// catch that a shared output failed every job (gate finding C1). The real-ffmpeg runs are in
// examples.test.ts; the plugin example cannot run there (core has no plugin bundles).
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Capabilities } from '@transcoda/contract';
import type { NodeMetadata } from '@transcoda/sdk';
import {
  type JsonValue,
  type TraceEntry,
  type WorkflowGraph,
  WorkflowGraphSchema,
} from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { filePort } from '../nodes/core/common.ts';
import { createCoreRegistry, NodeRegistry, type RegisteredNode } from '../nodes/registry.ts';
import { remoteNodeDefinition } from '../nodes/remote.ts';
import { validateWorkflow } from '../workflows/validate.ts';
import { capsOf, fileOf, probeOf } from './test-helpers.ts';
import { type WalkDeps, walkBuild, walkDecide } from './walk.ts';

const DIR = fileURLToPath(new URL('../../../../examples/workflows/', import.meta.url));

const caps: Capabilities = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '7.1',
  encoders: ['aac', 'libx264', 'libx265'],
  hwaccels: [],
  filters: ['pan'],
};

type Meta = Pick<NodeMetadata, 'type' | 'kind' | 'finishPhase' | 'inputs' | 'outputs' | 'hooks'>;

const emptySettings = z.toJSONSchema(z.object({}).loose(), { io: 'input' }) as JsonValue;

/** A plugin node whose host answers like the real plugin would, without a network. */
function fake(plugin: string, m: Meta, answer: () => JsonValue): RegisteredNode {
  const source = { kind: 'plugin', name: plugin, version: '1.0.0' } as const;
  const def = remoteNodeDefinition(
    {
      ...m,
      version: 1,
      title: m.type,
      description: 'A fake of a plugin node.',
      icon: 'plug',
      settingsSchema: emptySettings,
      onNodeSettings: [],
      requires: {},
      migrations: [],
    },
    source,
    { call: async () => ({ ok: true, result: answer() }) },
    { callTimeoutMs: 1000, finishRunTimeoutMs: 1000 },
  );
  return { def, source };
}

const finishFake = (plugin: string, type: string, phase: NonNullable<Meta['finishPhase']>) =>
  fake(
    plugin,
    {
      type,
      kind: 'finish',
      finishPhase: phase,
      inputs: [filePort],
      outputs: [],
      hooks: ['finish'],
    },
    () => ({ actions: [{ kind: 'plugin', description: type, required: false }], reason: type }),
  );

function registry(): NodeRegistry {
  const reg = new NodeRegistry(createCoreRegistry().list());
  reg.add([
    fake(
      'sonarr',
      {
        type: 'sonarr:original-language',
        kind: 'data',
        finishPhase: null,
        inputs: [],
        outputs: [
          { id: 'language', label: 'Original language', type: 'data:language' },
          { id: 'title', label: 'Series title', type: 'data:text' },
          { id: 'ids', label: 'Ids', type: 'data:ids' },
        ],
        hooks: ['data'],
      },
      () => ({
        value: { language: 'jpn', title: 'Show', ids: 'unknown' },
        reason: 'original language Japanese (jpn)',
      }),
    ),
    finishFake('sonarr', 'sonarr:rescan', 'library-manager'),
    finishFake('jellyfin', 'jellyfin:refresh', 'media-server'),
    finishFake('ntfy', 'ntfy:notify', 'notify'),
  ]);
  return reg;
}

/** An H.264 file with tracks to clean up: audio in three languages, two subtitles, a cover. */
const probe = probeOf([
  { type: 'video', codec: 'h264', width: 1920, height: 1080 },
  { type: 'audio', codec: 'ac3', language: 'jpn', channels: 6, default: true },
  { type: 'audio', codec: 'ac3', language: 'eng', channels: 6 },
  { type: 'audio', codec: 'ac3', language: 'fre', channels: 2 },
  { type: 'subtitle', codec: 'subrip', language: 'eng' },
  { type: 'subtitle', codec: 'subrip', language: 'spa' },
  { type: 'video', codec: 'mjpeg', attachedPic: true },
]);

async function examples(): Promise<Array<{ name: string; graph: WorkflowGraph }>> {
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(
    files.map(async (f) => ({
      name: f.replace(/\.json$/, ''),
      graph: WorkflowGraphSchema.parse(JSON.parse(await readFile(join(DIR, f), 'utf8'))),
    })),
  );
}

async function walkExample(graph: WorkflowGraph) {
  const trace: TraceEntry[] = [];
  const reg = registry();
  const deps: WalkDeps = {
    registry: reg,
    resolveChild: () => null,
    now: () => new Date('2026-10-19T20:00:00.000Z'),
    onTrace: (e) => trace.push(e),
    capabilities: capsOf(['aac', 'libx264', 'libx265']),
    log: () => {},
  };
  const input = { graph, probe, file: fileOf('/media/Show/a.mkv', probe.sizeBytes), attempt: 1 };
  const decided = await walkDecide(deps, input);
  if (decided.kind === 'failed') return { result: decided, trace, reg };
  return { result: await walkBuild(deps, input, decided), trace, reg };
}

describe('every example in examples/workflows walks through the engine', () => {
  it('finds the examples, the plugin one among them', async () => {
    expect((await examples()).map((e) => e.name)).toContain('keep-my-languages-plugins');
  });

  it('each validates without errors, walks to a build, and writes the result', async () => {
    for (const { name, graph } of await examples()) {
      const issues = validateWorkflow(graph, {
        registry: registry(),
        capabilities: caps,
        outputRoots: ['/out'],
        resolveSubworkflow: () => null,
      });
      expect(
        issues.filter((i) => i.severity === 'error'),
        name,
      ).toEqual([]);
      const { result, trace } = await walkExample(graph);
      if (result.kind !== 'built') throw new Error(`${name}: ${JSON.stringify(result)}`);
      expect(
        trace.filter((e) => e.reason.startsWith('failed')),
        name,
      ).toEqual([]);
      expect(
        result.actions.some((a) => a.kind === 'replace' || a.kind === 'move-copy'),
        name,
      ).toBe(true);
    }
  });

  it('each is at graph format 2 with exactly one Render before each Replace original', async () => {
    for (const { name, graph } of await examples()) {
      expect(graph.formatVersion, name).toBe(2);
      const renders = graph.nodes.filter((n) => n.type === 'core:render');
      const replaces = graph.nodes.filter((n) => n.type === 'core:replace-original');
      expect(renders.length, name).toBe(replaces.length);
      expect(renders.length, name).toBeGreaterThan(0);
      for (const r of renders) expect(r.settings, name).toEqual({});
    }
  });

  it('same-phase finish nodes on one output never tie on the canvas (their place sets the order)', async () => {
    const reg = registry();
    for (const { name, graph } of await examples()) {
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      const outputs = new Map<string, string[]>();
      for (const e of graph.edges) {
        const key = `${e.from.node}:${e.from.port}`;
        outputs.set(key, [...(outputs.get(key) ?? []), e.to.node]);
      }
      for (const [key, targets] of outputs) {
        if (targets.length < 2) continue;
        const spots = new Map<string, string>();
        for (const id of targets) {
          const n = byId.get(id);
          const def = n && reg.get(n.type)?.def;
          if (!n || def?.kind !== 'finish') continue;
          const spot = `${def.finishPhase}@${n.position.x},${n.position.y}`;
          expect(spots.get(spot), `${name} ${key}: ${id} ties with`).toBeUndefined();
          spots.set(spot, id);
        }
      }
    }
  });

  it('keep-my-languages-plugins: the three finish steps off Replace original run in phase order', async () => {
    const example = (await examples()).find((e) => e.name === 'keep-my-languages-plugins');
    if (!example) throw new Error('missing example');
    // The example wires the three to the one output of Replace original.
    expect(
      example.graph.edges
        .filter((e) => e.from.node === 'replace')
        .map((e) => e.to.node)
        .sort(),
    ).toEqual(['notify', 'refresh', 'rescan']);
    const { result } = await walkExample(example.graph);
    if (result.kind !== 'built') throw new Error(JSON.stringify(result));
    expect(result.path.map((s) => s.nodeId).slice(-4)).toEqual([
      'replace',
      'rescan',
      'refresh',
      'notify',
    ]);
    expect(result.actions.map((a) => ('phase' in a ? `${a.kind}:${a.phase}` : a.kind))).toEqual([
      'render',
      'replace',
      'plugin:library-manager',
      'plugin:media-server',
      'plugin:notify',
    ]);
    expect(result.gates).toEqual([]);
    // Sonarr's original language (the fake says Japanese) reached Keep languages: the Japanese
    // and English audio stay, the French goes.
    const audio = result.model.streams.filter((s) => s.type === 'audio' && s.keep);
    expect(audio.map((s) => s.sourceIndex).sort()).toEqual([1, 2]);
  });
});
