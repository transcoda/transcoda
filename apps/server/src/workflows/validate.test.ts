import type { Capabilities } from '@transcoda/contract';
import { defineNode } from '@transcoda/sdk';
import {
  emptyGraph,
  FINISH_PHASES,
  type FinishPhase,
  finishPhaseRank,
  type Issue,
  type JsonValue,
  type WorkflowGraph,
} from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { filePort } from '../nodes/core/common.ts';
import { createCoreRegistry, type NodeRegistry } from '../nodes/registry.ts';
import {
  bareGraph,
  bumpNoPath,
  bumpThrowing,
  bumpV1,
  bumpV2,
  bumpV3,
  chain,
  childGraph,
  edge,
  mainGraph,
  node,
  PLUGIN_LINKS,
  registryWithPlugin,
  remoteA,
  subGraph,
  testRegistry,
  withExtraNode,
} from './test-helpers.ts';
import {
  createValidationCache,
  migratePinned,
  type SubworkflowRef,
  type ValidationContext,
  validateWorkflow,
  walkPathRules,
} from './validate.ts';

const caps: Capabilities = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '7.1',
  encoders: ['aac', 'libx265'],
  hwaccels: [],
  filters: ['pan'],
};

function ctx(
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

const codes = (issues: Issue[]) => issues.map((i) => `${i.severity}:${i.code}`).sort();
const find = (issues: Issue[], code: Issue['code']) => issues.filter((i) => i.code === code);

/** in → <middle> → replace-original */
function mainWith(...middle: ReturnType<typeof node>[]): WorkflowGraph {
  return chain(
    'workflow',
    node('in', 'core:input-manual'),
    ...middle,
    node('ro', 'core:replace-original'),
  );
}

function runNode(id: string, subworkflowId: string, version: number, overrides = {}) {
  return node(id, 'core:run-subworkflow', { subworkflowId, version, overrides });
}

describe('validateWorkflow', () => {
  it('a connected main workflow (manual → keep-languages → set-default-track → size-gate → replace-original) has no issues', () => {
    expect(
      validateWorkflow(
        chain(
          'workflow',
          node('in', 'core:input-manual'),
          node('kl', 'core:keep-languages'),
          node('sd', 'core:set-default-track'),
          node('sg', 'core:size-gate'),
          node('ro', 'core:replace-original'),
        ),
        ctx(),
      ),
    ).toEqual([]);
  });

  it('a data node feeding keep-languages is reachable; an orphan data node is not', () => {
    const g = chain(
      'workflow',
      node('in', 'core:input-manual'),
      node('kl', 'core:keep-languages'),
      node('ro', 'core:replace-original'),
    );
    const withData = {
      ...g,
      nodes: [...g.nodes, node('d', 'test:data-language'), node('d2', 'test:data-language')],
      edges: [...g.edges, edge('d', 'kl', { from: 'language', to: 'language' })],
    };
    expect(validateWorkflow(withData, ctx()).map((i) => [i.code, i.nodeId])).toEqual([
      ['NODE_UNREACHABLE', 'd2'],
    ]);
    expect(find(validateWorkflow(withData, ctx()), 'NODE_UNREACHABLE')[0]?.severity).toBe(
      'warning',
    );
  });

  it('a data node feeding a reachable data consumer through another data node is reachable', () => {
    const g = mainWith(node('kl', 'core:keep-languages'));
    const ports = { from: 'language', to: 'language' };
    const g2 = {
      ...g,
      nodes: [...g.nodes, node('d', 'test:data-language'), node('p', 'test:data-language-pass')],
      edges: [...g.edges, edge('d', 'p', ports), edge('p', 'kl', ports)],
    };
    expect(validateWorkflow(g2, ctx())).toEqual([]);
    // without the second hop the first data node is unreachable
    const cut = { ...g2, edges: g2.edges.filter((e) => e.id !== 'p-kl') };
    expect(find(validateWorkflow(cut, ctx()), 'NODE_UNREACHABLE').map((i) => i.nodeId)).toEqual([
      'd',
      'p',
    ]);
  });

  it('a 499-node chain validates without throwing; a cycle in it is still found', () => {
    // in, 496 actions, Render, Replace original
    const middle = Array.from({ length: 496 }, (_, i) => node(`k${i}`, 'core:keep-languages'));
    const g = mainWith(...middle);
    expect(g.nodes).toHaveLength(499);
    expect(validateWorkflow(g, ctx())).toEqual([]);
    const cyclic = { ...g, edges: [...g.edges, edge('k495', 'k0')] };
    expect(find(validateWorkflow(cyclic, ctx()), 'GRAPH_CYCLE')).toHaveLength(1);
  });

  it('a settings schema that throws → INVALID_SETTINGS at the root', () => {
    const throwing = defineNode({
      type: 'test:throwing',
      version: 1,
      kind: 'action',
      title: 'Throwing',
      description: 'Settings schema throws.',
      icon: 'test',
      inputs: [{ id: 'file', label: 'File', type: 'file' }],
      outputs: [{ id: 'file', label: 'File', type: 'file' }],
      settings: z.object({}).superRefine(() => {
        throw new Error('boom');
      }) as unknown as z.ZodObject<z.ZodRawShape>,
    });
    const issues = validateWorkflow(
      mainWith(node('t', 'test:throwing')),
      ctx({ registry: testRegistry(throwing) }),
    );
    expect(issues).toEqual([
      {
        severity: 'error',
        code: 'INVALID_SETTINGS',
        message: 'Settings could not be checked: boom',
        nodeId: 't',
      },
    ]);
  });

  it('unknown type, newer version, outdated with a path, outdated without a path', () => {
    const unknown = validateWorkflow(
      mainWith(node('zz', 'zz:nope', { anything: 5 }), node('x', 'core:keep-languages')),
      ctx(),
    );
    // the edge from the unknown node still connects keep-languages' input
    expect(find(unknown, 'INPUT_UNCONNECTED')).toEqual([]);
    expect(find(unknown, 'UNKNOWN_NODE_TYPE')).toEqual([
      {
        severity: 'error',
        code: 'UNKNOWN_NODE_TYPE',
        message: 'Unknown node type zz:nope',
        nodeId: 'zz',
      },
    ]);

    const newer = validateWorkflow(
      mainWith(node('b', 'test:bump', { level: 'bad' }, { typeVersion: 9 })),
      ctx(),
    );
    expect(codes(newer)).toEqual(['error:UNKNOWN_NODE_VERSION']);
    expect(newer[0]?.nodeId).toBe('b');

    const outdated = validateWorkflow(
      mainWith(node('b', 'test:bump', { level: 'bad' })),
      ctx({ registry: testRegistry(bumpV2()) }),
    );
    expect(codes(outdated)).toEqual(['error:NODE_OUTDATED']);
    expect(outdated[0]?.message).toBe('Bump is at version 1; this server has version 2');

    const noPath = validateWorkflow(
      mainWith(node('b', 'test:bump', { level: 'bad' }, { label: 'My bump' })),
      ctx({ registry: testRegistry(bumpNoPath()) }),
    );
    expect(codes(noPath)).toEqual(['error:NODE_OUTDATED']);
    expect(noPath[0]?.message).toBe(
      'My bump is at version 1; this server has version 2, and no upgrade path exists',
    );
  });

  it('missing required setting → INVALID_SETTINGS "Needs a setting" with settingPath; non-object settings → INVALID_SETTINGS', () => {
    const missing = validateWorkflow(
      chain('workflow', node('in', 'core:input-manual'), node('mc', 'core:move-copy')),
      ctx(),
    );
    expect(missing).toEqual([
      {
        severity: 'error',
        code: 'INVALID_SETTINGS',
        message: 'Needs a setting',
        nodeId: 'mc',
        settingPath: 'outputRoot',
      },
    ]);

    const wrongType = validateWorkflow(mainWith(node('b', 'test:bump', { level: 'high' })), ctx());
    expect(wrongType).toEqual([
      expect.objectContaining({ code: 'INVALID_SETTINGS', nodeId: 'b', settingPath: 'level' }),
    ]);
    expect(wrongType[0]?.message).not.toBe('Needs a setting');

    for (const settings of [5, null, ['x']] as JsonValue[]) {
      const issues = validateWorkflow(mainWith(node('kl', 'core:keep-languages', settings)), ctx());
      expect(codes(issues)).toEqual(['error:INVALID_SETTINGS']);
      expect(issues[0]).toMatchObject({ nodeId: 'kl' });
      expect(issues[0]?.settingPath).toBeUndefined();
    }
  });

  it('edges: dangling, unknown port, wrong direction, type mismatch, double input, required input unconnected', () => {
    const base = mainWith(node('vi', 'core:video-is'), node('kl', 'core:keep-languages'));
    // base edges: in→vi (file→file, ok), vi→kl (vi has no 'file' output), kl→Render→ro
    const fixed: WorkflowGraph = {
      ...base,
      edges: [
        edge('in', 'vi'),
        edge('vi', 'kl', { from: 'pass' }),
        ...base.edges.filter((e) => [e.from.node, e.to.node].includes('render-1')),
      ],
    };
    // vi's else output stays unconnected: only the port-aware write-path warning
    expect(validateWorkflow(fixed, ctx()).map((i) => `${i.code}:${i.nodeId}`)).toEqual([
      'NO_WRITE_PATH:vi',
    ]);

    const withEdges = (...extra: WorkflowGraph['edges']) =>
      validateWorkflow({ ...fixed, edges: [...fixed.edges, ...extra] }, ctx());

    // dangling
    const dangling = withEdges(edge('kl', 'ghost'));
    expect(find(dangling, 'DANGLING_EDGE')).toEqual([
      expect.objectContaining({ severity: 'error', edgeId: 'kl-ghost' }),
    ]);

    // wrong direction: 'file' is vi's INPUT, not an output
    const fromInput = withEdges({ ...edge('vi', 'ro'), id: 'wrong-from' });
    expect(find(fromInput, 'UNKNOWN_PORT')).toEqual([
      expect.objectContaining({ edgeId: 'wrong-from' }),
    ]);

    // wrong direction: 'pass' is vi's OUTPUT, not an input
    const toOutput = withEdges({ ...edge('kl', 'vi', { to: 'pass' }), id: 'wrong-to' });
    expect(find(toOutput, 'UNKNOWN_PORT')).toEqual([
      expect.objectContaining({ edgeId: 'wrong-to' }),
    ]);

    // non-existent port
    const nope = withEdges({ ...edge('vi', 'ro', { from: 'nope' }), id: 'nope' });
    expect(find(nope, 'UNKNOWN_PORT')).toHaveLength(1);

    // type mismatch: data:language output into a file input
    const g = {
      ...fixed,
      nodes: [...fixed.nodes, node('d', 'test:data-language'), node('kl2', 'core:keep-languages')],
      edges: [...fixed.edges, edge('d', 'kl2', { from: 'language', to: 'file' })],
    };
    const mismatch = validateWorkflow(g, ctx());
    expect(find(mismatch, 'PORT_TYPE_MISMATCH')).toEqual([
      expect.objectContaining({ edgeId: 'd-kl2' }),
    ]);
    // the mismatched edge still counts as a connection: no INPUT_UNCONNECTED for kl2
    expect(find(mismatch, 'INPUT_UNCONNECTED')).toEqual([]);

    // two edges into ro.file
    const double = withEdges({ ...edge('vi', 'ro', { from: 'else' }), id: 'second' });
    expect(find(double, 'INPUT_MULTIPLE_EDGES')).toEqual([
      expect.objectContaining({ severity: 'error', nodeId: 'ro' }),
    ]);

    // required input unconnected (kl.file); kl.language is optional
    const unconnected = validateWorkflow(
      { ...fixed, edges: fixed.edges.filter((e) => e.to.node !== 'kl') },
      ctx(),
    );
    expect(find(unconnected, 'INPUT_UNCONNECTED')).toEqual([
      {
        severity: 'error',
        code: 'INPUT_UNCONNECTED',
        message: 'Keep languages: input File is not connected',
        nodeId: 'kl',
      },
    ]);
  });

  it('an edge touching an unknown-type node gets only the existence check', () => {
    const g = mainGraph(
      [node('in', 'core:input-manual'), node('zz', 'zz:nope')],
      [edge('in', 'zz', { to: 'whatever' }), edge('zz', 'ghost')],
    );
    expect(codes(validateWorkflow(g, ctx()))).toEqual([
      'error:DANGLING_EDGE',
      'error:NO_FINISH_PATH',
      'error:UNKNOWN_NODE_TYPE',
      'warning:NO_WRITE_PATH',
    ]);
  });

  it('cycle → GRAPH_CYCLE', () => {
    const g = mainWith(node('kl', 'core:keep-languages'), node('sd', 'core:set-default-track'));
    const cyclic = { ...g, edges: [...g.edges, edge('sd', 'kl')] };
    const cycles = find(validateWorkflow(cyclic, ctx()), 'GRAPH_CYCLE');
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.severity).toBe('error');
    expect(cycles[0]?.message).toContain('kl');
    expect(cycles[0]?.message).toContain('sd');
    expect(cycles[0]?.message).not.toContain('ro');
    expect(find(validateWorkflow(g, ctx()), 'GRAPH_CYCLE')).toEqual([]);
  });

  it('main workflow: zero or two triggers → TRIGGER_COUNT; no finish → NO_FINISH_PATH; start node → NODE_NOT_ALLOWED_HERE; orphan node → warning NODE_UNREACHABLE', () => {
    const none = validateWorkflow(
      chain('workflow', node('kl', 'core:keep-languages'), node('ro', 'core:replace-original')),
      ctx(),
    );
    expect(find(none, 'TRIGGER_COUNT')).toHaveLength(1);
    expect(find(none, 'NODE_UNREACHABLE')).toEqual([]); // no root, no reachability check

    const two = mainWith(node('kl', 'core:keep-languages'));
    const twoTriggers = validateWorkflow(
      withExtraNode(two, node('in2', 'core:input-webhook')),
      ctx(),
    );
    expect(codes(twoTriggers)).toEqual(['error:TRIGGER_COUNT']);

    expect(
      codes(
        validateWorkflow(
          chain('workflow', node('in', 'core:input-manual'), node('kl', 'core:keep-languages')),
          ctx(),
        ),
      ),
    ).toEqual(['error:NO_FINISH_PATH', 'warning:NO_WRITE_PATH']);
    expect(codes(validateWorkflow(emptyGraph('workflow'), ctx()))).toEqual([
      'error:NO_FINISH_PATH',
      'error:TRIGGER_COUNT',
    ]);

    // a finish node exists but is not reachable from the trigger
    const cut = mainWith(node('kl', 'core:keep-languages'));
    const disconnected = validateWorkflow(
      { ...cut, edges: cut.edges.filter((e) => e.to.node !== 'render-1') },
      ctx(),
    );
    expect(codes(disconnected)).toEqual([
      'error:INPUT_UNCONNECTED',
      'error:NO_FINISH_PATH',
      'warning:NODE_UNREACHABLE',
      'warning:NODE_UNREACHABLE',
      'warning:NO_WRITE_PATH',
    ]);

    const withStart = validateWorkflow(
      withExtraNode(mainWith(), node('s', 'core:subworkflow-start')),
      ctx(),
    );
    expect(find(withStart, 'NODE_NOT_ALLOWED_HERE')).toEqual([
      expect.objectContaining({ severity: 'error', nodeId: 's' }),
    ]);

    const orphan = validateWorkflow(withExtraNode(mainWith(), node('o', 'core:remux')), ctx());
    expect(orphan.map((i) => [i.severity, i.code, i.nodeId])).toEqual([
      ['error', 'INPUT_UNCONNECTED', 'o'],
      ['warning', 'NODE_UNREACHABLE', 'o'],
    ]);
  });

  it('sub-workflow: trigger/finish → NODE_NOT_ALLOWED_HERE; two starts → SUBWORKFLOW_IO_COUNT; emptyGraph("subworkflow") is valid', () => {
    expect(validateWorkflow(emptyGraph('subworkflow'), ctx())).toEqual([]);
    expect(validateWorkflow(childGraph(), ctx())).toEqual([]);

    const withTrigger = validateWorkflow(
      chain('subworkflow', node('in', 'core:input-manual'), node('ro', 'core:replace-original')),
      ctx(),
    );
    expect(
      find(withTrigger, 'NODE_NOT_ALLOWED_HERE')
        .map((i) => i.nodeId)
        .sort(),
    ).toEqual(['in', 'ro']);

    const twoStarts = validateWorkflow(
      subGraph(
        [node('start2', 'core:subworkflow-start')],
        [edge('start', 'end'), { ...edge('start2', 'end'), id: 'x' }],
      ),
      ctx(),
    );
    expect(find(twoStarts, 'SUBWORKFLOW_IO_COUNT')).toHaveLength(1);
    expect(find(twoStarts, 'NODE_UNREACHABLE')).toEqual([]); // no single root

    const noEnd: WorkflowGraph = {
      ...emptyGraph('subworkflow'),
      nodes: emptyGraph('subworkflow').nodes.filter((n) => n.id !== 'end'),
      edges: [],
    };
    expect(codes(validateWorkflow(noEnd, ctx()))).toEqual(['error:SUBWORKFLOW_IO_COUNT']);

    const orphan = validateWorkflow(withExtraNode(childGraph(), node('o', 'core:remux')), ctx());
    expect(find(orphan, 'NODE_UNREACHABLE').map((i) => i.nodeId)).toEqual(['o']);
  });

  it('run-subworkflow: missing/unknown-version → SUBWORKFLOW_MISSING; old pin → warning SUBWORKFLOW_OUTDATED; unknown override → warning OVERRIDE_DROPPED; bad override → INVALID_OVERRIDE', () => {
    const subs = new Map<string, SubworkflowRef>([
      ['child@1', { graph: childGraph(), currentVersion: 2 }],
      ['child@2', { graph: childGraph(), currentVersion: 2 }],
    ]);
    const c = ctx({ subs });

    expect(validateWorkflow(mainWith(runNode('r', 'child', 2)), c)).toEqual([]);

    for (const [id, version] of [
      ['nope', 1],
      ['child', 7],
    ] as const) {
      const issues = validateWorkflow(mainWith(runNode('r', id, version)), c);
      expect(issues).toEqual([
        expect.objectContaining({ severity: 'error', code: 'SUBWORKFLOW_MISSING', nodeId: 'r' }),
      ]);
    }

    const old = validateWorkflow(mainWith(runNode('r', 'child', 1)), c);
    expect(old).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'SUBWORKFLOW_OUTDATED', nodeId: 'r' }),
    ]);

    const overrides = validateWorkflow(
      mainWith(
        runNode('r', 'child', 2, {
          'kl.languages': ['fr'],
          'kl.bogus': 1,
          'gone.languages': ['en'],
          'kl.keepOriginal': 'yes',
        }),
      ),
      c,
    );
    expect(overrides.map((i) => [i.severity, i.code, i.nodeId, i.settingPath]).sort()).toEqual([
      ['error', 'INVALID_OVERRIDE', 'r', 'overrides.kl.keepOriginal'],
      ['warning', 'OVERRIDE_DROPPED', 'r', 'overrides.gone.languages'],
      ['warning', 'OVERRIDE_DROPPED', 'r', 'overrides.kl.bogus'],
    ]);

    // invalid run-node settings → INVALID_SETTINGS only, no reference checks
    const invalid = validateWorkflow(
      mainWith(node('r', 'core:run-subworkflow', { subworkflowId: 'nope' })),
      c,
    );
    expect(codes(invalid)).toEqual(['error:INVALID_SETTINGS']);
  });

  it('reference cycles: a sub calling itself (self id), and A→B→A', () => {
    const loop = chain('subworkflow', runNode('r', 'loop', 1));
    const selfCall = validateWorkflow(
      loop,
      ctx({
        subs: new Map([['loop@1', { graph: loop, currentVersion: 1 }]]),
        self: { id: 'loop' },
      }),
    );
    expect(selfCall).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'SUBWORKFLOW_REFERENCE_CYCLE',
        nodeId: 'r',
      }),
    ]);

    const a = chain('subworkflow', runNode('toB', 'B', 1));
    const b = chain('subworkflow', runNode('toA', 'A', 1));
    const subs = new Map<string, SubworkflowRef>([
      ['A@1', { graph: a, currentVersion: 1 }],
      ['B@1', { graph: b, currentVersion: 1 }],
    ]);
    // saving A: B calls back into A
    expect(codes(validateWorkflow(a, ctx({ subs, self: { id: 'A' } })))).toEqual([
      'error:SUBWORKFLOW_REFERENCE_CYCLE',
    ]);
    // a main workflow calling A (the cycle is below it), reported once on the top-level node
    expect(
      validateWorkflow(mainWith(runNode('r', 'A', 1)), ctx({ subs })).map((i) => [
        i.code,
        i.nodeId,
      ]),
    ).toEqual([['SUBWORKFLOW_REFERENCE_CYCLE', 'r']]);

    // the same id at another version still closes a cycle, also when that ref was explored first
    const x1 = chain('subworkflow', runNode('toR', 'R', 1));
    const r1 = chain('subworkflow', runNode('toX', 'X', 2));
    const versions = new Map<string, SubworkflowRef>([
      ['X@1', { graph: x1, currentVersion: 2 }],
      ['X@2', { graph: emptyGraph('subworkflow'), currentVersion: 2 }],
      ['R@1', { graph: r1, currentVersion: 1 }],
    ]);
    expect(
      find(
        validateWorkflow(
          mainWith(runNode('r1', 'R', 1), runNode('r2', 'X', 1)),
          ctx({ subs: versions }),
        ),
        'SUBWORKFLOW_REFERENCE_CYCLE',
      ).map((i) => i.nodeId),
    ).toEqual(['r2']); // R@1 → X@2 alone is acyclic

    // a diamond (A → C, A → C again via B) is not a cycle
    const c = chain('subworkflow', node('kl', 'core:keep-languages'));
    const a2 = chain('subworkflow', runNode('toB', 'B', 1), runNode('toC', 'C', 1));
    const b2 = chain('subworkflow', runNode('toC', 'C', 1));
    const diamond = new Map<string, SubworkflowRef>([
      ['A@1', { graph: a2, currentVersion: 1 }],
      ['B@1', { graph: b2, currentVersion: 1 }],
      ['C@1', { graph: c, currentVersion: 1 }],
    ]);
    expect(validateWorkflow(mainWith(runNode('r', 'A', 1)), ctx({ subs: diamond }))).toEqual([]);
  });

  it('broken pinned sub-workflows → SUBWORKFLOW_BROKEN on the top-level run node', () => {
    const broken = chain(
      'subworkflow',
      node('zz', 'zz:nope'),
      node('nv', 'test:bump', {}, { typeVersion: 9 }),
      node('ea', 'core:encode-audio'),
    );
    const subs = new Map<string, SubworkflowRef>([
      ['child@1', { graph: broken, currentVersion: 1 }],
    ]);
    const issues = validateWorkflow(
      mainWith(runNode('r', 'child', 1)),
      ctx({ subs, capabilities: { ...caps, encoders: [] } }),
    );
    expect(issues.map((i) => [i.severity, i.code, i.nodeId])).toEqual([
      ['error', 'SUBWORKFLOW_BROKEN', 'r'],
      ['error', 'SUBWORKFLOW_BROKEN', 'r'],
      ['error', 'SUBWORKFLOW_BROKEN', 'r'],
    ]);
    expect(issues.map((i) => i.message)).toEqual([
      'Run sub-workflow: sub-workflow child version 1: Unknown node type zz:nope',
      "Run sub-workflow: sub-workflow child version 1: Bump is at version 9, newer than this server's version 1",
      'Run sub-workflow: sub-workflow child version 1: Encode audio is unavailable here: missing encoder aac',
    ]);
  });

  it('a missing grandchild and an outdated node without a path are SUBWORKFLOW_BROKEN; a migratable outdated node is not', () => {
    const mid = chain('subworkflow', runNode('toG', 'grand', 3));
    const noPath = chain('subworkflow', node('b', 'test:bump', { level: 1 }));
    const subs = new Map<string, SubworkflowRef>([
      ['mid@1', { graph: mid, currentVersion: 1 }],
      ['old@1', { graph: noPath, currentVersion: 1 }],
    ]);
    const missing = validateWorkflow(mainWith(runNode('r', 'mid', 1)), ctx({ subs }));
    expect(missing).toEqual([
      {
        severity: 'error',
        code: 'SUBWORKFLOW_BROKEN',
        message:
          'Run sub-workflow: sub-workflow mid version 1: Run sub-workflow: sub-workflow grand version 3 does not exist',
        nodeId: 'r',
      },
    ]);

    const outdatedNoPath = validateWorkflow(
      mainWith(runNode('r', 'old', 1)),
      ctx({ subs, registry: testRegistry(bumpNoPath()) }),
    );
    expect(outdatedNoPath.map((i) => [i.code, i.nodeId, i.message])).toEqual([
      [
        'SUBWORKFLOW_BROKEN',
        'r',
        'Run sub-workflow: sub-workflow old version 1: Bump is at version 1; this server has version 2, and no upgrade path exists',
      ],
    ]);

    // pinned on purpose: an outdated node with a migration path is fine
    expect(
      validateWorkflow(
        mainWith(runNode('r', 'old', 1)),
        ctx({ subs, registry: testRegistry(bumpV2()) }),
      ),
    ).toEqual([]);
  });

  it('breakage two levels down is reported once per problem, through cycles and diamonds', () => {
    const grand = chain('subworkflow', node('zz', 'zz:nope'));
    const mid = chain('subworkflow', runNode('g1', 'grand', 1), runNode('g2', 'grand', 1));
    const top = chain('subworkflow', runNode('m', 'mid', 1), runNode('back', 'top', 1));
    const subs = new Map<string, SubworkflowRef>([
      ['grand@1', { graph: grand, currentVersion: 1 }],
      ['mid@1', { graph: mid, currentVersion: 1 }],
      ['top@1', { graph: top, currentVersion: 1 }],
    ]);
    const issues = validateWorkflow(mainWith(runNode('r', 'top', 1)), ctx({ subs }));
    expect(issues.map((i) => [i.code, i.nodeId, i.message])).toEqual([
      [
        'SUBWORKFLOW_BROKEN',
        'r',
        'Run sub-workflow: sub-workflow top version 1 → mid version 1 → grand version 1: Unknown node type zz:nope',
      ],
      ['SUBWORKFLOW_REFERENCE_CYCLE', 'r', 'Run sub-workflow: sub-workflow top calls itself'],
    ]);
  });

  it('a parent override of a nested Run node is OVERRIDE_DROPPED, not applied', () => {
    const s2 = chain('subworkflow', node('kl', 'core:keep-languages'));
    const s1 = chain('subworkflow', runNode('inner', 'S2', 1));
    const subs = new Map<string, SubworkflowRef>([
      ['S1@1', { graph: s1, currentVersion: 1 }],
      ['S2@1', { graph: s2, currentVersion: 1 }],
    ]);
    const issues = validateWorkflow(
      mainWith(
        runNode('r', 'S1', 1, {
          'inner.version': 999,
          'inner.subworkflowId': 'S1',
          'inner.overrides': {},
        }),
      ),
      ctx({ subs }),
    );
    expect(issues.map((i) => [i.severity, i.code, i.settingPath]).sort()).toEqual([
      ['warning', 'OVERRIDE_DROPPED', 'overrides.inner.overrides'],
      ['warning', 'OVERRIDE_DROPPED', 'overrides.inner.subworkflowId'],
      ['warning', 'OVERRIDE_DROPPED', 'overrides.inner.version'],
    ]);
  });

  it('a pinned child node whose migration path has a behaviour step is SUBWORKFLOW_BROKEN; a throwing safe migration too', () => {
    const old = chain('subworkflow', node('b', 'test:bump', { level: 1 }));
    const subs = new Map<string, SubworkflowRef>([['old@1', { graph: old, currentVersion: 1 }]]);
    const behaviour = validateWorkflow(
      mainWith(runNode('r', 'old', 1)),
      ctx({ subs, registry: testRegistry(bumpV3()) }),
    );
    expect(behaviour).toEqual([
      {
        severity: 'error',
        code: 'SUBWORKFLOW_BROKEN',
        message:
          'Run sub-workflow: sub-workflow old version 1: Bump needs a review; save an upgraded version of the workflow and queue the file again',
        nodeId: 'r',
      },
    ]);
    const throwing = validateWorkflow(
      mainWith(runNode('r', 'old', 1)),
      ctx({ subs, registry: testRegistry(bumpThrowing()) }),
    );
    expect(throwing.map((i) => [i.code, i.message])).toEqual([
      [
        'SUBWORKFLOW_BROKEN',
        'Run sub-workflow: sub-workflow old version 1: Bump could not be upgraded: boom',
      ],
    ]);
  });

  it('a pinned child is migrated before the parent overrides are applied (a safe rename keeps the override)', () => {
    const renamed = defineNode({
      type: 'test:bump',
      version: 2,
      kind: 'action',
      title: 'Bump',
      description: 'Renames level to lvl.',
      icon: 'test',
      inputs: [{ id: 'file', label: 'File', type: 'file' }],
      outputs: [{ id: 'file', label: 'File', type: 'file' }],
      settings: z.object({ lvl: z.number().int().describe('Level') }),
      migrations: [
        {
          from: 1,
          to: 2,
          risk: 'safe',
          note: 'level renamed to lvl',
          migrate: (s) => {
            const { level, ...rest } = s as Record<string, JsonValue>;
            return { ...rest, lvl: level ?? null };
          },
        },
      ],
    });
    // stored at v1 with a value the override is meant to replace
    const child = chain('subworkflow', node('b', 'test:bump', { level: 'bad' }));
    const subs = new Map<string, SubworkflowRef>([['c@1', { graph: child, currentVersion: 1 }]]);
    const registry = testRegistry(renamed);
    expect(
      validateWorkflow(mainWith(runNode('r', 'c', 1, { 'b.lvl': 2 })), ctx({ subs, registry })),
    ).toEqual([]);
    expect(
      validateWorkflow(mainWith(runNode('r', 'c', 1)), ctx({ subs, registry })).map((i) => i.code),
    ).toEqual(['SUBWORKFLOW_BROKEN']);
  });

  it('a pinned child is validated whole: INPUT_UNCONNECTED, INVALID_SETTINGS and a trigger node make the parent SUBWORKFLOW_BROKEN', () => {
    const unconnected = subGraph([node('kl', 'core:keep-languages')], [edge('start', 'end')]);
    const badSettings = chain('subworkflow', node('b', 'test:bump', { level: 'high' }));
    const trigger = chain('subworkflow', node('in', 'core:input-manual'));
    const subs = new Map<string, SubworkflowRef>([
      ['u@1', { graph: unconnected, currentVersion: 1 }],
      ['s@1', { graph: badSettings, currentVersion: 1 }],
      ['t@1', { graph: trigger, currentVersion: 1 }],
    ]);
    const messages = (id: string) =>
      validateWorkflow(mainWith(runNode('r', id, 1)), ctx({ subs })).map((i) => [
        i.code,
        i.nodeId,
        i.message,
      ]);
    expect(messages('u')).toEqual([
      [
        'SUBWORKFLOW_BROKEN',
        'r',
        'Run sub-workflow: sub-workflow u version 1: Keep languages: input File is not connected',
      ],
    ]);
    expect(messages('s')).toEqual([
      [
        'SUBWORKFLOW_BROKEN',
        'r',
        expect.stringMatching(/^Run sub-workflow: sub-workflow s version 1: Bump: level: /),
      ],
    ]);
    expect(messages('t')).toContainEqual([
      'SUBWORKFLOW_BROKEN',
      'r',
      'Run sub-workflow: sub-workflow t version 1: Manual input is not allowed in a sub-workflow',
    ]);
    // the parent's overrides are applied before the child is validated
    expect(
      validateWorkflow(mainWith(runNode('r', 's', 1, { 'b.level': 2 })), ctx({ subs })),
    ).toEqual([]);
  });

  it('N2: one shared cache resolves each id@version once across reachesCycle and child validation', () => {
    // S runs G; the parent runs S three times: every S@1 and G@1 lookup after the first is a hit
    const subs = new Map<string, SubworkflowRef>([
      ['S@1', { graph: chain('subworkflow', runNode('toG', 'G', 1)), currentVersion: 1 }],
      ['G@1', { graph: childGraph(), currentVersion: 1 }],
    ]);
    const resolveCalls = new Map<string, number>();
    const counting: ValidationContext = {
      ...ctx({ subs }),
      resolveSubworkflow: (id, version) => {
        const key = `${id}@${version}`;
        resolveCalls.set(key, (resolveCalls.get(key) ?? 0) + 1);
        return subs.get(key) ?? null;
      },
      cache: createValidationCache(),
    };
    const parent = mainWith(runNode('r1', 'S', 1), runNode('r2', 'S', 1), runNode('r3', 'S', 1));
    expect(validateWorkflow(parent, counting)).toEqual([]);
    expect(Object.fromEntries(resolveCalls)).toEqual({ 'S@1': 1, 'G@1': 1 });
  });

  it('a child reached twice (diamond, or two Run nodes) is validated once per call and per shared cache', () => {
    let parses = 0;
    const counting = defineNode({
      type: 'test:counting',
      version: 1,
      kind: 'action',
      title: 'Counting',
      description: 'Counts settings parses.',
      icon: 'test',
      inputs: [{ id: 'file', label: 'File', type: 'file' }],
      outputs: [{ id: 'file', label: 'File', type: 'file' }],
      settings: z.object({}).superRefine(() => {
        parses++;
      }) as unknown as z.ZodObject<z.ZodRawShape>,
    });
    // C has an unconnected required input, so every path to it is broken
    const c = subGraph([node('n', 'test:counting')], [edge('start', 'end')]);
    const b = chain('subworkflow', runNode('toC', 'C', 1));
    const a = chain('subworkflow', runNode('toB', 'B', 1), runNode('toC', 'C', 1));
    const subs = new Map<string, SubworkflowRef>([
      ['A@1', { graph: a, currentVersion: 1 }],
      ['B@1', { graph: b, currentVersion: 1 }],
      ['C@1', { graph: c, currentVersion: 1 }],
    ]);
    const c1 = ctx({ subs, registry: testRegistry(counting) });
    const issues = validateWorkflow(mainWith(runNode('r1', 'A', 1), runNode('r2', 'C', 1)), c1);
    expect(parses).toBe(1);
    expect(issues.map((i) => [i.code, i.nodeId, i.message])).toEqual([
      [
        'SUBWORKFLOW_BROKEN',
        'r1',
        'Run sub-workflow: sub-workflow A version 1 → B version 1 → C version 1: Counting: input File is not connected',
      ],
      [
        'SUBWORKFLOW_BROKEN',
        'r1',
        'Run sub-workflow: sub-workflow A version 1 → C version 1: Counting: input File is not connected',
      ],
      [
        'SUBWORKFLOW_BROKEN',
        'r2',
        'Run sub-workflow: sub-workflow C version 1: Counting: input File is not connected',
      ],
    ]);
    // a cache shared across calls (as list() does) validates C once in total
    parses = 0;
    const shared = { ...c1, cache: createValidationCache() };
    validateWorkflow(mainWith(runNode('r', 'A', 1)), shared);
    validateWorkflow(mainWith(runNode('r', 'C', 1)), shared);
    expect(parses).toBe(1);
  });

  it('a node whose groupId names no group → warning GROUP_MISSING', () => {
    const g = mainWith(node('kl', 'core:keep-languages', {}, { groupId: 'ghost' }));
    expect(validateWorkflow(g, ctx())).toEqual([
      {
        severity: 'warning',
        code: 'GROUP_MISSING',
        message: 'Keep languages is in group ghost, which does not exist',
        nodeId: 'kl',
      },
    ]);
    const grouped = {
      ...g,
      groups: [
        {
          id: 'ghost',
          name: 'Group',
          collapsed: false,
          position: { x: 0, y: 0 },
          size: { width: 1, height: 1 },
        },
      ],
    };
    expect(validateWorkflow(grouped, ctx())).toEqual([]);
  });

  it('a setting linked to a value that does not exist → warning VALUE_MISSING', () => {
    const g = mainWith(node('kl', 'core:keep-languages', {}, { links: { languages: 'Langs' } }));
    expect(validateWorkflow(g, ctx())).toEqual([
      {
        severity: 'warning',
        code: 'VALUE_MISSING',
        message: 'Keep languages follows the shared value "Langs", which does not exist',
        nodeId: 'kl',
        settingPath: 'languages',
      },
    ]);
  });

  it('a linked value is checked as the setting: a bad language in it is a setting error', () => {
    const g = {
      ...mainWith(node('kl', 'core:keep-languages', {}, { links: { languages: 'Langs' } })),
      values: {
        position: { x: 0, y: 0 },
        entries: [{ name: 'Langs', schema: {}, value: ['english'] }],
      },
    };
    const issues = validateWorkflow(g, ctx());
    expect(issues.map((i) => [i.code, i.nodeId, i.settingPath])).toEqual([
      ['INVALID_SETTINGS', 'kl', 'languages.0'],
    ]);
  });

  it('unavailable node (encode-audio without aac) → NODE_UNAVAILABLE; ffmpeg off → reason "ffmpeg is not available"', () => {
    const g = mainWith(node('ea', 'core:encode-audio'));
    expect(validateWorkflow(g, ctx())).toEqual([]);
    expect(validateWorkflow(g, ctx({ capabilities: { ...caps, encoders: [] } }))).toEqual([
      {
        severity: 'error',
        code: 'NODE_UNAVAILABLE',
        message: 'Encode audio is unavailable here: missing encoder aac',
        nodeId: 'ea',
      },
    ]);
    const off = validateWorkflow(
      g,
      ctx({ capabilities: { available: false, path: 'ffmpeg', error: 'ENOENT' } }),
    );
    expect(off).toEqual([
      expect.objectContaining({
        code: 'NODE_UNAVAILABLE',
        message: 'Encode audio is unavailable here: ffmpeg is not available',
      }),
    ]);
  });

  it('bypassed nodes are still validated', () => {
    const issues = validateWorkflow(
      chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('b', 'test:bump', { level: 'x' }, { bypassed: true }),
        node('mc', 'core:move-copy', {}, { bypassed: true }),
      ),
      ctx(),
    );
    expect(issues.map((i) => [i.code, i.nodeId])).toEqual([
      ['INVALID_SETTINGS', 'b'],
      ['INVALID_SETTINGS', 'mc'],
      // a bypassed move-copy writes nothing
      ['NO_WRITE_PATH', 'mc'],
    ]);
  });

  describe('finish order and write paths', () => {
    /** in → vi, plus the given edges out of vi (ports pass/else) and the nodes they reach. */
    function branching(
      rest: ReturnType<typeof node>[],
      edges: ReturnType<typeof edge>[],
    ): WorkflowGraph {
      return mainGraph(
        [node('in', 'core:input-manual'), node('vi', 'core:video-is'), ...rest],
        [edge('in', 'vi'), ...edges],
      );
    }

    it('FINISH_ORDER: replace before size gate', () => {
      const g = chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('ro', 'core:replace-original'),
        node('sg', 'core:size-gate'),
      );
      expect(validateWorkflow(g, ctx())).toEqual([
        {
          severity: 'error',
          code: 'FINISH_ORDER',
          message:
            'Size gate (gate) comes after Replace original (write); finish nodes run render → gate → write → library manager → media server → notify',
          nodeId: 'sg',
        },
      ]);
      // the same with move-copy
      const mc = chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('mc', 'core:move-copy', { outputRoot: '/out' }),
        node('sg', 'core:size-gate'),
      );
      expect(find(validateWorkflow(mc, ctx()), 'FINISH_ORDER').map((i) => i.nodeId)).toEqual([
        'sg',
      ]);
      // a gate before the write is fine
      expect(validateWorkflow(mainWith(node('sg', 'core:size-gate')), ctx())).toEqual([]);
    });

    describe('OUTPUT_MULTIPLE_EDGES', () => {
      const hook = (id: string) => node(id, 'core:notify-webhook', { url: 'https://e.test/h' });

      it('several finish nodes on one output are fine (they run in phase order)', () => {
        const g = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('ro', 'core:replace-original'),
            hook('a'),
            hook('b'),
          ],
          [edge('in', 'ro'), edge('ro', 'a'), edge('ro', 'b')],
        );
        expect(validateWorkflow(g, ctx())).toEqual([]);
        // on the size gate's pass and else too
        const gate = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('sg', 'core:size-gate'),
            node('ro', 'core:replace-original'),
            hook('p'),
            hook('e1'),
            hook('e2'),
          ],
          [
            edge('in', 'sg'),
            edge('sg', 'ro', { from: 'pass' }),
            edge('sg', 'p', { from: 'pass' }),
            edge('sg', 'e1', { from: 'else' }),
            edge('sg', 'e2', { from: 'else' }),
          ],
        );
        expect(find(validateWorkflow(gate, ctx()), 'OUTPUT_MULTIPLE_EDGES')).toEqual([]);
      });

      it('an output shared with anything but finish nodes is an error on the node it leaves', () => {
        const g = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('kl', 'core:keep-languages', { languages: ['en'] }),
            node('ro', 'core:replace-original'),
          ],
          [edge('in', 'kl'), edge('in', 'ro'), edge('kl', 'ro', { to: 'file' })],
        );
        // one issue per offending edge (drawn broken), none for the edge to the finish node
        expect(find(validateWorkflow(g, ctx()), 'OUTPUT_MULTIPLE_EDGES')).toEqual([
          {
            severity: 'error',
            code: 'OUTPUT_MULTIPLE_EDGES',
            message:
              'Manual input: output File has 2 connections, one to Keep languages; only finish steps can share an output (a file follows one path)',
            nodeId: 'in',
            edgeId: 'in-kl',
          },
        ]);
        // a data output may feed several nodes
        const data = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('d', 'test:data-language'),
            node('k1', 'core:keep-languages', { languages: ['en'] }),
            node('k2', 'core:keep-languages', { languages: ['en'] }),
            node('ro', 'core:replace-original'),
          ],
          [
            edge('in', 'k1'),
            edge('k1', 'k2'),
            edge('k2', 'ro'),
            edge('d', 'k1', { from: 'language', to: 'language' }),
            edge('d', 'k2', { from: 'language', to: 'language' }),
          ],
        );
        expect(find(validateWorkflow(data, ctx()), 'OUTPUT_MULTIPLE_EDGES')).toEqual([]);
      });

      it('in a sub-workflow, sharing an output is always an error (it has no finish nodes)', () => {
        const g = subGraph(
          [
            node('k1', 'core:keep-languages', { languages: ['en'] }),
            node('k2', 'core:keep-languages', { languages: ['de'] }),
          ],
          [edge('start', 'k1'), edge('start', 'k2'), edge('k1', 'end'), edge('k2', 'end')],
        );
        expect(find(validateWorkflow(g, ctx()), 'OUTPUT_MULTIPLE_EDGES')).toEqual([
          expect.objectContaining({ severity: 'error', nodeId: 'start', edgeId: 'start-k1' }),
          expect.objectContaining({ severity: 'error', nodeId: 'start', edgeId: 'start-k2' }),
        ]);
      });

      it('a Run node\u2019s output may feed several finish nodes', () => {
        const subs = new Map<string, SubworkflowRef>([
          ['child@1', { graph: childGraph(), currentVersion: 1 }],
        ]);
        const g = mainGraph(
          [
            node('in', 'core:input-manual'),
            runNode('r', 'child', 1),
            node('ro', 'core:replace-original'),
            hook('a'),
          ],
          [edge('in', 'r'), edge('r', 'ro'), edge('r', 'a')],
        );
        expect(validateWorkflow(g, ctx({ subs }))).toEqual([]);
        // with an action among them, the Run node is blamed, on that edge
        g.nodes.push(node('kl', 'core:keep-languages', { languages: ['en'] }));
        g.edges.push(edge('r', 'kl'));
        expect(find(validateWorkflow(g, ctx({ subs })), 'OUTPUT_MULTIPLE_EDGES')).toEqual([
          expect.objectContaining({ nodeId: 'r', edgeId: 'r-kl' }),
        ]);
      });

      it('SIZE_GATE_SHARED_OUTPUT: a size gate must be the only step on its output', () => {
        const g = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('ev', 'core:remux', { container: 'mkv' }),
            node('sg', 'core:size-gate'),
            node('ro', 'core:replace-original'),
            hook('n'),
          ],
          [edge('in', 'ev'), edge('ev', 'sg'), edge('ev', 'n'), edge('sg', 'ro', { from: 'pass' })],
        );
        const issues = validateWorkflow(g, ctx());
        expect(find(issues, 'SIZE_GATE_SHARED_OUTPUT')).toEqual([
          {
            severity: 'error',
            code: 'SIZE_GATE_SHARED_OUTPUT',
            message:
              'The size gate must be the only step on this output; put the other steps after the gate\u2019s Yes or No.',
            nodeId: 'sg',
            edgeId: 'ev-sg',
          },
        ]);
        expect(find(issues, 'OUTPUT_MULTIPLE_EDGES')).toEqual([]);
        // a bypassed gate runs no hook, so it decides nothing and may share
        const sg = g.nodes.find((n) => n.id === 'sg');
        if (sg) sg.bypassed = true;
        expect(find(validateWorkflow(g, ctx()), 'SIZE_GATE_SHARED_OUTPUT')).toEqual([]);
      });

      it('OUTPUT_MULTIPLE_WRITES: one step that writes the result per output', () => {
        const writes = (second: ReturnType<typeof node>) =>
          mainGraph(
            [
              node('in', 'core:input-manual'),
              node('ro', 'core:replace-original'),
              second,
              hook('n'),
            ],
            [edge('in', 'ro'), edge('in', second.id), edge('in', 'n')],
          );
        const mc = validateWorkflow(
          writes(node('mc', 'core:move-copy', { outputRoot: '/out' })),
          ctx(),
        );
        expect(find(mc, 'OUTPUT_MULTIPLE_WRITES')).toEqual([
          {
            severity: 'error',
            code: 'OUTPUT_MULTIPLE_WRITES',
            message:
              'Replace original: Render\u2019s output Done has 2 steps that write the result; only one of them can be on an output',
            nodeId: 'ro',
            edgeId: 'in-ro',
          },
          expect.objectContaining({
            code: 'OUTPUT_MULTIPLE_WRITES',
            nodeId: 'mc',
            edgeId: 'in-mc',
          }),
        ]);
        const two = validateWorkflow(writes(node('ro2', 'core:replace-original')), ctx());
        expect(find(two, 'OUTPUT_MULTIPLE_WRITES').map((i) => i.nodeId)).toEqual(['ro', 'ro2']);
        // a bypassed one does not write
        const bypassed = writes(node('ro2', 'core:replace-original', {}, { bypassed: true }));
        expect(find(validateWorkflow(bypassed, ctx()), 'OUTPUT_MULTIPLE_WRITES')).toEqual([]);
      });
    });

    it('FINISH_ORDER: an action after a finish node', () => {
      const g = chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('sg', 'core:size-gate'),
        node('ro', 'core:replace-original'),
        node('kl', 'core:keep-languages'),
      );
      expect(validateWorkflow(g, ctx())).toEqual([
        {
          severity: 'error',
          code: 'FINISH_ORDER',
          message: 'Keep languages comes after a finish node; only finish nodes may follow one',
          nodeId: 'kl',
        },
      ]);
      // finish after finish is fine (notify after replace)
      const notify = chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('ro', 'core:replace-original'),
        node('nw', 'core:notify-webhook', { url: 'https://example.test/hook' }),
      );
      expect(validateWorkflow(notify, ctx())).toEqual([]);
    });

    describe('size gate else', () => {
      const ELSE_TEXT =
        'After the size gate\u2019s \u201cNo\u201d, only notifications and other non-writing finish steps can follow.';
      const notify = () => node('nw', 'core:notify-webhook', { url: 'https://example.test/hook' });
      /** in → sg; sg.pass → ro; sg.else → `after`. */
      const gate = (after: ReturnType<typeof node>[], elseEdges: ReturnType<typeof edge>[]) =>
        mainGraph(
          [
            node('in', 'core:input-manual'),
            node('sg', 'core:size-gate'),
            node('ro', 'core:replace-original'),
            ...after,
          ],
          [edge('in', 'sg'), edge('sg', 'ro', { from: 'pass' }), ...elseEdges],
        );
      const elseTo = (id: string) => edge('sg', id, { from: 'else' });
      const phaseOf = (phase: FinishPhase) =>
        defineNode({
          type: `test:else-${phase}`,
          version: 1,
          kind: 'finish',
          finishPhase: phase,
          title: `Else ${phase}`,
          description: 'd',
          icon: 'x',
          inputs: [filePort],
          outputs: [filePort],
          settings: z.object({}),
        });
      const phaseCtx = () => ctx({ registry: testRegistry(...FINISH_PHASES.map(phaseOf)) });

      it('else → notify is valid, and so is an unconnected else', () => {
        expect(validateWorkflow(gate([notify()], [elseTo('nw')]), ctx())).toEqual([]);
        expect(validateWorkflow(gate([], []), ctx())).toEqual([]);
      });

      it('else → replace-original and else → move-copy are errors with the exact text', () => {
        expect(
          validateWorkflow(gate([node('rb', 'core:replace-original')], [elseTo('rb')]), ctx()),
        ).toEqual([
          { severity: 'error', code: 'ELSE_ONLY_NOTIFY', message: ELSE_TEXT, nodeId: 'rb' },
        ]);
        const mc = node('mc', 'core:move-copy', { mode: 'copy', outputRoot: '/out' });
        expect(validateWorkflow(gate([mc], [elseTo('mc')]), ctx())).toEqual([
          { severity: 'error', code: 'ELSE_ONLY_NOTIFY', message: ELSE_TEXT, nodeId: 'mc' },
        ]);
      });

      it('later nodes of the else chain are checked too; a second size gate is refused', () => {
        const g = gate(
          [notify(), node('rb', 'core:replace-original')],
          [elseTo('nw'), edge('nw', 'rb')],
        );
        expect(find(validateWorkflow(g, ctx()), 'ELSE_ONLY_NOTIFY').map((i) => i.nodeId)).toEqual([
          'rb',
        ]);
        const two = gate([node('sg2', 'core:size-gate')], [elseTo('sg2')]);
        expect(find(validateWorkflow(two, ctx()), 'ELSE_ONLY_NOTIFY').map((i) => i.nodeId)).toEqual(
          ['sg2'],
        );
      });

      it('an action after else is FINISH_ORDER as after any finish node; the else path needs no write', () => {
        const g = gate([node('kl', 'core:keep-languages')], [elseTo('kl')]);
        // the else path ends without a write, and that is not a NO_WRITE_PATH warning
        expect(codes(validateWorkflow(g, ctx()))).toEqual(['error:FINISH_ORDER']);
        expect(validateWorkflow(gate([notify()], [elseTo('nw')]), ctx())).toEqual([]);
      });

      it.each(FINISH_PHASES)('else → a plugin finish step in phase %s', (phase) => {
        const g = gate([node('p', `test:else-${phase}`)], [elseTo('p')]);
        const found = find(validateWorkflow(g, phaseCtx()), 'ELSE_ONLY_NOTIFY');
        if (phase === 'render' || phase === 'gate' || phase === 'write')
          expect(found.map((i) => i.nodeId)).toEqual(['p']);
        else expect(found).toEqual([]);
      });

      it('a bypassed write after else runs nothing, so it is not an error', () => {
        const g = gate(
          [node('rb', 'core:replace-original', {}, { bypassed: true })],
          [elseTo('rb')],
        );
        expect(find(validateWorkflow(g, ctx()), 'ELSE_ONLY_NOTIFY')).toEqual([]);
      });

      it('a pass chain still warns when it never writes; only else is exempt', () => {
        const g = mainGraph(
          [node('in', 'core:input-manual'), node('sg', 'core:size-gate'), notify()],
          [edge('in', 'sg'), edge('sg', 'nw', { from: 'pass' })],
        );
        expect(validateWorkflow(g, ctx()).map((i) => [i.code, i.nodeId])).toEqual([
          ['NO_WRITE_PATH', 'nw'],
        ]);
      });
    });

    describe('finish phases', () => {
      const phaseNode = (phase: FinishPhase) =>
        defineNode({
          type: `test:phase-${phase}`,
          version: 1,
          kind: 'finish',
          finishPhase: phase,
          title: `Phase ${phase}`,
          description: 'd',
          icon: 'x',
          inputs: [filePort],
          outputs: [filePort],
          settings: z.object({}),
        });
      const phaseCtx = () => ctx({ registry: testRegistry(...FINISH_PHASES.map(phaseNode)) });
      const pairs = FINISH_PHASES.flatMap((a) => FINISH_PHASES.map((b) => [a, b] as const));

      it.each(pairs)('%s then %s', (first, second) => {
        const g = chain(
          'workflow',
          node('in', 'core:input-manual'),
          node('a', `test:phase-${first}`),
          node('b', `test:phase-${second}`),
        );
        const issues = find(validateWorkflow(g, phaseCtx()), 'FINISH_ORDER');
        if (finishPhaseRank(second) >= finishPhaseRank(first)) {
          expect(issues).toEqual([]);
        } else {
          expect(issues).toEqual([
            {
              severity: 'error',
              code: 'FINISH_ORDER',
              message: `Phase ${second} (${second}) comes after Phase ${first} (${first}); finish nodes run render → gate → write → library manager → media server → notify`,
              nodeId: 'b',
            },
          ]);
        }
      });

      it('a bypassed finish node sets no phase', () => {
        const bypassedNotify = { ...node('a', 'test:phase-notify'), bypassed: true };
        const g = chain(
          'workflow',
          node('in', 'core:input-manual'),
          bypassedNotify,
          node('b', 'test:phase-gate'),
        );
        expect(find(validateWorkflow(g, phaseCtx()), 'FINISH_ORDER')).toEqual([]);
      });
    });

    it('NO_WRITE_PATH warning on a path that ends without replace or move', () => {
      const g = branching(
        [
          node('sg', 'core:size-gate'),
          node('ro', 'core:replace-original'),
          node('kl', 'core:keep-languages'),
        ],
        [
          edge('vi', 'sg', { from: 'pass' }),
          edge('sg', 'ro', { from: 'pass' }),
          edge('vi', 'kl', { from: 'else' }),
        ],
      );
      expect(validateWorkflow(g, ctx())).toEqual([
        {
          severity: 'warning',
          code: 'NO_WRITE_PATH',
          message: 'this path never writes the result',
          nodeId: 'kl',
        },
      ]);
      // a bypassed replace does not write either
      const bypassed = chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('ro', 'core:replace-original', {}, { bypassed: true }),
      );
      expect(validateWorkflow(bypassed, ctx()).map((i) => [i.code, i.nodeId])).toEqual([
        ['NO_WRITE_PATH', 'ro'],
      ]);
    });

    it('NO_WRITE_PATH is port-aware: a condition with only else connected warns on pass; a diamond is walked once per (node, flags)', () => {
      const g = branching(
        [node('sg', 'core:size-gate'), node('ro', 'core:replace-original')],
        [edge('vi', 'sg', { from: 'else' }), edge('sg', 'ro', { from: 'pass' })],
      );
      expect(validateWorkflow(g, ctx())).toEqual([
        {
          severity: 'warning',
          code: 'NO_WRITE_PATH',
          message: 'this path never writes the result (output "Yes" is unconnected)',
          nodeId: 'vi',
        },
      ]);

      // in → kl → {a0, a1, a2} → (a Render each) → sg → ro: sg and ro are expanded once, not
      // three times
      const wide = ['a0', 'a1', 'a2'];
      const diamond = mainGraph(
        [
          node('in', 'core:input-manual'),
          node('kl', 'core:keep-languages'),
          ...wide.map((id) => node(id, 'core:keep-languages')),
          node('sg', 'core:size-gate'),
          node('ro', 'core:replace-original'),
        ],
        [
          edge('in', 'kl'),
          ...wide.flatMap((id) => [edge('kl', id), edge(id, 'sg')]),
          edge('sg', 'ro', { from: 'pass' }),
        ],
      );
      expect(walkPathRules(diamond, ctx())).toEqual({ issues: [], visits: 10 });

      // 20 stacked 3-wide diamonds: 3^20 paths, but every node is expanded once
      const nodes = [node('in', 'core:input-manual'), node('h0', 'core:keep-languages')];
      const edges = [edge('in', 'h0')];
      for (let level = 0; level < 20; level++) {
        nodes.push(node(`h${level + 1}`, 'core:keep-languages'));
        for (const w of wide) {
          const id = `l${level}${w}`;
          nodes.push(node(id, 'core:keep-languages'));
          edges.push(edge(`h${level}`, id), edge(id, `h${level + 1}`));
        }
      }
      nodes.push(node('ro', 'core:replace-original'));
      edges.push(edge('h20', 'ro'));
      const stacked = mainGraph(nodes, edges);
      expect(walkPathRules(stacked, ctx())).toEqual({
        issues: [],
        visits: stacked.nodes.length,
      });
    });
  });

  describe('Render', () => {
    const notifyNode = (id = 'nw') =>
      node(id, 'core:notify-webhook', { url: 'https://example.test/hook' });
    const replaceDamaged = defineNode({
      type: 'test:replace-damaged',
      version: 1,
      kind: 'finish',
      finishPhase: 'library-manager',
      damagedOnly: true,
      title: 'Replace damaged file',
      description: 'd',
      icon: 'x',
      inputs: [filePort],
      outputs: [filePort],
      settings: z.object({}),
    });
    const damagedCtx = () => ctx({ registry: testRegistry(replaceDamaged) });
    /** in → enc → r (Render) → ro; r.damaged → `after` by `damagedEdges`. */
    const rendered = (
      qualityCheck: boolean,
      after: ReturnType<typeof node>[] = [],
      damagedEdges: ReturnType<typeof edge>[] = [],
    ) =>
      bareGraph(
        [
          node('in', 'core:input-manual'),
          node('kl', 'core:keep-languages'),
          node('r', 'core:render', { qualityCheck }),
          node('ro', 'core:replace-original'),
          ...after,
        ],
        [edge('in', 'kl'), edge('kl', 'r'), edge('r', 'ro', { from: 'done' }), ...damagedEdges],
      );
    const damagedTo = (id: string) => edge('r', id, { from: 'damaged' });

    it('a path to a finish node without Render → RENDER_MISSING on the finish node; with Render → clean', () => {
      const bare = bareGraph(
        [
          node('in', 'core:input-manual'),
          node('kl', 'core:keep-languages'),
          node('ro', 'core:replace-original'),
        ],
        [edge('in', 'kl'), edge('kl', 'ro')],
      );
      expect(validateWorkflow(bare, ctx())).toEqual([
        {
          severity: 'error',
          code: 'RENDER_MISSING',
          message:
            'Put a Render step before Replace original: every path that reaches a finish step renders once',
          nodeId: 'ro',
        },
      ]);
      expect(validateWorkflow(rendered(false), ctx())).toEqual([]);
      expect(validateWorkflow(rendered(true), ctx())).toEqual([]);
    });

    it('two Renders in a row → RENDER_TWICE; Render on an output shared with Replace original → RENDER_SHARED_OUTPUT', () => {
      const twice = bareGraph(
        [
          node('in', 'core:input-manual'),
          node('r1', 'core:render'),
          node('r2', 'core:render', {}, { label: 'Second render' }),
          node('ro', 'core:replace-original'),
        ],
        [edge('in', 'r1'), edge('r1', 'r2', { from: 'done' }), edge('r2', 'ro', { from: 'done' })],
      );
      expect(validateWorkflow(twice, ctx())).toEqual([
        {
          severity: 'error',
          code: 'RENDER_TWICE',
          message: 'Second render comes after another Render; a path renders once',
          nodeId: 'r2',
        },
      ]);
      const shared = bareGraph(
        [
          node('in', 'core:input-manual'),
          node('r', 'core:render'),
          node('ro', 'core:replace-original'),
          node('nw', 'core:notify-webhook', { url: 'https://example.test/hook' }),
        ],
        [edge('in', 'r'), edge('in', 'ro'), edge('r', 'nw', { from: 'done' })],
      );
      expect(find(validateWorkflow(shared, ctx()), 'RENDER_SHARED_OUTPUT')).toEqual([
        {
          severity: 'error',
          code: 'RENDER_SHARED_OUTPUT',
          message:
            'Render must be the only step on this output; put the other steps after Render\u2019s Done or Damaged',
          nodeId: 'r',
          edgeId: 'in-r',
        },
      ]);
    });

    it('a bypassed Render → RENDER_BYPASSED', () => {
      const g = rendered(false);
      const bypassed = {
        ...g,
        nodes: g.nodes.map((n) => (n.id === 'r' ? { ...n, bypassed: true } : n)),
      };
      expect(validateWorkflow(bypassed, ctx())).toEqual([
        {
          severity: 'error',
          code: 'RENDER_BYPASSED',
          message: 'Render can\u2019t be skipped: the file is rendered here',
          nodeId: 'r',
        },
      ]);
    });

    it('an edge from Damaged while Quality check is off → PORT_HIDDEN with the edge id; on → clean', () => {
      const off = rendered(false, [notifyNode()], [damagedTo('nw')]);
      const issues = validateWorkflow(off, ctx());
      expect(find(issues, 'PORT_HIDDEN')).toEqual([
        {
          severity: 'error',
          code: 'PORT_HIDDEN',
          message:
            'Render: output "Damaged" is only there while Quality check is on; remove the connection or turn Quality check on',
          edgeId: 'r-nw',
        },
      ]);
      // never followed: the notify behind it is unreachable, not a path of its own
      expect(codes(issues)).toEqual(['error:PORT_HIDDEN', 'warning:NODE_UNREACHABLE']);
      expect(validateWorkflow(rendered(true, [notifyNode()], [damagedTo('nw')]), ctx())).toEqual(
        [],
      );
    });

    it('after Damaged: replace-original → DAMAGED_ONLY_NOTIFY; notify-webhook → clean; NO_WRITE_PATH is not warned below Damaged', () => {
      const bad = rendered(true, [node('rb', 'core:replace-original')], [damagedTo('rb')]);
      expect(validateWorkflow(bad, ctx())).toEqual([
        {
          severity: 'error',
          code: 'DAMAGED_ONLY_NOTIFY',
          message:
            'After Render\u2019s Damaged, only notifications and other non-writing finish steps can follow.',
          nodeId: 'rb',
        },
      ]);
      const gate = rendered(true, [node('sg', 'core:size-gate')], [damagedTo('sg')]);
      expect(
        find(validateWorkflow(gate, ctx()), 'DAMAGED_ONLY_NOTIFY').map((i) => i.nodeId),
      ).toEqual(['sg']);
      // a chain of notifications on Damaged never writes, and needs not
      const chained = rendered(
        true,
        [notifyNode('n1'), notifyNode('n2')],
        [damagedTo('n1'), edge('n1', 'n2')],
      );
      expect(validateWorkflow(chained, ctx())).toEqual([]);
    });

    it('a damagedOnly finish node (test registry stub "test:replace-damaged", phase library-manager) on Done → DAMAGED_ONLY; on Damaged → clean; chained after a notify on Damaged → clean', () => {
      const onDone = bareGraph(
        [
          node('in', 'core:input-manual'),
          node('r', 'core:render'),
          node('ro', 'core:replace-original'),
          node('rd', 'test:replace-damaged'),
        ],
        [edge('in', 'r'), edge('r', 'ro', { from: 'done' }), edge('ro', 'rd')],
      );
      expect(validateWorkflow(onDone, damagedCtx())).toEqual([
        {
          severity: 'error',
          code: 'DAMAGED_ONLY',
          message: 'Replace damaged file can only follow a Damaged output',
          nodeId: 'rd',
        },
      ]);
      const onDamaged = rendered(true, [node('rd', 'test:replace-damaged')], [damagedTo('rd')]);
      expect(validateWorkflow(onDamaged, damagedCtx())).toEqual([]);
      const afterNotify = rendered(
        true,
        [
          node('n0', 'core:notify-webhook', { url: 'https://example.test/hook' }),
          node('rd', 'test:replace-damaged'),
        ],
        [damagedTo('n0'), edge('n0', 'rd')],
      );
      // still below Damaged (its order is FINISH_ORDER's business: notify runs after library-manager)
      expect(find(validateWorkflow(afterNotify, damagedCtx()), 'DAMAGED_ONLY')).toEqual([]);
    });

    it('Render in a sub-workflow → NODE_NOT_ALLOWED_HERE', () => {
      const sub = chain('subworkflow', node('r', 'core:render'));
      expect(
        find(validateWorkflow(sub, ctx()), 'NODE_NOT_ALLOWED_HERE').map((i) => i.nodeId),
      ).toEqual(['r']);
    });
  });

  describe('plugin availability', () => {
    const pluginNode = defineNode({
      type: 'example:check',
      version: 1,
      kind: 'action',
      title: 'Example check',
      description: 'd',
      icon: 'x',
      inputs: [filePort],
      outputs: [filePort],
      settings: z.object({ room: z.string() }),
    });
    const registry = (reason: string | null) =>
      createCoreRegistry([
        {
          def: pluginNode,
          source: { kind: 'plugin', name: 'example', version: '1.0.0' },
          unavailable: () => reason,
        },
      ]);

    it('PLUGIN_UNAVAILABLE (not NODE_UNAVAILABLE) when the plugin is down', () => {
      const g = mainWith(node('p', 'example:check', { room: 'a' }));
      expect(validateWorkflow(g, ctx({ registry: registry(null) }))).toEqual([]);
      expect(
        validateWorkflow(
          g,
          ctx({ registry: registry('plugin example is not running: exited with code 3') }),
        ),
      ).toEqual([
        {
          severity: 'error',
          code: 'PLUGIN_UNAVAILABLE',
          message: "Example check can't run: plugin example is not running: exited with code 3",
          nodeId: 'p',
        },
      ]);
    });

    it('still validates the settings of an unavailable plugin node', () => {
      const g = mainWith(node('p', 'example:check', {}));
      const issues = validateWorkflow(g, ctx({ registry: registry('plugin example is disabled') }));
      expect(codes(issues)).toEqual(['error:INVALID_SETTINGS', 'error:PLUGIN_UNAVAILABLE']);
    });
  });

  it('TARGET_UNSUPPORTED on encode-video hevc with targets [chrome]', () => {
    const issues = validateWorkflow(
      mainWith(node('ev', 'core:encode-video', { codec: 'hevc', targets: ['chrome'] })),
      ctx(),
    );
    expect(issues).toEqual([
      {
        severity: 'error',
        code: 'TARGET_UNSUPPORTED',
        message: 'Encode video: Chrome (desktop) cannot play hevc',
        nodeId: 'ev',
        settingPath: 'targets',
      },
    ]);
    expect(
      validateWorkflow(
        mainWith(node('ev', 'core:encode-video', { codec: 'h264', encoder: 'aac' })),
        ctx(),
      ).map((i) => i.code),
    ).not.toContain('TARGET_UNSUPPORTED');
    const audio = validateWorkflow(
      mainWith(node('ea', 'core:encode-audio', { codec: 'ac3', targets: ['chrome'] })),
      ctx(),
    );
    expect(find(audio, 'TARGET_UNSUPPORTED')).toEqual([
      expect.objectContaining({ nodeId: 'ea', settingPath: 'targets' }),
    ]);
  });

  it('ENCODER_UNAVAILABLE when the named encoder is missing; auto with no hevc encoder; none with libx265 present; none at all while ffmpeg is unavailable', () => {
    const named = mainWith(node('ev', 'core:encode-video', { encoder: 'hevc_nvenc' }));
    expect(validateWorkflow(named, ctx())).toEqual([
      {
        severity: 'error',
        code: 'ENCODER_UNAVAILABLE',
        message: 'Encode video: encoder hevc_nvenc is not available',
        nodeId: 'ev',
        settingPath: 'encoder',
      },
    ]);
    const auto = mainWith(node('ev', 'core:encode-video', { encoder: 'auto' }));
    expect(validateWorkflow(auto, ctx({ capabilities: { ...caps, encoders: ['aac'] } }))).toEqual([
      {
        severity: 'error',
        code: 'ENCODER_UNAVAILABLE',
        message: 'Encode video: no hevc encoder is available',
        nodeId: 'ev',
        settingPath: 'encoder',
      },
    ]);
    expect(validateWorkflow(auto, ctx())).toEqual([]);
    expect(validateWorkflow(mainWith(node('ev', 'core:encode-video')), ctx())).toEqual([]);
    const off = ctx({ capabilities: { available: false, path: 'ffmpeg', error: 'ENOENT' } });
    expect(validateWorkflow(named, off)).toEqual([]);
    expect(validateWorkflow(auto, off)).toEqual([]);
  });

  it('move-copy is unavailable without output roots and its outputRoot must be configured', () => {
    const g = (outputRoot: string) =>
      chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('mc', 'core:move-copy', { outputRoot }),
      );
    expect(validateWorkflow(g('/out'), ctx({ outputRoots: [] }))).toEqual([
      {
        severity: 'error',
        code: 'NODE_UNAVAILABLE',
        message:
          'Move or copy is unavailable here: no output roots configured (TRANSCODA_OUTPUT_ROOTS)',
        nodeId: 'mc',
      },
    ]);
    expect(validateWorkflow(g('/elsewhere'), ctx({ outputRoots: ['/out', '/media'] }))).toEqual([
      {
        severity: 'error',
        code: 'INVALID_SETTINGS',
        message: 'outputRoot must be one of the configured output roots',
        nodeId: 'mc',
        settingPath: 'outputRoot',
      },
    ]);
    expect(validateWorkflow(g('/media'), ctx({ outputRoots: ['/out', '/media'] }))).toEqual([]);
    // Compared resolved, as the pipeline does (final review M7): trailing slashes and `..` match.
    expect(validateWorkflow(g('/media/'), ctx({ outputRoots: ['/out', '/media'] }))).toEqual([]);
    expect(validateWorkflow(g('/media'), ctx({ outputRoots: ['/out/', '/media/'] }))).toEqual([]);
    expect(validateWorkflow(g('/out/x/..'), ctx({ outputRoots: ['/out'] }))).toEqual([]);
  });

  it('a bypassed node is not refused for its targets or a missing encoder (final review M5)', () => {
    const bypassed = (settings: { [key: string]: JsonValue }) =>
      mainWith(node('ev', 'core:encode-video', settings, { bypassed: true }));
    const codes = (settings: { [key: string]: JsonValue }) =>
      validateWorkflow(bypassed(settings), ctx()).map((i) => i.code);
    expect(codes({ codec: 'hevc', targets: ['chrome'] })).not.toContain('TARGET_UNSUPPORTED');
    expect(codes({ encoder: 'hevc_nvenc' })).not.toContain('ENCODER_UNAVAILABLE');
  });
});

