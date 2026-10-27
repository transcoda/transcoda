import type { Issue, IssueCode } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { chainMainReplace } from '../../test/fixtures/graphs.ts';
import {
  countIssues,
  edgeStateFor,
  edgesIntoBroken,
  firstError,
  graphIssues,
  missingPluginOf,
  type NodeState,
  nodeStateFor,
  stateTypeFor,
} from './issues.ts';

function on(code: string, extra: Partial<Issue> = {}): Issue {
  return {
    severity: 'error',
    code: code as IssueCode,
    message: 'x',
    nodeId: 'n',
    ...extra,
  };
}

describe('missingPluginOf', () => {
  it('names the plugin of a namespaced type; null for core and un-namespaced types', () => {
    const cases: Array<[string, string | null]> = [
      ['jellyfin:refresh', 'jellyfin'],
      ['acme:frobnicate', 'acme'],
      ['test:unavailable', 'test'],
      ['core:remux', null],
      ['core:gone', null],
      ['frobnicate', null],
      ['', null],
      [':nameless', null],
    ];
    for (const [type, plugin] of cases) expect(missingPluginOf(type), type).toBe(plugin);
  });
});

describe('stateTypeFor', () => {
  const catalog = { nodes: [{ type: 'core:remux' }, { type: 'acme:other' }] };
  it('passes the type only when no catalogue node shares its plugin namespace', () => {
    expect(stateTypeFor('acme:x', catalog)).toBeUndefined();
    expect(stateTypeFor('jellyfin:refresh', catalog)).toBe('jellyfin:refresh');
    expect(stateTypeFor('core:gone', catalog)).toBe('core:gone');
    expect(stateTypeFor('acme:x', null)).toBe('acme:x');
  });
});

describe('nodeStateFor with the node type (N6, question 2)', () => {
  it('a plugin node whose plugin is not installed reads "plugin missing"', () => {
    expect(nodeStateFor('n', [on('UNKNOWN_NODE_TYPE')], 'acme:frobnicate')).toMatchObject({
      badge: 'plugin-missing',
      word: 'plugin missing',
      border: 'red',
    });
  });

  it('a core or un-namespaced type, or no type, stays "unknown node"', () => {
    for (const type of ['core:gone', 'frobnicate', undefined]) {
      expect(nodeStateFor('n', [on('UNKNOWN_NODE_TYPE')], type), String(type)).toMatchObject({
        badge: 'unknown-node',
        word: 'unknown node',
        border: 'red',
      });
    }
  });

  it('a node needing a newer version reads "needs a newer version"; the badge follows the type', () => {
    expect(nodeStateFor('n', [on('UNKNOWN_NODE_VERSION')], 'acme:frobnicate')).toMatchObject({
      badge: 'plugin-missing',
      word: 'needs a newer version',
      border: 'red',
    });
    expect(nodeStateFor('n', [on('UNKNOWN_NODE_VERSION')], 'core:remux')).toMatchObject({
      badge: 'unknown-node',
      word: 'needs a newer version',
      border: 'red',
    });
  });
});

