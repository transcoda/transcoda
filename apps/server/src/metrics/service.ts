// One snapshot of the numbers behind `/metrics` and `system.status`: a few aggregate queries plus
// the engine's in-memory state, cached so a tight scrape interval cannot load the database.
import type { GpuLoadOutput, StatusOutput } from '@transcoda/contract';
import { RUNNING_JOB_STATES } from '@transcoda/shared';
import type { Database } from '../db/open.ts';
import { type MetricsTotals, metricsTotals } from '../db/repos/metrics.ts';
import { METRICS, type MetricName } from './catalog.ts';
import { type Labels, type MetricFamily, renderExposition } from './exposition.ts';
import { JOB_DURATION_BUCKETS, type MetricsRecorder } from './recorder.ts';

/** A snapshot is reused for this long. */
export const METRICS_CACHE_MS = 5_000;

export interface MetricsServiceDeps {
  db: Database;
  version: string;
  now: () => Date;
  queuePaused: () => boolean;
  gpuLoad: () => GpuLoadOutput;
  /** Free bytes on the transcode folder; may throw. */
  scratchFreeBytes: () => Promise<number>;
  /** How long to wait for `scratchFreeBytes` before reporting it unavailable. */
  scratchTimeoutMs?: number;
  recorder: MetricsRecorder;
}

/** A stalled filesystem (a hung network mount) must not hold up the snapshot. */
export const SCRATCH_TIMEOUT_MS = 2_000;

