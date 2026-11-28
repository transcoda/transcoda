// Shared setup for the walk tests (walk*.test.ts): test node definitions, a registry and walk deps
// over them (setup), and helpers to read the trace.
import { type AnyNodeDefinition, type DataValue, defineNode } from '@transcoda/sdk';
import type { JsonValue, TraceEntry, WorkflowGraph } from '@transcoda/shared';
import { expect, vi } from 'vitest';
import { z } from 'zod';
import { filePort, languageInput, passElse } from '../../nodes/core/common.ts';
import { NodeHookError } from '../../nodes/core/stream-rules.ts';
import { bareGraph, testRegistry } from '../../workflows/testing.ts';
import { capsOf, fileOf, probeOf } from '../testing/builders.ts';
import type { PathStep, WalkDeps } from './walk.ts';

export const NOW = new Date('2026-10-16T20:00:00.000Z');

/**
 * The walk does not need a Render (validation asks for one): the graphs here are walked as given,
 * and the Render tests (walk.finish.test.ts) put theirs in.
 */
export const mainGraph = bareGraph;
export const AT = NOW.toISOString();

const languageOf = (v: JsonValue | undefined) => v ?? null;

const cond = defineNode({
  type: 'test:cond',
  version: 1,
  kind: 'condition',
  title: 'Cond',
  description: 'Chooses the port named in its settings.',
  icon: 'test',
  inputs: [filePort, languageInput],
  outputs: passElse,
  settings: z.object({ port: z.enum(['pass', 'else', 'bogus']).default('pass') }),
  async decide(ctx, s) {
    return {
      port: s.port,
      reason: `chose ${s.port}`,
      findings: { language: languageOf(ctx.data.language), now: ctx.now },
    };
  },
});

const act = defineNode({
  type: 'test:act',
  version: 1,
  kind: 'action',
  title: 'Act',
  description: 'Appends its arg to globalArgs.',
  icon: 'test',
  inputs: [filePort, languageInput],
  outputs: [filePort],
  settings: z.object({ arg: z.string(), fail: z.boolean().default(false) }),
  async build(ctx, s) {
    if (s.fail) throw new NodeHookError(`cannot ${s.arg}`);
    return {
      model: { ...ctx.model, globalArgs: [...ctx.model.globalArgs, s.arg] },
      reason: `added ${s.arg}`,
      findings: { language: languageOf(ctx.data.language) },
    };
  },
});

const plain = defineNode({
  type: 'test:plain',
  version: 1,
  kind: 'action',
  title: 'Plain',
  description: 'An action without a build hook.',
  icon: 'test',
  inputs: [filePort],
  outputs: [filePort],
  settings: z.object({}),
});

const fin = defineNode({
  type: 'test:fin',
  version: 1,
  kind: 'finish',
  title: 'Fin',
  description: 'A size gate.',
  icon: 'test',
  inputs: [filePort],
  outputs: [filePort],
  settings: z.object({ percent: z.number() }),
  async finish(_ctx, s) {
    return {
      actions: [{ kind: 'size-gate', minSavingPercent: s.percent }],
      reason: `gate ${s.percent}`,
    };
  },
});

/** Finish nodes of each phase with no output (like plugin finish nodes); the action names them. */
const phased = (type: string, finishPhase: 'library-manager' | 'media-server' | 'notify') =>
  defineNode({
    type,
    version: 1,
    kind: 'finish',
    finishPhase,
    title: type,
    description: `A ${finishPhase} finish node.`,
    icon: 'test',
    inputs: [filePort],
    outputs: [],
    settings: z.object({}),
    async finish() {
      return { actions: [{ kind: 'plugin', description: type, required: false }], reason: type };
    },
  });
const lib = phased('test:lib', 'library-manager');
const media = phased('test:media', 'media-server');
const note = phased('test:note', 'notify');