describe('nodeStateFor', () => {
  it('maps the known codes to badge, word and border per the spec table', () => {
    const cases: Array<[Issue, Partial<NodeState>]> = [
      [
        on('UNKNOWN_NODE_TYPE'),
        { badge: 'unknown-node', word: 'unknown node', border: 'red', dim: null },
      ],
      [
        on('UNKNOWN_NODE_VERSION'),
        { badge: 'unknown-node', word: 'needs a newer version', border: 'red' },
      ],
      [
        on('PLUGIN_UNAVAILABLE'),
        { badge: 'plugin-stopped', word: 'plugin not running', border: 'red' },
      ],
      [
        on('NODE_UNAVAILABLE'),
        { badge: 'unavailable', word: 'not on this server', border: 'dashed', dim: 0.6 },
      ],
      [
        on('ENCODER_UNAVAILABLE'),
        { badge: 'unavailable', word: 'not on this server', border: 'dashed', dim: 0.6 },
      ],
      [
        on('INVALID_SETTINGS', { message: 'Needs a setting', settingPath: 'languages' }),
        { badge: 'needs-setting', word: 'needs a setting', border: 'amber' },
      ],
      [
        on('INVALID_SETTINGS', { message: 'Too small: expected number to be >=1' }),
        { badge: 'check-settings', word: 'check settings', border: 'amber' },
      ],
      [
        on('INVALID_OVERRIDE'),
        { badge: 'check-settings', word: 'check settings', border: 'amber' },
      ],
      [
        on('TARGET_UNSUPPORTED'),
        { badge: 'check-settings', word: 'check settings', border: 'amber' },
      ],
      [
        on('SUBWORKFLOW_MISSING'),
        { badge: 'subworkflow-problem', word: 'sub-workflow problem', border: 'red' },
      ],
      [
        on('SUBWORKFLOW_REFERENCE_CYCLE'),
        { badge: 'subworkflow-problem', word: 'sub-workflow problem', border: 'red' },
      ],
      [
        on('SUBWORKFLOW_BROKEN'),
        { badge: 'subworkflow-problem', word: 'sub-workflow problem', border: 'red' },
      ],
      [
        on('INPUT_UNCONNECTED'),
        { badge: 'needs-connection', word: 'needs a connection', border: 'amber' },
      ],
      [
        on('RENDER_MISSING'),
        { badge: 'needs-connection', word: 'needs a Render step', border: 'red' },
      ],
      [on('DAMAGED_ONLY'), { badge: 'not-allowed', word: 'not allowed here', border: 'red' }],
      [
        on('NODE_NOT_ALLOWED_HERE'),
        { badge: 'not-allowed', word: 'not allowed here', border: 'red' },
      ],
      [on('FINISH_ORDER'), { badge: 'not-allowed', word: 'not allowed here', border: 'red' }],
      [
        on('OUTPUT_MULTIPLE_EDGES'),
        { badge: 'not-allowed', word: 'not allowed here', border: 'red' },
      ],
      [
        on('OUTPUT_MULTIPLE_WRITES'),
        { badge: 'not-allowed', word: 'not allowed here', border: 'red' },
      ],
      [
        on('SIZE_GATE_SHARED_OUTPUT'),
        { badge: 'not-allowed', word: 'not allowed here', border: 'red' },
      ],
      [on('NODE_OUTDATED'), { badge: null, word: 'update pending', border: 'red' }],
      [
        on('NODE_OUTDATED', { severity: 'warning' }),
        { badge: null, word: null, border: null, dim: null },
      ],
      [
        on('SUBWORKFLOW_OUTDATED', { severity: 'warning' }),
        { badge: 'outdated-pin', word: null, border: null },
      ],
      [
        on('NODE_UNREACHABLE', { severity: 'warning' }),
        { badge: 'unreachable', word: 'not reachable', border: 'dashed', dim: 0.7 },
      ],
      [
        on('OVERRIDE_DROPPED', { severity: 'warning' }),
        { badge: null, word: null, border: null, dim: null },
      ],
      [
        on('NO_WRITE_PATH', { severity: 'warning' }),
        { badge: null, word: null, border: null, dim: null },
      ],
    ];
    for (const [issue, expected] of cases) {
      const state = nodeStateFor('n', [issue]);
      expect({ code: issue.code, ...state }).toMatchObject({ code: issue.code, ...expected });
      expect(state.issues).toEqual([issue]);
    }
  });

  it('an unreachable node reads "not reachable"; also unconnected, it reads "needs a connection" (one badge)', () => {
    const unreachable = on('NODE_UNREACHABLE', { severity: 'warning' });
    expect(nodeStateFor('n', [unreachable])).toMatchObject({
      badge: 'unreachable',
      word: 'not reachable',
      border: 'dashed',
      dim: 0.7,
    });
    expect(
      nodeStateFor('n', [unreachable, on('INPUT_UNCONNECTED', { severity: 'warning' })]),
    ).toMatchObject({
      badge: 'needs-connection',
      word: 'needs a connection',
      border: 'amber',
      dim: 0.7,
    });
    // Not on this server is an error at the same (dashed) level and wins.
    expect(nodeStateFor('n', [unreachable, on('NODE_UNAVAILABLE')])).toMatchObject({
      badge: 'unavailable',
      word: 'not on this server',
      dim: 0.6,
    });
  });

  it('renders an unknown code as a generic error or warning by severity', () => {
    expect(nodeStateFor('n', [on('FINISH_ORDER')]).word).toBe('not allowed here');
    expect(nodeStateFor('n', [on('SOMETHING_NEW', { severity: 'warning' })])).toMatchObject({
      badge: 'generic-warning',
      word: 'warning',
      border: 'amber',
    });
    expect(nodeStateFor('n', [on('SOMETHING_ELSE')])).toMatchObject({
      badge: 'generic-error',
      word: 'error',
      border: 'red',
    });
  });

  it('ignores issues on other nodes and is empty without issues', () => {
    expect(nodeStateFor('n', [on('UNKNOWN_NODE_TYPE', { nodeId: 'other' })])).toEqual({
      badge: null,
      word: null,
      border: null,
      dim: null,
      issues: [],
      fieldIssues: new Map(),
    });
  });

  it('prefers red over amber over dashed, and the first error in server order within a level', () => {
    const mixed = nodeStateFor('n', [
      on('NODE_UNAVAILABLE'),
      on('INPUT_UNCONNECTED'),
      on('SUBWORKFLOW_MISSING'),
      on('NODE_NOT_ALLOWED_HERE'),
      on('NODE_UNREACHABLE', { severity: 'warning' }),
    ]);
    expect(mixed).toMatchObject({
      badge: 'subworkflow-problem',
      word: 'sub-workflow problem',
      border: 'red',
      dim: 0.6,
    });
    expect(mixed.issues).toHaveLength(5);
    expect(
      nodeStateFor('n', [on('NODE_UNAVAILABLE'), on('INVALID_SETTINGS', { message: 'bad' })]),
    ).toMatchObject({ badge: 'check-settings', border: 'amber', dim: 0.6 });
    expect(
      nodeStateFor('n', [
        on('SOMETHING_NEW', { severity: 'warning' }),
        on('INVALID_SETTINGS', { message: 'Needs a setting' }),
      ]),
    ).toMatchObject({ badge: 'needs-setting', border: 'amber' });
  });

  it('an error NODE_OUTDATED with another issue keeps the red border and "update pending"', () => {
    const outdated = on('NODE_OUTDATED', { message: 'Keep languages 1 → 2 pending' });
    const needs = on('INVALID_SETTINGS', { message: 'Needs a setting', settingPath: 'languages' });
    const state = nodeStateFor('n', [
      needs,
      outdated,
      on('NODE_UNREACHABLE', { severity: 'warning' }),
    ]);
    expect(state).toMatchObject({ badge: null, word: 'update pending', border: 'red', dim: 0.7 });
    expect(state.fieldIssues.get('languages')).toEqual([needs]);
    // A red issue with a badge that comes first in server order wins over it.
    expect(nodeStateFor('n', [on('SUBWORKFLOW_MISSING'), outdated])).toMatchObject({
      badge: 'subworkflow-problem',
      word: 'sub-workflow problem',
      border: 'red',
    });
    // As a warning it draws nothing and leaves the other issue in charge.
    expect(nodeStateFor('n', [on('NODE_OUTDATED', { severity: 'warning' }), needs])).toMatchObject({
      badge: 'needs-setting',
      border: 'amber',
    });
  });

  it('fieldIssues groups INVALID_SETTINGS by settingPath', () => {
    const a = on('INVALID_SETTINGS', { message: 'Needs a setting', settingPath: 'languages' });
    const b = on('INVALID_SETTINGS', { message: 'Too long', settingPath: 'languages' });
    const c = on('INVALID_SETTINGS', { message: 'Too small', settingPath: 'crf' });
    const d = on('INVALID_OVERRIDE', { settingPath: 'overrides.keep.languages' });
    const e = on('INVALID_SETTINGS', { message: 'Expected object' });
    const state = nodeStateFor('n', [a, b, c, d, e]);
    expect([...state.fieldIssues.keys()]).toEqual(['languages', 'crf']);
    expect(state.fieldIssues.get('languages')).toEqual([a, b]);
    expect(state.fieldIssues.get('crf')).toEqual([c]);
  });

  it('SUBWORKFLOW_OUTDATED parses 3 from "Cleanup uses version 2; the latest is 3"', () => {
    const outdated = (message: string) =>
      nodeStateFor('n', [on('SUBWORKFLOW_OUTDATED', { severity: 'warning', message })]);
    expect(outdated('Cleanup uses version 2; the latest is 3').outdatedPinTo).toBe(3);
    expect(outdated('Cleanup uses an old version').outdatedPinTo).toBeUndefined();
    expect(outdated('Cleanup uses an old version')).toMatchObject({ badge: 'outdated-pin' });
  });
});

