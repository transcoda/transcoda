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
  /**
   * Each brought-back subtitle file's fingerprint key at the restore, by path, so an undo can
   * leave one another program changed since. Empty for restores recorded before this was kept.
   */
  sidecarKeys: Record<string, string>;
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

/** `sidecar_paths` holds `{paths, keys}`; a plain array of paths is the first form, without keys. */
function parseSidecars(json: string): Pick<RestoreRow, 'sidecarPaths' | 'sidecarKeys'> {
  const v = JSON.parse(json) as string[] | { paths: string[]; keys: Record<string, string> };
  return Array.isArray(v)
    ? { sidecarPaths: v, sidecarKeys: {} }
    : { sidecarPaths: v.paths, sidecarKeys: v.keys };
}

const toRestore = (r: DbRestore): RestoreRow => ({
  id: r.id,
  jobId: r.job_id,
  restoredAt: r.restored_at,
  restoredBy: r.restored_by,
  ...parseSidecars(r.sidecar_paths),
  undoneAt: r.undone_at,
  undoneBy: r.undone_by,
});

export function insertRestore(
  db: Database,
  row: Omit<RestoreRow, 'undoneAt' | 'undoneBy' | 'sidecarKeys'> &
    Partial<Pick<RestoreRow, 'sidecarKeys'>>,
): void {
  db.prepare(
    `INSERT INTO restores (id, job_id, restored_at, restored_by, sidecar_paths)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.jobId,
    row.restoredAt,
    row.restoredBy,
    JSON.stringify({ paths: row.sidecarPaths, keys: row.sidecarKeys ?? {} }),
  );
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
