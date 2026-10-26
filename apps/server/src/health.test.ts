import type { Capabilities } from '@transcoda/contract';
import { emptyGraph, type JobState } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { insertJob, updateJob } from './db/repos/jobs.ts';
import { insertLibrary } from './db/repos/libraries.ts';
import { insertRun } from './db/repos/runs.ts';
import { SETTING_KEYS, setSetting } from './db/repos/settings.ts';
import { insertWorkflow } from './db/repos/workflows.ts';
import { createTestDb } from './db/test-db.ts';
import type { JobSpaceWait } from './engine/space-waits.ts';
import { DEEP_HEALTH_CACHE_MS, HealthService } from './health.ts';

const T0 = new Date('2026-03-01T12:00:00.000Z');
const GIB = 1024 ** 3;
const okCaps: Capabilities = {
  available: true,
  path: 'ffmpeg',
  version: '7',
  encoders: [],
  hwaccels: [],
  filters: [],
};

function setup(
  opts: {
    caps?: Capabilities;
    freeBytes?: number;
    statfsThrows?: boolean;
    hang?: boolean;
    minFreeGiB?: number;
    stallHours?: number;
    timeoutMs?: number;
    spaceWaits?: JobSpaceWait[];
  } = {},
) {
  const db = createTestDb();
  seedParents(db);
  let t = T0.getTime();
  const logs: unknown[] = [];
  let statfsCalls = 0;
  const svc = new HealthService({
    db,
    config: {
      transcodeDir: '/secret/transcode/dir',
      healthStallHours: opts.stallHours ?? 6,
      healthMinFreeGiB: opts.minFreeGiB ?? 5,
    },
    capabilities: () => opts.caps ?? okCaps,
    fs: {
      statfs: async () => {
        statfsCalls++;
        if (opts.hang) await new Promise<never>(() => {});
        if (opts.statfsThrows) throw new Error('boom /secret/path');
        return { bavail: (opts.freeBytes ?? 100 * GIB) / 4096, bsize: 4096 };
      },
    },
    ...(opts.spaceWaits && { spaceWaits: () => opts.spaceWaits ?? [] }),
    now: () => new Date(t),
    timeoutMs: opts.timeoutMs ?? 5000,
    log: { info: (e) => logs.push(e), warn: (e) => logs.push(e), error: (e) => logs.push(e) },
  });
  return {
    db,
    svc,
    logs,
    calls: () => statfsCalls,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function addJob(
  db: ReturnType<typeof createTestDb>,
  id: string,
  state: JobState,
  updated: Date,
  paused = false,
) {
  const job = insertJob(
    db,
    {
      id,
      runId: 'r1',
      libraryId: 'l1',
      fileId: null,
      path: `/lib/${id}.mkv`,
      workflowId: 'w1',
      workflowVersion: 1,
      dryRun: false,
      testEncode: false,
      state,
      priority: 0,
    },
    updated,
  );
  if (paused) updateJob(db, job.id, { paused: true }, updated);
}

/** Parents every job needs. */
function seedParents(db: ReturnType<typeof createTestDb>) {
  insertWorkflow(
    db,
    { id: 'w1', kind: 'workflow', name: 'W', graph: emptyGraph('workflow'), createdBy: 'u' },
    T0,
  );
  insertLibrary(
    db,
    {
      id: 'l1',
      name: 'L',
      path: '/lib',
      recycleFolder: null,
      processHardlinked: false,
    },
    T0,
  );
  insertRun(
    db,
    {
      id: 'r1',
      libraryId: 'l1',
      workflowId: 'w1',
      workflowVersion: 1,
      requestedPath: '/lib',
      dryRun: false,
      testEncode: false,
      force: false,
      createdBy: 'u',
    },
    T0,
  );
}

const hoursAgo = (h: number) => new Date(T0.getTime() - h * 3600_000);

describe('HealthService.deep', () => {
  it('is all ok on a healthy server', async () => {
    const t = setup();
    expect(await t.svc.deep()).toEqual({
      database: 'ok',
      ffmpeg: 'ok',
      scratchSpace: 'ok',
      queue: 'ok',
    });
    expect(t.logs).toEqual([]);
  });

  it('fails scratchSpace under 5 GiB, even when the minimum is set lower', async () => {
    const t = setup({ freeBytes: 4 * GIB, minFreeGiB: 2 });
    expect((await t.svc.deep()).scratchSpace).toBe('fail');
  });

  it('honours a higher minimum free space', async () => {
    const t = setup({ freeBytes: 8 * GIB, minFreeGiB: 10 });
    expect((await t.svc.deep()).scratchSpace).toBe('fail');
    expect((await setup({ freeBytes: 8 * GIB }).svc.deep()).scratchSpace).toBe('ok');
  });

  it('fails scratchSpace when statfs throws, logging without leaking into the result', async () => {
    const t = setup({ statfsThrows: true });
    const r = await t.svc.deep();
    expect(r.scratchSpace).toBe('fail');
    expect(JSON.stringify(r)).not.toContain('secret');
    expect(t.logs).toEqual([
      expect.objectContaining({ msg: 'deep health check failed', check: 'scratchSpace' }),
    ]);
  });

  it('fails queue while a replace waits for free space, the wait named in the log only (C4)', async () => {
    const wait: JobSpaceWait = {
      jobId: 'j9',
      path: '/media/shows',
      neededBytes: 5_400_000_000,
      availableBytes: 5_100_000_000,
      since: '2026-10-19T14:56:00.000Z',
    };
    const t = setup({ spaceWaits: [wait] });
    const r = await t.svc.deep();
    expect(r).toEqual({ database: 'ok', ffmpeg: 'ok', scratchSpace: 'ok', queue: 'fail' });
    expect(t.logs).toEqual([
      expect.objectContaining({
        msg: 'deep health check failed',
        check: 'queue',
        error:
          'job j9 is waiting for 5.4 GB free on /media/shows (5.1 GB free) since 2026-10-19T14:56:00.000Z',
      }),
    ]);
    expect((await setup({ spaceWaits: [] }).svc.deep()).queue).toBe('ok');
    const two = setup({ spaceWaits: [wait, { ...wait, jobId: 'j10', path: '/media/movies' }] });
    await two.svc.deep();
    expect(two.logs).toEqual([
      expect.objectContaining({
        check: 'queue',
        error:
          '2 jobs wait for free space: job j9 is waiting for 5.4 GB free on /media/shows (5.1 GB free) since 2026-10-19T14:56:00.000Z; job j10 is waiting for 5.4 GB free on /media/movies (5.1 GB free) since 2026-10-19T14:56:00.000Z',
      }),
    ]);
  });

  it('fails ffmpeg when it is unavailable', async () => {
    const t = setup({ caps: { available: false, path: 'ffmpeg', error: 'nope' } });
    expect((await t.svc.deep()).ffmpeg).toBe('fail');
  });

  it('fails queue for a running job without progress for the stall window', async () => {
    const t = setup();
    addJob(t.db, 'j1', 'building', hoursAgo(7));
    expect((await t.svc.deep()).queue).toBe('fail');
  });

  it('keeps queue ok for a recently updated running job and for an old queued job', async () => {
    const a = setup();
    addJob(a.db, 'j1', 'building', hoursAgo(5));
    expect((await a.svc.deep()).queue).toBe('ok');
    const b = setup();
    addJob(b.db, 'j1', 'queued', hoursAgo(7));
    expect((await b.svc.deep()).queue).toBe('ok');
  });

  it('does not page for a paused job or a paused queue', async () => {
    const a = setup();
    addJob(a.db, 'j1', 'building', hoursAgo(7), true);
    expect((await a.svc.deep()).queue).toBe('ok');
    const b = setup();
    addJob(b.db, 'j1', 'encoding', hoursAgo(7));
    setSetting(b.db, SETTING_KEYS.queuePaused, true, T0);
    expect((await b.svc.deep()).queue).toBe('ok');
  });

  it('answers fail for a check that hangs, and caches the result', async () => {
    const t = setup({ hang: true, timeoutMs: 20 });
    expect(await t.svc.deep()).toEqual({
      database: 'ok',
      ffmpeg: 'ok',
      scratchSpace: 'fail',
      queue: 'ok',
    });
    await t.svc.deep();
    expect(t.calls()).toBe(1);
  });

  it('fails database when the db is closed', async () => {
    const t = setup();
    t.db.close();
    const r = await t.svc.deep();
    expect(r.database).toBe('fail');
    expect(t.logs).toContainEqual(
      expect.objectContaining({ msg: 'deep health check failed', check: 'database' }),
    );
  });

  it('runs one real check per cache window', async () => {
    const t = setup();
    await t.svc.deep();
    await t.svc.deep();
    expect(t.calls()).toBe(1);
    t.advance(DEEP_HEALTH_CACHE_MS - 1);
    await t.svc.deep();
    expect(t.calls()).toBe(1);
    t.advance(1);
    await t.svc.deep();
    expect(t.calls()).toBe(2);
  });

  it('shares one in-flight check between concurrent callers', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.svc.deep(), t.svc.deep()]);
    expect(a).toEqual(b);
    expect(t.calls()).toBe(1);
  });
});