describe('edges and graph issues', () => {
  it('edgeStateFor marks edge issue codes as broken', () => {
    for (const code of [
      'UNKNOWN_PORT',
      'PORT_TYPE_MISMATCH',
      'DANGLING_EDGE',
      'INPUT_MULTIPLE_EDGES',
      'OUTPUT_MULTIPLE_EDGES',
      'OUTPUT_MULTIPLE_WRITES',
      'SIZE_GATE_SHARED_OUTPUT',
    ]) {
      const issue = on(code, { nodeId: undefined, edgeId: 'e' });
      expect(edgeStateFor('e', [issue])).toEqual({ broken: true, issues: [issue] });
      expect(edgeStateFor('f', [issue])).toEqual({ broken: false, issues: [] });
    }
    // A shared-output issue names both its node and the edge: the node gets the badge, the edge
    // is drawn broken.
    const both = on('OUTPUT_MULTIPLE_EDGES', { nodeId: 'n', edgeId: 'e' });
    expect(edgeStateFor('e', [both]).broken).toBe(true);
    expect(nodeStateFor('n', [both]).word).toBe('not allowed here');
    // Unknown codes on an edge are listed but never draw it broken, whatever the severity.
    for (const severity of ['warning', 'error'] as const) {
      const odd = on('SOMETHING_NEW', { nodeId: undefined, edgeId: 'e', severity });
      expect(edgeStateFor('e', [odd])).toEqual({ broken: false, issues: [odd] });
      expect(nodeStateFor('n', [odd]).issues).toEqual([]);
    }
  });

  it('edgesIntoBroken returns the edges whose target node has a red border', () => {
    const g = chainMainReplace();
    const issues = [
      on('UNKNOWN_NODE_TYPE', { nodeId: 'keep' }),
      on('INPUT_UNCONNECTED', { nodeId: 'ro' }),
    ];
    const states = new Map(g.nodes.map((n) => [n.id, nodeStateFor(n.id, issues)]));
    expect(edgesIntoBroken(g, states)).toEqual(new Set(['in-keep']));
    expect(edgeStateFor('in-keep', [], edgesIntoBroken(g, states))).toEqual({
      broken: true,
      issues: [],
    });
  });

  it('graphIssues, firstError and countIssues', () => {
    const warn = on('NODE_UNREACHABLE', { severity: 'warning' });
    const graphWide = on('TRIGGER_COUNT', { nodeId: undefined });
    const edge = on('DANGLING_EDGE', { nodeId: undefined, edgeId: 'e' });
    const nodeError = on('UNKNOWN_NODE_TYPE');
    const all = [warn, graphWide, edge, nodeError];
    expect(graphIssues(all)).toEqual([graphWide]);
    expect(firstError(all)).toBe(graphWide);
    expect(firstError([warn])).toBeNull();
    expect(countIssues(all)).toEqual({ errors: 3, warnings: 1 });
  });
});