describe('plugin nodes pinned to an older node version', () => {
  const pluginCtx = (registry: NodeRegistry) => ctx({ registry });
  const reg = () => registryWithPlugin(remoteA(3, PLUGIN_LINKS));
  const withA = (typeVersion: number, settings: JsonValue = { old: 'a' }) =>
    mainWith(node('p', 'x:a', settings, { typeVersion }));

  it('a node at an older version with a safe-only path validates with no issue; its settings are not parsed by core', () => {
    // `{ old: 'a' }` would fail the v3 schema (`value` is required): the host validates after migrating.
    const safe = () => registryWithPlugin(remoteA(2, PLUGIN_LINKS.slice(0, 1)));
    expect(validateWorkflow(withA(1), pluginCtx(safe()))).toEqual([]);
    // At the current version core still checks the settings.
    expect(codes(validateWorkflow(withA(3), pluginCtx(reg())))).toEqual(['error:INVALID_SETTINGS']);
  });

  it('a path with a behaviour step is NODE_OUTDATED with the review text, never run unreviewed', () => {
    for (const v of [1, 2]) {
      const issues = validateWorkflow(withA(v), pluginCtx(reg()));
      expect(codes(issues)).toEqual(['error:NODE_OUTDATED']);
      expect(issues[0]?.message).toBe(
        'plugin update changes behaviour of A; review and activate a new version',
      );
    }
  });

  it('a node whose version the plugin no longer serves is NODE_OUTDATED, "no upgrade path"', () => {
    const issues = validateWorkflow(withA(0), pluginCtx(reg()));
    expect(codes(issues)).toEqual(['error:NODE_OUTDATED']);
    expect(issues[0]?.message).toBe(
      'A is at version 0; plugin x no longer serves it (no upgrade path)',
    );
    const dropped = registryWithPlugin(remoteA(4, [{ from: 2, to: 4, risk: 'safe', note: 'n' }]));
    expect(validateWorkflow(withA(1), pluginCtx(dropped))[0]?.message).toContain(
      'no longer serves',
    );
  });

  it('migratePinned leaves plugin nodes as stored: held with the review text for a behaviour step, not held for a safe-only path', () => {
    const r = migratePinned(withA(1), reg());
    expect(r.held).toEqual([
      expect.objectContaining({
        nodeId: 'p',
        message: 'plugin update changes behaviour of A; review and activate a new version',
      }),
    ]);
    expect(r.graph.nodes.find((n) => n.id === 'p')).toMatchObject({
      typeVersion: 1,
      settings: { old: 'a' },
    });
    const safe = migratePinned(withA(1), registryWithPlugin(remoteA(2, PLUGIN_LINKS.slice(0, 1))));
    expect(safe.held).toEqual([]);
  });
});

