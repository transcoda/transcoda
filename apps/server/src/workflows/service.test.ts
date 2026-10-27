import type { Capabilities } from '@transcoda/contract';
import { type AnyNodeDefinition, defineNode } from '@transcoda/sdk';
import type { Issue, JsonValue, NodeInstance, WorkflowGraph } from '@transcoda/shared';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { z } from 'zod';
import type { Database } from '../db/open.ts';
import { insertLibrary, softDeleteLibrary } from '../db/repos/libraries.ts';
import { getSetting } from '../db/repos/settings.ts';
import { NotFoundError, VersionConflictError } from '../db/repos/workflows.ts';
import { createTestDb } from '../db/test-db.ts';
import type { Logger } from '../logger.ts';
import { filePort } from '../nodes/core/common.ts';
import type { NodeRegistry, RegisteredNode } from '../nodes/registry.ts';
import { CorruptGraphError, FORMAT_2_NOTE, KindMismatchError, WorkflowService } from './service.ts';
import {
  bumpNoPath,
  bumpThrowing,
  bumpV1,
  bumpV2,
  bumpV3,
  chain,
  childGraph,
  mainGraph,
  moveNodes,
  node,
  PLUGIN_LINKS,
  registryWithPlugin,
  remoteA,
  testRegistry,
  withSetting,
} from './test-helpers.ts';
import { NOTIFY_NODE } from './webhook-urls.ts';

const caps: Capabilities = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '7.1',
  encoders: ['aac'],
  hwaccels: [],
  filters: ['pan'],
};

const NOW = new Date('2026-10-16T20:00:00.000Z');
const USER = 'user-1';

let db: Database;
let log: { [K in keyof Logger]: Mock<Logger[K]> };
let svc: WorkflowService;

function makeSvc(defs: AnyNodeDefinition[], capabilities: Capabilities = caps): WorkflowService {
  return new WorkflowService({
    db,
    registry: testRegistry(...defs),
    capabilities: () => capabilities,
    now: () => NOW,
    log,
  });
}

/** A service over the same db with a different registry (a restart with bumped definitions). */
function svcWith(...defs: AnyNodeDefinition[]): WorkflowService {
  return makeSvc(defs);
}

beforeEach(() => {
  db = createTestDb();
  log = {
    info: vi.fn<Logger['info']>(),
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>(),
  };
  svc = svcWith(bumpV1());
});

const codes = (issues: Issue[]) => issues.map((i) => `${i.severity}:${i.code}`).sort();

/** in → <middle> → replace-original */
function mainWith(...middle: NodeInstance[]): WorkflowGraph {
  return chain(
    'workflow',
    node('in', 'core:input-manual'),
    ...middle,
    node('ro', 'core:replace-original'),
  );
}

function run(
  id: string,
  subworkflowId: string,
  version: number,
  overrides: Record<string, JsonValue> = {},
): NodeInstance {
  return node(id, 'core:run-subworkflow', { subworkflowId, version, overrides });
}

/** Creates a workflow and saves `graphs` in order; returns its id. */
function make(name: string, kind: 'workflow' | 'subworkflow', ...graphs: WorkflowGraph[]): string {
  const created = svc.create({ name, kind }, USER);
  let version = created.version;
  for (const graph of graphs) {
    version = svc.save({ id: created.id, baseVersion: version, graph }, USER).version;
  }
  return created.id;
}

function current(id: string): number {
  return svc.get(id)?.currentVersion ?? -1;
}

function save(id: string, graph: WorkflowGraph) {
  return svc.save({ id, baseVersion: current(id), graph }, USER);
}

/** Activates `version` (default: the current one); throws when the service refuses. */
function activate(id: string, version: number = current(id)): void {
  const r = svc.activate(id, version, USER);
  if (r.kind !== 'ok') throw new Error(`could not activate ${id}: ${JSON.stringify(r)}`);
}

const activeOf = (id: string) => svc.get(id)?.active ?? null;

function corrupt(id: string): void {
  db.prepare('UPDATE workflow_versions SET graph = ? WHERE workflow_id = ? AND version = ?').run(
    '{"formatVersion":1',
    id,
    current(id),
  );
}

function summary(id: string) {
  const s = svc.list().find((w) => w.id === id);
  if (!s) throw new Error(`no summary for ${id}`);
  return s;
}

