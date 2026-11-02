// The catch-up scan: each library with an active feeder is listed shortly after start and then on
// an interval, and the files it has not seen yet are queued as a `library` run (held to its run
// hours). A timer and not a file watcher: inotify misses changes on network shares.
import type { Database } from '../db/open.ts';
import { type LibraryRow, listLibraries } from '../db/repos/libraries.ts';
import { findFeeder } from '../db/repos/workflows.ts';
import type { Logger } from '../logger.ts';
import type { QueueService } from './queue-service.ts';

/** `runs.created_by` of a catch-up run. */
export const CATCH_UP_BY = 'system:catch-up';
/** The first scan waits for the start-up work to settle. */
export const CATCH_UP_FIRST_DELAY_MS = 60 * 1000;
export const CATCH_UP_INTERVAL_MS = 15 * 60 * 1000;
/**
 * How long one library's scan may take before the others go on without it: far above a large
 * library on a slow share. File system calls cannot be cancelled, so the scan itself runs on.
 */
export const CATCH_UP_SCAN_TIMEOUT_MS = 30 * 60 * 1000;

export interface CatchUpDeps {
  db: Database;
  queue: Pick<QueueService, 'queueNew'>;
  log: Logger;
  firstDelayMs?: number;
  intervalMs?: number;
  scanTimeoutMs?: number;
}

export class LibraryCatchUp {
  private first: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Libraries whose scan has not ended (a hung share): not scanned again until it does. */
  private readonly unfinished = new Set<string>();

  constructor(private readonly deps: CatchUpDeps) {}

  /**
   * Scans every live library that an active version feeds; returns how many files it queued. A
   * library that cannot be scanned (an unmounted share) is logged and the others go on, also when
   * its scan hangs past the timeout; that library is skipped until its scan ends.
   */
  async scanAll(): Promise<number> {
    const { db } = this.deps;
    let total = 0;
    for (const library of listLibraries(db)) {
      if (findFeeder(db, library.id) === null || this.unfinished.has(library.id)) continue;
      total += await this.scanLibrary(library);
    }
    return total;
  }

  private async scanLibrary(library: LibraryRow): Promise<number> {
    const { queue, log } = this.deps;
    this.unfinished.add(library.id);
    const scan = queue
      .queueNew(library.path, CATCH_UP_BY)
      .finally(() => this.unfinished.delete(library.id));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(
        () => resolve('timeout'),
        this.deps.scanTimeoutMs ?? CATCH_UP_SCAN_TIMEOUT_MS,
      );
    });
    try {
      const r = await Promise.race([scan, timeout]);
      if (r === 'timeout') {
        log.warn(`library ${library.name}: the scan is not answering; it is skipped until it ends`);
        // A late failure has nobody waiting for it.
        scan.catch(() => {});
        return 0;
      }
      if (r.kind === 'queued') {
        log.info(`library ${library.name}: queued ${r.jobs.length} new file(s)`);
        return r.jobs.length;
      }
      if (r.kind === 'path-rejected') {
        log.warn(`library ${library.name} was not scanned: ${r.reason}`);
      } else if (r.kind === 'workflow-invalid') {
        log.warn(`library ${library.name} was not scanned: its workflow cannot run`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      log.warn(`library ${library.name} was not scanned: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    return 0;
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