describe('LIBRARY_MISSING', () => {
  const withLibrary = (libraryId: JsonValue): WorkflowGraph =>
    chain(
      'workflow',
      node('in', 'core:input-library', { libraryId }),
      node('ro', 'core:replace-original'),
    );
  const exists = (id: string) => id === 'lib1';

  it('warns once on a Library input naming no live library', () => {
    const issues = validateWorkflow(withLibrary('gone'), { ...ctx(), libraryExists: exists });
    expect(find(issues, 'LIBRARY_MISSING')).toEqual([
      {
        severity: 'warning',
        code: 'LIBRARY_MISSING',
        message: 'Library input: no library with this id',
        nodeId: 'in',
        settingPath: 'libraryId',
      },
    ]);
  });

  it('says nothing for a live library or without the lookup', () => {
    expect(
      find(
        validateWorkflow(withLibrary('lib1'), { ...ctx(), libraryExists: exists }),
        'LIBRARY_MISSING',
      ),
    ).toEqual([]);
    expect(find(validateWorkflow(withLibrary('gone'), ctx()), 'LIBRARY_MISSING')).toEqual([]);
  });

  it('leaves an empty id to INVALID_SETTINGS', () => {
    const issues = validateWorkflow(withLibrary(''), { ...ctx(), libraryExists: exists });
    expect(find(issues, 'LIBRARY_MISSING')).toEqual([]);
    expect(find(issues, 'INVALID_SETTINGS').map((i) => [i.severity, i.nodeId])).toEqual([
      ['error', 'in'],
    ]);
  });
});
