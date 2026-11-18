import { basename } from 'node:path';
import { parseFileName, type StoredJobMedia } from '@transcoda/shared';
import type { Database } from '../open.ts';
import { type JobListRow, listJobListRows, parseMedia } from './jobs.ts';
import { findLibrary } from './libraries.ts';

export const LIBRARY_FILES_MAX = 200;
export type FileSort = 'title' | 'size' | 'lastRun' | 'result';
export interface ShowRef {
  title: string;
  year: number | null;
}
/** `season: 'none'` = episodes without a season number. */
export type SeasonRef = number | 'none';

export interface LibraryFileRow {
  id: string;
  libraryId: string;
  path: string;
  fileName: string;
  /** What is there now: the latest job's afterBytes when it replaced the file (restore not in effect), else files.size_bytes. */
  sizeBytes: number;
  /** The original's size when the latest job replaced the file (restore not in effect); else null. */
  originalBytes: number | null;
  /** ISO, from files.mtime_ms. */
  mtime: string;
  goneAt: string | null;
  /** The media job's media, else what the file name says (relative to the library root). */
  media: StoredJobMedia;
  /** The job whose media (and poster) the row shows: the latest job if it has media, else the newest job that has some; null: none has. */
  mediaJobId: string | null;
  /** A file is listed only once it has a job, so there always is one. */
  latest: JobListRow;
}

/** Which files {@link latestJobPerFileSql} covers; empty: every file of every library. */
export interface LatestJobScope {
  libraryId?: string;
  fileId?: string;
}

/**
 * A `WITH` clause defining `latest`: one row per file that has a job, with columns
 * - `file_id`;
 * - `latest_id`: the file's latest job, the newest (queued_at, then rowid) real job that is not
 *   skipped, already_processed or cancelled, else the newest job of any kind;
 * - `latest_media`: that job's own `media` (NULL when it has none);
 * - `media_id` / `media`: the latest job when it has media, else the newest job that has some;
 *   both NULL when no job of the file has media.
 *
 * Callers append `, more AS (…)` or a `SELECT` and bind `params` (named, merged with their own).
 * The window reads each file's jobs through `jobs_file_queued`.
 */
export function latestJobPerFileSql(scope: LatestJobScope): {
  sql: string;
  params: Record<string, string>;
} {
  const where: string[] = [];
  const params: Record<string, string> = {};
  if (scope.libraryId !== undefined) {
    where.push('f.library_id = @latestLibraryId');
    params.latestLibraryId = scope.libraryId;
  }
  if (scope.fileId !== undefined) {
    where.push('j.file_id = @latestFileId');
    params.latestFileId = scope.fileId;
  }
  const sql = `WITH ranked AS (
  SELECT j.id, j.file_id, j.media,
    ROW_NUMBER() OVER (PARTITION BY j.file_id ORDER BY
      (j.dry_run = 0 AND j.state NOT IN ('skipped','already_processed','cancelled')) DESC,
      j.queued_at DESC, j.rowid DESC) AS rn,
    FIRST_VALUE(j.id) OVER by_media AS m_id,
    FIRST_VALUE(j.media) OVER by_media AS m_media
  FROM jobs j JOIN files f ON f.id = j.file_id
  ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
  WINDOW by_media AS (PARTITION BY j.file_id ORDER BY
    (j.media IS NOT NULL) DESC, j.queued_at DESC, j.rowid DESC)
),
latest AS (
  SELECT file_id, id AS latest_id, media AS latest_media,
    CASE WHEN media IS NOT NULL THEN id WHEN m_media IS NOT NULL THEN m_id END AS media_id,
    COALESCE(media, m_media) AS media
  FROM ranked WHERE rn = 1
)`;
  return { sql, params };
}

/** Escapes `\`, `%` and `_` for a `LIKE … ESCAPE '\'`. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The file name of `f.path` (after its last `/`). */
const FILE_NAME_SQL = "substr(f.path, length(rtrim(f.path, replace(f.path, '/', ''))) + 1)";

/** The `listed` CTE (after `latest`): each file with its latest job's sort and filter keys. */
const LISTED_SQL = `base AS (
  SELECT f.id, f.library_id, f.path, f.size_bytes, f.mtime_ms, f.gone_at,
    lt.latest_id, lt.media_id, lt.media, lj.state AS latest_state,
    COALESCE(lj.finished_at, lj.queued_at) AS last_run, r.before_bytes, r.after_bytes,
    -- A corrupt media cell reads as none rather than failing the whole list.
    CASE WHEN json_valid(lt.media) THEN lt.media END AS media_json,
    (r.replaced_to IS NOT NULL AND r.after_bytes IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM restores x WHERE x.job_id = lt.latest_id AND x.undone_at IS NULL)) AS replaced,
    ${FILE_NAME_SQL} AS file_name
  FROM latest lt
  JOIN files f ON f.id = lt.file_id
  JOIN jobs lj ON lj.id = lt.latest_id
  LEFT JOIN job_results r ON r.job_id = lt.latest_id
),
listed AS (
  SELECT *,
    CASE WHEN replaced THEN after_bytes ELSE size_bytes END AS now_size,
    json_extract(media_json, '$.kind') AS kind,
    COALESCE(json_extract(media_json, '$.title'), file_name) AS title,
    json_extract(media_json, '$.year') AS year,
    json_extract(media_json, '$.season') AS season,
    json_extract(media_json, '$.episode') AS episode,
    json_extract(media_json, '$.episodeTitle') AS episode_title
  FROM base
)`;

interface DbListed {
  id: string;
  library_id: string;
  path: string;
  size_bytes: number;
  mtime_ms: number;
  gone_at: string | null;
  latest_id: string;
  media_id: string | null;
  media: string | null;
  replaced: number | null;
  before_bytes: number | null;
  now_size: number;
}

