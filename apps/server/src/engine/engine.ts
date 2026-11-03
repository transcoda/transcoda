// The engine facade in AppDeps: queueing, the scheduler with the pipeline, events, startup and
// shutdown, and the read side the API serves (job detail, lists, stats, logs).
import type { Capabilities, JobHistoryOutput } from '@transcoda/contract';
import type { ProbeResult } from '@transcoda/sdk';
import {
  isFinalState,
  type JobPlan,
  type JobState,
  localDayStarts,
  type TraceEntry,
  type WorkflowGraph,
} from '@transcoda/shared';
import { z } from 'zod';
import { encodeSlots, readEncodeDevice, readGpuOrder } from '../capabilities/devices.ts';
import type { Exec } from '../capabilities/ffmpeg.ts';
import type { Config } from '../config.ts';
import type { Database } from '../db/open.ts';
import {
  allTimeSaved,
  countDependsOnSize,
  countJobsByState,
  countProblems,
  findJob,
  findJobListRow,
  findJobProbe,
  findJobResult,
  insertJobResult,
  type JobListFilter,
  type JobListRow,
  type JobResultRow,
  type JobRow,
  jobHistory,
  jobStats,
  jobsWithReplaceJournal,
  listJobs,
  listRecycledForJob,
  listTrace,
  type ReplaceJournal,
  recycledTotalsByLibrary,
  updateJob,
  type WalkStep,
} from '../db/repos/jobs.ts';
import { findLibrary, listLibraries } from '../db/repos/libraries.ts';
import { findActiveRestore } from '../db/repos/restores.ts';
import { getSettingOr, SETTING_DEFAULTS, SETTING_KEYS } from '../db/repos/settings.ts';
import { findUserById } from '../db/repos/users.ts';
import { findVersion } from '../db/repos/workflows.ts';
import type { Logger } from '../logger.ts';
import type { NodeRegistry } from '../nodes/registry.ts';
import type { PluginHooksRunner } from '../plugins/hooks.ts';
import type { PluginRestartGate } from '../plugins/restart-gate.ts';
import { graphUpgrade, type WorkflowService } from '../workflows/service.ts';
import { migratePinned } from '../workflows/validate.ts';
import { LibraryCatchUp } from './catch-up.ts';
import { contentHash } from './content-hash.ts';
import { EngineEvents } from './events.ts';
import { fingerprintKey } from './fingerprint.ts';
import type { FsOps } from './fs-ops.ts';
import { readCondensedTail } from './log-condense.ts';
import { logPathFor, Pipeline } from './pipeline.ts';
import { type JobProbe, jobProbeOf } from './probe.ts';
import type { ProcessSpawner } from './process.ts';
import { QueueService } from './queue-service.ts';
import {
  deleteRecycledEntry,
  emptyRecycle,
  pruneRecycle,
  type RecycleView,
  recycleView,
} from './recycle.ts';
import { fingerprintFromStats, type ReplaceDeps } from './replace.ts';
import { type RestoreResult, restoreRecycled } from './restore.ts';
import { closedLibraries, type RunHoursHold, runHoursHold, serverTimeZone } from './run-hours.ts';
import { pickSlot, Scheduler } from './scheduler.ts';
import { SpaceWaits } from './space-waits.ts';
import { removeOrigCopy, type SweepResult, startupSweep } from './sweep.ts';
import { type TestOutputRow, TestOutputStore } from './test-outputs.ts';

/** The part of a job log `jobLog` returns: its tail. */
export const JOB_LOG_TAIL_BYTES = 64 * 1024;

export interface EngineDeps {
  db: Database;
  config: Config;
  workflows: WorkflowService;
  registry: NodeRegistry;
  capabilities(): Capabilities;
  spawner: ProcessSpawner;
  fs: FsOps;
  exec?: Exec;
  now(): Date;
  log: Logger;
  /** Default SETTLE_MINUTES (0 in the test app). */
  settleMinutes?: number;
  /** Heartbeat of the event stream (tests shorten it). */
  heartbeatMs?: number;
  waitForSpace?: ReplaceDeps['waitForSpace'];
  /** Plugin job hooks (absent: none run). The runner's target is attached later by PluginService. */
  hooks?: PluginHooksRunner;
  /** Waits for plugins in restart backoff before a job fails on them (absent: never waits). */
  restartGate?: PluginRestartGate;
  /** The zone libraries' run hours are read in (default the server's). */
  timeZone?: string;
}