/** A second migrating node type, so one workflow can upgrade while another fails. */
function otherDef(version: 1 | 2): AnyNodeDefinition {
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

describe('WorkflowService', () => {
  it('create → not active, version 1; main workflow has TRIGGER_COUNT, sub-workflow is valid with settings []', () => {
    const main = svc.create({ name: 'Main', kind: 'workflow' }, USER);
    expect(main).toMatchObject({ active: null, version: 1, currentVersion: 1, valid: false });
    expect(main.graph).toEqual({
      formatVersion: 2,
      kind: 'workflow',
      nodes: [],
      edges: [],
      groups: [],
    });
    expect(codes(main.issues)).toContain('error:TRIGGER_COUNT');
    expect(main.activeIssues).toEqual([]);
    expect(main.settings).toBeNull();

    const sub = svc.create({ name: 'Sub', kind: 'subworkflow' }, USER);
    expect(sub).toMatchObject({ active: null, version: 1, valid: true, errorCount: 0 });
    expect(sub.settings).toEqual([]);
    expect(sub.usedBy).toEqual([]);
    expect(svc.versions(sub.id)).toEqual([
      { version: 1, note: null, createdBy: USER, createdAt: NOW.toISOString() },
    ]);
    expect(svc.versions('nope')).toBeNull();
  });

  it('create stores a given graph as version 1 with the note; refuses a graph of the other kind', () => {
    const d = svc.create(
      { name: 'Sub', kind: 'subworkflow', graph: childGraph(), note: 'via MCP' },
      USER,
    );
    expect(d.version).toBe(1);
    expect(d.graph).toEqual(childGraph());
    expect(svc.versions(d.id)).toEqual([
      expect.objectContaining({ version: 1, note: 'via MCP', createdBy: USER }),
    ]);
    expect(() => svc.create({ name: 'W', kind: 'workflow', graph: childGraph() }, USER)).toThrow(
      KindMismatchError,
    );
    expect(svc.list().map((w) => w.name)).toEqual(['Sub']);
    const plain = svc.create({ name: 'P', kind: 'workflow', note: '' }, USER);
    expect(svc.versions(plain.id)?.[0]?.note).toBeNull();
  });

  it('duplicate copies the current version under the new name, same kind, without webhook URLs', () => {
    const src = svc.create(
      {
        name: 'Src',
        kind: 'workflow',
        graph: mainGraph([
          node('in', 'core:input-manual'),
          node('n', NOTIFY_NODE, { url: 'https://h/p?t=s3cret', method: 'POST' }),
        ]),
      },
      USER,
    );
    const r = svc.duplicate(src.id, 'Copy', 'u2', 'via MCP: copy');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.detail).toMatchObject({ name: 'Copy', kind: 'workflow', version: 1, active: null });
    expect(r.detail.id).not.toBe(src.id);
    expect(r.sourceVersion).toBe(1);
    expect(r.droppedNodeIds).toEqual(['n']);
    expect(JSON.stringify(r.detail.graph)).not.toContain('s3cret');
    expect(r.detail.issues.map((i) => i.code)).toContain('INVALID_SETTINGS');
    expect(svc.versions(r.detail.id)?.[0]).toMatchObject({
      note: 'via MCP: copy',
      createdBy: 'u2',
    });
    expect(svc.duplicate('nope', 'x', USER)).toEqual({ kind: 'not-found' });
  });

  it('duplicate of an active source → the copy is not active, the source stays active at its version', () => {
    const w = make('Src', 'workflow', mainWith());
    activate(w, 2);
    expect(svc.duplicate(w, 'Copy', USER)).toMatchObject({
      kind: 'ok',
      detail: { active: null },
    });
    expect(summary(w).active).toMatchObject({ version: 2, runnable: true });
  });

  it('duplicate of a corrupt current version throws CorruptGraphError', () => {
    const w = make('Src', 'workflow', mainWith());
    corrupt(w);
    expect(() => svc.duplicate(w, 'Copy', USER)).toThrow(CorruptGraphError);
  });

  it('save: stale baseVersion → VersionConflictError with currentVersion; good save returns version 2, issues, active null and no changes', () => {
    const id = svc.create({ name: 'Main', kind: 'workflow' }, USER).id;
    const out = svc.save(
      { id, baseVersion: 1, graph: mainWith(node('b', 'test:bump', { level: 2 })) },
      USER,
    );
    expect(out).toEqual({ version: 2, issues: [], valid: true, active: null, changes: [] });
    const invalid = svc.save({ id, baseVersion: 2, graph: mainWith(node('x', 'test:nope')) }, USER);
    expect(invalid).toMatchObject({ version: 3, valid: false });
    expect(codes(invalid.issues)).toContain('error:UNKNOWN_NODE_TYPE');

    let conflict: unknown;
    try {
      svc.save({ id, baseVersion: 1, graph: mainWith() }, USER);
    } catch (err) {
      conflict = err;
    }
    expect(conflict).toBeInstanceOf(VersionConflictError);
    expect((conflict as VersionConflictError).currentVersion).toBe(3);
    expect(current(id)).toBe(3);
    expect(() => svc.save({ id: 'nope', baseVersion: 1, graph: mainWith() }, USER)).toThrow(
      NotFoundError,
    );
  });

  it('save copies each shared value into the settings that follow it', () => {
    const id = svc.create({ name: 'Main', kind: 'workflow' }, USER).id;
    const graph = {
      ...mainWith(node('b', 'test:bump', { level: 1 }, { links: { level: 'Level' } })),
      values: {
        position: { x: 0, y: 0 },
        entries: [{ name: 'Level', schema: { type: 'number' }, value: 3 }],
      },
    };
    svc.save({ id, baseVersion: 1, graph }, USER);
    const stored = svc.get(id)?.graph;
    expect(stored?.nodes.find((n) => n.id === 'b')?.settings).toEqual({ level: 3 });
    expect(stored?.values?.entries[0]?.value).toBe(3);
  });

  it('save stores the note; versions() returns it; a save without note stores null', () => {
    const id = svc.create({ name: 'Main', kind: 'workflow' }, USER).id;
    svc.save({ id, baseVersion: 1, graph: mainWith(), note: 'Layout only' }, USER);
    svc.save({ id, baseVersion: 2, graph: mainWith() }, USER);
    expect(svc.versions(id)?.map((v) => [v.version, v.note])).toEqual([
      [3, null],
      [2, 'Layout only'],
      [1, null],
    ]);
  });

  it('save: changed subworkflowId → a change line; changed version with only moved nodes → none; changed version with changed child settings → a line; a new run node is not a pin change; the active version never moves', () => {
    // a: v2 child, v3 moved only, v4 changed settings; b: v2 child
    const a = make(
      'Sub A',
      'subworkflow',
      childGraph(),
      moveNodes(childGraph()),
      withSetting(moveNodes(childGraph()), 'kl', { languages: ['en'] }),
    );
    const b = make('Sub B', 'subworkflow', childGraph());
    const parent = make('Parent', 'workflow', mainWith(run('run', a, 2)));
    activate(parent);
    const activated = activeOf(parent);

    const moved = save(parent, mainWith(run('run', a, 3)));
    expect(moved.changes).toEqual([]);
    expect(moved.active).toEqual(activated);

    expect(save(parent, mainWith(run('run', a, 4))).changes).toEqual([
      'Updated sub-workflow Sub A 3→4',
    ]);

    const switched = save(parent, mainWith(run('run', b, 2)));
    expect(switched.changes).toEqual(['Switched sub-workflow Sub A 4→Sub B 2']);

    expect(save(parent, mainWith(run('run', b, 2), run('run2', a, 2))).changes).toEqual([]);

    expect(save(parent, mainWith(run('run', b, 2), run('run2', a, 4))).changes).toEqual([
      'Updated sub-workflow Sub A 2→4',
    ]);
    expect(activeOf(parent)).toEqual(activated);
  });

  it('save: a graph of the other kind → KindMismatchError, nothing stored', () => {
    const id = svc.create({ name: 'Main', kind: 'workflow' }, USER).id;
    expect(() => svc.save({ id, baseVersion: 1, graph: childGraph() }, USER)).toThrow(
      KindMismatchError,
    );
    expect(current(id)).toBe(1);
  });

  it('save over a corrupt base version → a change line, the active version unchanged', () => {
    const id = make('Main', 'workflow', mainWith(), mainWith());
    activate(id, 2);
    corrupt(id); // version 3
    const out = svc.save({ id, baseVersion: 3, graph: mainWith(node('b', 'test:bump')) }, USER);
    expect(out).toMatchObject({
      version: 4,
      valid: true,
      changes: ['Previous version 3 could not be read'],
      active: { version: 2, runnable: true },
    });
  });

  it('save drops stale override keys before storing and lists them in changes', () => {
    const a = make('Sub A', 'subworkflow', childGraph());
    const parent = make('Parent', 'workflow', mainWith(run('run', a, 2)));
    activate(parent);
    const out = save(
      parent,
      mainWith(run('run', a, 2, { 'kl.languages': ['en'], 'kl.nope': 1, 'zz.level': 2 })),
    );
    expect(out.changes).toHaveLength(1);
    expect(out.changes[0]).toContain('Dropped overrides that no longer exist');
    expect(out.changes[0]).toContain('kl.nope');
    expect(out.active).toMatchObject({ version: 2, runnable: true });
    expect(codes(out.issues)).not.toContain('warning:OVERRIDE_DROPPED');
    const stored = svc.get(parent)?.graph.nodes.find((n) => n.id === 'run');
    expect(stored?.settings).toEqual({
      subworkflowId: a,
      version: 2,
      overrides: { 'kl.languages': ['en'] },
    });
  });

  it('list: usedBy and usesOutdatedSubworkflow after the child is saved again; a corrupt current version lists as invalid with errorCount 1', () => {
    const a = make('Sub A', 'subworkflow', childGraph());
    const zed = make('Zed parent', 'workflow', mainWith(run('run', a, 2)));
    const parent = make('Parent', 'workflow', mainWith(run('run', a, 2), run('again', a, 2)));
    expect(summary(a).usedBy).toEqual([
      { id: parent, name: 'Parent' },
      { id: zed, name: 'Zed parent' },
    ]);
    expect(summary(parent)).toMatchObject({ usesOutdatedSubworkflow: false, usedBy: [] });

    save(a, moveNodes(childGraph()));
    expect(summary(parent).usesOutdatedSubworkflow).toBe(true);
    expect(svc.get(parent)?.usesOutdatedSubworkflow).toBe(true);
    expect(svc.get(a)?.usedBy).toHaveLength(2);

    const broken = make('Broken', 'workflow', mainWith(run('run', a, 3)));
    corrupt(broken);
    expect(summary(broken)).toMatchObject({
      valid: false,
      errorCount: 1,
      usesOutdatedSubworkflow: false,
      currentVersion: 2,
    });
    expect(summary(a).usedBy.map((r) => r.name)).toEqual(['Parent', 'Zed parent']);
    expect(() => svc.get(broken)).toThrow(CorruptGraphError);
    expect(svc.get(broken, 1)?.version).toBe(1);
    expect(svc.get(broken, 9)).toBeNull();
  });

  it('activate: refuses a sub-workflow, an unknown workflow, an unknown version, a version with errors, a corrupt version and a version whose pinned child has a behaviour step pending', () => {
    const sub = svc.create({ name: 'Sub', kind: 'subworkflow' }, USER).id;
    expect(svc.activate(sub, 1, USER)).toEqual({ kind: 'kind-mismatch' });
    expect(svc.get(sub)?.active).toBeNull();
    expect(svc.activate('nope', 1, USER)).toEqual({ kind: 'not-found', what: 'workflow' });

    const id = svc.create({ name: 'Main', kind: 'workflow' }, USER).id;
    expect(svc.activate(id, 9, USER)).toEqual({ kind: 'not-found', what: 'version' });
    const refused = svc.activate(id, 1, USER);
    expect(refused.kind).toBe('invalid');
    expect(refused.kind === 'invalid' && codes(refused.issues)).toContain('error:TRIGGER_COUNT');
    expect(svc.get(id)?.active).toBeNull();

    save(id, mainWith());
    corrupt(id);
    const corrupted = svc.activate(id, 2, USER);
    expect(corrupted.kind === 'invalid' && codes(corrupted.issues)).toEqual([
      'error:CORRUPT_GRAPH',
    ]);

    const child = make('Strict', 'subworkflow', chain('subworkflow', node('b', 'test:bump')));
    const parent = make('Parent', 'workflow', mainWith(run('run', child, 2)));
    const after = svcWith(bumpV3());
    const broken = after.activate(parent, 2, USER);
    expect(broken.kind === 'invalid' && codes(broken.issues)).toContain('error:SUBWORKFLOW_BROKEN');
    expect(after.get(parent)?.active).toBeNull();
  });

  it('activate the newest, then an older one (rollback), then the same again (no-op)', () => {
    const id = make('Main', 'workflow', mainWith(), mainWith(node('b', 'test:bump')));
    const first = svc.activate(id, 3, USER);
    expect(first.kind === 'ok' && first.summary.active).toEqual({
      version: 3,
      runnable: true,
      activatedAt: NOW.toISOString(),
      activatedBy: USER,
    });

    const later = new Date('2026-10-17T08:00:00.000Z');
    const lateSvc = new WorkflowService({
      db,
      registry: testRegistry(bumpV1()),
      capabilities: () => caps,
      now: () => later,
      log,
    });
    const rolled = lateSvc.activate(id, 2, 'user-2');
    expect(rolled.kind === 'ok' && rolled.summary.active).toEqual({
      version: 2,
      runnable: true,
      activatedAt: later.toISOString(),
      activatedBy: 'user-2',
    });
    expect(rolled.kind === 'ok' && rolled.summary.currentVersion).toBe(3);

    const again = new WorkflowService({
      db,
      registry: testRegistry(bumpV1()),
      capabilities: () => caps,
      now: () => new Date('2026-10-18T08:00:00.000Z'),
      log,
    }).activate(id, 2, 'user-3');
    expect(again.kind === 'ok' && again.summary.active).toEqual({
      version: 2,
      runnable: true,
      activatedAt: later.toISOString(),
      activatedBy: 'user-2',
    });
  });

  it('deactivate: active null with activatedAt/By gone; a second deactivate is ok; sub-workflow and unknown ids are refused', () => {
    const id = make('Main', 'workflow', mainWith());
    activate(id);
    const off = svc.deactivate(id);
    expect(off.kind === 'ok' && off.summary.active).toBeNull();
    expect(db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)).toMatchObject({
      active_version: null,
      activated_at: null,
      activated_by: null,
    });
    expect(svc.deactivate(id).kind).toBe('ok');
    const sub = svc.create({ name: 'Sub', kind: 'subworkflow' }, USER).id;
    expect(svc.deactivate(sub)).toEqual({ kind: 'kind-mismatch' });
    expect(svc.deactivate('nope')).toEqual({ kind: 'not-found' });
  });

  it('save with restoredFrom upgrades the restored graph; a node without a path leaves the graph as sent', () => {
    const id = make('Main', 'workflow', mainWith(node('b', 'test:bump', { level: 1 })));
    const out = svcWith(bumpV2()).save(
      {
        id,
        baseVersion: 2,
        graph: mainWith(node('b', 'test:bump', { level: 1 })),
        note: 'Restored v1',
        restoredFrom: 1,
      },
      USER,
    );
    expect(out.changes).toEqual(['Updated Bump 1→2']);
    expect(out.valid).toBe(true);
    const stored = svc.get(id, out.version);
    expect(stored?.graph.nodes.find((n) => n.id === 'b')?.typeVersion).toBe(2);
    expect(svc.versions(id)?.[0]?.note).toBe('Restored v1; Updated Bump 1→2');

    const stuck = svcWith(bumpNoPath()).save(
      {
        id,
        baseVersion: 3,
        graph: mainWith(node('b', 'test:bump', { level: 1 })),
        restoredFrom: 1,
      },
      USER,
    );
    expect(stuck.changes).toEqual(['Could not upgrade: b']);
    expect(stuck.valid).toBe(false);
    expect(svc.get(id, stuck.version)?.graph.nodes.find((n) => n.id === 'b')?.typeVersion).toBe(1);

    // without restoredFrom nothing is upgraded
    const plain = svcWith(bumpV2()).save(
      { id, baseVersion: 4, graph: mainWith(node('b', 'test:bump', { level: 1 })) },
      USER,
    );
    expect(plain.changes).toEqual([]);
  });

  it('list/get: active.runnable false and activeIssues one NODE_OUTDATED after a behaviour upgrade of the active version; true again after activating the upgraded newest', () => {
    const id = make('Main', 'workflow', mainWith(node('b', 'test:bump', { level: 1 })));
    activate(id, 2);
    // a safe upgrade path still runs; a behaviour step on the path holds the node
    expect(svcWith(bumpV2()).get(id)).toMatchObject({ active: { version: 2, runnable: true } });
    const after = svcWith(bumpV3());
    expect(after.upgradeAll()).toMatchObject({ upgraded: 1, behaviour: 1 });
    const held = after.get(id);
    expect(held?.active).toMatchObject({ version: 2, runnable: false });
    expect(codes(held?.activeIssues ?? [])).toEqual(['error:NODE_OUTDATED']);
    expect(after.list().find((w) => w.id === id)?.active).toMatchObject({ runnable: false });

    expect(after.activate(id, 3, USER).kind).toBe('ok');
    expect(after.get(id)).toMatchObject({
      active: { version: 3, runnable: true },
      activeIssues: [],
    });
  });

  it('list/get: a parent whose active (older) version pins a child that broke → active.runnable false with SUBWORKFLOW_BROKEN; re-pinning and saving does not change that until activated', () => {
    const sub = make('Strict', 'subworkflow', chain('subworkflow', node('b', 'test:bump')));
    const parent = make('Parent', 'workflow', mainWith(run('run', sub, 2)));
    activate(parent, 2);
    const after = svcWith(bumpV3());
    after.upgradeAll();
    expect(after.get(parent)).toMatchObject({ active: { version: 2, runnable: false } });
    expect(codes(after.get(parent)?.activeIssues ?? [])).toContain('error:SUBWORKFLOW_BROKEN');

    const saved = after.save(
      { id: parent, baseVersion: 2, graph: mainWith(run('run', sub, 3)) },
      USER,
    );
    expect(saved).toMatchObject({ valid: true, active: { version: 2, runnable: false } });
    expect(after.activate(parent, 3, USER).kind).toBe('ok');
    expect(after.get(parent)).toMatchObject({ active: { version: 3, runnable: true } });
  });

  it('usedBy and delete count a parent whose active version pins the child even when its current version does not', () => {
    const a = make('Sub A', 'subworkflow', childGraph());
    const parent = make('Parent', 'workflow', mainWith(run('run', a, 2)));
    activate(parent, 2);
    save(parent, mainWith());
    expect(summary(a).usedBy).toEqual([{ id: parent, name: 'Parent' }]);
    expect(svc.delete(a)).toEqual({ kind: 'in-use', usedBy: [{ id: parent, name: 'Parent' }] });
    svc.deactivate(parent);
    expect(summary(a).usedBy).toEqual([]);
    expect(svc.delete(a)).toEqual({ kind: 'ok' });
  });

  it('delete refuses while a live parent whose active version is corrupt still mentions the sub-workflow', () => {
    const a = make('Sub A', 'subworkflow', childGraph());
    const parent = make('Parent', 'workflow', mainWith(run('run', a, 2)), mainWith());
    db.prepare('UPDATE workflow_versions SET graph = ? WHERE workflow_id = ? AND version = ?').run(
      `{"formatVersion":1,"nodes":[{"settings":{"subworkflowId":"${a}"`,
      parent,
      2,
    );
    // the corrupt row is the active one; the current version (3) is readable and does not pin a
    db.prepare(
      'UPDATE workflows SET active_version = 2, activated_at = ?, activated_by = ? WHERE id = ?',
    ).run(NOW.toISOString(), USER, parent);
    expect(svc.delete(a)).toEqual({ kind: 'in-use', usedBy: [{ id: parent, name: 'Parent' }] });
  });

  it('activeState, activeVersionOf and loadForRun agree on the pointer', () => {
    const id = make('Main', 'workflow', mainWith());
    activate(id, 2);
    expect(svc.activeVersionOf(id)).toBe(2);
    expect(svc.loadForRun(id, 2)).toMatchObject({ kind: 'ok', activeVersion: 2 });
    expect(svc.get(id)?.active).toMatchObject({ version: 2, runnable: true });
    // The schema's CHECK keeps the three columns together, so the activatedAt fallback to
    // updated_at cannot be reached through the database.
  });

  it('re-activating the already-active version when it cannot run is invalid, not a no-op ok', () => {
    const id = make('Main', 'workflow', mainWith(node('b', 'test:bump', { level: 1 })));
    activate(id, 2);
    const after = svcWith(bumpV3());
    const r = after.activate(id, 2, USER);
    expect(r.kind === 'invalid' && codes(r.issues)).toEqual(['error:NODE_OUTDATED']);
  });

  it('activeVersionOf: null, the active version, "missing" for a sub-workflow, a deleted and an unknown id', () => {
    const id = make('Main', 'workflow', mainWith());
    expect(svc.activeVersionOf(id)).toBeNull();
    activate(id, 2);
    expect(svc.activeVersionOf(id)).toBe(2);
    const sub = make('Sub', 'subworkflow', childGraph());
    expect(svc.activeVersionOf(sub)).toBe('missing');
    expect(svc.activeVersionOf('nope')).toBe('missing');
    svc.deactivate(id);
    expect(svc.delete(id)).toEqual({ kind: 'ok' });
    expect(svc.activeVersionOf(id)).toBe('missing');
  });

  it('rename changes the name without a new version', () => {
    const id = make('Old', 'workflow', mainWith());
    expect(svc.rename(id, 'New')).toMatchObject({ name: 'New', currentVersion: 2 });
    expect(svc.rename('nope', 'New')).toBeNull();
  });

  it('delete refuses an in-use sub-workflow, deletes after the parent stops referencing it; get on deleted → null; parent then shows SUBWORKFLOW_MISSING', () => {
    const a = make('Sub A', 'subworkflow', childGraph());
    const parent = make('Parent', 'workflow', mainWith(run('run', a, 2)));
    expect(svc.delete(a)).toEqual({ kind: 'in-use', usedBy: [{ id: parent, name: 'Parent' }] });

    save(parent, mainWith());
    expect(svc.delete(a)).toEqual({ kind: 'ok' });
    expect(svc.get(a)).toBeNull();
    expect(svc.versions(a)).toBeNull();
    expect(svc.delete(a)).toEqual({ kind: 'not-found' });
    expect(svc.list().map((w) => w.id)).toEqual([parent]);
    // the parent's older version still pins the deleted sub-workflow
    expect(codes(svc.get(parent, 2)?.issues ?? [])).toContain('error:SUBWORKFLOW_MISSING');
  });

  it('validation treats soft-deleted and kind-mismatched sub-workflows as missing', () => {
    const a = make('Sub A', 'subworkflow', childGraph());
    const other = make('Main', 'workflow', mainWith());
    expect(codes(svc.validate(mainWith(run('run', a, 2))).issues)).not.toContain(
      'error:SUBWORKFLOW_MISSING',
    );
    const mismatched = svc.validate(mainWith(run('run', other, 2)));
    expect(mismatched.valid).toBe(false);
    expect(codes(mismatched.issues)).toContain('error:SUBWORKFLOW_MISSING');

    expect(svc.delete(a)).toEqual({ kind: 'ok' });
    expect(codes(svc.validate(mainWith(run('run', a, 2))).issues)).toContain(
      'error:SUBWORKFLOW_MISSING',
    );
    // selfId: a sub-workflow calling itself is a reference cycle
    const self = make('Self', 'subworkflow', childGraph());
    const selfCall = chain('subworkflow', run('run', self, 2));
    expect(codes(svc.validate(selfCall, self).issues)).toContain(
      'error:SUBWORKFLOW_REFERENCE_CYCLE',
    );
  });

  describe('size gate v1 workflows (pass/else outputs)', () => {
    /** in → gate(v1, stored as an older server wrote it) → replace-original; the gate leaves by "file". */
    const v1Gate = (): WorkflowGraph => ({
      ...mainGraph(
        [
          node('in', 'core:input-manual'),
          node('sg', 'core:size-gate', { minSavingPercent: 20 }, { typeVersion: 1 }),
          node('ro', 'core:replace-original'),
        ],
        [
          { id: 'a', from: { node: 'in', port: 'file' }, to: { node: 'sg', port: 'file' } },
          { id: 'b', from: { node: 'sg', port: 'file' }, to: { node: 'ro', port: 'file' } },
        ],
      ),
    });
    const ports = (g: WorkflowGraph) => g.edges.map((e) => `${e.from.node}.${e.from.port}`);

    it('an active v1 workflow keeps running: a job loads it migrated, with its edge on pass', () => {
      const w = make('Gate', 'workflow', v1Gate());
      activate(w, 2);
      const loaded = svc.loadForRun(w, 2);
      if (loaded.kind !== 'ok') throw new Error(JSON.stringify(loaded));
      expect(ports(loaded.graph)).toEqual(['in.file', 'sg.pass']);
      expect(loaded.graph.nodes.find((n) => n.id === 'sg')).toMatchObject({
        typeVersion: 2,
        settings: { minSavingPercent: 20 },
      });
      expect(activeOf(w)).toMatchObject({ version: 2, runnable: true });
    });

    it('upgradeAll writes a new safe version with the edge re-keyed; the active version is untouched and still runnable', () => {
      const w = make('Gate', 'workflow', v1Gate());
      activate(w, 2);
      expect(svc.upgradeAll()).toMatchObject({ upgraded: 1, behaviour: 0, broken: 0 });
      const detail = svc.get(w);
      expect(detail).toMatchObject({ currentVersion: 3, active: { version: 2, runnable: true } });
      expect(ports(detail?.graph as WorkflowGraph)).toEqual(['in.file', 'sg.pass']);
      expect(svc.versions(w)?.[0]).toMatchObject({
        version: 3,
        note: 'Updated Size gate 1\u21922',
        createdBy: 'system:upgrade',
      });
      // v2 (the active one) is stored as v1 wrote it, but shown as the engine runs it: no
      // spurious UNKNOWN_PORT, the edge on pass
      const old = svc.get(w, 2);
      expect(ports(old?.graph as WorkflowGraph)).toEqual(['in.file', 'sg.pass']);
      expect(old?.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(svc.loadForRun(w, 2)).toMatchObject({ kind: 'ok', activeVersion: 2 });
      // the upgraded version is valid as it stands
      expect(svc.get(w, 3)?.issues.filter((i) => i.severity === 'error')).toEqual([]);
    });
  });

  it('upgradeAll: safe bump → new version with note "Updated Bump 1→2", active_version untouched, summary { upgraded: 1, behaviour: 0, broken: 0, unchanged: N }', () => {
    const w = make('Bumpy', 'workflow', mainWith(node('b', 'test:bump', { level: 1 })));
    activate(w, 2);
    make('Sub', 'subworkflow', childGraph());
    make('Plain', 'workflow', mainWith());

    const after = svcWith(bumpV2());
    expect(after.upgradeAll()).toEqual({ upgraded: 1, behaviour: 0, broken: 0, unchanged: 2 });
    const detail = after.get(w);
    expect(detail).toMatchObject({
      currentVersion: 3,
      active: { version: 2, runnable: true },
    });
    expect(detail?.graph.nodes.find((n) => n.id === 'b')).toMatchObject({
      typeVersion: 2,
      settings: { level: 1, label: '' },
    });
    expect(after.versions(w)?.[0]).toEqual({
      version: 3,
      note: 'Updated Bump 1→2',
      createdBy: 'system:upgrade',
      createdAt: NOW.toISOString(),
    });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      'workflow upgrades: 1 upgraded (0 with behaviour changes), 0 broken, 2 unchanged',
    );
    expect(log.warn).not.toHaveBeenCalled();
    expect(after.upgradeAll()).toEqual({ upgraded: 0, behaviour: 0, broken: 0, unchanged: 3 });
    expect(getSetting(db, 'workflow_review_acks', z.unknown())).toBeNull();
  });

  it('upgradeAll: behaviour bump → new version whose note carries the migration note, behaviour counted, active untouched and no longer runnable', () => {
    const on = make('Enabled', 'workflow', mainWith(node('b', 'test:bump', { level: 1 })));
    activate(on, 2);
    const dry = make('Dry', 'workflow', mainWith(node('b', 'test:bump', { level: 1 })));

    const after = svcWith(bumpV3());
    expect(after.upgradeAll()).toEqual({ upgraded: 2, behaviour: 2, broken: 0, unchanged: 0 });
    const onDetail = after.get(on);
    expect(onDetail).toMatchObject({ currentVersion: 3, active: { version: 2, runnable: false } });
    expect(onDetail?.graph.nodes.find((n) => n.id === 'b')?.settings).toEqual({
      level: 1,
      label: '',
      strict: true,
    });
    expect(after.get(dry)).toMatchObject({ currentVersion: 3, active: null });
    expect(after.versions(on)?.[0]?.note).toBe('Updated Bump 1→3 (strict mode on by default)');
  });

  it('upgradeAll: no path → nothing written, broken 1; throwing migration → broken 1, logged once, other workflows still upgraded; corrupt graph → broken 1; exactly one info line', () => {
    // 'A mixed' has a bump node (no path) and an 'other' node (has a path): nothing is rewritten
    const mixed = make(
      'A mixed',
      'workflow',
      mainWith(node('b', 'test:bump', { level: 1 }), node('o', 'test:other', { n: 1 })),
    );
    const other = make('B other', 'workflow', mainWith(node('o', 'test:other', { n: 1 })));
    const broken = make('C corrupt', 'workflow', mainWith());
    corrupt(broken);

    expect(svcWith(bumpNoPath(), otherDef(2)).upgradeAll()).toEqual({
      upgraded: 1,
      behaviour: 0,
      broken: 2,
      unchanged: 0,
    });
    expect(current(mixed)).toBe(2);
    expect(svc.get(mixed)?.graph.nodes.find((n) => n.id === 'o')?.typeVersion).toBe(1);
    expect(current(other)).toBe(3);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      'workflow upgrades: 1 upgraded (0 with behaviour changes), 2 broken, 0 unchanged',
    );
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith({
      msg: 'workflow upgrade skipped: no migration path',
      workflowId: mixed,
      nodeIds: ['b'],
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: 'workflow upgrade skipped: corrupt graph',
        workflowId: broken,
        version: 2,
        error: expect.any(String),
      }),
    );

    vi.clearAllMocks();
    const late = make('D other', 'workflow', mainWith(node('o', 'test:other', { n: 2 })));
    expect(svcWith(bumpThrowing(), otherDef(2)).upgradeAll()).toEqual({
      upgraded: 1,
      behaviour: 0,
      broken: 2,
      unchanged: 1,
    });
    expect(current(mixed)).toBe(2);
    expect(current(late)).toBe(3);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith({
      msg: 'workflow upgrade failed',
      workflowId: mixed,
      error: 'boom',
    });
  });

  it('upgradeAll upgrades a sub-workflow without touching its parents (parent then usesOutdatedSubworkflow)', () => {
    const sub = make('Sub', 'subworkflow', chain('subworkflow', node('b', 'test:bump')));
    const parent = make('Parent', 'workflow', mainWith(run('run', sub, 2)));
    expect(summary(parent).usesOutdatedSubworkflow).toBe(false);

    const after = svcWith(bumpV2());
    expect(after.upgradeAll()).toEqual({ upgraded: 1, behaviour: 0, broken: 0, unchanged: 1 });
    expect(after.get(sub)?.currentVersion).toBe(3);
    const p = after.get(parent);
    expect(p).toMatchObject({ currentVersion: 2, usesOutdatedSubworkflow: true });
    expect(p?.graph.nodes.find((n) => n.id === 'run')?.settings).toMatchObject({ version: 2 });
  });

  it('upgradeAll: a migration output that does not parse as a graph → broken 1, warned once, nothing written, active unchanged', () => {
    const w = make('Bumpy', 'workflow', mainWith(node('b', 'test:bump', { level: 1 })));
    activate(w, 2);
    const forgetful = defineNode({
      type: 'test:bump',
      version: 2,
      kind: 'action',
      title: 'Bump',
      description: 'Migration mutates and forgets to return.',
      icon: 'test',
      inputs: [filePort],
      outputs: [filePort],
      settings: z.object({ level: z.number().default(1).describe('Level') }),
      migrations: [
        {
          from: 1,
          to: 2,
          risk: 'safe',
          note: 'label added',
          migrate: ((s: Record<string, JsonValue>) => {
            s.label = '';
          }) as unknown as (s: JsonValue) => JsonValue,
        },
      ],
    });
    const after = svcWith(forgetful);
    expect(after.upgradeAll()).toEqual({ upgraded: 0, behaviour: 0, broken: 1, unchanged: 0 });
    expect(current(w)).toBe(2);
    expect(summary(w).active).toMatchObject({ version: 2, runnable: true });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith({
      msg: 'workflow upgrade failed',
      workflowId: w,
      error: expect.any(String),
    });
  });

  it('upgradeAll: a database failure while listing logs one error and returns the empty summary', () => {
    make('Bumpy', 'workflow', mainWith(node('b', 'test:bump', { level: 1 })));
    const after = svcWith(bumpV2());
    vi.spyOn(db, 'prepare').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    expect(after.upgradeAll()).toEqual({ upgraded: 0, behaviour: 0, broken: 0, unchanged: 0 });
    vi.restoreAllMocks();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith({
      msg: 'workflow upgrades failed: could not list workflows',
      error: 'disk I/O error',
    });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('upgradeAll: a live workflow whose current version row is missing counts as broken; list shows it invalid', () => {
    const w = make('Gone', 'workflow', mainWith());
    make('Plain', 'workflow', mainWith());
    db.prepare('UPDATE workflows SET current_version = 9 WHERE id = ?').run(w);
    expect(svc.upgradeAll()).toEqual({ upgraded: 0, behaviour: 0, broken: 1, unchanged: 1 });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: 'workflow upgrade skipped: corrupt graph',
        workflowId: w,
        version: 9,
        error: 'Stored version 9 is missing',
      }),
    );
    expect(summary(w)).toMatchObject({ valid: false, errorCount: 1, currentVersion: 9 });
    expect(() => svc.get(w)).toThrow(CorruptGraphError);
  });

  it('upgradeAll: a no-path or corrupt active workflow keeps its active version', () => {
    const noPath = make('No path', 'workflow', mainWith(node('b', 'test:bump', { level: 1 })));
    const broken = make('Corrupt', 'workflow', mainWith());
    activate(noPath, 2);
    activate(broken, 2);
    corrupt(broken);
    expect(svcWith(bumpNoPath()).upgradeAll()).toEqual({
      upgraded: 0,
      behaviour: 0,
      broken: 2,
      unchanged: 0,
    });
    expect(summary(noPath)).toMatchObject({ currentVersion: 2, active: { version: 2 } });
    expect(summary(broken)).toMatchObject({
      currentVersion: 2,
      active: { version: 2, runnable: false },
    });
  });

  it('save: Run settings that fail to parse on either side are a change; the version is stored with its errors', () => {
    const a = make('Sub A', 'subworkflow', childGraph());
    const parent = make('Parent', 'workflow', mainWith(run('run', a, 2)));
    activate(parent);

    const broken = save(parent, mainWith(node('run', 'core:run-subworkflow', { version: 'x' })));
    expect(broken).toMatchObject({
      valid: false,
      changes: ['Switched sub-workflow Sub A 2→none'],
      active: { version: 2, runnable: true },
    });
    expect(svc.versions(parent)?.[0]?.version).toBe(3);

    expect(save(parent, mainWith(run('run', a, 2))).changes).toEqual([
      'Switched sub-workflow none→Sub A 2',
    ]);
  });

  it('delete refuses while a live parent whose current version is corrupt still mentions the sub-workflow', () => {
    const a = make('Sub A', 'subworkflow', childGraph());
    const b = make('Sub B', 'subworkflow', childGraph());
    const parent = make('Parent', 'workflow', mainWith(run('run', a, 2)));
    db.prepare('UPDATE workflow_versions SET graph = ? WHERE workflow_id = ? AND version = ?').run(
      `{"formatVersion":1,"nodes":[{"settings":{"subworkflowId":"${a}"`,
      parent,
      2,
    );
    expect(svc.delete(a)).toEqual({ kind: 'in-use', usedBy: [{ id: parent, name: 'Parent' }] });
    expect(svc.delete(b)).toEqual({ kind: 'ok' });
  });

  it('save: an override of a nested Run node is dropped and listed in changes', () => {
    const inner = make('Inner', 'subworkflow', childGraph());
    const outer = make('Outer', 'subworkflow', chain('subworkflow', run('nested', inner, 2)));
    const parent = make('Parent', 'workflow', mainWith(run('run', outer, 2)));
    activate(parent);
    const out = save(parent, mainWith(run('run', outer, 2, { 'nested.version': 999 })));
    expect(out.valid).toBe(true);
    expect(out.changes.join(';')).toContain('nested.version');
    expect(svc.get(parent)?.graph.nodes.find((n) => n.id === 'run')?.settings).toEqual({
      subworkflowId: outer,
      version: 2,
      overrides: {},
    });
    expect(svc.get(outer)?.settings?.map((x) => x.nodeId)).not.toContain('nested');
  });

  it('save: a version with errors is stored, valid false, and the active version stays', () => {
    const id = make('Main', 'workflow', mainWith());
    activate(id, 2);
    const orphan = { ...mainWith(), nodes: [...mainWith().nodes, node('o', 'core:remux')] };
    const brokenOut = save(id, orphan); // INPUT_UNCONNECTED (error) + NODE_UNREACHABLE (warning)
    expect(brokenOut).toMatchObject({
      valid: false,
      changes: [],
      active: { version: 2, runnable: true },
    });
    expect(svc.versions(id)?.[0]?.version).toBe(3);
    expect(svc.get(id)?.active).toMatchObject({ version: 2, runnable: true });

    const dry = make('Dry', 'workflow', mainWith());
    expect(save(dry, orphan)).toMatchObject({ valid: false, active: null });
  });

  it('save on a workflow whose current version row is missing → a change line, current_version repaired', () => {
    const id = make('Gone', 'workflow', mainWith(), mainWith());
    activate(id, 2);
    db.prepare('DELETE FROM workflow_versions WHERE workflow_id = ? AND version = 3').run(id);
    const out = svc.save({ id, baseVersion: 3, graph: mainWith() }, USER);
    expect(out).toMatchObject({
      version: 4,
      valid: true,
      changes: ['Previous version 3 could not be read'],
      active: { version: 2, runnable: true },
    });
    expect(svc.get(id)).toMatchObject({ currentVersion: 4, version: 4 });
  });

  it('upgradeAll: a behaviour upgrade of a sub-workflow writes no parent version and moves no active pointer; the parent pinning the old version just cannot run', () => {
    const sub = make('Strict sub', 'subworkflow', chain('subworkflow', node('b', 'test:bump')));
    const parent = make('Parent', 'workflow', mainWith(run('run', sub, 2)));
    activate(parent);
    const other = make('Other', 'workflow', mainWith());
    activate(other);

    const after = svcWith(bumpV3());
    expect(after.upgradeAll()).toEqual({ upgraded: 1, behaviour: 1, broken: 0, unchanged: 2 });
    expect(after.get(sub)).toMatchObject({ currentVersion: 3, active: null });
    const p = after.get(parent);
    expect(p).toMatchObject({ currentVersion: 2, active: { version: 2, runnable: false } });
    expect(after.versions(parent)).toHaveLength(2);
    expect(codes(p?.activeIssues ?? [])).toContain('error:SUBWORKFLOW_BROKEN');
    expect(after.get(other)?.active).toMatchObject({ version: 2, runnable: true });
  });

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

