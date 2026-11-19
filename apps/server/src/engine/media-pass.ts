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

export class MediaPass {
  private running: Promise<void> | null = null;
  private pending = false;

  constructor(
    private readonly deps: {
      db: Database;
      fs: FsOps;
      log: Logger;
      resolver?: () => MediaResolver;
      batch?: number;
    },
  ) {}

  /** Starts a pass unless one runs; a kick during a pass runs one more pass after it. Never rejects. */
  kick(): void {
    if (this.running !== null) {
      this.pending = true;
      return;
    }
    this.running = this.loop();
  }

  /** Resolves when no pass is running or pending. */
  async idle(): Promise<void> {
    while (this.running !== null) await this.running;
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
      } while (this.pending);
    } finally {
      this.running = null;
    }
  }

  /** One pass: batches until no latest job lacks media. */
  async run(): Promise<{ filled: number }> {
    const { db, fs, log } = this.deps;
    const batch = this.deps.batch ?? DEFAULT_BATCH;
    // One resolver per pass: it caches folder listings.
    const resolver = (this.deps.resolver ?? (() => createMediaResolver({ fs, log })))();
    let filled = 0;
    for (;;) {
      const todo = latestJobsWithoutMedia(db, batch);
      if (todo.length === 0) break;
      let next = 0;
      let wrote = 0;
      const worker = async (): Promise<void> => {
        while (next < todo.length) {
          const j = todo[next++];
          if (j === undefined) return;
          // resolve never throws; a file whose sidecars fail gets its file-name media.
          const media = await resolver.resolve(j.path, j.libraryRoot);
          if (setJobMedia(db, j.jobId, media)) wrote++;
        }
      };
      await Promise.all(Array.from({ length: Math.min(MEDIA_CONCURRENCY, todo.length) }, worker));
      filled += wrote;
      // Nothing written (every job already had media by now): stop rather than spin.
      if (wrote === 0) break;
    }
    if (filled > 0) log.info({ msg: 'media pass: filled job(s)', filled });
    return { filled };
  }
}