/** The read's result, or null when it fails or takes longer than `ms`. */
async function withTimeout(read: () => Promise<number>, ms: number): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([read().catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface Snapshot {
  totals: MetricsTotals;
  /** Library id → label (its name; `name (id prefix)` when two live libraries share it). */
  names: Map<string, string>;
  queuePaused: boolean;
  scratchFreeBytes: number | null;
  encoders: ReturnType<MetricsRecorder['encoderBusy']>;
  durations: ReturnType<MetricsRecorder['jobDurations']>;
  media: ReturnType<MetricsRecorder['jobMediaSeconds']>;
  gpus: GpuLoadOutput['gpus'];
}

const RUNNING = new Set<string>(RUNNING_JOB_STATES);

function libraryNames(libraries: MetricsTotals['libraries']): Map<string, string> {
  const count = new Map<string, number>();
  for (const l of libraries) count.set(l.name, (count.get(l.name) ?? 0) + 1);
  return new Map(
    libraries.map((l) => [
      l.id,
      (count.get(l.name) ?? 0) > 1 ? `${l.name} (${l.id.slice(0, 8)})` : l.name,
    ]),
  );
}

export class MetricsService {
  private cache: { at: number; snapshot: Snapshot } | null = null;
  private inflight: Promise<Snapshot> | null = null;

  constructor(private readonly deps: MetricsServiceDeps) {}

  private snapshot(): Promise<Snapshot> {
    const now = this.deps.now().getTime();
    const age = this.cache ? now - this.cache.at : -1;
    // A negative age means the clock moved backward: the snapshot's age is unknown, take a new one.
    if (this.cache && age >= 0 && age < METRICS_CACHE_MS) {
      return Promise.resolve(this.cache.snapshot);
    }
    this.inflight ??= this.take().then(
      (snapshot) => {
        this.cache = { at: now, snapshot };
        this.inflight = null;
        return snapshot;
      },
      (err: unknown) => {
        this.inflight = null;
        throw err;
      },
    );
    return this.inflight;
  }

  private async take(): Promise<Snapshot> {
    const { deps } = this;
    const scratchFreeBytes = await withTimeout(
      deps.scratchFreeBytes,
      deps.scratchTimeoutMs ?? SCRATCH_TIMEOUT_MS,
    );
    const totals = metricsTotals(deps.db);
    return {
      totals,
      names: libraryNames(totals.libraries),
      queuePaused: deps.queuePaused(),
      scratchFreeBytes,
      encoders: deps.recorder.encoderBusy(),
      durations: deps.recorder.jobDurations(),
      media: deps.recorder.jobMediaSeconds(),
      gpus: deps.gpuLoad().gpus,
    };
  }

  async exposition(): Promise<string> {
    return renderExposition(this.families(await this.snapshot()));
  }

  private families(s: Snapshot): MetricFamily[] {
    const lib = (id: string): string => s.names.get(id) ?? id;
    const perLib = (pick: (r: MetricsTotals['perLibrary'][number]) => number) =>
      s.totals.perLibrary.map((r) => ({ labels: { library: lib(r.libraryId) }, value: pick(r) }));
    const pausedByLib = new Map<string, number>();
    for (const a of s.totals.active) {
      pausedByLib.set(a.libraryId, (pausedByLib.get(a.libraryId) ?? 0) + a.paused);
    }
    const scalar: Record<
      Exclude<MetricName, 'transcoda_job_duration_seconds'>,
      { labels: Labels; value: number }[]
    > = {
      transcoda_build_info: [{ labels: { version: this.deps.version }, value: 1 }],
      transcoda_queue_paused: [{ labels: {}, value: s.queuePaused ? 1 : 0 }],
      transcoda_jobs: s.totals.active.map((a) => ({
        labels: { library: lib(a.libraryId), state: a.state, lane: a.lane ?? '' },
        value: a.jobs,
      })),
      transcoda_jobs_paused: s.totals.libraries.map((l) => ({
        labels: { library: lib(l.id) },
        value: pausedByLib.get(l.id) ?? 0,
      })),
      transcoda_jobs_finished: s.totals.finished.map((f) => ({
        labels: { library: lib(f.libraryId), outcome: f.outcome },
        value: f.jobs,
      })),
      transcoda_job_retries: perLib((r) => r.retries),
      transcoda_source_bytes: perLib((r) => r.sourceBytes),
      transcoda_output_bytes: perLib((r) => r.outputBytes),
      transcoda_saved_bytes: perLib((r) => r.savedBytes),
      transcoda_processed_media_seconds: perLib((r) => r.mediaSeconds),
      transcoda_job_media_seconds_total: s.media,
      transcoda_encoder_busy: s.encoders.map((e) => ({
        labels: { encoder: e.encoder },
        value: e.busy ? 1 : 0,
      })),
      transcoda_encoder_busy_seconds_total: s.encoders.map((e) => ({
        labels: { encoder: e.encoder },
        value: e.seconds,
      })),
      transcoda_gpu_utilization_ratio: s.gpus.flatMap((g) => {
        const last = g.samples[g.samples.length - 1];
        if (!last) return [];
        return [
          { labels: { gpu: g.id, engine: 'encoder' }, value: last.encoder / 100 },
          { labels: { gpu: g.id, engine: 'decoder' }, value: last.decoder / 100 },
        ];
      }),
      transcoda_recycle_bytes: perLib((r) => r.recycleBytes),
      transcoda_recycle_files: perLib((r) => r.recycleFiles),
      transcoda_library_files: perLib((r) => r.files),
      transcoda_runs: s.totals.runs.map((r) => ({
        labels: { library: lib(r.libraryId), source: r.source },
        value: r.runs,
      })),
      transcoda_scratch_free_bytes:
        s.scratchFreeBytes === null ? [] : [{ labels: {}, value: s.scratchFreeBytes }],
    };
    return METRICS.map((m): MetricFamily => {
      if (m.name === 'transcoda_job_duration_seconds') {
        return {
          name: m.name,
          type: 'histogram',
          help: m.help,
          buckets: JOB_DURATION_BUCKETS,
          samples: s.durations,
        };
      }
      return {
        name: m.name,
        type: m.type as 'gauge' | 'counter',
        help: m.help,
        samples: scalar[m.name],
      };
    });
  }

  async status(): Promise<StatusOutput> {
    const s = await this.snapshot();
    const { totals } = s;
    const perLib = new Map(
      totals.libraries.map((l) => [
        l.id,
        { queued: 0, running: 0, savedBytes: 0, recycleBytes: 0 },
      ]),
    );
    let queued = 0;
    let running = 0;
    let paused = 0;
    for (const a of totals.active) {
      const row = perLib.get(a.libraryId);
      if (a.state === 'queued') {
        queued += a.jobs;
        if (row) row.queued += a.jobs;
      } else if (RUNNING.has(a.state)) {
        running += a.jobs;
        if (row) row.running += a.jobs;
      }
      paused += a.paused;
    }
    const sum = (pick: (r: MetricsTotals['perLibrary'][number]) => number) =>
      totals.perLibrary.reduce((n, r) => n + pick(r), 0);
    for (const r of totals.perLibrary) {
      const row = perLib.get(r.libraryId);
      if (row) {
        row.savedBytes = r.savedBytes;
        row.recycleBytes = r.recycleBytes;
      }
    }
    return {
      version: this.deps.version,
      queuePaused: s.queuePaused,
      jobs: {
        queued,
        running,
        paused,
        failed: totals.finished
          .filter((f) => f.outcome === 'failed')
          .reduce((n, f) => n + f.jobs, 0),
        finished: totals.finished.reduce((n, f) => n + f.jobs, 0),
      },
      encoders: { busy: s.encoders.filter((e) => e.busy).length, total: s.encoders.length },
      savedBytes: sum((r) => r.savedBytes),
      sourceBytes: sum((r) => r.sourceBytes),
      outputBytes: sum((r) => r.outputBytes),
      recycleBytes: sum((r) => r.recycleBytes),
      recycleFiles: sum((r) => r.recycleFiles),
      scratchFreeBytes: s.scratchFreeBytes,
      libraries: totals.libraries.map((l) => ({
        name: s.names.get(l.id) ?? l.name,
        ...(perLib.get(l.id) ?? { queued: 0, running: 0, savedBytes: 0, recycleBytes: 0 }),
      })),
    };
  }
}
