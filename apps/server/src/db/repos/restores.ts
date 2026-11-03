import type { Database } from '../open.ts';

/** A restore of a job's original (#39); undone when the output went back over it. */
export interface RestoreRow {
  id: string;
  jobId: string;
  restoredAt: string;
  /** The user id of the person who restored it. */
  restoredBy: string;
  /** The subtitle files the restore brought back with the original. */
  sidecarPaths: string[];
  undoneAt: string | null;
  undoneBy: string | null;
}

interface DbRestore {
  id: string;
  job_id: string;
  restored_at: string;
  restored_by: string;
  sidecar_paths: string;
  undone_at: string | null;
  undone_by: string | null;
}

const toRestore = (r: DbRestore): RestoreRow => ({
  id: r.id,
  jobId: r.job_id,
  restoredAt: r.restored_at,
  restoredBy: r.restored_by,
  sidecarPaths: JSON.parse(r.sidecar_paths) as string[],
  undoneAt: r.undone_at,
  undoneBy: r.undone_by,
});

export function insertRestore(db: Database, row: Omit<RestoreRow, 'undoneAt' | 'undoneBy'>): void {
  db.prepare(
    `INSERT INTO restores (id, job_id, restored_at, restored_by, sidecar_paths)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(row.id, row.jobId, row.restoredAt, row.restoredBy, JSON.stringify(row.sidecarPaths));
}

/** The job's restore that is still in effect (not undone), or null. */
export function findActiveRestore(db: Database, jobId: string): RestoreRow | null {
  const r = db
    .prepare('SELECT * FROM restores WHERE job_id = ? AND undone_at IS NULL')
    .get(jobId) as DbRestore | undefined;
  return r ? toRestore(r) : null;
}

export function findRestore(db: Database, id: string): RestoreRow | null {
  const r = db.prepare('SELECT * FROM restores WHERE id = ?').get(id) as DbRestore | undefined;
  return r ? toRestore(r) : null;
}

/** Marks the restore undone; false when it was undone already (or doesn't exist). */
export function markRestoreUndone(db: Database, id: string, at: string, by: string): boolean {
  return (
    db
      .prepare(
        'UPDATE restores SET undone_at = ?, undone_by = ? WHERE id = ? AND undone_at IS NULL',
      )
      .run(at, by, id).changes > 0
  );
}
