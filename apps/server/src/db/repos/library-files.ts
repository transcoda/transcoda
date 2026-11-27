import { basename } from 'node:path';
import type { FileSort } from '@transcoda/contract';
import { type JsonValue, parseFileName, type StoredJobMedia } from '@transcoda/shared';
import type { Database } from '../open.ts';
import { type JobListRow, listJobListRows, parseMedia } from './jobs/jobs.ts';
import { findLibrary } from './libraries.ts';

export const LIBRARY_FILES_MAX = 200;
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
  /**
   * What is there now: the latest job's afterBytes when it replaced the file (restore not in
   * effect) and the file has not been seen since with another fingerprint, else files.size_bytes.
   */
  sizeBytes: number;
  /** The original's size when sizeBytes is the latest job's afterBytes; else null. */
  originalBytes: number | null;
  /** sizeBytes is the latest job's afterBytes: its replace is what is at the path now. */
  replaced: boolean;
  /** ISO, from files.mtime_ms. */
  mtime: string;
  goneAt: string | null;
  /** The media job's media, else what the file name says (relative to the library root). */
  media: StoredJobMedia;
  /** The job whose media (and poster) the row shows: the latest job if it has media, else the newest job that has some; null: none has. */
  mediaJobId: string | null;
  /** The key of the show the titles list groups this file under; null unless the stored media says episode. */
  showKey: string | null;
  /** The season route's form (a number, or `none`); null exactly when `showKey` is. */
  season: SeasonRef | null;
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
 * The latest job is the stored `files.latest_job_id` (migration 21 keeps it current); only a file
 * whose latest job has no media looks further, newest first through `jobs_file_queued`.
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
    where.push('f.id = @latestFileId');
    params.latestFileId = scope.fileId;
  }
  const sql = `WITH latest_ids AS (
  SELECT f.id AS file_id, lj.id AS latest_id, lj.media AS latest_media,
    CASE WHEN lj.media IS NOT NULL THEN lj.id ELSE
      (SELECT m.id FROM jobs m WHERE m.file_id = f.id AND m.media IS NOT NULL
       ORDER BY m.queued_at DESC, m.rowid DESC LIMIT 1)
    END AS media_id
  FROM files f JOIN jobs lj ON lj.id = f.latest_job_id
  ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
),
latest AS (
  SELECT li.file_id, li.latest_id, li.latest_media, li.media_id,
    COALESCE(li.latest_media, mj.media) AS media
  FROM latest_ids li LEFT JOIN jobs mj ON mj.id = li.media_id
)`;
  return { sql, params };
}

/**
 * Latest jobs (as {@link latestJobPerFileSql} defines them) of live libraries' present files whose
 * own `media` is NULL, oldest first (all of them when `limit` is left out). The job's own cell
 * counts, not the coalesced one: an older job's media does not give the latest job its title.
 */
export function latestJobsWithoutMedia(
  db: Database,
  limit?: number,
): Array<{ jobId: string; libraryId: string; path: string; libraryRoot: string }> {
  const latest = latestJobPerFileSql({});
  const rows = db
    .prepare(
      `${latest.sql}
SELECT lt.latest_id AS job_id, f.library_id AS library_id, f.path AS path,
  l.path AS library_root
FROM latest lt
JOIN files f ON f.id = lt.file_id
JOIN libraries l ON l.id = f.library_id AND l.deleted_at IS NULL
JOIN jobs j ON j.id = lt.latest_id
WHERE lt.latest_media IS NULL AND f.gone_at IS NULL
ORDER BY j.queued_at, j.rowid
LIMIT @limit`,
    )
    .all({ ...latest.params, limit: limit ?? -1 }) as Array<{
    job_id: string;
    library_id: string;
    path: string;
    library_root: string;
  }>;
  return rows.map((r) => ({
    jobId: r.job_id,
    libraryId: r.library_id,
    path: r.path,
    libraryRoot: r.library_root,
  }));
}

/**
 * The media jobs (as {@link latestJobPerFileSql} defines them: what the listing shows) of live
 * libraries' present files whose stored media is an episode that has never had its show poster
 * looked up (no `showPosterPath` key: resolved before show posters), oldest first.
 */
