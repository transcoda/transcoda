import { dirname, join, relative, resolve } from 'node:path';
import type { Database } from '../db/open.ts';
import {
  deleteRecycled,
  findRecycled,
  hasFileJournal,
  insertRecycled,
  listRecycled,
  type RecycledInsert,
  type RecycledRow,
} from '../db/repos/jobs.ts';
import { findLibrary, type LibraryRow } from '../db/repos/libraries.ts';
import type { Logger } from '../logger.ts';
import { errorCode, type FsOps } from './fs-ops.ts';

/**
 * Records a recycled original (`insertRecycled`) and logs when that replaced a stale row: one whose
 * original had been moved back out of the recycle folder by hand (C5).
 */
export function recordRecycledRow(db: Database, row: RecycledInsert, log: Logger): void {
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

/** A library's recycle folder, absolute. */
export function recycleFolderFor(library: LibraryRow): string {
  return resolve(library.path, library.recycleFolder ?? defaultRecycleFolder(library.path));
}

/**
 * Whether a recycle entry's folder can be reached: its library's recycle folder exists (an
 * unmounted share leaves an empty mount point, so the library root alone proves nothing). Without
 * its library, the file's own folder.
 */
async function recycleFolderReachable(db: Database, fs: FsOps, row: RecycledRow): Promise<boolean> {
  const library = findLibrary(db, row.libraryId);
  return fs.exists(library ? recycleFolderFor(library) : dirname(row.path));
}

/**
 * Unlinks a recycle entry's file and drops its row; returns the bytes freed: 0 when the file was
 * already gone, null (row kept) while the job has a replace or restore journal (that file may be
 * the only copy), when the unlink failed (logged) or when the recycle folder can't be reached (a
 * missing file there means an unmounted share, not a removed file). The only way Transcoda removes
 * a recycled file.
 */
export async function removeRecycledRow(
  db: Database,
  fs: FsOps,
  row: RecycledRow,
  log: Logger,
): Promise<number | null> {
  if (hasFileJournal(db, row.jobId)) return null;
  let freed = row.sizeBytes;
  try {
    await fs.unlink(row.path);
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') {
      log.warn({
        msg: 'could not remove a recycled original',
        path: row.path,
        code: errorCode(err),
      });
      return null;
    }
    if (!(await recycleFolderReachable(db, fs, row))) {
      log.warn({ msg: "a recycle folder can't be reached; its entry is kept", path: row.path });
      return null;
    }
    freed = 0;
  }
  deleteRecycled(db, row.path);
  return freed;
}

/** One library's recycle folder as the Recycle page shows it. */
export interface RecycleView {
  libraryId: string;
  /** The folder (absolute). */
  folder: string;
  totalBytes: number;
  /** Free space on the folder's filesystem (the library root's when the folder is missing); null when unknown. */
  freeBytes: number | null;
  /** Oldest first; `relativePath` is where the file came from in the library. */
  entries: (RecycledRow & { relativePath: string; deletesAt: string })[];
}

export async function recycleView(
  db: Database,
  fs: FsOps,
  library: LibraryRow,
  opts: { retentionDays: number },
): Promise<RecycleView> {
  const folder = recycleFolderFor(library);
  const rows = listRecycled(db, library.id);
  let freeBytes: number | null = null;
  for (const p of [folder, library.path]) {
    try {
      const s = await fs.statfs(p);
      freeBytes = s.bavail * s.bsize;
      break;
    } catch {
      // try the next place
    }
  }
  return {
    libraryId: library.id,
    folder,
    totalBytes: rows.reduce((n, r) => n + r.sizeBytes, 0),
    freeBytes,
    entries: rows.map((r) => ({
      ...r,
      relativePath: relative(library.path, r.originalPath ?? r.path),
      deletesAt: new Date(Date.parse(r.recycledAt) + opts.retentionDays * DAY_MS).toISOString(),
    })),
  };
}

/** Deletes one recycle entry for good (the Recycle page's Delete). */
export async function deleteRecycledEntry(
  db: Database,
  fs: FsOps,
  path: string,
  log: Logger,
): Promise<
  { kind: 'deleted'; bytes: number } | { kind: 'not-found' } | { kind: 'refused'; reason: string }
> {
  const row = findRecycled(db, path);
  if (row === null) return { kind: 'not-found' };
  const freed = await removeRecycledRow(db, fs, row, log);
  if (freed === null) {
    if (hasFileJournal(db, row.jobId)) {
      return {
        kind: 'refused',
        reason: "A replace or restore of this file's job is in progress; try again in a moment.",
      };
    }
    if (!(await recycleFolderReachable(db, fs, row))) {
      return {
        kind: 'refused',
        reason: "The library's folder can't be reached (is the share mounted?).",
      };
    }
    return { kind: 'refused', reason: "The file couldn't be removed; see the server log." };
  }
  return { kind: 'deleted', bytes: freed };
}

/**
 * Empties a library's recycle folder: every entry recycled at or before `throughRecycledAt` (what
 * the person confirmed; a file recycled since stays). In-flight entries are skipped and counted.
 */
export async function emptyRecycle(
  db: Database,
  fs: FsOps,
  libraryId: string,
  throughRecycledAt: string,
  log: Logger,
): Promise<{ removed: number; bytes: number; skipped: number }> {
  const through = Date.parse(throughRecycledAt);
  let removed = 0;
  let bytes = 0;
  let skipped = 0;
  for (const row of listRecycled(db, libraryId)) {
    if (Date.parse(row.recycledAt) > through) continue;
    const freed = await removeRecycledRow(db, fs, row, log);
    if (freed === null) {
      skipped += 1;
    } else {
      removed += 1;
      bytes += freed;
    }
  }
  return { removed, bytes, skipped };
}

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
  const inFlight = (row: RecycledRow): boolean => hasFileJournal(db, row.jobId);
  const remove = async (row: RecycledRow): Promise<number | null> => {
    const freed = await removeRecycledRow(db, fs, row, opts.log);
    if (freed !== null) {
      removed += 1;
      bytes += freed;
    }
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
