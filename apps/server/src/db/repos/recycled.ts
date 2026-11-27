import type { Database } from '../open.ts';

// The recycled table: what sits in a library's recycle folder and where it came from.

/** What a recycle entry holds: a replaced original, a subtitle file, or an output a restore set aside. */
export type RecycledKind = 'original' | 'sidecar' | 'restored-output';

export interface RecycledRow {
  path: string;
  libraryId: string;
  jobId: string;
  sizeBytes: number;
  recycledAt: string;
  kind: RecycledKind;
  /** Where the file came from (its way back); null on rows from before migration 0017 it couldn't tell. */
  originalPath: string | null;
  /** A `restored-output` row: the restore that set it aside. */
  restoreId: string | null;
}

/** A row to record; an original with no known way back unless said. */
export type RecycledInsert = Omit<RecycledRow, 'kind' | 'originalPath' | 'restoreId'> &
  Partial<Pick<RecycledRow, 'kind' | 'originalPath' | 'restoreId'>>;

interface DbRecycled {
  path: string;
  library_id: string;
  job_id: string;
  size_bytes: number;
  recycled_at: string;
  kind: RecycledKind;
  original_path: string | null;
  restore_id: string | null;
}

const toRecycled = (r: DbRecycled): RecycledRow => ({
  path: r.path,
  libraryId: r.library_id,
  jobId: r.job_id,
  sizeBytes: r.size_bytes,
  recycledAt: r.recycled_at,
  kind: r.kind,
  originalPath: r.original_path,
  restoreId: r.restore_id,
});

/**
 * Records the original now at `row.path` in the recycle folder; returns the row it replaced, if
 * any. A row for the same path can only be stale (C5): a replace never moves an original onto a
 * taken path, so that row's original was moved back out by hand. It is replaced, not kept.
 */
export function insertRecycled(db: Database, row: RecycledInsert): RecycledRow | null {
  return db.transaction(() => {
    const prior = db.prepare('SELECT * FROM recycled WHERE path = ?').get(row.path) as
      | DbRecycled
      | undefined;
    db.prepare(
      `INSERT INTO recycled (path, library_id, job_id, size_bytes, recycled_at, kind, original_path,
         restore_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET library_id = excluded.library_id, job_id = excluded.job_id,
         size_bytes = excluded.size_bytes, recycled_at = excluded.recycled_at, kind = excluded.kind,
         original_path = excluded.original_path, restore_id = excluded.restore_id`,
    ).run(
      row.path,
      row.libraryId,
      row.jobId,
      row.sizeBytes,
      row.recycledAt,
      row.kind ?? 'original',
      row.originalPath ?? null,
      row.restoreId ?? null,
    );
    return prior ? toRecycled(prior) : null;
  })();
}

/** The recycle entry at `path`, or null. */
export function findRecycled(db: Database, path: string): RecycledRow | null {
  const r = db.prepare('SELECT * FROM recycled WHERE path = ?').get(path) as DbRecycled | undefined;
  return r ? toRecycled(r) : null;
}

/** A job's recycle entries, newest first (a restore's set-aside output before older rows). */
export function listRecycledForJob(db: Database, jobId: string): RecycledRow[] {
  const rows = db
    .prepare('SELECT * FROM recycled WHERE job_id = ? ORDER BY recycled_at DESC, rowid DESC')
    .all(jobId) as DbRecycled[];
  return rows.map(toRecycled);
}

/** Recycled originals, oldest first (the order retention removes them in). */
export function listRecycled(db: Database, libraryId?: string): RecycledRow[] {
  const rows = (
    libraryId === undefined
      ? db.prepare('SELECT * FROM recycled ORDER BY recycled_at, rowid').all()
      : db
          .prepare('SELECT * FROM recycled WHERE library_id = ? ORDER BY recycled_at, rowid')
          .all(libraryId)
  ) as DbRecycled[];
  return rows.map(toRecycled);
}

/** How many recycled originals there are and their total size. */
export function recycledTotals(db: Database): { files: number; bytes: number } {
  const r = db
    .prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM recycled')
    .get() as { files: number; bytes: number };
  return { files: r.files, bytes: r.bytes };
}

/** Files and bytes in the recycle index per library, by library id. */
export function recycledTotalsByLibrary(
  db: Database,
): { libraryId: string; files: number; bytes: number }[] {
  return db
    .prepare(
      `SELECT library_id AS libraryId, COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes
       FROM recycled GROUP BY library_id ORDER BY library_id`,
    )
    .all() as { libraryId: string; files: number; bytes: number }[];
}

export function deleteRecycled(db: Database, path: string): boolean {
  return db.prepare('DELETE FROM recycled WHERE path = ?').run(path).changes > 0;
}
