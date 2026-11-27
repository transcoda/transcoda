import { ACTIVE_JOB_STATES, type JsonValue } from '@transcoda/shared';
import type { Database } from '../open.ts';

// Files on disk as the database keys them, and the `files` table's rows.

/** Identity of a file on disk: if any of size, mtime, inode or device changes, it is a new file. */
export interface Fingerprint {
  sizeBytes: number;
  mtimeMs: number;
  ino: number;
  dev: number;
  /** Hard-link count; reported, but not part of the identity. */
  nlink: number;
}

/** The key the jobs and files tables store for a fingerprint (`fingerprint`, `output_fingerprint`). */
export function fingerprintKey(f: Fingerprint): string {
  return `${f.dev}:${f.ino}:${f.sizeBytes}:${f.mtimeMs}`;
}

export interface FileRow {
  id: string;
  libraryId: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  ino: number;
  dev: number;
  /** `fingerprintKey` of the identity columns. */
  fingerprint: string;
  lastProbe: JsonValue | null;
  /** When a folder listing last failed to find the file (null: present). */
  goneAt: string | null;
  updatedAt: string;
}

interface DbFile {
  id: string;
  library_id: string;
  path: string;
  size_bytes: number;
  mtime_ms: number;
  ino: number;
  dev: number;
  fingerprint: string;
  last_probe: string | null;
  gone_at: string | null;
  updated_at: string;
}

const parseJson = <T>(s: string | null): T | null => (s === null ? null : (JSON.parse(s) as T));
const toJson = (v: unknown): string | null => (v === null ? null : JSON.stringify(v));
const ACTIVE_SQL = ACTIVE_JOB_STATES.map((s) => `'${s}'`).join(',');

const toFile = (r: DbFile): FileRow => ({
  id: r.id,
  libraryId: r.library_id,
  path: r.path,
  sizeBytes: r.size_bytes,
  mtimeMs: r.mtime_ms,
  ino: r.ino,
  dev: r.dev,
  fingerprint: r.fingerprint,
  lastProbe: parseJson<JsonValue>(r.last_probe),
  goneAt: r.gone_at,
  updatedAt: r.updated_at,
});

/**
 * Inserts the file or, when the path is known, refreshes its identity (keeping its id). A null
 * `lastProbe` keeps the stored probe while the fingerprint is unchanged (a re-queue does not wipe
 * it) and clears it when the file changed (the probe was of the previous file); a probe replaces
 * it. A file seen again is present, so `gone_at` is cleared.
 */
export function upsertFile(
  db: Database,
  input: { libraryId: string; path: string; fingerprint: Fingerprint; lastProbe: JsonValue | null },
  now: Date,
): FileRow {
  const f = input.fingerprint;
  db.prepare(
    `INSERT INTO files (id, library_id, path, size_bytes, mtime_ms, ino, dev, fingerprint, last_probe,
       updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET library_id = excluded.library_id,
       size_bytes = excluded.size_bytes, mtime_ms = excluded.mtime_ms, ino = excluded.ino,
       dev = excluded.dev, fingerprint = excluded.fingerprint,
       last_probe = COALESCE(excluded.last_probe,
         CASE WHEN files.fingerprint = excluded.fingerprint THEN files.last_probe END),
       gone_at = NULL, updated_at = excluded.updated_at`,
  ).run(
    crypto.randomUUID(),
    input.libraryId,
    input.path,
    f.sizeBytes,
    f.mtimeMs,
    f.ino,
    f.dev,
    fingerprintKey(f),
    toJson(input.lastProbe),
    now.toISOString(),
  );
  const r = db.prepare('SELECT * FROM files WHERE path = ?').get(input.path) as DbFile;
  return toFile(r);
}

/**
 * Records what a listing of `folder` found. Rows of the library under the folder (never a sibling
 * that merely shares the name's prefix) that `paths` lacks get `gone_at` (the first time is kept);
 * rows `paths` lists are present again. `paths` must be in the form `upsertFile` stores (real
 * paths). Files under a folder of `unlisted` are left alone: that part of the listing failed.
 * With `startedAt` (when the listing began), a row written since (`updated_at`, e.g. queued by
 * another request meanwhile) is not marked gone: the older listing could not have seen it.
 */
export function markFolderListing(
  db: Database,
  input: {
    libraryId: string;
    folder: string;
    paths: readonly string[];
    unlisted?: readonly string[];
    startedAt?: Date;
  },
  now: Date,
): { gone: number; back: number } {
  const prefix = input.folder.endsWith('/') ? input.folder : `${input.folder}/`;
  const listed = JSON.stringify(input.paths);
  const unlisted = JSON.stringify(
    (input.unlisted ?? []).map((f) => (f.endsWith('/') ? f : `${f}/`)),
  );
  const startedAt = input.startedAt?.toISOString() ?? null;
  return db.transaction(() => {
    const gone = db
      .prepare(
        `UPDATE files SET gone_at = ?
         WHERE library_id = ? AND gone_at IS NULL AND substr(path, 1, length(?)) = ?
           AND path NOT IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (SELECT 1 FROM json_each(?) u
                           WHERE substr(files.path, 1, length(u.value)) = u.value)
           AND (? IS NULL OR updated_at < ?)`,
      )
      .run(
        now.toISOString(),
        input.libraryId,
        prefix,
        prefix,
        listed,
        unlisted,
        startedAt,
        startedAt,
      ).changes;
    const back = db
      .prepare(
        `UPDATE files SET gone_at = NULL
         WHERE library_id = ? AND gone_at IS NOT NULL
           AND path IN (SELECT value FROM json_each(?))`,
      )
      .run(input.libraryId, listed).changes;
    return { gone, back };
  })();
}

/**
 * True when the file at `path` is known as it is now: a `files` row with this fingerprint (queued,
 * dry-run or probed before), or a job of that path still active. The catch-up scan leaves it alone.
 */
export function fileSeen(db: Database, path: string, fingerprint: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM files WHERE path = @path AND fingerprint = @fp
       UNION ALL SELECT 1 FROM jobs WHERE path = @path AND state IN (${ACTIVE_SQL})
       LIMIT 1`,
    )
    .get({ path, fp: fingerprint });
  return row !== undefined;
}
