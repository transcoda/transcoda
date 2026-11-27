import { type AnyNodeDefinition, defineNode } from '@transcoda/sdk';
import type { JsonValue } from '@transcoda/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { filePort } from '../nodes/core/common.ts';
import type { NodeRegistry, RegisteredNode } from '../nodes/registry.ts';
import { WorkflowService } from './service.ts';
import {
  bumpV1,
  bumpV2,
  chain,
  node,
  PLUGIN_LINKS,
  registryWithPlugin,
  remoteA,
  testRegistry,
} from './test-helpers.ts';
import {
  activate,
  caps,
  current,
  db,
  log,
  mainWith,
  make,
  makeSvc,
  NOW,
  run,
  save,
  setSvc,
  svc,
  USER,
  useServiceDb,
} from './testing.ts';

useServiceDb();

describe('WorkflowService', () => {
  it('M4: listNodes builds metadata once per registry', () => {
    let reads = 0;
    const base = bumpV1();
    const counting = {
      ...base,
      get settings() {
        reads++;
        return base.settings;
      },
    } as AnyNodeDefinition;
    const nodes = makeSvc([counting]);
    const first = nodes.listNodes();
    const afterFirst = reads;
    expect(afterFirst).toBeGreaterThan(0);
    expect(nodes.listNodes()).toEqual(first);
    expect(reads).toBe(afterFirst);
    // the cached metadata is shared, so it is frozen (and a copy of the definition's own arrays)
    const bump = first.find((n) => n.type === 'test:bump');
    expect(Object.isFrozen(bump?.inputs)).toBe(true);
    expect(Object.isFrozen(bump?.inputs[0])).toBe(true);
    expect(Object.isFrozen(bump?.settingsSchema)).toBe(true);
    expect(Object.isFrozen(base.inputs)).toBe(false);
  });

  it("listNodes carries each finish node's phase and null for the other kinds", () => {
    const nodes = makeSvc([bumpV1()]).listNodes();
    const phase = (type: string) => nodes.find((n) => n.type === type)?.finishPhase;
    expect(phase('core:replace-original')).toBe('write');
    expect(phase('core:size-gate')).toBe('gate');
    expect(phase('core:notify-webhook')).toBe('notify');
    expect(phase('core:encode-audio')).toBeNull();
    expect(phase('test:bump')).toBeNull();
  });

  it('listNodes marks encode-audio unavailable when ffmpeg lacks aac and reports source core', () => {
    const nodes = makeSvc([bumpV1()], { ...caps, encoders: [] }).listNodes();
    const audio = nodes.find((n) => n.type === 'core:encode-audio');
    expect(audio).toMatchObject({
      source: { kind: 'core' },
      availability: { available: false, reason: expect.stringContaining('encoder aac') },
    });
    expect(audio && Object.keys(audio).sort()).toEqual(
      [
        'availability',
        'damagedOnly',
        'description',
        'finishPhase',
        'icon',
        'inputs',
        'kind',
        'onNodeSettings',
        'outputs',
        'settingsSchema',
        'source',
        'title',
        'type',
        'version',
      ].sort(),
    );
    expect(svc.listNodes().find((n) => n.type === 'core:encode-audio')?.availability).toEqual({
      available: true,
    });
    expect(nodes.find((n) => n.type === 'test:bump')?.version).toBe(1);
  });
});

