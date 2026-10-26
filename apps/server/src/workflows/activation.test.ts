import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Capabilities } from '@transcoda/contract';
import type { AnyNodeDefinition } from '@transcoda/sdk';
import type { JsonValue, NodeInstance, WorkflowGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/open.ts';
import { findFeeder, findWorkflow, VersionConflictError } from '../db/repos/workflows.ts';
import { createTestDb } from '../db/test-db.ts';
import { EngineEvents } from '../engine/events.ts';
import { tempDir } from '../engine/fixtures.ts';
import { type QueueResult, QueueService } from '../engine/queue-service.ts';
import { WorkflowService } from './service.ts';
import { bumpV1, bumpV2, bumpV3, chain, node, testRegistry } from './test-helpers.ts';

const caps: Capabilities = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '7.1',
  encoders: ['aac', 'libx264', 'libx265'],
  hwaccels: [],
  filters: ['pan'],
};
const USER = 'u';

interface World {
  workflows: WorkflowService;
  queue: QueueService;
}

let base: string;
let file: string;
let db: Database;
let world: World;
let flowId: string;
let subId: string;

/** Services over the same db with one registry: a "restart" with other node definitions. */
function worldWith(...defs: AnyNodeDefinition[]): World {
  const workflows = new WorkflowService({
    db,
    registry: testRegistry(...defs),
    capabilities: () => caps,
    now: () => new Date(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const queue = new QueueService({
    db,
    workflows,
    events: new EngineEvents(),
    now: () => new Date(),
    settleMinutes: 3,
    onQueued: vi.fn(),
  });
  return { workflows, queue };
}

function run(id: string, version: number, overrides: Record<string, JsonValue> = {}): NodeInstance {
  return node(id, 'core:run-subworkflow', { subworkflowId: subId, version, overrides });
}

function mainWith(...middle: NodeInstance[]): WorkflowGraph {
  return chain(
    'workflow',
    node('in', 'core:input-manual'),
    ...middle,
    node('ro', 'core:replace-original'),
  );
}

/** What the active version 1 contains: an old Bump node and a pinned Run node. */
const v1Graph = (): WorkflowGraph =>
  mainWith(node('b', 'test:bump', { level: 1 }, { typeVersion: 1 }), run('run', 2));

const current = (): number => findWorkflow(db, flowId)?.currentVersion ?? -1;

function save(graph: WorkflowGraph, extra: { note?: string; restoredFrom?: number } = {}) {
  return world.workflows.save({ id: flowId, baseVersion: current(), graph, ...extra }, USER);
}

async function queueReal(): Promise<QueueResult> {
  return world.queue.queue({
    path: file,
    workflowId: flowId,
    dryRun: false,
    force: true,
    priority: 0,
    createdBy: USER,
  });
}

async function queuedReal() {
  const r = await queueReal();
  if (r.kind !== 'queued') throw new Error(`expected queued, got ${JSON.stringify(r)}`);
  return r;
}

beforeEach(async () => {
  base = await tempDir('activation-');
  const root = join(base, 'lib');
  await mkdir(root, { recursive: true });
  file = join(root, 'a.mkv');
  await writeFile(file, 'x');
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(file, hourAgo, hourAgo);

  db = createTestDb();
  world = worldWith(bumpV1());
  const sub = world.workflows.create({ name: 'Sub', kind: 'subworkflow' }, USER);
  subId = sub.id;
  world.workflows.save(
    {
      id: subId,
      baseVersion: 1,
      graph: chain('subworkflow', node('kl', 'core:keep-languages', { languages: ['en', 'de'] })),
    },
    USER,
  );
  flowId = world.workflows.create({ name: 'Main', kind: 'workflow', graph: v1Graph() }, USER).id;
  const lib = await world.queue.createLibrary({
    name: 'TV',
    path: root,
  });
  if (!('id' in lib)) throw new Error('library not created');
});

afterEach(async () => {
  db.close();
  await rm(base, { recursive: true, force: true });
});

interface Action {
  name: string;
  /** True when the action leaves the newest version unable to run (matters with nothing active). */
  breaksNewest?: boolean;
  /** With v1 active: the real queue is refused with this issue code (never a run of a newer version). */
  expectsRefusal?: 'CORRUPT_GRAPH' | 'NODE_OUTDATED';
  /** Extra assertions on the version a real run still loads (v1). */
  checkRun?(): void;
  /** An action may swap the services (a restart); it never calls activate/deactivate. */
  perform(): void;
}

const actions: Action[] = [
  { name: 'a plain save (v2)', perform: () => void save(v1Graph()) },
  {
    name: 'a save with a Run-node pin change',
    perform: () => {
      // a second version of the child, then the parent re-pins to it
      world.workflows.save(
        {
          id: subId,
          baseVersion: 2,
          graph: chain('subworkflow', node('kl', 'core:keep-languages', { languages: ['en'] })),
        },
        USER,
      );
      const out = save(mainWith(node('b', 'test:bump', { level: 1 }), run('run', 3)));
      expect(out.changes.length).toBeGreaterThan(0);
    },
    checkRun: () => {
      const loaded = world.workflows.loadForRun(flowId, 1);
      if (loaded.kind !== 'ok') throw new Error('v1 no longer loads');
      expect(loaded.graph.nodes.find((n) => n.id === 'run')?.settings).toMatchObject({
        subworkflowId: subId,
        version: 2,
      });
    },
  },
  {
    name: 'a save that drops stale overrides',
    perform: () => {
      const out = save(
        mainWith(
          node('b', 'test:bump', { level: 1 }),
          run('run', 2, { 'kl.languages': ['en'], 'kl.nope': 1 }),
        ),
      );
      expect(out.changes.join(' ')).toContain('Dropped overrides');
    },
  },
  {
    name: 'a save with errors (valid false)',
    perform: () => {
      const out = save(mainWith(node('x', 'test:does-not-exist')));
      expect(out.valid).toBe(false);
    },
    breaksNewest: true,
  },
  {
    name: 'a save over a corrupt base (v1 text replaced by "{")',
    perform: () => {
      db.prepare(
        'UPDATE workflow_versions SET graph = ? WHERE workflow_id = ? AND version = 1',
      ).run('{', flowId);
      const out = save(v1Graph());
      expect(out.version).toBe(2);
    },
    expectsRefusal: 'CORRUPT_GRAPH',
  },
  {
    name: 'a restore (save with restoredFrom: 1) with upgrades applied',
    perform: () => {
      world = worldWith(bumpV2());
      const out = save(v1Graph(), { note: 'Restored v1', restoredFrom: 1 });
      expect(out.changes.length).toBeGreaterThan(0);
    },
  },
  {
    name: '"Save over it": a save with a stale base conflicts and writes nothing',
    perform: () => {
      save(v1Graph());
      expect(() =>
        world.workflows.save({ id: flowId, baseVersion: 1, graph: v1Graph() }, USER),
      ).toThrow(VersionConflictError);
      expect(world.workflows.versions(flowId)).toHaveLength(2);
    },
  },
  {
    name: 'create and duplicate of this workflow',
    perform: () => {
      const dup = world.workflows.duplicate(flowId, 'Copy', USER);
      if (dup.kind !== 'ok') throw new Error('duplicate failed');
      const other = world.workflows.create(
        { name: 'Other', kind: 'workflow', graph: v1Graph() },
        USER,
      );
      for (const id of [dup.detail.id, other.id]) {
        const row = findWorkflow(db, id);
        expect(row).toMatchObject({ activeVersion: null, activatedAt: null, activatedBy: null });
        expect(world.workflows.list().find((w) => w.id === id)?.active).toBeNull();
      }
    },
  },
  {
    name: 'deleting the sub-workflow the active version pins is refused',
    perform: () => {
      const r = world.workflows.delete(subId);
      expect(r).toMatchObject({ kind: 'in-use', usedBy: [{ id: flowId }] });
    },
  },
  {
    name: 'rename',
    perform: () => {
      expect(world.workflows.rename(flowId, 'Renamed')?.name).toBe('Renamed');
    },
  },
  {
    name: 'upgradeAll with a safe migration',
    perform: () => {
      world = worldWith(bumpV2());
      expect(world.workflows.upgradeAll()).toMatchObject({ upgraded: 1, behaviour: 0 });
    },
  },
  {
    name: 'upgradeAll with a behaviour migration',
    perform: () => {
      world = worldWith(bumpV3());
      expect(world.workflows.upgradeAll()).toMatchObject({ upgraded: 1, behaviour: 1 });
    },
    expectsRefusal: 'NODE_OUTDATED',
  },
];

const rawActive = (): number | null => findWorkflow(db, flowId)?.activeVersion ?? null;

describe('a save never changes what runs', () => {
  describe('with version 1 active', () => {
    beforeEach(async () => {
      expect(world.workflows.activate(flowId, 1, USER).kind).toBe('ok');
      const r = await queuedReal();
      expect(r.run).toMatchObject({ workflowVersion: 1, dryRun: false, note: null });
    });

    for (const action of actions) {
      it(action.name, async () => {
        action.perform();
        expect(world.workflows.list().find((w) => w.id === flowId)?.active?.version).toBe(1);
        expect(rawActive()).toBe(1);

        action.checkRun?.();
        if (action.expectsRefusal) {
          // the active version can no longer run: refused, never a dry run of a newer version
          const r = await queueReal();
          expect(r.kind).toBe('workflow-invalid');
          if (r.kind === 'workflow-invalid') {
            expect(r.issues.map((i) => i.code)).toContain(action.expectsRefusal);
          }
          expect(world.workflows.list().find((w) => w.id === flowId)?.active?.version).toBe(1);
          expect(rawActive()).toBe(1);
          return;
        }
        const r = await queuedReal();
        expect(r.run).toMatchObject({ workflowVersion: 1, dryRun: false, note: null });
        expect(r.jobs.every((j) => j.workflowVersion === 1 && !j.dryRun)).toBe(true);
      });
    }
  });

  describe('with nothing active', () => {
    for (const action of actions) {
      it(action.name, async () => {
        action.perform();
        expect(world.workflows.list().find((w) => w.id === flowId)?.active).toBeNull();
        expect(rawActive()).toBeNull();
        expect(findWorkflow(db, flowId)).toMatchObject({ activatedAt: null, activatedBy: null });
        const r = await queueReal();
        if (action.breaksNewest) {
          expect(r.kind).toBe('workflow-invalid');
          return;
        }
        expect(r.kind).toBe('queued');
        if (r.kind === 'queued') {
          expect(r.run).toMatchObject({
            workflowVersion: current(),
            dryRun: true,
            note: 'no active version',
          });
        }
      });
    }
  });

  it('deleting the active workflow soft-deletes it: nothing runs, no other version is used', async () => {
    expect(world.workflows.activate(flowId, 1, USER).kind).toBe('ok');
    save(v1Graph());
    expect(world.workflows.delete(flowId)).toEqual({ kind: 'ok' });
    expect(world.workflows.list().some((w) => w.id === flowId)).toBe(false);
    expect((await queueReal()).kind).toBe('workflow-missing');
    expect(
      (
        await world.queue.queue({
          path: file,
          workflowId: flowId,
          dryRun: true,
          force: true,
          priority: 0,
          createdBy: USER,
        })
      ).kind,
    ).toBe('workflow-missing');
  });

  it('only activate and deactivate move the pointer', () => {
    const { workflows } = world;
    save(v1Graph());
    expect(workflows.activate(flowId, 2, USER).kind).toBe('ok');
    expect(rawActive()).toBe(2);
    expect(workflows.list().find((w) => w.id === flowId)?.active?.version).toBe(2);
    const row = findWorkflow(db, flowId);
    expect(row?.activatedBy).toBe(USER);
    expect(row?.activatedAt).not.toBeNull();

    expect(workflows.deactivate(flowId).kind).toBe('ok');
    expect(rawActive()).toBeNull();
    const cleared = findWorkflow(db, flowId);
    expect(cleared?.activatedAt).toBeNull();
    expect(cleared?.activatedBy).toBeNull();
    expect(workflows.list().find((w) => w.id === flowId)?.active).toBeNull();
  });
});

describe('a Library input binds the active workflow to its library', () => {
  let shows: string;
  let gone: string;

  const fromLibrary = (libraryId: string): WorkflowGraph =>
    chain(
      'workflow',
      node('in', 'core:input-library', { libraryId }),
      node('ro', 'core:replace-original'),
    );

  function workflow(name: string, ...graphs: WorkflowGraph[]): string {
    const [first, ...rest] = graphs;
    const id = world.workflows.create({ name, kind: 'workflow', graph: first }, USER).id;
    for (const graph of rest) {
      const at = findWorkflow(db, id)?.currentVersion ?? 0;
      world.workflows.save({ id, baseVersion: at, graph }, USER);
    }
    return id;
  }

  async function library(name: string): Promise<string> {
    const root = join(base, name.toLowerCase());
    await mkdir(root, { recursive: true });
    const lib = await world.queue.createLibrary({ name, path: root });
    if (!('id' in lib)) throw new Error('library not created');
    return lib.id;
  }

  beforeEach(async () => {
    shows = await library('Shows');
    gone = await library('Gone');
    expect(world.queue.deleteLibrary(gone)).toBe('ok');
  });

  it('activating binds; another workflow naming the same library is refused until it is free', () => {
    const a = workflow('Downsize', fromLibrary(shows));
    const b = workflow('Other', fromLibrary(shows));
    expect(world.workflows.activate(a, 1, USER).kind).toBe('ok');
    expect(findFeeder(db, shows)).toEqual({ workflowId: a, name: 'Downsize', version: 1 });

    expect(world.workflows.activate(b, 1, USER)).toEqual({
      kind: 'library-taken',
      library: { id: shows, name: 'Shows' },
      workflow: { id: a, name: 'Downsize', version: 1 },
    });
    expect(findWorkflow(db, b)?.activeVersion).toBeNull();

    expect(world.workflows.deactivate(a).kind).toBe('ok');
    expect(world.workflows.activate(b, 1, USER).kind).toBe('ok');
    expect(findFeeder(db, shows)?.workflowId).toBe(b);
  });

  it('the feeder itself may re-activate or roll back on its own library', () => {
    const graphs = [1, 2, 3, 4].map(() => fromLibrary(shows));
    const a = workflow('Downsize', ...graphs);
    expect(world.workflows.activate(a, 4, USER).kind).toBe('ok');
    expect(world.workflows.activate(a, 4, USER).kind).toBe('ok');
    expect(world.workflows.activate(a, 3, USER).kind).toBe('ok');
    expect(findFeeder(db, shows)).toEqual({ workflowId: a, name: 'Downsize', version: 3 });
  });

  it('a version naming a deleted library cannot be activated, but still dry runs', async () => {
    const a = workflow('Downsize', fromLibrary(gone));
    expect(world.workflows.activate(a, 1, USER)).toEqual({
      kind: 'library-missing',
      libraryId: gone,
    });
    expect(findWorkflow(db, a)?.activeVersion).toBeNull();
    const dry = await world.queue.queue({
      path: file,
      workflowId: a,
      dryRun: true,
      force: true,
      priority: 0,
      createdBy: USER,
    });
    expect(dry.kind).toBe('queued');
  });

  it('a soft-deleted feeder never blocks another workflow', () => {
    const a = workflow('Downsize', fromLibrary(shows));
    const b = workflow('Other', fromLibrary(shows));
    expect(world.workflows.activate(a, 1, USER).kind).toBe('ok');
    expect(world.workflows.delete(a)).toEqual({ kind: 'ok' });
    expect(findWorkflow(db, a, { includeDeleted: true })?.activeLibraryId).toBe(shows);
    expect(world.workflows.activate(b, 1, USER).kind).toBe('ok');
    expect(findFeeder(db, shows)?.workflowId).toBe(b);
  });

  it('inactive drafts may name the same library', () => {
    const a = workflow('Downsize', fromLibrary(shows));
    const b = workflow('Other', fromLibrary(shows));
    expect(world.workflows.activate(a, 1, USER).kind).toBe('ok');
    for (const id of [a, b]) {
      const saved = world.workflows.save({ id, baseVersion: 1, graph: fromLibrary(shows) }, USER);
      expect(saved.valid).toBe(true);
      expect(saved.issues).toEqual([]);
    }
  });

  it('activating a version without a Library input frees the library', () => {
    const a = workflow('Downsize', fromLibrary(shows), mainWith());
    expect(world.workflows.activate(a, 1, USER).kind).toBe('ok');
    expect(world.workflows.activate(a, 2, USER).kind).toBe('ok');
    expect(findFeeder(db, shows)).toBeNull();
    expect(findWorkflow(db, a)?.activeLibraryId).toBeNull();
  });
});
