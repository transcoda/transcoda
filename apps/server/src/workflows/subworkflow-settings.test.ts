import {
  RUN_SUBWORKFLOW_TYPE,
  type RunSubworkflowSettings,
  type WorkflowGraph,
} from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import {
  applyOverrides,
  checkOverrides,
  dropStaleOverrides,
  subworkflowSettings,
} from './subworkflow-settings.ts';
import {
  bumpV2,
  chain,
  childGraph,
  mainGraph,
  node,
  testRegistry,
  withSetting,
} from './test-helpers.ts';

const reg = testRegistry();

describe('subworkflowSettings', () => {
  it('generates one entry per top-level setting with the child value as default', () => {
    const s = subworkflowSettings(childGraph(), reg);
    expect(s.map((x) => x.key)).toEqual(['kl.languages', 'kl.keepOriginal', 'kl.keepUntagged']);
    expect(s[0]).toMatchObject({
      nodeId: 'kl',
      nodeTitle: 'Keep EN/DE',
      settingKey: 'languages',
      default: ['en', 'de'],
      schema: { type: 'array' },
    });
    expect(s[1]?.default).toBe(true); // schema default (not set in the child)
  });

  it('a node with non-object settings falls back to schema defaults and does not throw', () => {
    const g = withSetting(childGraph(), 'kl', 5);
    expect(subworkflowSettings(g, reg).find((x) => x.key === 'kl.languages')?.default).toEqual([
      'en',
    ]);
  });

  it('a required setting without a schema default yields default null', () => {
    const g = chain('subworkflow', node('mc', 'core:move-copy', {}));
    expect(subworkflowSettings(g, reg).find((x) => x.key === 'mc.outputRoot')?.default).toBeNull();
  });

  it('skips start/end nodes and unknown node types', () => {
    const g = chain('subworkflow', node('x', 'nope:nothing', {}));
    expect(subworkflowSettings(g, reg)).toEqual([]);
  });
});

describe('nested Run nodes are not overridable', () => {
  const inner = node(
    'inner',
    RUN_SUBWORKFLOW_TYPE,
    { subworkflowId: 's2', version: 1, overrides: {} },
    { label: 'Inner' },
  );
  const withRun = chain('subworkflow', node('kl', 'core:keep-languages'), inner);
  const nested = { 'inner.version': 999, 'inner.subworkflowId': 'p', 'inner.overrides': {} };

  it('settings of a sub-workflow containing a Run node omit it', () => {
    expect(subworkflowSettings(withRun, reg).map((s) => s.nodeId)).not.toContain('inner');
    expect(subworkflowSettings(withRun, reg).map((s) => s.key)).toContain('kl.languages');
  });

  it('nested pin keys are unknown to checkOverrides, ignored by applyOverrides and dropped as stale', () => {
    expect(checkOverrides(nested, withRun, reg)).toEqual({
      unknownKeys: Object.keys(nested),
      invalid: [],
    });
    const applied = applyOverrides(withRun, nested, reg);
    expect(applied.nodes.find((n) => n.id === 'inner')?.settings).toEqual(inner.settings);
    const parent = mainGraph([
      node('run', RUN_SUBWORKFLOW_TYPE, { subworkflowId: 's1', version: 1, overrides: nested }),
    ]);
    const r = dropStaleOverrides(parent, () => withRun, reg);
    expect(r.dropped.map((d) => d.key)).toEqual(Object.keys(nested));
    const stored = r.graph.nodes[0]?.settings as RunSubworkflowSettings | undefined;
    expect(stored?.overrides).toEqual({});
  });
});

describe('overrides', () => {
  it('checkOverrides reports unknown keys and invalid values', () => {
    expect(
      checkOverrides(
        { 'kl.languages': ['fr'], 'kl.nope': 1, 'zz.languages': [] },
        childGraph(),
        reg,
      ),
    ).toEqual({ unknownKeys: ['kl.nope', 'zz.languages'], invalid: [] });
    expect(checkOverrides({ 'kl.languages': 'fr' }, childGraph(), reg).invalid).toEqual([
      { key: 'kl.languages', message: expect.any(String) },
    ]);
  });

  it('applyOverrides replaces the whole setting value and leaves the input untouched', () => {
    const before = childGraph();
    const g = applyOverrides(before, { 'kl.languages': ['fr'], 'kl.nope': 1 }, reg);
    expect(g.nodes.find((n) => n.id === 'kl')?.settings).toEqual({ languages: ['fr'] });
    expect(before.nodes.find((n) => n.id === 'kl')?.settings).toEqual({ languages: ['en', 'de'] });
  });

  it('applyOverrides uses the given registry for non-core node types', () => {
    const child = chain('subworkflow', node('b', 'test:bump', { level: 1 }, { typeVersion: 2 }));
    const overrides = { 'b.label': 'x', 'b.level': 3 };
    const bump = (g: WorkflowGraph) => g.nodes.find((n) => n.id === 'b')?.settings;
    expect(bump(applyOverrides(child, overrides, testRegistry(bumpV2())))).toEqual({
      level: 3,
      label: 'x',
    });
    expect(bump(applyOverrides(child, overrides, reg))).toEqual({ level: 1 }); // core only
  });

  it('dropStaleOverrides removes keys the pinned child no longer has', () => {
    const parent = mainGraph([
      node('run', RUN_SUBWORKFLOW_TYPE, {
        subworkflowId: 'c',
        version: 2,
        overrides: { 'kl.languages': ['fr'], 'old.x': 1 },
      }),
    ]);
    const r = dropStaleOverrides(parent, () => childGraph(), reg);
    expect(r.dropped).toEqual([{ nodeId: 'run', key: 'old.x' }]);
    const settings = r.graph.nodes[0]?.settings as RunSubworkflowSettings;
    expect(settings.overrides).toEqual({ 'kl.languages': ['fr'] });
    expect(dropStaleOverrides(parent, () => null, reg).dropped).toEqual([]); // unresolved child
  });

  it('dropStaleOverrides leaves a Run node with invalid settings unchanged', () => {
    const run = node('run', RUN_SUBWORKFLOW_TYPE, {
      subworkflowId: 'c',
      overrides: { 'old.x': 1 },
    });
    const r = dropStaleOverrides(mainGraph([run]), () => childGraph(), reg);
    expect(r.dropped).toEqual([]);
    expect(r.graph.nodes[0]).toBe(run);
  });
});