describe('plugin nodes [activation]', () => {
  const PLUGIN_TYPE = 'example:stamp';
  const stamp = defineNode({
    type: PLUGIN_TYPE,
    version: 1,
    kind: 'action',
    title: 'Stamp',
    description: 'A plugin node.',
    icon: 'plug',
    inputs: [filePort],
    outputs: [filePort],
    settings: z.object({}),
  });
  let down: string | null;
  let registry: NodeRegistry;
  let pluginSvc: WorkflowService;

  beforeEach(() => {
    down = null;
    registry = testRegistry(bumpV1());
    pluginSvc = new WorkflowService({
      db,
      registry,
      capabilities: () => caps,
      now: () => NOW,
      log,
    });
    setSvc(pluginSvc);
  });

  const entry = (): RegisteredNode => ({
    def: stamp,
    source: { kind: 'plugin', name: 'example', version: '1.0.0' },
    unavailable: () => down,
  });
  const withPlugin = () => mainWith(node('p', PLUGIN_TYPE));

  it('an active version whose plugin goes away is not runnable, with PLUGIN_UNAVAILABLE; activate and loadForRun refuse', () => {
    registry.add([entry()]);
    const id = make('Main', 'workflow', withPlugin());
    activate(id, 2);
    expect(svc.list().find((w) => w.id === id)?.active).toMatchObject({ runnable: true });
    expect(svc.get(id)?.activeIssues).toEqual([]);

    down = 'plugin example is not running: exited with code 3';
    const summaryNow = svc.list().find((w) => w.id === id);
    expect(summaryNow?.active).toMatchObject({ version: 2, runnable: false });
    const detail = svc.get(id);
    expect(detail?.activeIssues).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'PLUGIN_UNAVAILABLE',
        nodeId: 'p',
        message: expect.stringContaining('plugin example is not running: exited with code 3'),
      }),
    ]);
    expect(detail?.issues.map((i) => i.code)).toContain('PLUGIN_UNAVAILABLE');
    expect(svc.activate(id, 2, USER).kind).toBe('invalid');
    const loaded = svc.loadForRun(id, 2);
    expect(loaded.kind).toBe('invalid');
    expect(loaded.kind === 'invalid' && loaded.issues.map((i) => i.code)).toContain(
      'PLUGIN_UNAVAILABLE',
    );

    down = null;
    expect(svc.loadForRun(id, 2)).toMatchObject({ kind: 'ok', activeVersion: 2 });
  });

  it('a removed plugin makes the node unknown-type, never silently runnable', () => {
    registry.add([entry()]);
    const id = make('Main', 'workflow', withPlugin());
    activate(id, 2);
    registry.removeBySource('example');
    expect(svc.get(id)?.active).toMatchObject({ runnable: false });
    const loaded = svc.loadForRun(id, 2);
    expect(loaded.kind).toBe('invalid');
    expect(loaded.kind === 'invalid' && loaded.issues.map((i) => i.code)).toContain(
      'UNKNOWN_NODE_TYPE',
    );
  });

  it('listNodes follows the registry generation without a new service, and reports plugin availability', () => {
    const listSpy = vi.spyOn(registry, 'list');
    const before = svc.listNodes();
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(before.some((n) => n.type === PLUGIN_TYPE)).toBe(false);
    svc.listNodes();
    expect(listSpy).toHaveBeenCalledTimes(1); // same generation: metadata not rebuilt
    registry.add([entry()]);
    const added = svc.listNodes().find((n) => n.type === PLUGIN_TYPE);
    expect(added).toMatchObject({
      source: { kind: 'plugin', name: 'example', version: '1.0.0' },
      availability: { available: true },
    });
    down = 'plugin example is disabled';
    expect(svc.listNodes().find((n) => n.type === PLUGIN_TYPE)?.availability).toEqual({
      available: false,
      reason: 'plugin example is disabled',
    });
    expect(listSpy).toHaveBeenCalledTimes(2); // the add rebuilt it once
    registry.removeBySource('example');
    expect(svc.listNodes().some((n) => n.type === PLUGIN_TYPE)).toBe(false);
  });

  it('workflowsUsingNodeTypes: the active version counts even when the current one dropped the node', () => {
    registry.add([entry()]);
    const activeUse = make('B active', 'workflow', withPlugin(), mainWith());
    activate(activeUse, 2); // v2 has the node, v3 (current) does not
    const currentOnly = make('A current', 'workflow', withPlugin());
    const unrelated = make('C none', 'workflow', mainWith());
    const both = make('D both', 'workflow', withPlugin());
    activate(both, 2);
    expect(unrelated).toBeTruthy();
    expect(svc.workflowsUsingNodeTypes([PLUGIN_TYPE])).toEqual([
      { id: currentOnly, name: 'A current', active: false },
      { id: activeUse, name: 'B active', active: true },
      { id: both, name: 'D both', active: true },
    ]);
    expect(svc.workflowsUsingNodeTypes(['example:other'])).toEqual([]);
    svc.deactivate(both);
    expect(svc.workflowsUsingNodeTypes([PLUGIN_TYPE]).find((w) => w.id === both)).toMatchObject({
      active: false,
    });
  });

  it('workflowsUsingNodeTypes follows pinned Run nodes: the parent is listed, active through its active pin; cycles end', () => {
    registry.add([entry()]);
    const child = make('Child', 'subworkflow', chain('subworkflow', node('p', PLUGIN_TYPE)));
    const parent = make('Parent', 'workflow', mainWith(run('run', child, 2)));
    activate(parent, 2);
    // The child's current version drops the node; the pinned version 2 still has it.
    save(child, chain('subworkflow'));
    const listed = svc.workflowsUsingNodeTypes([PLUGIN_TYPE]);
    expect(listed.find((w) => w.id === parent)).toEqual({
      id: parent,
      name: 'Parent',
      active: true,
    });
    expect(listed.some((w) => w.id === child)).toBe(false); // its current version dropped the node
    // Re-pinning to the version without the node drops the parent (current) but not the active one.
    save(parent, mainWith(run('run', child, 3)));
    expect(svc.workflowsUsingNodeTypes([PLUGIN_TYPE]).find((w) => w.id === parent)).toMatchObject({
      active: true,
    });
    svc.deactivate(parent);
    expect(svc.workflowsUsingNodeTypes([PLUGIN_TYPE]).some((w) => w.id === parent)).toBe(false);
  });

  it('workflowsUsingNodeTypes terminates on a cycle of pins', () => {
    registry.add([entry()]);
    const a = make('A', 'subworkflow', chain('subworkflow'));
    const b = make('B', 'subworkflow', chain('subworkflow', run('r', a, 2)));
    // A's version 3 runs B (which runs A@2); a cycle by data: B v3 runs A@3.
    save(a, chain('subworkflow', run('r', b, 2)));
    save(b, chain('subworkflow', run('r', a, 3)));
    expect(svc.workflowsUsingNodeTypes([PLUGIN_TYPE])).toEqual([]);
  });
});

