// Fills `media` (title, poster) on each file's latest job when it is NULL: a pass reads sidecars
// beside the files (never runs ffmpeg), a batch at a time, so the library pages need no folder read.

import type { Database } from '../db/open.ts';
import { latestJobsWithoutMedia, setJobMedia } from '../db/repos/library-files.ts';
import type { Logger } from '../logger.ts';
import type { FsOps } from './fs-ops.ts';
import { createMediaResolver, type MediaResolver } from './media-info.ts';

/** Files resolved at once (the same bound as queueing). */
const MEDIA_CONCURRENCY = 8;
const DEFAULT_BATCH = 200;
/** A burst of kicks (one per queued run) within this delay runs one pass. */
const DEFAULT_KICK_DELAY_MS = 1000;

export class MediaPass {
  private running: Promise<void> | null = null;
  private pending = false;
  private stopped = false;
  /** The delayed start of the next pass, and the wake-up of `idle()` callers waiting for it. */
  private scheduled: { timer: ReturnType<typeof setTimeout>; fired: () => void } | null = null;
  private scheduledDone: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      db: Database;
      fs: FsOps;
      log: Logger;
      resolver?: () => MediaResolver;
      batch?: number;
      /** How long a kick waits before the pass starts, so a burst of kicks runs one pass. */
      kickDelayMs?: number;
    },
  ) {}

  /**
   * Starts a pass after a short delay unless one is already due or running; a kick during a pass
   * runs one more pass after it. Never rejects.
   */
  kick(): void {
    if (this.stopped) return;
    if (this.running !== null) {
      this.pending = true;
      return;
    }
    if (this.scheduled !== null) return;
    let fired: () => void = () => {};
    this.scheduledDone = new Promise<void>((r) => {
      fired = r;
    });
    const timer = setTimeout(() => {
      this.scheduled = null;
      if (!this.stopped) this.running = this.loop();
      fired();
    }, this.deps.kickDelayMs ?? DEFAULT_KICK_DELAY_MS);
    timer.unref?.();
    this.scheduled = { timer, fired };
  }

  /**
   * Shutdown: later kicks do nothing, no pass is pending, and a running pass starts no new file
   * (those in flight finish and may write).
   */
  stop(): void {
    this.stopped = true;
    this.pending = false;
    if (this.scheduled !== null) {
      clearTimeout(this.scheduled.timer);
      this.scheduled.fired();
      this.scheduled = null;
    }
  }

  /** Resolves when no pass is due, running or pending. */
  async idle(): Promise<void> {
    for (;;) {
      if (this.running !== null) await this.running;
      else if (this.scheduled !== null && this.scheduledDone !== null) await this.scheduledDone;
      else return;
    }
  }

  private async loop(): Promise<void> {
    try {
      do {
        this.pending = false;
        try {
          await this.run();
        } catch (err) {
          this.deps.log.warn({
            msg: 'media pass failed',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } while (this.pending && !this.stopped);
    } finally {
      this.running = null;
    }
  }

  /**
   * One pass: reads the latest jobs lacking media once, then works through that list a batch at a
   * time. Jobs queued during the pass are left to the pass their kick runs.
   */
  async run(): Promise<{ filled: number }> {
    const { db, fs, log } = this.deps;
    const batch = this.deps.batch ?? DEFAULT_BATCH;
    // One resolver per pass: it caches folder listings.
    const resolver = (this.deps.resolver ?? (() => createMediaResolver({ fs, log })))();
    const all = latestJobsWithoutMedia(db);
    let filled = 0;
    for (let start = 0; start < all.length && !this.stopped; start += batch) {
      const todo = all.slice(start, start + batch);
      let next = 0;
      let wrote = 0;
      const worker = async (): Promise<void> => {
        while (next < todo.length && !this.stopped) {
          const j = todo[next++];
          if (j === undefined) return;
          // resolve never throws; a file whose sidecars fail gets its file-name media.
          const media = await resolver.resolve(j.path, j.libraryRoot);
          if (setJobMedia(db, j.jobId, media)) wrote++;
        }
      };
      await Promise.all(Array.from({ length: Math.min(MEDIA_CONCURRENCY, todo.length) }, worker));
      filled += wrote;
    }
    if (filled > 0) log.info({ msg: 'media pass: filled job(s)', filled });
    return { filled };
  }
}
