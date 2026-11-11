import { emptyGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/open.ts';
import { insertJob, insertJobResult, updateJob } from '../db/repos/jobs.ts';
import { insertLibrary } from '../db/repos/libraries.ts';
import { insertRun } from '../db/repos/runs.ts';
import { insertWorkflow } from '../db/repos/workflows.ts';
import { createTestDb } from '../db/test-db.ts';
import { METRICS } from './catalog.ts';
import { parseExposition } from './parse-exposition.ts';
import { MetricsRecorder } from './recorder.ts';
import { METRICS_CACHE_MS, MetricsService, type MetricsServiceDeps } from './service.ts';

const t0 = Date.parse('2026-01-01T00:00:00.000Z');
let db: Database;
let now: number;

function lib(id: string, name: string) {
  insertLibrary(
    db,
    { id, name, path: `/media/${id}`, recycleFolder: null, processHardlinked: false },
    new Date(t0),
  );
  insertRun(
    db,
    {
      id: `run-${id}`,
      libraryId: id,
      workflowId: 'w1',
      workflowVersion: 1,
      requestedPath: `/media/${id}`,
      dryRun: false,
      testEncode: false,
      force: false,
      createdBy: 'u',
    },
    new Date(t0),
  );
}

function job(id: string, libraryId: string, state: 'queued' | 'encoding' | 'done') {
  insertJob(
    db,
    {
      id,
      runId: `run-${libraryId}`,
      libraryId,
      fileId: null,
      path: `/media/${libraryId}/${id}.mkv`,
      workflowId: 'w1',
      workflowVersion: 1,
      dryRun: false,
      testEncode: false,
      state: 'queued',
      priority: 0,
    },
    new Date(t0),
  );
  if (state !== 'queued')
    updateJob(db, id, { state, lane: state === 'encoding' ? 'encode' : null }, new Date(t0));
}

function service(over: Partial<MetricsServiceDeps> = {}) {
  let scratchCalls = 0;
  const recorder = new MetricsRecorder({
    now: () => new Date(now),
    jobTimes: () => null,
    slots: () => [
      { id: 'encode', label: 'Encode', jobId: 'e1' },
      { id: 'nvidia:1', label: 'GPU 1', jobId: null },
    ],
  });
  const svc = new MetricsService({
    db,
    version: '0.5.0',
    now: () => new Date(now),
    queuePaused: () => true,
    gpuLoad: () => ({
      intervalMs: 5000,
      gpus: [
        {
          id: 'nvidia:0',
          index: 0,
          name: 'A',
          samples: [
            { at: '2026-01-01T00:00:00.000Z', encoder: 10, decoder: 5 },
            { at: '2026-01-01T00:00:05.000Z', encoder: 97, decoder: 41 },
          ],
        },
      ],
    }),
    scratchFreeBytes: async () => {
      scratchCalls += 1;
      return 123_000_000_000;
    },
    recorder,
    ...over,
  });
  return { svc, scratchCalls: () => scratchCalls };
}

beforeEach(() => {
  now = t0;
  db = createTestDb();
  insertWorkflow(
    db,
    { id: 'w1', kind: 'workflow', name: 'Shrink', graph: emptyGraph('workflow'), createdBy: 'u' },
    new Date(t0),
  );
});
afterEach(() => db.close());

const value = (text: string, name: string, labels: Record<string, string> = {}) =>
  parseExposition(text).samples.find(
    (s) =>
      s.name === name &&
      Object.keys(labels).every((k) => s.labels[k] === labels[k]) &&
      Object.keys(s.labels).length >= Object.keys(labels).length,
  )?.value;

describe('MetricsService.exposition', () => {
  it('writes every catalog family once, in catalog order, with the catalog type and help', async () => {
    const text = await service().svc.exposition();
    const parsed = parseExposition(text);
    expect([...parsed.types.keys()]).toEqual(METRICS.map((m) => m.name));
    for (const m of METRICS) {
      expect(parsed.types.get(m.name)).toBe(m.type);
      expect(parsed.help.get(m.name)).toBe(m.help);
    }
  });

  it('uses only the catalog labels on every sample (le on histogram buckets)', async () => {
    lib('l1', 'Movies');
    job('q', 'l1', 'queued');
    job('e1', 'l1', 'encoding');
    job('d', 'l1', 'done');
    const parsed = parseExposition(await service().svc.exposition());
    for (const s of parsed.samples) {
      const def = METRICS.find(
        (m) =>
          s.name === m.name ||
          (m.type === 'histogram' &&
            ['_bucket', '_sum', '_count'].some((x) => s.name === `${m.name}${x}`)),
      );
      expect(def, s.name).toBeDefined();
      const allowed = new Set([
        ...(def?.labels ?? []),
        ...(s.name.endsWith('_bucket') ? ['le'] : []),
      ]);
      for (const k of Object.keys(s.labels)) expect(allowed.has(k), `${s.name} ${k}`).toBe(true);
    }
  });

  it('reports the queue, jobs, encoders, GPUs, scratch space and the build', async () => {
    lib('l1', 'Movies');
    job('q', 'l1', 'queued');
    job('e1', 'l1', 'encoding');
    job('d', 'l1', 'done');
    insertJobResult(db, {
      jobId: 'd',
      fingerprint: 'k',
      workflowId: 'w1',
      workflowVersion: 1,
      outcome: 'done',
      beforeBytes: 1000,
      afterBytes: 250,
      estimatedBytes: null,
      command: null,
      plan: null,
      replacedTo: 'recycle',
      logPath: null,
      warnings: [],
      problems: [],
      outputProbe: null,
      sourceDamaged: false,
      outputFingerprint: null,
      sourceHash: null,
      outputHash: null,
      createdAt: new Date(t0).toISOString(),
    });
    const { svc } = service();
    now += 4000;
    const text = await svc.exposition();
    expect(value(text, 'transcoda_build_info', { version: '0.5.0' })).toBe(1);
    expect(value(text, 'transcoda_queue_paused')).toBe(1);
    expect(value(text, 'transcoda_jobs', { library: 'Movies', state: 'queued' })).toBe(1);
    expect(
      value(text, 'transcoda_jobs', { library: 'Movies', state: 'encoding', lane: 'encode' }),
    ).toBe(1);
    expect(value(text, 'transcoda_jobs_finished', { library: 'Movies', outcome: 'done' })).toBe(1);
    expect(value(text, 'transcoda_saved_bytes', { library: 'Movies' })).toBe(750);
    expect(value(text, 'transcoda_encoder_busy', { encoder: 'encode' })).toBe(1);
    expect(value(text, 'transcoda_encoder_busy', { encoder: 'nvidia:1' })).toBe(0);
    expect(value(text, 'transcoda_encoder_busy_seconds_total', { encoder: 'encode' })).toBe(4);
    expect(
      value(text, 'transcoda_gpu_utilization_ratio', { gpu: 'nvidia:0', engine: 'encoder' }),
    ).toBe(0.97);
    expect(
      value(text, 'transcoda_gpu_utilization_ratio', { gpu: 'nvidia:0', engine: 'decoder' }),
    ).toBe(0.41);
    expect(value(text, 'transcoda_scratch_free_bytes')).toBe(123_000_000_000);
    expect(value(text, 'transcoda_runs', { library: 'Movies', source: 'manual' })).toBe(1);
  });

  it('never writes a path or a job id', async () => {
    lib('l1', 'Movies');
    job('job-secret-id', 'l1', 'queued');
    const text = await service().svc.exposition();
    expect(text).not.toContain('/media');
    expect(text).not.toContain('job-secret-id');
  });

  it('tells two libraries with the same name apart', async () => {
    lib('aaaaaaaa-1', 'Movies');
    lib('bbbbbbbb-2', 'Movies');
    const text = await service().svc.exposition();
    const names = parseExposition(text)
      .samples.filter((s) => s.name === 'transcoda_library_files')
      .map((s) => s.labels.library);
    expect(names).toEqual(['Movies (aaaaaaaa)', 'Movies (bbbbbbbb)']);
  });

  it('leaves scratch space out when it cannot be read', async () => {
    const text = await service({
      scratchFreeBytes: async () => {
        throw new Error('EIO');
      },
    }).svc.exposition();
    expect(value(text, 'transcoda_scratch_free_bytes')).toBeUndefined();
    expect(parseExposition(text).types.get('transcoda_scratch_free_bytes')).toBe('gauge');
  });

  it(`answers from a cache for ${METRICS_CACHE_MS} ms`, async () => {
    const { svc, scratchCalls } = service();
    lib('l1', 'Movies');
    const first = await svc.exposition();
    job('q', 'l1', 'queued');
    now += METRICS_CACHE_MS - 1;
    expect(await svc.exposition()).toBe(first);
    expect(scratchCalls()).toBe(1);
    now += 1;
    expect(value(await svc.exposition(), 'transcoda_jobs', { state: 'queued' })).toBe(1);
    expect(scratchCalls()).toBe(2);
  });
});

describe('MetricsService cache and scratch space', () => {
  it('takes a new snapshot when the clock moves backward', async () => {
    const { svc, scratchCalls } = service();
    await svc.exposition();
    now -= 60_000;
    await svc.exposition();
    expect(scratchCalls()).toBe(2);
  });
});

describe('MetricsService.status', () => {
  it('sums the same snapshot into a small JSON for Home Assistant', async () => {
    lib('l1', 'Movies');
    lib('l2', 'Shows');
    job('q', 'l1', 'queued');
    job('q2', 'l2', 'queued');
    job('e1', 'l1', 'encoding');
    expect(await service().svc.status()).toEqual({
      version: '0.5.0',
      queuePaused: true,
      jobs: { queued: 2, running: 1, paused: 0, failed: 0, finished: 0 },
      encoders: { busy: 1, total: 2 },
      savedBytes: 0,
      sourceBytes: 0,
      outputBytes: 0,
      recycleBytes: 0,
      recycleFiles: 0,
      scratchFreeBytes: 123_000_000_000,
      libraries: [
        { name: 'Movies', queued: 1, running: 1, savedBytes: 0, recycleBytes: 0 },
        { name: 'Shows', queued: 1, running: 0, savedBytes: 0, recycleBytes: 0 },
      ],
    });
  });
});
