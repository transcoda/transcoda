// The catch-up scan: each library with an active feeder is listed shortly after start and then on
// an interval, and the files it has not seen yet are queued as a `library` run (held to its run
// hours). A timer and not a file watcher: inotify misses changes on network shares.
import type { Database } from '../db/open.ts';
import { listLibraries } from '../db/repos/libraries.ts';
import { findFeeder } from '../db/repos/workflows.ts';
import type { Logger } from '../logger.ts';
import type { QueueService } from './queue-service.ts';

/** `runs.created_by` of a catch-up run. */
export const CATCH_UP_BY = 'system:catch-up';
/** The first scan waits for the start-up work to settle. */
export const CATCH_UP_FIRST_DELAY_MS = 60 * 1000;
export const CATCH_UP_INTERVAL_MS = 15 * 60 * 1000;

export interface CatchUpDeps {
  db: Database;
  queue: Pick<QueueService, 'queueNew'>;
  log: Logger;
  firstDelayMs?: number;
  intervalMs?: number;
}

export class LibraryCatchUp {
  private first: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: CatchUpDeps) {}

  /**
   * Scans every live library that an active version feeds; returns how many files it queued. A
   * library that cannot be scanned (an unmounted share) is logged and the others go on.
   */
  async scanAll(): Promise<number> {
    const { db, queue, log } = this.deps;
    let total = 0;
    for (const library of listLibraries(db)) {
      if (findFeeder(db, library.id) === null) continue;
      try {
        const r = await queue.queueNew(library.path, CATCH_UP_BY);
        if (r.kind === 'queued') {
          total += r.jobs.length;
          log.info(`library ${library.name}: queued ${r.jobs.length} new file(s)`);
        } else if (r.kind === 'path-rejected') {
          log.warn(`library ${library.name} was not scanned: ${r.reason}`);
        } else if (r.kind === 'workflow-invalid') {
          log.warn(`library ${library.name} was not scanned: its workflow cannot run`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown error';
        log.warn(`library ${library.name} was not scanned: ${reason}`);
      }
    }
    return total;
  }

  /** Scans after the first delay, then on every interval; a scan still running skips a turn. */
  start(): void {
    if (this.first !== null || this.timer !== null) return;
    const tick = () => void this.tick();
    this.first = setTimeout(() => {
      this.first = null;
      tick();
      this.timer = setInterval(tick, this.deps.intervalMs ?? CATCH_UP_INTERVAL_MS);
      this.timer.unref?.();
    }, this.deps.firstDelayMs ?? CATCH_UP_FIRST_DELAY_MS);
    this.first.unref?.();
  }

  stop(): void {
    if (this.first !== null) clearTimeout(this.first);
    if (this.timer !== null) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.scanAll();
    } catch (err) {
      this.deps.log.warn(
        `library scan failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    } finally {
      this.running = false;
    }
  }
}
