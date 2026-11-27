// Fills `media` (title, poster) on each file's latest job when it is NULL, and the show poster on
// episode media resolved before show posters existed: a pass reads sidecars beside the files
// (never runs ffmpeg), a batch at a time, so the library pages need no folder read. Each library
// it wrote to gets a `library.changed` event, at most one per library per interval.

import type { Database } from '../../db/open.ts';
import {
  episodesWithoutShowPoster,
  latestJobsWithoutMedia,
  setJobMedia,
  setShowPosterPath,
} from '../../db/repos/library-files.ts';
import type { FsOps } from '../../platform/fs-ops.ts';
import type { Logger } from '../../platform/logger.ts';
import type { EngineEvent } from '../events.ts';
import { createMediaResolver, type MediaResolver } from '../media/media-info.ts';

/** Files resolved at once (the same bound as queueing). */
const MEDIA_CONCURRENCY = 8;
const DEFAULT_BATCH = 200;
/** A burst of kicks (one per queued run) within this delay runs one pass. */
const DEFAULT_KICK_DELAY_MS = 1000;
/**
 * The least time between two `library.changed` events of one pass: a backfill of thousands of
 * files tells each open listing every few seconds, not once per batch (a refetch storm).
 */
const DEFAULT_NOTIFY_INTERVAL_MS = 3000;

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
      /** Where `library.changed` goes after a write; nowhere when left out. */
      events?: { publish(e: EngineEvent): void };
      /** The least time between two rounds of `library.changed` in one pass. */
      notifyIntervalMs?: number;
      /** A monotonic clock in ms, for the notify interval. */
      clock?: () => number;
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
   * time; then the same for episode media that never had its show poster looked up (the key is
   * written once the show folder was read in full, null when it has none, so later passes skip it;
   * a read error leaves it missing for a later pass, logged once per pass). Jobs queued
   * during the pass are left to the pass their kick runs. `filled`: jobs given media. The
   * libraries written to hear `library.changed` after a batch once the notify interval has passed
   * since the last round (the first batch always), and once more when the pass ends, failed or
   * stopped.
   */
  async run(): Promise<{ filled: number }> {
    const { db, fs, log, events } = this.deps;
    const interval = this.deps.notifyIntervalMs ?? DEFAULT_NOTIFY_INTERVAL_MS;
    const clock = this.deps.clock ?? (() => performance.now());
    /** Libraries written to since the last round of events. */
    const dirty = new Set<string>();
    let notifiedAt = Number.NEGATIVE_INFINITY;
    const notify = (): void => {
      notifiedAt = clock();
      for (const libraryId of dirty) events?.publish({ type: 'library.changed', libraryId });
      dirty.clear();
    };
    const afterBatch = (): void => {
      if (dirty.size > 0 && clock() - notifiedAt >= interval) notify();
    };
    // One resolver per pass: it caches folder listings, tvshow.nfo and show posters per folder.
    const resolver = (this.deps.resolver ?? (() => createMediaResolver({ fs, log })))();
    try {
      const filled = await this.inBatches(
        latestJobsWithoutMedia(db),
        async (j) => {
          // resolve never throws; a file whose sidecars fail gets its file-name media.
          const wrote = setJobMedia(db, j.jobId, await resolver.resolve(j.path, j.libraryRoot));
          if (wrote) dirty.add(j.libraryId);
          return wrote;
        },
        afterBatch,
      );
      if (filled > 0) log.info({ msg: 'media pass: filled job(s)', filled });
      if (this.stopped) return { filled };
      // A library whose root cannot be listed (an unmounted share) is skipped for this pass, and a
      // show folder that cannot be read leaves the key missing: both are looked up again later.
      const reachable = new Map<string, Promise<boolean>>();
      const rootReachable = (root: string): Promise<boolean> => {
        let r = reachable.get(root);
        if (r === undefined) {
          r = fs.readdir(root).then(
            () => true,
            () => false,
          );
          reachable.set(root, r);
        }
        return r;
      };
      const unreachable = new Set<string>();
      let unreadable = 0;
      const showPosters = await this.inBatches(
        episodesWithoutShowPoster(db),
        async (j) => {
          if (!(await rootReachable(j.libraryRoot))) {
            unreachable.add(j.libraryRoot);
            return false;
          }
          const found = await resolver.showPoster(j.path, j.libraryRoot);
          if (!('path' in found)) {
            unreadable++;
            return false;
          }
          const wrote = setShowPosterPath(db, j.jobId, found.path);
          if (wrote) dirty.add(j.libraryId);
          return wrote;
        },
        afterBatch,
      );
      if (showPosters > 0) {
        log.info({ msg: 'media pass: looked up show posters', jobs: showPosters });
      }
      if (unreadable > 0 || unreachable.size > 0) {
        log.warn({
          msg: 'media pass: some show folders could not be read; their show posters are looked up on a later pass',
          jobs: unreadable,
          unreachableLibraries: unreachable.size,
        });
      }
      return { filled };
    } finally {
      // What was written is news even when the pass failed or was stopped part way.
      if (dirty.size > 0) notify();
    }
  }

  /**
   * Runs `write` over `all` a batch at a time, {@link MEDIA_CONCURRENCY} at once; the count of
   * writes that changed a row. `afterBatch` runs after each batch that settled without failure. A
   * failure stops new work and rethrows once every worker settled.
   */
  private async inBatches<T>(
    all: T[],
    write: (item: T) => Promise<boolean>,
    afterBatch: () => void,
  ): Promise<number> {
    const batch = this.deps.batch ?? DEFAULT_BATCH;
    let wrote = 0;
    for (let start = 0; start < all.length && !this.stopped; start += batch) {
      const todo = all.slice(start, start + batch);
      let next = 0;
      let failed = false;
      const worker = async (): Promise<void> => {
        while (next < todo.length && !this.stopped && !failed) {
          const item = todo[next++];
          if (item === undefined) return;
          try {
            if (await write(item)) wrote++;
          } catch (err) {
            failed = true; // the other workers start no new file
            throw err;
          }
        }
      };
      // Every worker settles before the pass ends, so none outlives `running` (idle, stop, kick).
      const settled = await Promise.allSettled(
        Array.from({ length: Math.min(MEDIA_CONCURRENCY, todo.length) }, worker),
      );
      const failure = settled.find((s) => s.status === 'rejected');
      if (failure !== undefined) throw failure.reason;
      afterBatch();
    }
    return wrote;
  }
}