export function episodesWithoutShowPoster(
  db: Database,
  limit?: number,
): Array<{ jobId: string; libraryId: string; path: string; libraryRoot: string }> {
  const latest = latestJobPerFileSql({});
  const rows = db
    .prepare(
      `${latest.sql}
SELECT lt.media_id AS job_id, f.library_id AS library_id, f.path AS path,
  l.path AS library_root
FROM latest lt
JOIN files f ON f.id = lt.file_id
JOIN libraries l ON l.id = f.library_id AND l.deleted_at IS NULL
JOIN jobs j ON j.id = lt.media_id
WHERE f.gone_at IS NULL AND json_valid(lt.media)
  AND json_extract(lt.media, '$.kind') = 'episode'
  AND json_type(lt.media, '$.showPosterPath') IS NULL
ORDER BY j.queued_at, j.rowid
LIMIT @limit`,
    )
    .all({ ...latest.params, limit: limit ?? -1 }) as Array<{
    job_id: string;
    library_id: string;
    path: string;
    library_root: string;
  }>;
  return rows.map((r) => ({
    jobId: r.job_id,
    libraryId: r.library_id,
    path: r.path,
    libraryRoot: r.library_root,
  }));
}

/**
 * Adds `showPosterPath` (a path, or null for none) to the job's stored media, only while the key
 * is still missing; false when the media is gone, not JSON or already has it.
 */
export function setShowPosterPath(db: Database, jobId: string, path: string | null): boolean {
  return (
    db
      .prepare(
        `UPDATE jobs SET media = json_set(media, '$.showPosterPath', ?)
         WHERE id = ? AND json_valid(media) AND json_type(media, '$.showPosterPath') IS NULL`,
      )
      .run(path, jobId).changes > 0
  );
}

