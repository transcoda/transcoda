import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Capabilities } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/open.ts';
import { insertJobResult, listJobs, updateJob } from '../db/repos/jobs.ts';
import type { LibraryRow } from '../db/repos/libraries.ts';
import { listRuns } from '../db/repos/runs.ts';
import { createTestDb } from '../db/test-db.ts';
import type { Logger } from '../logger.ts';
import { WorkflowService } from '../workflows/service.ts';
import { chain, node, testRegistry } from '../workflows/test-helpers.ts';
import { CATCH_UP_BY, LibraryCatchUp } from './catch-up.ts';
import { EngineEvents } from './events.ts';
import { fingerprintKey, fingerprintOf } from './fingerprint.ts';
import { tempDir } from './fixtures.ts';
import { nodeFsOps } from './fs-ops.ts';
import { QueueService } from './queue-service.ts';

const caps: Capabilities = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '7.1',
  encoders: ['aac', 'libx264', 'libx265'],
  hwaccels: [],
  filters: ['pan'],
};
const HOUR_AGO = (): Date => new Date(Date.now() - 60 * 60 * 1000);

let base: string;
let root: string;
let db: Database;
let workflows: WorkflowService;
let queue: QueueService;
let log: Logger;
let lib: LibraryRow;
let flowId: string;
let catchUp: LibraryCatchUp;

/** A Library input → replace original workflow for `libraryId`, v2 activated when `active`. */
function feed(libraryId: string, active: boolean): string {
  const { id } = workflows.create({ name: 'Cleanup', kind: 'workflow' }, 'u');
  workflows.save(
    {
      id,
      baseVersion: 1,
      graph: chain(
        'workflow',
        node('in', 'core:input-library', { libraryId }),
        node('ro', 'core:replace-original'),
      ),
    },
    'u',
  );
  if (active) expect(workflows.activate(id, 2, 'u').kind).toBe('ok');
  return id;
}

/** A media file backdated an hour, so the settle window never sees it as growing. */
async function settled(path: string, body = 'x'): Promise<string> {
  await writeFile(path, body);
  await utimes(path, HOUR_AGO(), HOUR_AGO());
  return path;
}

/** "Scan now": the whole library, real, through its feeder. */
async function scanNow(library: LibraryRow): Promise<void> {
  const r = await queue.queue({
    path: library.path,
    dryRun: false,
    force: false,
    priority: 0,
    createdBy: 'u1',
  });
  expect(r.kind).toBe('queued');
}

const jobPaths = (runId: string) =>
  listJobs(db, { runId })
    .map((j) => j.path)
    .sort();

beforeEach(async () => {
  base = await tempDir('catch-up-');
  root = join(base, 'movies');
  await mkdir(root, { recursive: true });
  db = createTestDb();
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  workflows = new WorkflowService({
    db,
    registry: testRegistry(),
    capabilities: () => caps,
    now: () => new Date(),
    log,
  });
  queue = new QueueService({
    db,
    workflows,
    events: new EngineEvents(),
    now: () => new Date(),
    fs: nodeFsOps,
    settleMinutes: 3,
    onQueued: vi.fn(),
  });
  const created = await queue.createLibrary({ name: 'Movies', path: root });
  if (!('id' in created)) throw new Error('library not created');
  lib = created;
  flowId = feed(lib.id, true);
  catchUp = new LibraryCatchUp({ db, queue, log });
});

afterEach(async () => {
  catchUp.stop();
  vi.useRealTimers();
  db.close();
  await rm(base, { recursive: true, force: true });
});

