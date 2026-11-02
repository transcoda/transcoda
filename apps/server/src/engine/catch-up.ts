// The catch-up scan: each library with an active feeder is listed shortly after start and then on
// an interval, and the files it has not seen yet are queued as a `library` run (held to its run
// hours). The timed scan is the guarantee. A watcher on each fed library's folder (its "Watch the
// folder" setting) only starts that library's scan sooner; it gets no events from a network share
// written by another machine, and a watcher that fails is logged once and left to the timed scan.
import { watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '../db/open.ts';
import { findLibrary, type LibraryRow, listLibraries } from '../db/repos/libraries.ts';
import { findFeeder } from '../db/repos/workflows.ts';
import type { Logger } from '../logger.ts';
import { isRecycleOrTemp, SETTLE_MINUTES } from './paths.ts';
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
/** After the settle window, how long a watched folder must stay quiet before its scan. */
export const WATCH_QUIET_MS = 10 * 1000;

/**
 * Watches `root` and below; `onChange` gets the changed name relative to it (null when unknown).
 * Throws when the watcher cannot start; `onError` is for a watcher that fails later.
 */
export type WatchFn = (
  root: string,
  onChange: (name: string | null) => void,
  onError: (err: Error) => void,
) => { close(): void };

/** Recursive `fs.watch` (inotify per folder on Linux). */
export const watchRecursive: WatchFn = (root, onChange, onError) => {
  const w = fsWatch(root, { recursive: true, persistent: false }, (_event, name) =>
    onChange(name === null ? null : String(name)),
  );
  w.on('error', onError);
  return { close: () => w.close() };
};

export interface CatchUpDeps {
  db: Database;
  queue: Pick<QueueService, 'queueNew'>;
  log: Logger;
  firstDelayMs?: number;
  intervalMs?: number;
  scanTimeoutMs?: number;
  /** A new file counts as still growing this long after its last write (default SETTLE_MINUTES). */
  settleMinutes?: number;
  quietMs?: number;
  watch?: WatchFn;
}

export class LibraryCatchUp {
  private first: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Libraries whose scan has not ended (a hung share): not scanned again until it does. */
  private readonly unfinished = new Set<string>();
  /** Scans run one at a time: the timed scan and the watchers' early ones. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly watchers = new Map<string, { close(): void }>();
  /** The recycle folder each watcher filters by; a changed one replaces the watcher. */
  private readonly watchedRecycle = new Map<string, string | null>();
  /** Libraries whose watcher failed (logged once): left to the timed scan until restart. */
  private readonly failed = new Set<string>();
  private readonly early = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: CatchUpDeps) {}

  /**
   * Scans every live library that an active version feeds; returns how many files it queued. A
   * library that cannot be scanned (an unmounted share) is logged and the others go on, also when
   * its scan hangs past the timeout; that library is skipped until its scan ends.
   */
  async scanAll(): Promise<number> {
    let total = 0;
    for (const library of listLibraries(this.deps.db)) total += await this.scanLibrary(library);
    return total;
  }

  private async scanLibrary(library: LibraryRow): Promise<number> {
    const { db, queue, log } = this.deps;
    if (findFeeder(db, library.id) === null || this.unfinished.has(library.id)) return 0;
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

  /**
   * Watches the folder of every fed library with watching on and closes the rest. Called at start,
   * on every timed scan and when a library changes; never throws.
   */
  syncWatchers(): void {
    const { db } = this.deps;
    const wanted = new Map<string, LibraryRow>();
    for (const library of listLibraries(db)) {
      if (!library.watchFolder || this.failed.has(library.id)) continue;
      if (findFeeder(db, library.id) === null) continue;
      wanted.set(library.id, library);
    }
    for (const id of [...this.watchers.keys()]) {
      const library = wanted.get(id);
      if (!library || library.recycleFolder !== this.watchedRecycle.get(id)) this.unwatch(id);
    }
    for (const library of wanted.values()) {
      if (!this.watchers.has(library.id)) this.watchLibrary(library);
    }
  }

  private watchLibrary(library: LibraryRow): void {
    const watch = this.deps.watch ?? watchRecursive;
    const onChange = (name: string | null) => {
      if (name !== null && isRecycleOrTemp(join(library.path, name), library)) return;
      this.scanSoon(library.id);
    };
    try {
      this.watchers.set(
        library.id,
        watch(library.path, onChange, (err) => this.watchFailed(library, err)),
      );
      this.watchedRecycle.set(library.id, library.recycleFolder);
    } catch (err) {
      this.watchFailed(library, err);
    }
  }

  /** Logs once, closes the watcher and leaves the library to the timed scan. */
  private watchFailed(library: LibraryRow, err: unknown): void {
    if (!this.failed.has(library.id)) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      this.deps.log.warn(
        `library ${library.name}: cannot watch the folder (${reason}); new files are found by the scan every 15 minutes`,
      );
    }
    this.failed.add(library.id);
    this.unwatch(library.id);
  }

  private unwatch(id: string): void {
    const w = this.watchers.get(id);
    this.watchers.delete(id);
    this.watchedRecycle.delete(id);
    try {
      w?.close();
    } catch {
      // Already closed.
    }
    const t = this.early.get(id);
    if (t !== undefined) clearTimeout(t);
    this.early.delete(id);
  }

  /**
   * One scan of the library once its folder has been quiet for the settle window plus the quiet
   * time: a new file is only queued once it is no longer growing, so an earlier scan would skip it.
   */
  private scanSoon(id: string): void {
    const pending = this.early.get(id);
    if (pending !== undefined) clearTimeout(pending);
    const settleMs = (this.deps.settleMinutes ?? SETTLE_MINUTES) * 60_000;
    const t = setTimeout(
      () => {
        this.early.delete(id);
        const library = findLibrary(this.deps.db, id);
        if (library === null || library.deletedAt !== null) return;
        void this.serial(() => this.scanLibrary(library));
      },
      settleMs + (this.deps.quietMs ?? WATCH_QUIET_MS),
    );
    t.unref?.();
    this.early.set(id, t);
  }

  /** Scans after the first delay, then on every interval; a scan still running skips a turn. */
  start(): void {
    if (this.first !== null || this.timer !== null) return;
    this.syncWatchers();
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
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
    for (const t of this.early.values()) clearTimeout(t);
    this.early.clear();
  }

  private serial<T>(scan: () => Promise<T>): Promise<T> {
    const next = this.chain.then(scan);
    this.chain = next.catch(() => {});
    return next;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.syncWatchers();
      await this.serial(() => this.scanAll());
    } catch (err) {
      this.deps.log.warn(
        `library scan failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    } finally {
      this.running = false;
    }
  }
}