interface Filters {
  includeGone: boolean;
  show?: ShowRef;
  season?: SeasonRef;
  search?: string;
}

function filterSql(f: Filters): { where: string; params: Record<string, string | number | null> } {
  const where: string[] = [];
  const params: Record<string, string | number | null> = {};
  if (!f.includeGone) where.push('gone_at IS NULL');
  if (f.show !== undefined) {
    where.push("kind = 'episode' AND title = @showTitle AND year IS @showYear");
    params.showTitle = f.show.title;
    params.showYear = f.show.year;
  }
  if (f.season !== undefined) {
    if (f.season === 'none') where.push('season IS NULL');
    else {
      where.push('season = @season');
      params.season = f.season;
    }
  }
  if (f.search !== undefined && f.search !== '') {
    where.push(
      `(title LIKE @search ESCAPE '\\' OR episode_title LIKE @search ESCAPE '\\'
        OR file_name LIKE @search ESCAPE '\\')`,
    );
    params.search = `%${escapeLike(f.search)}%`;
  }
  return { where: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params };
}

const SORT_KEY: Record<FileSort, string> = {
  title: 'title COLLATE NOCASE',
  size: 'now_size',
  lastRun: 'last_run',
  result: 'latest_state',
};
/** `desc` flips the primary key only; ties fall back to title, season, episode, path. */
const orderSql = (sort: FileSort, desc: boolean): string =>
  `${SORT_KEY[sort]} ${desc ? 'DESC' : 'ASC'}, title COLLATE NOCASE, season, episode, path`;

/** Fills listed rows with their latest job and media. */
function toRows(db: Database, rows: DbListed[]): LibraryFileRow[] {
  if (rows.length === 0) return [];
  const jobs = new Map(
    listJobListRows(
      db,
      rows.map((r) => r.latest_id),
    ).map((j) => [j.id, j]),
  );
  const roots = new Map<string, string | undefined>();
  const rootOf = (libraryId: string): string | undefined => {
    if (!roots.has(libraryId)) roots.set(libraryId, findLibrary(db, libraryId)?.path);
    return roots.get(libraryId);
  };
  return rows.flatMap((r) => {
    const latest = jobs.get(r.latest_id);
    if (!latest) return [];
    const stored = parseMedia(r.media);
    return [
      {
        id: r.id,
        libraryId: r.library_id,
        path: r.path,
        fileName: basename(r.path),
        sizeBytes: r.now_size,
        originalBytes: r.replaced ? r.before_bytes : null,
        mtime: new Date(r.mtime_ms).toISOString(),
        goneAt: r.gone_at,
        media: stored ?? parseFileName(r.path, rootOf(r.library_id)),
        mediaJobId: stored ? r.media_id : null,
        latest,
      },
    ];
  });
}

/** One page of a library's files (not gone) that have a job, filtered and sorted on the server. */
export function listLibraryFiles(
  db: Database,
  q: {
    libraryId: string;
    show?: ShowRef;
    season?: SeasonRef;
    search?: string;
    sort: FileSort;
    desc: boolean;
    offset: number;
    limit: number;
  },
): { rows: LibraryFileRow[]; total: number } {
  const latest = latestJobPerFileSql({ libraryId: q.libraryId });
  const filter = filterSql({
    includeGone: false,
    ...(q.show !== undefined && { show: q.show }),
    ...(q.season !== undefined && { season: q.season }),
    ...(q.search !== undefined && { search: q.search }),
  });
  const params = { ...latest.params, ...filter.params };
  const limit = Math.max(0, Math.min(q.limit, LIBRARY_FILES_MAX));
  const offset = Math.max(0, q.offset);
  const page = db
    .prepare(
      `${latest.sql}, ${LISTED_SQL}
       SELECT *, COUNT(*) OVER () AS total FROM listed ${filter.where}
       ORDER BY ${orderSql(q.sort, q.desc)} LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as (DbListed & { total: number })[];
  const total =
    page.length > 0
      ? (page[0] as { total: number }).total
      : (
          db
            .prepare(
              `${latest.sql}, ${LISTED_SQL} SELECT COUNT(*) AS n FROM listed ${filter.where}`,
            )
            .get(params) as { n: number }
        ).n;
  return { rows: toRows(db, page), total };
}

/** Gone files too (history still opens); null for an unknown id, another library's file or a file with no job. */
export function findLibraryFile(
  db: Database,
  libraryId: string,
  fileId: string,
): LibraryFileRow | null {
  const latest = latestJobPerFileSql({ libraryId, fileId });
  const filter = filterSql({ includeGone: true });
  const r = db
    .prepare(`${latest.sql}, ${LISTED_SQL} SELECT * FROM listed ${filter.where}`)
    .get({ ...latest.params, ...filter.params }) as DbListed | undefined;
  return r ? (toRows(db, [r])[0] ?? null) : null;
}

/** Every job of the file, newest first (queued_at DESC, rowid DESC). */
export function listFileJobs(
  db: Database,
  fileId: string,
  page: { offset: number; limit: number },
): { jobs: JobListRow[]; total: number } {
  const ids = db
    .prepare(
      `SELECT id FROM jobs WHERE file_id = ? ORDER BY queued_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    )
    .pluck()
    .all(fileId, Math.max(0, page.limit), Math.max(0, page.offset)) as string[];
  const total = db
    .prepare('SELECT COUNT(*) FROM jobs WHERE file_id = ?')
    .pluck()
    .get(fileId) as number;
  return { jobs: listJobListRows(db, ids), total };
}