describe('LibraryCatchUp.scanAll', () => {
  it('a new file in an existing, already scanned library gets a job without Scan now', async () => {
    await settled(join(root, 'Old.mkv'));
    await scanNow(lib);
    const before = listRuns(db, { limit: 10 }).length;

    const added = await settled(join(root, 'New.mkv'));
    await catchUp.scanAll();

    const runs = listRuns(db, { limit: 10 });
    expect(runs).toHaveLength(before + 1);
    const run = runs[0];
    expect(run?.source).toBe('library');
    expect(run?.createdBy).toBe(CATCH_UP_BY);
    expect(run?.dryRun).toBe(false);
    // Only the new file: the one Scan now already queued is left alone.
    expect(jobPaths(run?.id ?? '')).toEqual([added]);
    expect(listJobs(db, { runId: run?.id ?? '' })[0]?.state).toBe('queued');
  });

  it('a library with no new files gets no run at all', async () => {
    await settled(join(root, 'Old.mkv'));
    await scanNow(lib);
    const before = listRuns(db, { limit: 10 }).length;
    await catchUp.scanAll();
    await catchUp.scanAll();
    expect(listRuns(db, { limit: 10 })).toHaveLength(before);
  });

  it('queues every file the library has never seen on the first scan', async () => {
    const a = await settled(join(root, 'A.mkv'));
    const b = await settled(join(root, 'B.mkv'));
    await catchUp.scanAll();
    const runs = listRuns(db, { limit: 10 });
    expect(runs).toHaveLength(1);
    expect(jobPaths(runs[0]?.id ?? '')).toEqual([a, b].sort());
  });

  it('a file still being copied is not queued (no skipped row) until it has settled', async () => {
    const growing = join(root, 'Copying.mkv');
    await writeFile(growing, 'x');
    await catchUp.scanAll();
    expect(listRuns(db, { limit: 10 })).toHaveLength(0);

    await utimes(growing, HOUR_AGO(), HOUR_AGO());
    await catchUp.scanAll();
    const runs = listRuns(db, { limit: 10 });
    expect(runs).toHaveLength(1);
    expect(jobPaths(runs[0]?.id ?? '')).toEqual([growing]);
  });

  it('a file the feed already wrote is not queued again; one replaced by someone else is', async () => {
    const mine = await settled(join(root, 'Mine.mkv'));
    const theirs = await settled(join(root, 'Theirs.mkv'));
    await scanNow(lib);
    const [run] = listRuns(db, { limit: 1 });
    const jobs = listJobs(db, { runId: run?.id ?? '' });
    const mineJob = jobs.find((j) => j.path === mine);
    if (!mineJob) throw new Error('no job for Mine.mkv');
    const sourceFp = fingerprintKey(await fingerprintOf(mine));
    // Both jobs have ended: Mine.mkv replaced, Theirs.mkv left as it was.
    for (const j of jobs) {
      updateJob(db, j.id, { state: j.path === mine ? 'done' : 'nothing_to_do' }, new Date());
    }

    // Transcoda replaces Mine.mkv; a downloader upgrades Theirs.mkv.
    await rm(mine);
    await settled(mine, 'smaller');
    insertJobResult(db, {
      jobId: mineJob.id,
      fingerprint: sourceFp,
      outputFingerprint: fingerprintKey(await fingerprintOf(mine)),
      workflowId: flowId,
      workflowVersion: 2,
      outcome: 'done',
      beforeBytes: 1,
      afterBytes: 7,
      estimatedBytes: null,
      command: null,
      plan: null,
      replacedTo: 'recycle',
      logPath: null,
      warnings: [],
      problems: [],
      outputProbe: null,
      sourceDamaged: false,
      createdAt: new Date().toISOString(),
    });
    await rm(theirs);
    await settled(theirs, 'a better release');

    await catchUp.scanAll();
    const [latest] = listRuns(db, { limit: 1 });
    expect(latest?.id).not.toBe(run?.id);
    expect(jobPaths(latest?.id ?? '')).toEqual([theirs]);
  });

  it('leaves a library nobody feeds alone, and keeps scanning the others', async () => {
    const otherRoot = join(base, 'shows');
    await mkdir(otherRoot);
    const other = await queue.createLibrary({ name: 'Shows', path: otherRoot });
    if (!('id' in other)) throw new Error('library not created');
    feed(other.id, false);
    await settled(join(otherRoot, 'Episode.mkv'));
    const movie = await settled(join(root, 'Movie.mkv'));

    await catchUp.scanAll();
    const runs = listRuns(db, { limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.libraryId).toBe(lib.id);
    expect(jobPaths(runs[0]?.id ?? '')).toEqual([movie]);
  });

  it('an unreachable library root is logged and the scan goes on', async () => {
    await rm(root, { recursive: true, force: true });
    await expect(catchUp.scanAll()).resolves.toBe(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Movies'));
  });
});

describe('LibraryCatchUp.start', () => {
  it('scans shortly after start and then on every interval until stopped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const timed = new LibraryCatchUp({ db, queue, log, firstDelayMs: 1000, intervalMs: 5000 });
    const spy = vi.spyOn(timed, 'scanAll').mockResolvedValue(0);
    timed.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(spy).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spy).toHaveBeenCalledTimes(3);
    timed.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('never runs two scans at once', async () => {
    let release: () => void = () => {};
    const timed = new LibraryCatchUp({ db, queue, log, firstDelayMs: 0, intervalMs: 10 });
    const spy = vi.spyOn(timed, 'scanAll').mockImplementation(
      () =>
        new Promise<number>((res) => {
          release = () => res(0);
        }),
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    timed.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(spy).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(spy).toHaveBeenCalledTimes(2);
    timed.stop();
  });
});
