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
import { CATCH_UP_BY, LibraryCatchUp, type WatchFn } from './catch-up.ts';
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

describe('LibraryCatchUp review fixes', () => {
  it('queues nothing when the library gets another feeder while its folder is being listed', async () => {
    await settled(join(root, 'New.mkv'));
    const otherRoot = join(base, 'shows');
    await mkdir(otherRoot);
    const other = await queue.createLibrary({ name: 'Shows', path: otherRoot });
    if (!('id' in other)) throw new Error('library not created');
    // While the scan lists Movies, its workflow is moved to feed Shows instead.
    const racing = new QueueService({
      db,
      workflows,
      events: new EngineEvents(),
      now: () => new Date(),
      fs: {
        ...nodeFsOps,
        readdir: async (p) => {
          db.prepare('UPDATE workflows SET active_library_id = ? WHERE id = ?').run(
            other.id,
            flowId,
          );
          return nodeFsOps.readdir(p);
        },
      },
      settleMinutes: 3,
      onQueued: vi.fn(),
    });
    expect((await racing.queueNew(root, CATCH_UP_BY)).kind).toBe('nothing-new');
    expect(listRuns(db, { limit: 10 })).toHaveLength(0);
  });

  it('a library whose scan hangs (a share that stopped answering) does not hold up the others', async () => {
    const otherRoot = join(base, 'shows');
    await mkdir(otherRoot);
    const other = await queue.createLibrary({ name: 'Shows', path: otherRoot });
    if (!('id' in other)) throw new Error('library not created');
    feed(other.id, true);
    const queueNew = vi.fn<QueueService['queueNew']>((path) =>
      path === root ? new Promise(() => {}) : Promise.resolve({ kind: 'nothing-new' }),
    );
    const stuck = new LibraryCatchUp({ db, queue: { queueNew }, log, scanTimeoutMs: 1000 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const first = stuck.scanAll();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(first).resolves.toBe(0);
    expect(queueNew.mock.calls.map(([p]) => p)).toEqual([root, otherRoot]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Movies'));

    // The next scan leaves the hung library alone (no second stuck call) and scans the rest.
    await stuck.scanAll();
    expect(queueNew.mock.calls.map(([p]) => p)).toEqual([root, otherRoot, otherRoot]);
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

/** A fake `watch`: records each watcher so a test can send it events or errors. */
function fakeWatch() {
  const open: { root: string; change(name: string | null): void; fail(err: Error): void }[] = [];
  let closed = 0;
  const watch: WatchFn = (root, onChange, onError) => {
    const w = { root, change: onChange, fail: onError };
    open.push(w);
    return {
      close() {
        closed++;
        open.splice(open.indexOf(w), 1);
      },
    };
  };
  return { watch, open, closed: () => closed };
}

describe('LibraryCatchUp watching', () => {
  const fakeTimers = () =>
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });

  it('watches each fed library with watching on; not one nobody feeds or one switched off', async () => {
    const shows = join(base, 'shows');
    const docs = join(base, 'docs');
    await mkdir(shows);
    await mkdir(docs);
    const s = await queue.createLibrary({ name: 'Shows', path: shows });
    const d = await queue.createLibrary({ name: 'Docs', path: docs, watchFolder: false });
    if (!('id' in s) || !('id' in d)) throw new Error('library not created');
    feed(d.id, true);
    const fake = fakeWatch();
    const watched = new LibraryCatchUp({ db, queue, log, watch: fake.watch });
    watched.syncWatchers();
    expect(fake.open.map((w) => w.root)).toEqual([root]);

    // Switching it off (or the feed going away) closes the watcher at the next sync.
    queue.updateLibrary(lib.id, { watchFolder: false });
    watched.syncWatchers();
    expect(fake.open).toEqual([]);
    expect(fake.closed()).toBe(1);
    watched.stop();
  });

  it('a burst of events gives one scan of that library, after the settle window', async () => {
    const fake = fakeWatch();
    const watched = new LibraryCatchUp({
      db,
      queue,
      log,
      watch: fake.watch,
      settleMinutes: 3,
      quietMs: 10_000,
    });
    const queueNew = vi.spyOn(queue, 'queueNew');
    fakeTimers();
    watched.syncWatchers();
    const [w] = fake.open;
    if (!w) throw new Error('not watched');
    for (let i = 0; i < 20; i++) w.change(`New ${i}.mkv`);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    w.change('New 20.mkv');
    // Quiet for the settle window plus the quiet time after the last event: then one scan.
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 9_999);
    expect(queueNew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(queueNew).toHaveBeenCalledTimes(1);
    expect(queueNew).toHaveBeenCalledWith(root, CATCH_UP_BY);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(queueNew).toHaveBeenCalledTimes(1);
    watched.stop();
  });

  it("ignores events in the recycle folder and Transcoda's own temp files", async () => {
    const fake = fakeWatch();
    const watched = new LibraryCatchUp({ db, queue, log, watch: fake.watch, settleMinutes: 0 });
    const queueNew = vi.spyOn(queue, 'queueNew');
    fakeTimers();
    watched.syncWatchers();
    const [w] = fake.open;
    w?.change('.transcoda-recycle/Old.mkv');
    w?.change('.transcoda-recycle');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queueNew).not.toHaveBeenCalled();
    watched.stop();
  });

  it('a changed recycle folder applies to the running watcher', async () => {
    await mkdir(join(root, 'Trash'));
    queue.updateLibrary(lib.id, { recycleFolder: 'Trash' });
    const fake = fakeWatch();
    const watched = new LibraryCatchUp({ db, queue, log, watch: fake.watch, settleMinutes: 0 });
    const queueNew = vi.spyOn(queue, 'queueNew');
    fakeTimers();
    watched.syncWatchers();
    fake.open[0]?.change('Trash/Old.mkv');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queueNew).not.toHaveBeenCalled();

    // Back to the default recycle folder: Trash is part of the library again.
    queue.updateLibrary(lib.id, { recycleFolder: null });
    watched.syncWatchers();
    expect(fake.open).toHaveLength(1);
    fake.open[0]?.change('Trash/New.mkv');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queueNew).toHaveBeenCalledTimes(1);
    watched.stop();
  });

  it('a watcher that cannot start is logged once; the timed scan still finds the file', async () => {
    const watch: WatchFn = () => {
      throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), {
        code: 'ENOSPC',
      });
    };
    const watched = new LibraryCatchUp({ db, queue, log, watch });
    expect(() => watched.syncWatchers()).not.toThrow();
    watched.syncWatchers();
    const warnings = vi.mocked(log.warn).mock.calls.filter(([m]) => String(m).includes('watch'));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toContain('Movies');

    const added = await settled(join(root, 'New.mkv'));
    await watched.scanAll();
    const [run] = listRuns(db, { limit: 1 });
    expect(jobPaths(run?.id ?? '')).toEqual([added]);
    watched.stop();
  });

  it('a watcher that errors later is closed and logged once; nothing throws', async () => {
    const fake = fakeWatch();
    const watched = new LibraryCatchUp({ db, queue, log, watch: fake.watch });
    watched.syncWatchers();
    const [w] = fake.open;
    expect(() => w?.fail(new Error('EIO: watched folder went away'))).not.toThrow();
    expect(fake.open).toEqual([]);
    watched.syncWatchers();
    expect(fake.open).toEqual([]);
    const warnings = vi.mocked(log.warn).mock.calls.filter(([m]) => String(m).includes('watch'));
    expect(warnings).toHaveLength(1);
    watched.stop();
  });

  it('a watcher scan still waiting behind another scan does not run after stop', async () => {
    const fake = fakeWatch();
    const watched = new LibraryCatchUp({
      db,
      queue,
      log,
      watch: fake.watch,
      firstDelayMs: 0,
      settleMinutes: 0,
      quietMs: 10,
    });
    let release: () => void = () => {};
    const queueNew = vi.spyOn(queue, 'queueNew').mockImplementation(
      () =>
        new Promise((res) => {
          release = () => res({ kind: 'nothing-new' });
        }),
    );
    fakeTimers();
    watched.start();
    // The timed scan is running; an event schedules an early scan, which waits behind it.
    await vi.advanceTimersByTimeAsync(0);
    expect(queueNew).toHaveBeenCalledTimes(1);
    fake.open[0]?.change('New.mkv');
    await vi.advanceTimersByTimeAsync(10);
    watched.stop();
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queueNew).toHaveBeenCalledTimes(1);
  });

  it('a file the watcher never reported is still queued by the timed scan', async () => {
    const fake = fakeWatch();
    const watched = new LibraryCatchUp({ db, queue, log, watch: fake.watch });
    watched.syncWatchers();
    const added = await settled(join(root, 'Missed.mkv'));
    await watched.scanAll();
    const [run] = listRuns(db, { limit: 1 });
    expect(jobPaths(run?.id ?? '')).toEqual([added]);
    watched.stop();
  });

  it('with the real fs.watch, a file copied into a subfolder is queued without the timed scan', async () => {
    await mkdir(join(root, 'Film (2024)'));
    const watched = new LibraryCatchUp({ db, queue, log, settleMinutes: 0, quietMs: 50 });
    watched.syncWatchers();
    // Give the watcher a moment to attach before writing.
    await new Promise((r) => setTimeout(r, 200));
    // A finished copy: older than the queue's settle window.
    const added = await settled(join(root, 'Film (2024)', 'Film.mkv'));
    await vi.waitFor(
      () => {
        const [run] = listRuns(db, { limit: 1 });
        expect(jobPaths(run?.id ?? '')).toEqual([added]);
      },
      { timeout: 5000, interval: 50 },
    );
    watched.stop();
  });
});
