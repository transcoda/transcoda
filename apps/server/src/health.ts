import type { Capabilities } from '@transcoda/contract';
import { RUNNING_JOB_STATES } from '@transcoda/shared';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { Database } from './db/open.ts';
import { getSetting, getSettingOr, SETTING_KEYS, setSetting } from './db/repos/settings.ts';
import type { FsOps } from './engine/fs-ops.ts';
import { spaceWaitText } from './engine/replace.ts';
import type { JobSpaceWait } from './engine/space-waits.ts';
import { scratchMinFreeBytes } from './engine/test-outputs.ts';
import type { Logger } from './logger.ts';

/** A deep check runs at most once per this window; callers inside it get the last answer. */
export const DEEP_HEALTH_CACHE_MS = 10_000;

type Check = 'ok' | 'fail';
export type HealthChecks = {
  database: Check;
  ffmpeg: Check;
  scratchSpace: Check;
  queue: Check;
};

/** One check never takes longer than this: a hung disk answers `fail`, not a hung endpoint. */
const CHECK_TIMEOUT_MS = 5_000;

export interface HealthDeps {
  db: Database;
  config: Pick<Config, 'transcodeDir' | 'healthStallHours' | 'healthMinFreeGiB'>;
  capabilities(): Capabilities;
  fs: Pick<FsOps, 'statfs'>;
  /** The replaces waiting for free space now (the engine's `SpaceWaits`); absent: none. */
  spaceWaits?(): readonly JobSpaceWait[];
  now(): Date;
  log: Logger;
  /** Per-check time limit (default `CHECK_TIMEOUT_MS`; tests shorten it). */
  timeoutMs?: number;
}

/**
 * The deep health check behind `GET /system/health?deep=1`. Results are names and ok/fail only:
 * the endpoint is public, so the reason for a failure goes to the server log, never the response.
 */
export class HealthService {
  private cache: { at: number; result: HealthChecks } | null = null;
  private inflight: Promise<HealthChecks> | null = null;

  constructor(private readonly deps: HealthDeps) {}

  /** At most one real check per `DEEP_HEALTH_CACHE_MS`; concurrent callers share the in-flight check. */
  deep(): Promise<HealthChecks> {
    const now = this.deps.now().getTime();
    if (this.cache && now - this.cache.at < DEEP_HEALTH_CACHE_MS) {
      return Promise.resolve(this.cache.result);
    }
    this.inflight ??= this.run().then(
      (result) => {
        this.cache = { at: this.deps.now().getTime(), result };
        this.inflight = null;
        return result;
      },
      (err: unknown) => {
        this.inflight = null;
        throw err;
      },
    );
    return this.inflight;
  }

  private async run(): Promise<HealthChecks> {
    const [database, ffmpeg, scratchSpace, queue] = await Promise.all([
      this.check('database', async () => this.database()),
      this.check('ffmpeg', async () => this.deps.capabilities().available),
      this.check('scratchSpace', () => this.scratchSpace()),
      this.check('queue', async () => this.queue()),
    ]);
    return { database, ffmpeg, scratchSpace, queue };
  }

  private async check(name: keyof HealthChecks, fn: () => Promise<boolean>): Promise<Check> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timed out')),
          this.deps.timeoutMs ?? CHECK_TIMEOUT_MS,
        );
      });
      if (await Promise.race([fn(), limit])) return 'ok';
      this.deps.log.warn({ msg: 'deep health check failed', check: name });
    } catch (err) {
      this.deps.log.warn({
        msg: 'deep health check failed',
        check: name,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timer);
    }
    return 'fail';
  }

  /** Writes and reads back one settings row in a single transaction. */
  private database(): boolean {
    const { db } = this.deps;
    const now = this.deps.now();
    return db.transaction(() => {
      setSetting(db, 'health.lastDeepCheck', now.toISOString(), now);
      return getSetting(db, 'health.lastDeepCheck', z.string()) === now.toISOString();
    })();
  }

  private async scratchSpace(): Promise<boolean> {
    const { config, fs } = this.deps;
    const { bavail, bsize } = await fs.statfs(config.transcodeDir);
    return bavail * bsize >= scratchMinFreeBytes(config);
  }

  /**
   * No job's replace may be waiting for free space (C4: the run cannot move on by itself; the
   * log line names the wait), and no running, unpaused job may have gone without a progress write
   * (`updated_at`) for the stall window.
   */
  private queue(): boolean {
    const { db, config } = this.deps;
    const waits = this.deps.spaceWaits?.() ?? [];
    if (waits.length > 0) {
      const each = waits.map((w) => `job ${w.jobId} is ${spaceWaitText(w)} since ${w.since}`);
      throw new Error(
        waits.length === 1
          ? each.join('')
          : `${waits.length} jobs wait for free space: ${each.join('; ')}`,
      );
    }
    // Paused work (a paused job or a paused queue) is not a stall: nobody should be paged for it.
    if (getSettingOr(db, SETTING_KEYS.queuePaused, z.boolean(), false)) return true;
    const cutoff = new Date(this.deps.now().getTime() - config.healthStallHours * 3600_000);
    const marks = RUNNING_JOB_STATES.map(() => '?').join(',');
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs WHERE state IN (${marks}) AND paused = 0 AND updated_at < ?`,
      )
      .get(...RUNNING_JOB_STATES, cutoff.toISOString()) as { n: number };
    return row.n === 0;
  }
}
