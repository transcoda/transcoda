import type { Capabilities } from '@transcoda/contract';
import type { AnyNodeDefinition } from '@transcoda/sdk';
import type { WorkflowGraph } from '@transcoda/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/open.ts';
import { createTestDb } from '../db/test-db.ts';
import type { Logger } from '../logger.ts';
import { WorkflowService } from '../workflows/service.ts';
import { bumpV1, bumpV2, bumpV3, chain, node, testRegistry } from '../workflows/test-helpers.ts';
import { loadWorkflowForJob } from './load-workflow.ts';

const caps: Capabilities = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '7.1',
  encoders: ['aac'],
  hwaccels: [],
  filters: ['pan'],
};
const NOW = new Date('2026-10-16T20:00:00.000Z');

let db: Database;

function service(...defs: AnyNodeDefinition[]): WorkflowService {
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return new WorkflowService({
    db,
    registry: testRegistry(...defs),
    capabilities: () => caps,
    now: () => NOW,
    log,
  });
}

/** in → bump → replace-original, with the bump node at `typeVersion`. */
function bumpGraph(typeVersion: number, settings: Record<string, string | number> = {}) {
  return chain(
    'workflow',
    node('in', 'core:input-manual'),
    node('b', 'test:bump', { level: 2, ...settings }, { typeVersion }),
    node('ro', 'core:replace-original'),
  );
}

/** A saved workflow with `graph` as version 2; returns its id. */
function make(svc: WorkflowService, graph: WorkflowGraph): string {
  const { id } = svc.create({ name: 'Flow', kind: 'workflow' }, 'u');
  svc.save({ id, baseVersion: 1, graph }, 'u');
  return id;
}

beforeEach(() => {
  db = createTestDb();
});

describe('loadWorkflowForJob', () => {
  it('a real job on a workflow with active v2 and newest v4 loads v2; a dry-run job pinned to v4 loads v4', () => {
    const svc = service(bumpV1());
    const id = make(svc, bumpGraph(1));
    svc.save({ id, baseVersion: 2, graph: bumpGraph(1, { extra: 'a' }) }, 'u');
    svc.save({ id, baseVersion: 3, graph: bumpGraph(1, { extra: 'b' }) }, 'u');
    expect(svc.activate(id, 2, 'u').kind).toBe('ok');
    const real = loadWorkflowForJob(svc, { workflowId: id, workflowVersion: 4, dryRun: false });
    expect(real).toMatchObject({ kind: 'ok', version: 2 });
    if (real.kind !== 'ok') throw new Error('expected ok');
    expect(real.graph.nodes.map((n) => n.id)).toEqual(['in', 'b', 'ro', 'render-1']);
    expect(
      loadWorkflowForJob(svc, { workflowId: id, workflowVersion: 4, dryRun: true }),
    ).toMatchObject({
      kind: 'ok',
      version: 4,
    });
  });

  it('a real job with nothing active is not-active; a dry-run job with nothing active still loads its version', () => {
    const svc = service(bumpV1());
    const id = make(svc, bumpGraph(1));
    expect(loadWorkflowForJob(svc, { workflowId: id, workflowVersion: 2, dryRun: false })).toEqual({
      kind: 'not-active',
    });
    expect(
      loadWorkflowForJob(svc, { workflowId: id, workflowVersion: 2, dryRun: true }),
    ).toMatchObject({
      kind: 'ok',
      version: 2,
    });
  });

  it('a real job whose active version has a behaviour migration pending is invalid, never the newest', () => {
    const id = make(service(bumpV2()), bumpGraph(2, { label: 'x' }));
    expect(service(bumpV2()).activate(id, 2, 'u').kind).toBe('ok');
    // A newer, runnable version exists, but the active one is what a real job loads.
    const svc = service(bumpV3());
    svc.save({ id, baseVersion: 2, graph: bumpGraph(3, { label: 'x' }) }, 'u');
    const loaded = loadWorkflowForJob(svc, { workflowId: id, workflowVersion: 3, dryRun: false });
    expect(loaded.kind).toBe('invalid');
    if (loaded.kind !== 'invalid') return;
    expect(loaded.issues.filter((i) => i.code === 'NODE_OUTDATED')).toHaveLength(1);
  });

  it('applies all-safe migrations to the pinned version itself', () => {
    const id = make(service(bumpV1()), bumpGraph(1));
    const svc = service(bumpV2());
    const loaded = loadWorkflowForJob(svc, { workflowId: id, workflowVersion: 2, dryRun: true });
    if (loaded.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(loaded)}`);
    expect(loaded.graph.nodes[1]).toMatchObject({
      typeVersion: 2,
      settings: { level: 2, label: '' },
    });
  });

  it('applies all-safe migrations to the active version a real job loads', () => {
    const id = make(service(bumpV1()), bumpGraph(1));
    const svc = service(bumpV2());
    expect(svc.activate(id, 2, 'u').kind).toBe('ok');
    const loaded = loadWorkflowForJob(svc, { workflowId: id, workflowVersion: 2, dryRun: false });
    if (loaded.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(loaded)}`);
    expect(loaded.version).toBe(2);
    expect(loaded.graph.nodes[1]).toMatchObject({
      typeVersion: 2,
      settings: { level: 2, label: '' },
    });
  });

  it('a pinned version with a behaviour migration pending is invalid, with one issue on the node', () => {
    const id = make(service(bumpV2()), bumpGraph(2, { label: 'x' }));
    const svc = service(bumpV3());
    const loaded = loadWorkflowForJob(svc, { workflowId: id, workflowVersion: 2, dryRun: true });
    expect(loaded.kind).toBe('invalid');
    if (loaded.kind !== 'invalid') return;
    const onNode = loaded.issues.filter((i) => i.nodeId === 'b');
    expect(onNode).toEqual([
      {
        severity: 'error',
        code: 'NODE_OUTDATED',
        nodeId: 'b',
        message:
          'Bump needs a review: its upgrade from version 2 changes behaviour; save an upgraded version of the workflow and queue the file again',
      },
    ]);
  });

  it('a pinned child with a behaviour migration pending makes the job invalid', () => {
    const svc2 = service(bumpV2());
    const { id: childId } = svc2.create({ name: 'Child', kind: 'subworkflow' }, 'u');
    svc2.save(
      {
        id: childId,
        baseVersion: 1,
        graph: chain(
          'subworkflow',
          node('b', 'test:bump', { level: 1, label: '' }, { typeVersion: 2 }),
        ),
      },
      'u',
    );
    const id = make(
      svc2,
      chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('r', 'core:run-subworkflow', { subworkflowId: childId, version: 2, overrides: {} }),
        node('ro', 'core:replace-original'),
      ),
    );
    const loaded = loadWorkflowForJob(service(bumpV3()), {
      workflowId: id,
      workflowVersion: 2,
      dryRun: true,
    });
    expect(loaded.kind).toBe('invalid');
    if (loaded.kind !== 'invalid') return;
    expect(loaded.issues.map((i) => `${i.code}@${i.nodeId}`)).toContain('SUBWORKFLOW_BROKEN@r');
  });

  it('a deleted workflow or an unknown version is missing', () => {
    const svc = service(bumpV1());
    const id = make(svc, bumpGraph(1));
    expect(loadWorkflowForJob(svc, { workflowId: id, workflowVersion: 9, dryRun: true })).toEqual({
      kind: 'missing',
    });
    expect(svc.delete(id).kind).toBe('ok');
    expect(loadWorkflowForJob(svc, { workflowId: id, workflowVersion: 2, dryRun: false })).toEqual({
      kind: 'missing',
    });
  });
});