function dataLanguage(calls: { count: number }): AnyNodeDefinition {
  return defineNode({
    type: 'test:data-language',
    version: 1,
    kind: 'data',
    title: 'Language',
    description: 'A language from its settings.',
    icon: 'test',
    inputs: [],
    outputs: [{ id: 'language', label: 'Language', type: 'data:language' }],
    settings: z.object({ language: z.string().default('jpn'), fail: z.boolean().default(false) }),
    async data(_ctx, s) {
      calls.count++;
      if (s.fail) throw new Error('boom');
      return { value: s.language, reason: `language ${s.language}` };
    },
  });
}

function dataMulti(value: DataValue): AnyNodeDefinition {
  return defineNode({
    type: 'test:data-multi',
    version: 1,
    kind: 'data',
    title: 'Multi',
    description: 'A data node with two outputs.',
    icon: 'test',
    inputs: [],
    outputs: [
      { id: 'a', label: 'A', type: 'data:language' },
      { id: 'b', label: 'B', type: 'data:language' },
    ],
    settings: z.object({ fail: z.boolean().default(false) }),
    async data(_ctx, s) {
      if (s.fail) throw new Error('boom');
      return { value, reason: 'multi' };
    },
  });
}

export function setup(
  opts: {
    multi?: DataValue;
    children?: Record<string, { name: string; graph: WorkflowGraph }>;
    calls?: { count: number };
  } = {},
): {
  deps: WalkDeps;
  trace: TraceEntry[];
  started: string[];
  resolveChild: ReturnType<typeof vi.fn>;
} {
  const trace: TraceEntry[] = [];
  const started: string[] = [];
  const resolveChild = vi.fn(
    (id: string, _version: number, _overrides: Record<string, JsonValue>) =>
      opts.children?.[id] ?? null,
  );
  const deps: WalkDeps = {
    registry: testRegistry(
      cond,
      act,
      plain,
      fin,
      lib,
      media,
      note,
      dataLanguage(opts.calls ?? { count: 0 }),
      dataMulti(opts.multi ?? 'unknown'),
    ),
    resolveChild,
    now: () => NOW,
    onTrace: (entry) => trace.push(entry),
    onNodeStart: ({ workflowPath, nodeId }) => started.push([...workflowPath, nodeId].join('/')),
    capabilities: capsOf(['libx264']),
    log: () => {},
  };
  return { deps, trace, started, resolveChild };
}

export const input = (graph: WorkflowGraph) => ({
  graph,
  probe: probeOf([{ type: 'video' }, { type: 'audio', language: 'jpn' }]),
  file: fileOf('/media/a.mkv', 1000),
  attempt: 2,
});

/** The trace without seq, timestamps, attempt and findings (checked once). */
export const brief = (trace: TraceEntry[]) =>
  trace.map(({ nodeId, workflowPath, phase, port, reason }) => ({
    nodeId,
    workflowPath,
    phase,
    port,
    reason,
  }));

export const ids = (path: { nodeId: string }[]) => path.map((r) => r.nodeId);
export const at = (s: { workflowPath: string[]; nodeId: string }) =>
  [...s.workflowPath, s.nodeId].join('/');

/**
 * Seqs run 1, 2, … in emission order, and every path step has exactly one non-data entry for
 * its node with the port it left by (a failing step: its `failed:` entry).
 */
export function expectCovered(path: PathStep[], trace: TraceEntry[]): void {
  expect(trace.map((e) => e.seq)).toEqual(trace.map((_, i) => i + 1));
  const entries = trace.filter((e) => e.phase !== 'data');
  for (const s of path) {
    const mine = entries.filter((e) => at(e) === at(s));
    expect(mine.length, at(s)).toBeGreaterThanOrEqual(1);
    const ok = mine.filter((e) => !e.reason.startsWith('failed: '));
    if (ok.length > 0) {
      expect(ok, at(s)).toHaveLength(1);
      expect(ok[0]?.port, at(s)).toBe(s.port);
    }
  }
  expect(new Set(entries.map(at))).toEqual(new Set(path.map(at)));
}