describe('plugin node upgrades', () => {
  const NODE_AT = (typeVersion: number) => node('p', 'x:a', { old: 'a' }, { typeVersion });
  const migrate = vi.fn<(t: string, from: number, s: JsonValue) => Promise<JsonValue>>();
  beforeEach(() => {
    migrate.mockReset();
    migrate.mockResolvedValue({ value: 'a' });
    setSvc(
      new WorkflowService({
        db,
        registry: registryWithPlugin(remoteA(3, PLUGIN_LINKS)),
        capabilities: () => caps,
        now: () => NOW,
        log,
      }),
    );
  });

  /** A service whose plugin serves node version `version` with these links. */
  const serving = (version: number, links: typeof PLUGIN_LINKS) => {
    setSvc(
      new WorkflowService({
        db,
        registry: registryWithPlugin(remoteA(version, links)),
        capabilities: () => caps,
        now: () => NOW,
        log,
      }),
    );
  };
  const SAFE = PLUGIN_LINKS.slice(0, 1);

  it('upgradePluginNodes appends a version with the note through the host and leaves active_version alone; the active version is held for review (behaviour step)', async () => {
    serving(2, SAFE);
    const id = make('Main', 'workflow', mainWith(NODE_AT(1)));
    activate(id, 2);
    serving(3, PLUGIN_LINKS); // the update: 2→3 changes behavior
    const summary = await svc.upgradePluginNodes(['x:a'], migrate);
    expect(summary).toEqual({ upgraded: 1, behaviour: 1, broken: 0, unchanged: 0 });
    expect(migrate).toHaveBeenCalledWith('x:a', 1, { old: 'a' });
    const detail = svc.get(id);
    expect(detail?.currentVersion).toBe(3);
    expect(detail?.active).toMatchObject({ version: 2, runnable: false });
    expect(detail?.activeIssues.map((i) => i.message)).toContain(
      'plugin update changes behavior of A; review and activate a new version',
    );
    expect(detail?.graph.nodes.find((n) => n.id === 'p')).toMatchObject({
      typeVersion: 3,
      settings: { value: 'a' },
    });
    const versions = svc.versions(id) ?? [];
    expect(versions[0]).toMatchObject({
      version: 3,
      note: 'Updated A 1→3 (value is now required)',
      createdBy: 'system:upgrade',
    });
  });

  it('upgradePluginNodes: a failing host or a node with no path counts as broken, leaves the workflow, and never throws', async () => {
    // The plugin serves 2→3 only: version 1 has no path.
    setSvc(
      new WorkflowService({
        db,
        registry: registryWithPlugin(remoteA(3, PLUGIN_LINKS.slice(1))),
        capabilities: () => caps,
        now: () => NOW,
        log,
      }),
    );
    const failing = make('Fails', 'workflow', mainWith(NODE_AT(2)));
    const noPath = make('NoPath', 'workflow', mainWith(NODE_AT(1)));
    const fine = make('Fine', 'workflow', mainWith(NODE_AT(3)));
    migrate.mockRejectedValueOnce(new Error('host down'));
    const summary = await svc.upgradePluginNodes(['x:a'], migrate);
    expect(summary).toMatchObject({ upgraded: 0, broken: 2, unchanged: 1 });
    expect([failing, noPath, fine].map(current)).toEqual([2, 2, 2]);
  });

  it('the no-path warning is logged once per workflow version per process, not on every sweep', async () => {
    serving(3, PLUGIN_LINKS.slice(1));
    make('NoPath', 'workflow', mainWith(NODE_AT(1)));
    await svc.upgradePluginNodes(['x:a'], migrate);
    await svc.upgradePluginNodes(['x:a'], migrate);
    const warned = log.warn.mock.calls.filter(
      (c) => (c[0] as { msg?: string }).msg === 'plugin node upgrade skipped: no migration path',
    );
    expect(warned).toHaveLength(1);
  });

  it('upgradePluginNodes ignores other types', async () => {
    const id = make('Main', 'workflow', mainWith(NODE_AT(1)));
    expect(await svc.upgradePluginNodes(['y:b'], migrate)).toMatchObject({ upgraded: 0 });
    expect(current(id)).toBe(2);
    expect(migrate).not.toHaveBeenCalled();
  });

  it('pinnedNodes returns the current and the active graph separately, the active one flagged', () => {
    serving(2, SAFE);
    const id = make('Main', 'workflow', mainWith(NODE_AT(1)));
    activate(id, 2);
    save(id, mainWith(NODE_AT(3)));
    const rows = svc.pinnedNodes(['x:a']);
    expect(rows).toEqual([
      {
        workflow: { id, name: 'Main' },
        active: true,
        version: 2,
        nodes: [{ type: 'x:a', typeVersion: 1 }],
      },
      {
        workflow: { id, name: 'Main' },
        active: false,
        version: 3,
        nodes: [{ type: 'x:a', typeVersion: 3 }],
      },
    ]);
    expect(svc.pinnedNodes(['y:b'])).toEqual([]);
  });

  it('pinnedNodes: one entry when the current version is the active one, and through a pinned Run node', () => {
    serving(2, SAFE);
    const child = make('Child', 'subworkflow', chain('subworkflow', NODE_AT(1)));
    const parent = make('Parent', 'workflow', mainWith(run('r', child, 2)));
    activate(parent, 2);
    expect(svc.pinnedNodes(['x:a'])).toEqual(
      expect.arrayContaining([
        {
          workflow: { id: parent, name: 'Parent' },
          active: true,
          version: 2,
          nodes: [{ type: 'x:a', typeVersion: 1 }],
        },
      ]),
    );
    expect(svc.pinnedNodes(['x:a']).filter((r) => r.workflow.id === parent)).toHaveLength(1);
  });

  it('an active version pinned to an older plugin node version with a safe-only path stays runnable (the host migrates at call time)', () => {
    serving(2, SAFE);
    const id = make('Main', 'workflow', mainWith(NODE_AT(1)));
    activate(id, 2);
    expect(svc.get(id)?.active).toMatchObject({ runnable: true });
    expect(svc.loadForRun(id, 2)).toMatchObject({ kind: 'ok', activeVersion: 2 });
  });

  it('a path with a behaviour step is held like a core node: NODE_OUTDATED with the review text, not runnable, loadForRun invalid, activation refused', () => {
    serving(2, SAFE);
    const id = make('Main', 'workflow', mainWith(NODE_AT(1)));
    activate(id, 2);
    serving(3, PLUGIN_LINKS);
    const text = 'plugin update changes behavior of A; review and activate a new version';
    expect(svc.get(id)?.active).toMatchObject({ version: 2, runnable: false });
    const loaded = svc.loadForRun(id, 2);
    expect(loaded.kind).toBe('invalid');
    expect(loaded.kind === 'invalid' && loaded.issues).toEqual([
      expect.objectContaining({ code: 'NODE_OUTDATED', nodeId: 'p', message: text }),
    ]);
    expect(svc.activate(id, 2, USER).kind).toBe('invalid');
  });

  it('after the plugin drops the node version: NODE_OUTDATED with "no upgrade path" and active.runnable false', () => {
    serving(2, SAFE);
    const id = make('Main', 'workflow', mainWith(NODE_AT(1)));
    activate(id, 2);
    setSvc(
      new WorkflowService({
        db,
        registry: registryWithPlugin(remoteA(4, [{ from: 2, to: 4, risk: 'safe', note: 'n' }])),
        capabilities: () => caps,
        now: () => NOW,
        log,
      }),
    );
    expect(svc.get(id)?.active).toMatchObject({ version: 2, runnable: false });
    const loaded = svc.loadForRun(id, 2);
    expect(loaded.kind).toBe('invalid');
    expect(loaded.kind === 'invalid' && loaded.issues).toEqual([
      expect.objectContaining({
        code: 'NODE_OUTDATED',
        nodeId: 'p',
        message: 'A is at version 1; plugin x no longer serves it (no upgrade path)',
      }),
    ]);
    expect(svc.activate(id, 2, USER).kind).toBe('invalid');
  });

  it('the startup sweep still upgrades core nodes in a graph that also holds a plugin node with a path', () => {
    const registry = registryWithPlugin(remoteA(3, PLUGIN_LINKS));
    registry.add([{ def: bumpV2(), source: { kind: 'core' } }]);
    setSvc(
      new WorkflowService({
        db,
        registry,
        capabilities: () => caps,
        now: () => NOW,
        log,
      }),
    );
    const id = make(
      'Mixed',
      'workflow',
      mainWith(NODE_AT(1), node('b', 'test:bump', { level: 2 }, { typeVersion: 1 })),
    );
    expect(svc.upgradeAll()).toMatchObject({ upgraded: 1, broken: 0 });
    const graph = svc.get(id)?.graph;
    expect(graph?.nodes.find((n) => n.id === 'b')).toMatchObject({ typeVersion: 2 });
    expect(graph?.nodes.find((n) => n.id === 'p')).toMatchObject({
      typeVersion: 1,
      settings: { old: 'a' },
    });
  });
});
