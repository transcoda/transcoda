import type { SpaceWait } from './replace.ts';

/** A job's replace waiting for free space, since when (ISO). */
export type JobSpaceWait = SpaceWait & { jobId: string; since: string };

/**
 * The replaces waiting for free space right now (C4), kept in memory by the engine: the deep
 * health's `queue` check reports them. A restart ends every wait (the sweep settles the jobs).
 */
export class SpaceWaits {
  private readonly waits = new Map<string, JobSpaceWait>();

  set(jobId: string, wait: SpaceWait, now: Date): void {
    const since = this.waits.get(jobId)?.since ?? now.toISOString();
    this.waits.set(jobId, { ...wait, jobId, since });
  }

  clear(jobId: string): void {
    this.waits.delete(jobId);
  }

  list(): JobSpaceWait[] {
    return [...this.waits.values()];
  }
}