/** Writes `media` only where the job's cell is still NULL; false when it already had some. */
export function setJobMedia(db: Database, jobId: string, media: StoredJobMedia): boolean {
  return (
    db
      .prepare('UPDATE jobs SET media = ? WHERE id = ? AND media IS NULL')
      .run(JSON.stringify(media), jobId).changes > 0
  );
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
    -- The job's output is still what is there: the file was last seen as the job's input (the
    -- job's own probe) or as its output; a later sighting with another fingerprint (an external
    -- replace) means files.size_bytes is newer than the job's result.
    (r.replaced_to IS NOT NULL AND r.after_bytes IS NOT NULL
      AND f.fingerprint IN (r.fingerprint, r.output_fingerprint) AND NOT EXISTS
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
  kind: string | null;
  title: string;
  year: number | null;
  season: number | null;
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
        replaced: r.replaced === 1,
        mtime: new Date(r.mtime_ms).toISOString(),
        goneAt: r.gone_at,
        media: stored ?? parseFileName(r.path, rootOf(r.library_id)),
        mediaJobId: stored ? r.media_id : null,
        showKey: r.kind === 'episode' ? showKey({ title: r.title, year: r.year }) : null,
        season: r.kind === 'episode' ? (r.season ?? 'none') : null,
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

/**
 * How many files {@link listLibraryFiles} lists for the library with no filter (present files
 * that have a job), by index: no latest-job scan.
 */
export function countListedFiles(db: Database, libraryId: string): number {
  return db
    .prepare(
      `SELECT COUNT(*) FROM files f
       WHERE f.library_id = ? AND f.gone_at IS NULL
         AND EXISTS (SELECT 1 FROM jobs j WHERE j.file_id = f.id)`,
    )
    .pluck()
    .get(libraryId) as number;
}

/**
 * The paths a "run on a selection" request names, only from this library. `fileIds`: the ids that
 * are this library's files (repeats once); every other id (unknown, another library's) is counted
 * in `notFound`. A show (and optionally one season): its listed files, exactly the set
 * {@link listLibraryFiles} lists for the same filter (not gone, with a job).
 */
export function filePathsOf(
  db: Database,
  libraryId: string,
  sel: { fileIds: string[] } | { show: ShowRef; season?: SeasonRef },
): { paths: string[]; notFound: number } {
  if ('fileIds' in sel) {
    const unique = [...new Set(sel.fileIds)];
    const find = db.prepare('SELECT path FROM files WHERE id = ? AND library_id = ?').pluck();
    const paths: string[] = [];
    for (const id of unique) {
      const path = find.get(id, libraryId) as string | undefined;
      if (path !== undefined) paths.push(path);
    }
    return { paths, notFound: unique.length - paths.length };
  }
  const latest = latestJobPerFileSql({ libraryId });
  const filter = filterSql({
    includeGone: false,
    show: sel.show,
    ...(sel.season !== undefined && { season: sel.season }),
  });
  const paths = db
    .prepare(`${latest.sql}, ${LISTED_SQL} SELECT path FROM listed ${filter.where} ORDER BY path`)
    .pluck()
    .all({ ...latest.params, ...filter.params }) as string[];
  return { paths, notFound: 0 };
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

export interface OutcomeCounts {
  replaced: number;
  kept: number;
  failed: number;
  other: number;
}
/**
 * One file's poster reference: the media job's id (else the latest job's) and its media. `of:
 * 'show'`: the image is that media's `showPosterPath` (the show's own poster), not `posterPath`.
 */
export interface PosterRef {
  jobId: string;
  media: StoredJobMedia;
  of?: 'show';
}
export interface ShowGroup {
  key: string;
  title: string;
  year: number | null;
  /**
   * The show's own poster when an episode's media has one (`of: 'show'`), else the group's first
   * episode poster as for a season; null when no job of any episode has media.
   */
  poster: PosterRef | null;
  episodes: number;
  seasons: number;
  outcomes: OutcomeCounts;
  savedBytes: number;
}
export interface MovieItem {
  fileId: string;
  /** Null when no job of the file has media. */
  poster: PosterRef | null;
  latest: JobListRow;
}
export type TitleItem = ({ type: 'show' } & ShowGroup) | ({ type: 'movie' } & MovieItem);
export interface SeasonGroup {
  season: SeasonRef;
  episodes: number;
  poster: PosterRef | null;
  outcomes: OutcomeCounts;
  savedBytes: number;
}

/** Base64url of the JSON `[title, year]`; the key a show card carries. */
export function showKey(show: ShowRef): string {
  return Buffer.from(JSON.stringify([show.title, show.year])).toString('base64url');
}

/** The show a {@link showKey} names; null for anything that is not that shape. */
export function parseShowKey(key: string): ShowRef | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(key, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== 2) return null;
    const [title, year] = v as [unknown, unknown];
    if (typeof title !== 'string') return null;
    if (year !== null && !(typeof year === 'number' && Number.isInteger(year))) return null;
    return { title, year };
  } catch {
    return null;
  }
}

/**
 * The `tagged` CTE (after `latest`, `base`, `listed`): the listed, not-gone files with their
 * outcome class, space saved and poster rank within `(title, year)` for shows or `(season)` of one show.
 */
const TAGGED_SQL = `tagged AS (
  SELECT l.*,
    CASE
      WHEN latest_state = 'done' AND NOT EXISTS
        (SELECT 1 FROM restores x WHERE x.job_id = l.latest_id AND x.undone_at IS NULL) THEN 'replaced'
      WHEN latest_state = 'kept_original' THEN 'kept'
      WHEN latest_state = 'failed' THEN 'failed'
      ELSE 'other'
    END AS outcome,
    (json_extract(media_json, '$.posterPath') IS NOT NULL) AS has_poster,
    (json_extract(media_json, '$.showPosterPath') IS NOT NULL) AS has_show_poster
  FROM listed l
  WHERE gone_at IS NULL
)`;

/** Per-group aggregates over `tagged`; `poster_id` / `poster_media` are the group's poster file's. */
const GROUP_AGG_SQL = `COUNT(*) AS episodes,
    COUNT(DISTINCT IFNULL(season, 'none')) AS seasons,
    SUM(outcome = 'replaced') AS replaced,
    SUM(outcome = 'kept') AS kept,
    SUM(outcome = 'failed') AS failed,
    SUM(outcome = 'other') AS other,
    COALESCE(SUM(CASE WHEN outcome = 'replaced' AND before_bytes IS NOT NULL AND after_bytes IS NOT NULL
      THEN MAX(0, before_bytes - after_bytes) ELSE 0 END), 0) AS saved,
    MAX(CASE WHEN prn = 1 THEN COALESCE(media_id, latest_id) END) AS poster_id,
    MAX(CASE WHEN prn = 1 THEN media END) AS poster_media`;

const POSTER_ORDER = 'has_poster DESC, season IS NULL, season, episode IS NULL, episode, path';
/** A show card's own poster: the first episode (in season order) whose media names the show's. */
const SHOW_POSTER_ORDER =
  'has_show_poster DESC, season IS NULL, season, episode IS NULL, episode, path';
/** The show-poster columns of a show group (`srn` ranks by {@link SHOW_POSTER_ORDER}). */
const SHOW_POSTER_AGG_SQL = `MAX(CASE WHEN srn = 1 AND has_show_poster THEN media_id END) AS show_poster_id,
    MAX(CASE WHEN srn = 1 AND has_show_poster THEN media END) AS show_poster_media`;

interface DbGroup {
  title: string;
  year: number | null;
  season?: number | null;
  episodes: number;
  seasons: number;
  replaced: number;
  kept: number;
  failed: number;
  other: number;
  saved: number;
  poster_id: string | null;
  poster_media: string | null;
}

function posterOf(id: string | null, media: string | null): PosterRef | null {
  const stored = parseMedia(media);
  return id !== null && stored ? { jobId: id, media: stored } : null;
}

/** The show's own poster when one is named, else the group's episode poster. */
function showPosterOf(
  g: DbGroup & { show_poster_id: string | null; show_poster_media: string | null },
): PosterRef | null {
  const own = posterOf(g.show_poster_id, g.show_poster_media);
  if (typeof own?.media.showPosterPath === 'string') return { ...own, of: 'show' };
  return posterOf(g.poster_id, g.poster_media);
}

const outcomesOf = (g: DbGroup): OutcomeCounts => ({
  replaced: g.replaced,
  kept: g.kept,
  failed: g.failed,
  other: g.other,
});

/**
 * One page of a library's titles: a show card per `(title, year)` of its episodes, one movie item
 * per other file. Files that are gone or have no job are not counted. Search matches the title only.
 */
export function listTitles(
  db: Database,
  q: { libraryId: string; search?: string; offset: number; limit: number },
): { items: TitleItem[]; total: number } {
  const latest = latestJobPerFileSql({ libraryId: q.libraryId });
  const params: Record<string, string | number> = { ...latest.params };
  let search = '';
  if (q.search !== undefined && q.search !== '') {
    search = "AND title LIKE @search ESCAPE '\\'";
    params.search = `%${escapeLike(q.search)}%`;
  }
  params.limit = Math.max(0, Math.min(q.limit, LIBRARY_FILES_MAX));
  params.offset = Math.max(0, q.offset);
  const sql = `${latest.sql}, ${LISTED_SQL}, ${TAGGED_SQL},
    grouped AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY title, year ORDER BY ${POSTER_ORDER}) AS prn,
        ROW_NUMBER() OVER (PARTITION BY title, year ORDER BY ${SHOW_POSTER_ORDER}) AS srn
      FROM tagged WHERE kind = 'episode' ${search}
    ),
    items AS (
      SELECT 'show' AS type, title, year, NULL AS file_id, NULL AS latest_id, ${GROUP_AGG_SQL},
        ${SHOW_POSTER_AGG_SQL}
      FROM grouped GROUP BY title, year
      UNION ALL
      SELECT 'movie', title, year, id, latest_id, 1, 0, 0, 0, 0, 0, 0,
        COALESCE(media_id, latest_id), media, NULL, NULL
      FROM tagged WHERE kind IS NOT 'episode' ${search}
    )
    SELECT *, COUNT(*) OVER () AS total FROM items
    ORDER BY title COLLATE NOCASE, title, year, type, file_id LIMIT @limit OFFSET @offset`;
  type Item = DbGroup & {
    type: 'show' | 'movie';
    file_id: string | null;
    latest_id: string | null;
    show_poster_id: string | null;
    show_poster_media: string | null;
  };
  const page = db.prepare(sql).all(params) as (Item & { total: number })[];
  let total = (page[0] as { total: number } | undefined)?.total ?? 0;
  if (page.length === 0 && params.offset > 0) {
    total = db
      .prepare(
        `${latest.sql}, ${LISTED_SQL}, ${TAGGED_SQL}
           SELECT COUNT(*) FROM (SELECT 1 FROM tagged WHERE kind = 'episode' ${search} GROUP BY title, year
             UNION ALL SELECT 1 FROM tagged WHERE kind IS NOT 'episode' ${search})`,
      )
      .pluck()
      .get(params) as number;
  }
  const latestJobs = new Map(
    listJobListRows(
      db,
      page.flatMap((r) => (r.latest_id !== null ? [r.latest_id] : [])),
    ).map((j) => [j.id, j]),
  );
  const items = page.flatMap((r): TitleItem[] => {
    if (r.type === 'show') {
      return [
        {
          type: 'show',
          key: showKey({ title: r.title, year: r.year }),
          title: r.title,
          year: r.year,
          poster: showPosterOf(r),
          episodes: r.episodes,
          seasons: r.seasons,
          outcomes: outcomesOf(r),
          savedBytes: r.saved,
        },
      ];
    }
    const latestJob = r.latest_id !== null ? latestJobs.get(r.latest_id) : undefined;
    if (r.file_id === null || !latestJob) return [];
    return [
      {
        type: 'movie',
        fileId: r.file_id,
        poster: posterOf(r.poster_id, r.poster_media),
        latest: latestJob,
      },
    ];
  });
  return { items, total };
}

/** A show's seasons, ascending with `'none'` (no season number) last. */
export function listSeasons(db: Database, libraryId: string, show: ShowRef): SeasonGroup[] {
  const latest = latestJobPerFileSql({ libraryId });
  const rows = db
    .prepare(
      `${latest.sql}, ${LISTED_SQL}, ${TAGGED_SQL},
       grouped AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY season ORDER BY ${POSTER_ORDER}) AS prn
         FROM tagged WHERE kind = 'episode' AND title = @showTitle AND year IS @showYear
       )
       SELECT season, ${GROUP_AGG_SQL} FROM grouped GROUP BY season ORDER BY season IS NULL, season`,
    )
    .all({ ...latest.params, showTitle: show.title, showYear: show.year }) as DbGroup[];
  return rows.map((r) => ({
    season: r.season ?? 'none',
    episodes: r.episodes,
    poster: posterOf(r.poster_id, r.poster_media),
    outcomes: outcomesOf(r),
    savedBytes: r.saved,
  }));
}

/**
 * Whether a present file of the library is an episode of `show` by the media the listing shows
 * (its latest job's, else the newest job's that has some): the files list's `show` filter with
 * nothing else applied. A show only older jobs named (since renamed) is unknown, as for seasons.
 */
export function showExists(db: Database, libraryId: string, show: ShowRef): boolean {
  const latest = latestJobPerFileSql({ libraryId });
  const filter = filterSql({ includeGone: false, show });
  return (
    db
      .prepare(`${latest.sql}, ${LISTED_SQL} SELECT EXISTS (SELECT 1 FROM listed ${filter.where})`)
      .pluck()
      .get({ ...latest.params, ...filter.params }) === 1
  );
}

/**
 * A show selection of a library (a `show` key, and a `season` as the contract's season parameter
 * gives it: digits or `none`): null when the key does not parse or names no show with a present
 * episode here ({@link showExists}). `libraries.files` and the run-on-a-selection routes share it.
 */
export function resolveShowSelection(
  db: Database,
  libraryId: string,
  key: string,
  season?: string,
): { show: ShowRef; season?: SeasonRef } | null {
  const show = parseShowKey(key);
  if (!show || !showExists(db, libraryId, show)) return null;
  if (season === undefined) return { show };
  return { show, season: season === 'none' ? 'none' : Number(season) };
}

/**
 * The probe stored with the file (what it is now); null when it was never probed, the file is
 * unknown or the stored probe does not parse.
 */
export function findFileProbe(db: Database, fileId: string): JsonValue | null {
  const r = db.prepare('SELECT last_probe FROM files WHERE id = ?').get(fileId) as
    | { last_probe: string | null }
    | undefined;
  if (!r?.last_probe) return null;
  try {
    return JSON.parse(r.last_probe) as JsonValue;
  } catch {
    return null;
  }
}
