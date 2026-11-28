import { defineNode } from '@transcoda/sdk';
import { emptyGraph, type JsonValue } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  bumpNoPath,
  bumpThrowing,
  bumpV2,
  bumpV3,
  chain,
  childGraph,
  edge,
  node,
  subGraph,
  testRegistry,
} from '../testing.ts';
import { caps, codes, ctx, find, mainWith, runNode } from './testing.ts';
import {
  createValidationCache,
  type SubworkflowRef,
  type ValidationContext,
  validateWorkflow,
} from './validate.ts';

describe('validateWorkflow', () => {
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
});
