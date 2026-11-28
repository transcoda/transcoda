// Shared setup for the QueueService tests (queue-service*.test.ts): a temp library with a fed
// workflow, the service over a test database, the events it publishes, and queueing helpers.
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Capabilities } from '@transcoda/contract';
import { afterEach, beforeEach, expect, type Mock, vi } from 'vitest';
import type { Database } from '../../../db/open.ts';
import { insertJobResult, type JobResultRow } from '../../../db/repos/jobs/jobs.ts';
import type { LibraryRow } from '../../../db/repos/libraries.ts';
import { createTestDb } from '../../../db/testing.ts';
import type { Logger } from '../../../platform/logger.ts';
import { WorkflowService } from '../../../workflows/service.ts';
import { chain, node, testRegistry } from '../../../workflows/test-helpers.ts';
import { type EngineEvent, EngineEvents } from '../../events.ts';
import { tempDir } from '../../testing/fixtures.ts';
import { type QueueInput, QueueService } from '../queue-service.ts';

export const caps: Capabilities = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '7.1',
  encoders: ['aac', 'libx264', 'libx265'],
  hwaccels: [],
  filters: ['pan'],
};
const HOUR_AGO = (): Date => new Date(Date.now() - 60 * 60 * 1000);
export let base: string;
export let root: string;
export let outside: string;
export let db: Database;
export let workflows: WorkflowService;
export let events: EngineEvents;
export let published: EngineEvent[];
export let onQueued: Mock<() => void>;
export let svc: QueueService;
export let flowId: string;
export let lib: LibraryRow;

/**
 * A valid workflow (manual input → replace original) as v2, activated when `active`. With
 * `libraryId` its input is a Library input naming that library, so activating it feeds the library.
 */
export function makeWorkflow(name: string, active: boolean, libraryId?: string): string {
  const { id } = workflows.create({ name, kind: 'workflow' }, 'u');
  workflows.save(
    {
      id,
      baseVersion: 1,
      graph: chain(
        'workflow',
        libraryId === undefined
          ? node('in', 'core:input-manual')
          : node('in', 'core:input-library', { libraryId }),
        node('ro', 'core:replace-original'),
      ),
    },
    'u',
  );
  if (active) expect(workflows.activate(id, 2, 'u').kind).toBe('ok');
  return id;
}

/** Saves the same valid graph again `n` times (versions 3, 4, …). */
export function saveMore(id: string, n: number): void {
  for (let i = 0; i < n; i++) {
    const cur = workflows.get(id);
    if (!cur) throw new Error('no workflow');
    workflows.save({ id, baseVersion: cur.currentVersion, graph: cur.graph }, 'u');
  }
}

/** An empty media file, backdated an hour so the settle window never sees it as growing. */
export async function settled(path: string): Promise<string> {
  await writeFile(path, 'x');
  await utimes(path, HOUR_AGO(), HOUR_AGO());
  return path;
}

export function input(path: string, extra: Partial<QueueInput> = {}): QueueInput {
  return { path, dryRun: false, force: false, priority: 0, createdBy: 'u1', ...extra };
}

export async function queued(path: string, extra: Partial<QueueInput> = {}) {
  const r = await svc.queue(input(path, extra));
  if (r.kind !== 'queued') throw new Error(`expected queued, got ${JSON.stringify(r)}`);
  return r;
}

/** Ends every job still queued, so a rescan isn't skipped for a file another run holds. */
export function cancelQueued() {
  db.prepare("UPDATE jobs SET state = 'cancelled', finished_at = ? WHERE state = 'queued'").run(
    new Date().toISOString(),
  );
}

export function doneResult(jobId: string, fingerprint: string, extra: Partial<JobResultRow> = {}) {
  insertJobResult(db, {
    jobId,
    fingerprint,
    workflowId: flowId,
    workflowVersion: 2,
    outcome: 'done',
    beforeBytes: 1000,
    afterBytes: 400,
    estimatedBytes: null,
    command: null,
    plan: null,
    replacedTo: 'recycle',
    logPath: null,
    warnings: [],
    problems: [],
    outputProbe: null,
    sourceDamaged: false,
    createdAt: '2026-10-01T10:00:00.000Z',
    ...extra,
  });
}

/** Registers the setup and teardown every test in these files shares. */
export function useQueueService(): void {
  beforeEach(async () => {
    base = await tempDir('queue-');
    root = join(base, 'lib');
    outside = join(base, 'outside');
    await mkdir(join(root, 'Show', 'Season 1'), { recursive: true });
    await mkdir(outside, { recursive: true });
    db = createTestDb();
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    workflows = new WorkflowService({
      db,
      registry: testRegistry(),
      capabilities: () => caps,
      now: () => new Date(),
      log,
    });
    events = new EngineEvents();
    published = [];
    const publish = events.publish.bind(events);
    vi.spyOn(events, 'publish').mockImplementation((e) => {
      published.push(e);
      publish(e);
    });
    onQueued = vi.fn<() => void>();
    svc = new QueueService({
      db,
      workflows,
      events,
      now: () => new Date(),
      settleMinutes: 3,
      onQueued,
    });
    const created = await svc.createLibrary({ name: 'TV', path: root });
    if (!('id' in created)) throw new Error('library not created');
    lib = created;
    // The library's feeder: a queue without a workflowId uses it.
    flowId = makeWorkflow('Shrink', true, lib.id);
  });
  afterEach(async () => {
    db.close();
    await rm(base, { recursive: true, force: true });
  });
}