describe('graph format 2', () => {
  /** in → encode → replace-original, as format 1 stored it (no Render). */
  const v1Graph = () => ({
    formatVersion: 1 as const,
    kind: 'workflow' as const,
    nodes: [
      node('in', 'core:input-manual'),
      node('enc', 'core:encode-video', { codec: 'hevc' }, { position: { x: 200, y: 0 } }),
      node('ro', 'core:replace-original', {}, { position: { x: 600, y: 0 } }),
    ],
    edges: [
      { id: 'in-enc', from: { node: 'in', port: 'file' }, to: { node: 'enc', port: 'file' } },
      { id: 'enc-ro', from: { node: 'enc', port: 'file' }, to: { node: 'ro', port: 'file' } },
    ],
    groups: [],
  });
  const storeV1 = (id: string, version: number, graph: unknown = v1Graph()) =>
    db
      .prepare(
        'UPDATE workflow_versions SET graph = ?, format_version = 1 WHERE workflow_id = ? AND version = ?',
      )
      .run(JSON.stringify(graph), id, version);
  const types = (g: WorkflowGraph | undefined) => g?.nodes.map((n) => n.type);

  it('create with a format-1 graph stores format 2 with a Render; get returns it', () => {
    const created = svc.create({ name: 'Old', kind: 'workflow', graph: v1Graph() }, USER);
    expect(created.graph.formatVersion).toBe(2);
    expect(types(created.graph)).toContain('core:render');
    expect(created.graph.edges).toContainEqual({
      id: 'render-1-in',
      from: { node: 'enc', port: 'file' },
      to: { node: 'render-1', port: 'file' },
    });
    const row = db
      .prepare('SELECT format_version, graph FROM workflow_versions WHERE workflow_id = ?')
      .get(created.id) as { format_version: number; graph: string };
    expect(row.format_version).toBe(2);
    expect(row.graph).toContain('core:render');
    expect(svc.get(created.id)?.graph.formatVersion).toBe(2);
  });

  it('save and validate take a format-1 graph as format 2', () => {
    const id = make('W', 'workflow');
    const saved = svc.save({ id, baseVersion: 1, graph: v1Graph() }, USER);
    expect(types(svc.get(id, saved.version)?.graph)).toContain('core:render');
    const checked = svc.validate(v1Graph());
    expect(checked.issues.some((i) => i.code === 'UNKNOWN_PORT')).toBe(false);
  });

  it('a stored format-1 version reads as format 2; upgradeAll writes it once, then leaves it unchanged', () => {
    const id = make('Stored', 'workflow', mainWith());
    storeV1(id, 2);
    expect(svc.get(id)?.graph.formatVersion).toBe(2);
    expect(types(svc.get(id)?.graph)).toContain('core:render');

    expect(svc.upgradeAll()).toEqual({ upgraded: 1, behaviour: 0, broken: 0, unchanged: 0 });
    expect(current(id)).toBe(3);
    expect(svc.versions(id)?.[0]).toMatchObject({
      version: 3,
      note: FORMAT_2_NOTE,
      createdBy: 'system:upgrade',
    });
    const row = db
      .prepare('SELECT format_version FROM workflow_versions WHERE workflow_id = ? AND version = 3')
      .get(id) as { format_version: number };
    expect(row.format_version).toBe(2);
    expect(svc.upgradeAll()).toEqual({ upgraded: 0, behaviour: 0, broken: 0, unchanged: 1 });
  });

  it('upgradeAll leaves a format-1 version with an unknown node type at format 1 (upgraded on read)', () => {
    const id = make('Plugin', 'workflow', mainWith());
    const g = v1Graph();
    g.nodes.push(node('x', 'x:not-installed', {}, { position: { x: 800, y: 0 } }));
    g.edges.push({
      id: 'ro-x',
      from: { node: 'ro', port: 'file' },
      to: { node: 'x', port: 'file' },
    });
    storeV1(id, 2, g);
    expect(svc.upgradeAll()).toMatchObject({ upgraded: 0, unchanged: 1 });
    expect(current(id)).toBe(2);
    expect(types(svc.get(id)?.graph)).toContain('core:render');
  });

  it('upgradeAll writes the format with node upgrades in one version, notes joined', () => {
    const id = make('Both', 'workflow', mainWith(node('b', 'test:bump', { level: 1 })));
    const stored = svc.get(id)?.graph as WorkflowGraph;
    storeV1(id, 2, { ...stored, formatVersion: 1 });
    const after = svcWith(bumpV2());
    expect(after.upgradeAll()).toMatchObject({ upgraded: 1 });
    expect(after.versions(id)?.[0]?.note).toBe(`${FORMAT_2_NOTE}; Updated Bump 1→2`);
    expect(types(after.get(id)?.graph)).toContain('core:render');
  });
});