/** Everything a job screen shows. */
export interface JobDetail {
  job: JobListRow & { heldByRunHours: RunHoursHold | null };
  trace: TraceEntry[];
  result: JobResultRow | null;
  /** The probe this job was planned from (`jobs.probe`), without the raw ffprobe JSON. */
  probe: JobProbe | null;
  /** The probe verify read of the output (`job_results.output_probe`); null when none. */
  outputProbe: JobProbe | null;
  /** The pinned workflow version's graph, for the trace view; null when it cannot be read. */
  graph: WorkflowGraph | null;
  plan: JobPlan | null;
  /** The path the walk took (partial on a walk failure); [] before the walk. */
  path: WalkStep[];
  /** The kept test-encode output; null when there is none (any more). */
  testOutput: TestOutputRow | null;
  /** Why the test output was not kept or went early; null when nothing to say. */
  testOutputNote: string | null;
  /** The replaced original in the recycle folder, kept until retention removes it; null when none. */
  recycled: { path: string; keptUntil: string } | null;
  /** The restore in effect (`restoredBy` is the username); null when none. */
  restore: { restoredAt: string; restoredBy: string; outputPath: string | null } | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class EngineService {
  readonly events: EngineEvents;
  readonly pipeline: Pipeline;
  readonly scheduler: Scheduler;
  readonly queue: QueueService;
  /** Queues the files that appear in fed libraries; started by bootstrap once the engine runs. */
  readonly catchUp: LibraryCatchUp;
  /** The replaces waiting for free space now (C4; the deep health's `queue` check). */
  readonly spaceWaits = new SpaceWaits();
  /** Kept test-encode outputs: retention, sweeps and the scratch-space guard. */
  readonly testOutputs: TestOutputStore;
  /** The zone libraries' run hours are read in. */
  readonly timeZone: string;
  private readonly db: Database;

  constructor(private readonly deps: EngineDeps) {
    this.db = deps.db;
    this.timeZone = deps.timeZone ?? serverTimeZone();
    this.testOutputs = new TestOutputStore({
      db: deps.db,
      fs: deps.fs,
      config: deps.config,
      now: deps.now,
      log: deps.log,
    });
    this.events = new EngineEvents({
      now: deps.now,
      ...(deps.heartbeatMs !== undefined ? { heartbeatMs: deps.heartbeatMs } : {}),
    });
    // The encode slots now, from the GPUs, the "Encoding device" and the GPU order settings.
    const slots = () =>
      encodeSlots(deps.capabilities(), readEncodeDevice(deps.db), readGpuOrder(deps.db));
    this.pipeline = new Pipeline({
      db: deps.db,
      config: deps.config,
      workflows: deps.workflows,
      registry: deps.registry,
      capabilities: deps.capabilities,
      events: this.events,
      spawner: deps.spawner,
      fs: deps.fs,
      now: deps.now,
      log: deps.log,
      ...(deps.exec ? { exec: deps.exec } : {}),
      ...(deps.settleMinutes !== undefined ? { settleMinutes: deps.settleMinutes } : {}),
      ...(deps.waitForSpace ? { waitForSpace: deps.waitForSpace } : {}),
      spaceWaits: this.spaceWaits,
      ...(deps.hooks ? { hooks: deps.hooks } : {}),
      ...(deps.restartGate ? { restartGate: deps.restartGate } : {}),
      testOutputs: this.testOutputs,
      otherGpuFor: (fit, failed) => {
        const all = slots();
        return pickSlot(all, all, fit, failed) !== undefined;
      },
    });
    this.scheduler = new Scheduler({
      db: deps.db,
      executor: this.pipeline,
      events: this.events,
      now: deps.now,
      log: deps.log,
      // Asked at every grant, so a changed "Encoding device" applies to the next job.
      encodeSlots: slots,
      timeZone: this.timeZone,
    });
    this.queue = new QueueService({
      db: deps.db,
      workflows: deps.workflows,
      events: this.events,
      now: deps.now,
      fs: deps.fs,
      ...(deps.settleMinutes !== undefined ? { settleMinutes: deps.settleMinutes } : {}),
      onQueued: () => this.scheduler.tick(),
      onLibrariesChanged: () => this.catchUp.syncWatchers(),
    });
    this.catchUp = new LibraryCatchUp({
      db: deps.db,
      queue: this.queue,
      log: deps.log,
      ...(deps.settleMinutes !== undefined ? { settleMinutes: deps.settleMinutes } : {}),
    });
  }

  /**
   * Startup: the sweep (stale ffmpeg, journaled replaces, interrupted jobs, temp), a recycle prune,
   * the replaces the sweep left at intent `cleaning` finished (`done`), then the scheduler.
   */
  /** Why `start()` failed (the engine then stays stopped); null when it started or never ran. */
  startError: string | null = null;

  async start(): Promise<SweepResult> {
    try {
      const sweep = await this.startUp();
      this.startError = null;
      return sweep;
    } catch (err) {
      this.startError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private async startUp(): Promise<SweepResult> {
    const { db, fs, config, log } = this.deps;
    const sweep = await startupSweep(db, {
      fs,
      transcodeDir: config.transcodeDir,
      libraryRoots: listLibraries(db).map((l) => l.path),
      now: this.deps.now,
      log,
    });
    // After the temp sweep (which leaves test-outputs alone): expired and stray outputs go.
    await this.testOutputs.sweep();
    await this.pruneRecycle();
    for (const job of jobsWithReplaceJournal(db)) {
      const j = job.replaceJournal as ReplaceJournal;
      if (job.state !== 'replacing' || j.step !== 'cleaning') continue;
      await this.finishCleaning(job, j);
    }
    this.scheduler.start();
    return sweep;
  }

  /** Stops every job (processes killed, nothing written) and waits for the executors. */
  async stop(): Promise<void> {
    this.catchUp.stop();
    await this.scheduler.stop();
  }

  /** Deletes expired and stray test outputs (hourly and at start); never rejects. */
  sweepTestOutputs(): Promise<number> {
    return this.testOutputs.sweep();
  }

  /** Removes recycled originals past the retention or over the free-space share (settings). */
  async pruneRecycle(): Promise<{ removed: number; bytes: number }> {
    const { db } = this.deps;
    try {
      return await pruneRecycle(db, this.deps.fs, {
        ...this.recycleSettings(),
        now: this.deps.now(),
        log: this.deps.log,
      });
    } catch (err) {
      this.deps.log.warn({
        msg: 'recycle prune failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return { removed: 0, bytes: 0 };
    }
  }

  /** The recycle retention settings (Settings → Recycle folder). */
  recycleSettings(): { retentionDays: number; maxFreePercent: number } {
    const { db } = this.deps;
    return {
      retentionDays: getSettingOr(
        db,
        SETTING_KEYS.recycleRetentionDays,
        z.number().min(0),
        SETTING_DEFAULTS.recycleRetentionDays,
      ),
      maxFreePercent: getSettingOr(
        db,
        SETTING_KEYS.recycleMaxFreePercent,
        z.number().min(0).max(100),
        SETTING_DEFAULTS.recycleMaxFreePercent,
      ),
    };
  }

  /** Restores a recycled original, or undoes a restore (`engine/restore.ts`). */
  restoreRecycled(input: { path: string; userId: string }): Promise<RestoreResult> {
    const { db, fs, log } = this.deps;
    return restoreRecycled({ db, fs, now: () => this.deps.now(), log }, input);
  }

  /**
   * The Recycle page: every library with its recycle totals, and one library's folder (the asked
   * one; else the first with files, else the first). Null `library` when the id is unknown or
   * there are no libraries.
   */
  async recycleList(libraryId?: string): Promise<{
    libraries: { id: string; name: string; files: number; bytes: number }[];
    library: (RecycleView & { name: string; retentionDays: number }) | null;
  }> {
    const { db } = this;
    const totals = new Map(recycledTotalsByLibrary(db).map((t) => [t.libraryId, t]));
    const all = listLibraries(db);
    const libraries = all.map((l) => ({
      id: l.id,
      name: l.name,
      files: totals.get(l.id)?.files ?? 0,
      bytes: totals.get(l.id)?.bytes ?? 0,
    }));
    const picked =
      libraryId !== undefined
        ? all.find((l) => l.id === libraryId)
        : (all.find((l) => (totals.get(l.id)?.files ?? 0) > 0) ?? all[0]);
    if (picked === undefined) return { libraries, library: null };
    const { retentionDays } = this.recycleSettings();
    const view = await recycleView(db, this.deps.fs, picked, { retentionDays });
    return { libraries, library: { ...view, name: picked.name, retentionDays } };
  }

  /** Deletes one recycle entry for good. */
  deleteRecycled(path: string): ReturnType<typeof deleteRecycledEntry> {
    return deleteRecycledEntry(this.db, this.deps.fs, path, this.deps.log);
  }

  /** Empties a library's recycle folder up to what was confirmed; null for an unknown library. */
  async emptyRecycle(
    libraryId: string,
    throughRecycledAt: string,
  ): Promise<{ removed: number; bytes: number; skipped: number } | null> {
    const library = findLibrary(this.db, libraryId);
    if (library === null || library.deletedAt !== null) return null;
    return emptyRecycle(this.db, this.deps.fs, libraryId, throughRecycledAt, this.deps.log);
  }

  /** The job's recycle facts for its page: the kept original, and the restore in effect. */
  private recycleFacts(id: string): Pick<JobDetail, 'recycled' | 'restore'> {
    const { db } = this;
    const rows = listRecycledForJob(db, id);
    const original = rows.find((r) => r.kind === 'original');
    const active = findActiveRestore(db, id);
    const days = this.recycleSettings().retentionDays;
    return {
      recycled: original
        ? {
            path: original.path,
            keptUntil: new Date(Date.parse(original.recycledAt) + days * DAY_MS).toISOString(),
          }
        : null,
      restore: active
        ? {
            restoredAt: active.restoredAt,
            restoredBy: findUserById(db, active.restoredBy)?.username ?? 'a removed user',
            outputPath:
              rows.find((r) => r.kind === 'restored-output' && r.restoreId === active.id)?.path ??
              null,
          }
        : null,
    };
  }

  jobDetail(id: string): JobDetail | null {
    const { db } = this;
    const row = findJob(db, id);
    if (!row) return null;
    const listed = findJobListRow(db, id);
    if (!listed) return null;
    const result = findJobResult(db, id);
    // The job's own probe, never the file's latest: after a replace the file has other streams.
    const ownProbe = findJobProbe(db, id) as ProbeResult | null;
    // Stored as a JobProbe; the first builds stored the whole ProbeResult (with `raw`).
    const output = result?.outputProbe as (JobProbe | ProbeResult) | null | undefined;
    const stored = findVersion(
      db,
      row.workflowId,
      row.workflowVersion,
      graphUpgrade(this.deps.registry),
    );
    return {
      job: this.withHold(listed),
      trace: listTrace(db, id),
      result,
      probe: ownProbe ? jobProbeOf(ownProbe) : null,
      outputProbe: !output ? null : 'raw' in output ? jobProbeOf(output) : output,
      // As the job ran it: a version stored by an older server shows its migrated edges.
      graph: stored?.ok ? migratePinned(stored.row.graph, this.deps.registry).graph : null,
      plan: result?.plan ?? null,
      path: row.walkPath ?? [],
      testOutput: this.testOutputs.find(id),
      testOutputNote: this.testOutputs.note(id),
      ...this.recycleFacts(id),
    };
  }

  listJobs(filter: JobListFilter): {
    jobs: Array<JobListRow & { heldByRunHours: RunHoursHold | null }>;
    counts: Record<JobState, number>;
    problemCount: number;
    dependsOnSizeCount: number;
  } {
    // The list's scope (run, library) applies; its state filter and paging do not.
    const scope = {
      ...(filter.libraryId !== undefined ? { libraryId: filter.libraryId } : {}),
      ...(filter.runId !== undefined ? { runId: filter.runId } : {}),
    };
    const closed = closedLibraries(this.db, this.deps.now(), this.timeZone);
    return {
      jobs: listJobs(this.db, filter).map((job) => this.withHold(job, closed)),
      counts: countJobsByState(this.db, scope),
      problemCount: countProblems(this.db, scope),
      dependsOnSizeCount: countDependsOnSize(this.db, scope),
    };
  }

  /** The row with what holds it back for its library's run hours (null: nothing). */
  private withHold(
    job: JobListRow,
    closed = closedLibraries(this.db, this.deps.now(), this.timeZone),
  ): JobListRow & { heldByRunHours: RunHoursHold | null } {
    return { ...job, heldByRunHours: runHoursHold(job, closed, this.timeZone) };
  }

  /** Totals since `since`; without it, since the start of today in the server's time zone. */
  jobStats(since?: string): ReturnType<typeof jobStats> {
    const today = localDayStarts(this.deps.now(), this.timeZone, 1)[0]?.start ?? this.deps.now();
    return jobStats(this.db, since ?? today.toISOString());
  }

  /** The Jobs page history: the last 7 server-local days (today last) and the all-time total. */
  jobHistory(): JobHistoryOutput {
    const days = localDayStarts(this.deps.now(), this.timeZone, 7);
    const totals = jobHistory(
      this.db,
      days.map((d) => d.start.toISOString()),
    );
    return {
      timeZone: this.timeZone,
      days: totals.map((t, i) => ({ date: days[i]?.date ?? '', ...t })),
      allTime: allTimeSaved(this.db),
    };
  }

  /**
   * The tail of the job's ffmpeg log ('' when there is none yet), repeats said once (#43, see
   * `readCondensedTail`); null for an unknown job.
   */
  async jobLog(id: string): Promise<string | null> {
    const path = this.jobLogPath(id);
    return path === null ? null : readCondensedTail(path, JOB_LOG_TAIL_BYTES);
  }

  /**
   * Where the job's ffmpeg log is (it may not exist yet); null for an unknown job. A finished job
   * has the log its result names; a running one its current attempt's.
   */
  jobLogPath(id: string): string | null {
    const row = findJob(this.db, id);
    if (!row) return null;
    const recorded = isFinalState(row.state) ? findJobResult(this.db, id)?.logPath : null;
    return recorded ?? logPathFor(this.deps.config, row);
  }

  // ---- internals ----

  /** A replace the sweep found installed: drop the `.orig` (when not recycling) and record done. */
  private async finishCleaning(job: JobRow, j: ReplaceJournal): Promise<void> {
    const { db, fs, log } = this.deps;
    // Keep the journal when the .orig cannot be removed; the next start tries again.
    if (!(await removeOrigCopy({ fs, log }, job.id, j))) return;
    // The replacement is installed at the original's path: Already processed knows it by this.
    let outputFingerprint: string | null = null;
    let outputHash: string | null = null;
    try {
      outputFingerprint = fingerprintKey(fingerprintFromStats(await fs.stat(j.originalPath)));
      outputHash = await contentHash(j.originalPath);
    } catch {
      // Gone or unreadable since: the result just has no output fingerprint or hash.
    }
    const now = this.deps.now();
    db.transaction(() => {
      updateJob(
        db,
        job.id,
        { state: 'done', reason: null, replaceJournal: null, lane: null, progress: null },
        now,
      );
      // The replace finished: whatever the job recorded before (a failure) is replaced.
      const previous = findJobResult(db, job.id);
      db.prepare('DELETE FROM job_results WHERE job_id = ?').run(job.id);
      insertJobResult(db, {
        jobId: job.id,
        fingerprint: fingerprintKey(j.fingerprint),
        workflowId: job.workflowId,
        workflowVersion: job.workflowVersion,
        outcome: 'done',
        beforeBytes: j.fingerprint.sizeBytes,
        afterBytes: j.outputBytes,
        estimatedBytes: previous?.estimatedBytes ?? null,
        command: previous?.command ?? null,
        plan: previous?.plan ?? null,
        replacedTo: j.recycling ? 'recycle' : 'deleted',
        logPath: previous?.logPath ?? null,
        warnings: [...(previous?.warnings ?? []), 'replace finished by the startup sweep'],
        problems: previous?.problems ?? [],
        outputProbe: previous?.outputProbe ?? null,
        sourceDamaged: false,
        outputFingerprint,
        sourceHash: previous?.sourceHash ?? null,
        outputHash,
        createdAt: now.toISOString(),
      });
    })();
    this.events.publish({ type: 'run.changed', runId: job.runId });
  }
}
