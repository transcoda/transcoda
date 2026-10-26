import { dirname, join } from 'node:path';
import type { Database } from '../db/open.ts';
import {
  deleteRecycled,
  hasReplaceJournal,
  insertRecycled,
  listRecycled,
  type RecycledRow,
} from '../db/repos/jobs.ts';
import type { Logger } from '../logger.ts';
import { errorCode, type FsOps } from './fs-ops.ts';

/**
 * Records a recycled original (`insertRecycled`) and logs when that replaced a stale row: one whose
 * original had been moved back out of the recycle folder by hand (C5).
 */
export function recordRecycledRow(db: Database, row: RecycledRow, log: Logger): void {
  const stale = insertRecycled(db, row);
  if (stale && stale.jobId !== row.jobId) {
    log.warn({
      msg: 'replaced a stale recycle row; its original had left the recycle folder',
      path: row.path,
      job: row.jobId,
      staleJob: stale.jobId,
      staleRecycledAt: stale.recycledAt,
    });
  }
}

export function defaultRecycleFolder(libraryRoot: string): string {
  return join(libraryRoot, '.transcoda-recycle');
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Prunes recycled originals: first every row older than `retentionDays`, then, per library, the
 * oldest rows while the recycled bytes exceed `maxFreePercent` % of (free + recycled) on that
 * filesystem. A file that is already gone just drops its row; a file that cannot be removed keeps
 * it (logged, retried next time).
 *
 * A row whose job still has a replace journal is never removed: between the move into the recycle
 * folder and the install (or while a stuck replace waits for the sweep) that file is the only copy
 * of the original. It still counts towards the recycled bytes. The check is repeated right before
 * each unlink, since a replace may start while the prune runs.
 */
export async function pruneRecycle(
  db: Database,
  fs: FsOps,
  opts: { retentionDays: number; maxFreePercent: number; now: Date; log: Logger },
): Promise<{ removed: number; bytes: number }> {
  let removed = 0;
  let bytes = 0;
  /** Unlinks the file and drops the row; returns the bytes freed (null when it could not). */
  const inFlight = (row: RecycledRow): boolean => hasReplaceJournal(db, row.jobId);
  const remove = async (row: RecycledRow): Promise<number | null> => {
    if (inFlight(row)) return null;
    let freed = row.sizeBytes;
    try {
      await fs.unlink(row.path);
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') {
        opts.log.warn({
          msg: 'could not remove a recycled original',
          path: row.path,
          code: errorCode(err),
        });
        return null;
      }
      freed = 0;
    }
    deleteRecycled(db, row.path);
    removed += 1;
    bytes += freed;
    return freed;
  };

  const cutoff = opts.now.getTime() - opts.retentionDays * DAY_MS;
  const kept: RecycledRow[] = [];
  for (const row of listRecycled(db)) {
    if (Date.parse(row.recycledAt) < cutoff && !inFlight(row)) {
      if ((await remove(row)) === null) kept.push(row);
    } else {
      kept.push(row);
    }
  }

  const byLibrary = new Map<string, RecycledRow[]>();
  for (const row of kept)
    byLibrary.set(row.libraryId, [...(byLibrary.get(row.libraryId) ?? []), row]);
  for (const rows of byLibrary.values()) {
    let free: number | null = null;
    for (const row of rows) {
      try {
        const s = await fs.statfs(dirname(row.path));
        free = s.bavail * s.bsize;
        break;
      } catch {
        // that folder is gone; try the next row's
      }
    }
    if (free === null) continue;
    let recycled = rows.reduce((n, r) => n + r.sizeBytes, 0);
    for (const row of rows) {
      if (recycled * 100 <= opts.maxFreePercent * (free + recycled)) break;
      const freed = await remove(row);
      if (freed === null) continue;
      recycled -= row.sizeBytes;
      free += freed;
    }
  }
  return { removed, bytes };
}