describe('resolvePinnedChild', () => {
  it('migrates all-safe paths, then applies the overrides; null for a missing or deleted child', () => {
    const child = make(
      'Child',
      'subworkflow',
      chain('subworkflow', node('b', 'test:bump', { level: 1 })),
    );
    const v2 = svcWith(bumpV2());
    const resolved = v2.resolvePinnedChild(child, 2, { 'b.label': 'over' });
    expect(resolved?.name).toBe('Child');
    expect(resolved?.graph.nodes.find((n) => n.id === 'b')).toMatchObject({
      id: 'b',
      typeVersion: 2,
      settings: { level: 1, label: 'over' },
    });
    expect(v2.resolvePinnedChild(child, 7, {})).toBeNull();
    expect(v2.delete(child).kind).toBe('ok');
    expect(v2.resolvePinnedChild(child, 2, {})).toBeNull();
  });
});

describe('loadForRun', () => {
  it('a workflow id of kind subworkflow is missing; an invalid graph lists its errors', () => {
    const child = make('Child', 'subworkflow', childGraph());
    expect(svc.loadForRun(child, 2)).toEqual({ kind: 'missing' });
    const id = make('Main', 'workflow', chain('workflow', node('in', 'core:input-manual')));
    const loaded = svc.loadForRun(id, 2);
    expect(loaded.kind).toBe('invalid');
    expect(loaded.kind === 'invalid' && codes(loaded.issues)).toContain('error:NO_FINISH_PATH');
  });

  it('returns the activeVersion (null, then the active one) and the graph', () => {
    const id = make('Main', 'workflow', mainWith());
    expect(svc.loadForRun(id, 2)).toMatchObject({ kind: 'ok', activeVersion: null });
    activate(id, 2);
    expect(svc.loadForRun(id, 1)).toMatchObject({ kind: 'invalid' });
    expect(svc.loadForRun(id, 2)).toMatchObject({ kind: 'ok', activeVersion: 2 });
    expect(svc.loadForRun(id, 9)).toEqual({ kind: 'missing' });
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
    svc = pluginSvc;
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
    svc = new WorkflowService({
      db,
      registry: registryWithPlugin(remoteA(3, PLUGIN_LINKS)),
      capabilities: () => caps,
      now: () => NOW,
      log,
    });
  });

  /** A service whose plugin serves node version `version` with these links. */
  const serving = (version: number, links: typeof PLUGIN_LINKS) => {
    svc = new WorkflowService({
      db,
      registry: registryWithPlugin(remoteA(version, links)),
      capabilities: () => caps,
      now: () => NOW,
      log,
    });
  };
  const SAFE = PLUGIN_LINKS.slice(0, 1);

  it('upgradePluginNodes appends a version with the note through the host and leaves active_version alone; the active version is held for review (behaviour step)', async () => {
    serving(2, SAFE);
    const id = make('Main', 'workflow', mainWith(NODE_AT(1)));
    activate(id, 2);
    serving(3, PLUGIN_LINKS); // the update: 2→3 changes behaviour
    const summary = await svc.upgradePluginNodes(['x:a'], migrate);
    expect(summary).toEqual({ upgraded: 1, behaviour: 1, broken: 0, unchanged: 0 });
    expect(migrate).toHaveBeenCalledWith('x:a', 1, { old: 'a' });
    const detail = svc.get(id);
    expect(detail?.currentVersion).toBe(3);
    expect(detail?.active).toMatchObject({ version: 2, runnable: false });
    expect(detail?.activeIssues.map((i) => i.message)).toContain(
      'plugin update changes behaviour of A; review and activate a new version',
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
    svc = new WorkflowService({
      db,
      registry: registryWithPlugin(remoteA(3, PLUGIN_LINKS.slice(1))),
      capabilities: () => caps,
      now: () => NOW,
      log,
    });
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
    const text = 'plugin update changes behaviour of A; review and activate a new version';
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
    svc = new WorkflowService({
      db,
      registry: registryWithPlugin(remoteA(4, [{ from: 2, to: 4, risk: 'safe', note: 'n' }])),
      capabilities: () => caps,
      now: () => NOW,
      log,
    });
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
    svc = new WorkflowService({
      db,
      registry,
      capabilities: () => caps,
      now: () => NOW,
      log,
    });
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

describe('library trigger read fields', () => {
  const fromLibrary = (libraryId: string): WorkflowGraph =>
    chain(
      'workflow',
      node('in', 'core:input-library', { libraryId }),
      node('ro', 'core:replace-original'),
    );
  const lib = (id: string, name: string) =>
    insertLibrary(
      db,
      { id, name, path: `/media/${id}`, recycleFolder: null, processHardlinked: false },
      NOW,
    );

  it('feedsLibrary names the live library the active version takes files from; libraryInput the newest', () => {
    lib('shows', 'Shows');
    lib('movies', 'Movies');
    const a = make('Downsize', 'workflow', fromLibrary('shows'));
    expect(summary(a)).toMatchObject({
      feedsLibrary: null,
      libraryInput: { id: 'shows', name: 'Shows' },
    });
    activate(a);
    expect(summary(a)).toMatchObject({
      feedsLibrary: { id: 'shows', name: 'Shows' },
      libraryInput: { id: 'shows', name: 'Shows' },
    });
    // A newer draft names another library: the active binding is unchanged.
    save(a, fromLibrary('movies'));
    expect(summary(a)).toMatchObject({
      feedsLibrary: { id: 'shows', name: 'Shows' },
      libraryInput: { id: 'movies', name: 'Movies' },
    });
    expect(svc.get(a, 2)?.libraryInput).toEqual({ id: 'movies', name: 'Movies' });

    softDeleteLibrary(db, 'shows', NOW);
    expect(summary(a).feedsLibrary).toBeNull();
    save(a, fromLibrary('shows'));
    expect(summary(a).libraryInput).toEqual({ id: 'shows', name: null });
    expect(svc.get(a)?.issues).toEqual([
      {
        severity: 'warning',
        code: 'LIBRARY_MISSING',
        message: 'Library input: no library with this id',
        nodeId: 'in',
        settingPath: 'libraryId',
      },
    ]);
  });

  it('both are null without a Library input and for a sub-workflow', () => {
    const manual = make('Manual', 'workflow', mainWith());
    activate(manual);
    expect(summary(manual)).toMatchObject({ feedsLibrary: null, libraryInput: null });
    const sub = make('Sub', 'subworkflow', childGraph());
    expect(summary(sub)).toMatchObject({ feedsLibrary: null, libraryInput: null });
    expect(svc.get(sub)).toMatchObject({ feedsLibrary: null, libraryInput: null });
  });
});
