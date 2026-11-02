import { type RunHours, RunHoursSchema } from '@transcoda/shared';
import type { Database } from '../open.ts';

export interface LibraryRow {
  id: string;
  name: string;
  path: string;
  recycleFolder: string | null;
  processHardlinked: boolean;
  /** Verify decodes the whole output (not only its start and end) before replacing. */
  verifyFullDecode: boolean;
  /** When its automatic jobs may start; null: never set (no restriction). */
  runHours: RunHours | null;
  /** New files in its folder start its catch-up scan early (engine/catch-up.ts). */
  watchFolder: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface DbLibrary {
  id: string;
  name: string;
  path: string;
  recycle_folder: string | null;
  process_hardlinked: number;
  verify_full_decode: number;
  run_hours: string | null;
  watch_folder: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** The stored run hours; null for none or a value that no longer parses (no restriction). */
function parseRunHours(text: string | null): RunHours | null {
  if (text === null) return null;
  try {
    const parsed = RunHoursSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** `/media/tv/` → `/media/tv`; `/` stays `/`. */
export const trimSlash = (p: string): string => p.replace(/(.)\/+$/, '$1');

const toLibrary = (r: DbLibrary): LibraryRow => ({
  id: r.id,
  name: r.name,
  path: r.path,
  recycleFolder: r.recycle_folder,
  processHardlinked: r.process_hardlinked !== 0,
  verifyFullDecode: r.verify_full_decode !== 0,
  runHours: parseRunHours(r.run_hours),
  watchFolder: r.watch_folder !== 0,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
});

export type LibraryInsert = Omit<
  LibraryRow,
  'createdAt' | 'updatedAt' | 'deletedAt' | 'verifyFullDecode' | 'runHours' | 'watchFolder'
> & { verifyFullDecode?: boolean; runHours?: RunHours | null; watchFolder?: boolean };

/**
 * Inserts a library (`verifyFullDecode` defaults to false, `runHours` to none, `watchFolder` to
 * true); its path is stored
 * without a trailing slash.
 */
export function insertLibrary(db: Database, input: LibraryInsert, now: Date): LibraryRow {
  const ts = now.toISOString();
  const path = trimSlash(input.path);
  const verifyFullDecode = input.verifyFullDecode ?? false;
  const runHours = input.runHours ?? null;
  const watchFolder = input.watchFolder ?? true;
  db.prepare(
    `INSERT INTO libraries (id, name, path, recycle_folder, process_hardlinked, verify_full_decode,
       run_hours, watch_folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.name,
    path,
    input.recycleFolder,
    input.processHardlinked ? 1 : 0,
    verifyFullDecode ? 1 : 0,
    runHours === null ? null : JSON.stringify(runHours),
    watchFolder ? 1 : 0,
    ts,
    ts,
  );
  return {
    ...input,
    path,
    verifyFullDecode,
    runHours,
    watchFolder,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
  };
}

/** A library by id, including a soft-deleted one (jobs keep pointing at it). */
export function findLibrary(db: Database, id: string): LibraryRow | null {
  const r = db.prepare('SELECT * FROM libraries WHERE id = ?').get(id) as DbLibrary | undefined;
  return r ? toLibrary(r) : null;
}

/** Live libraries, by name. */
export function listLibraries(db: Database): LibraryRow[] {
  const rows = db
    .prepare('SELECT * FROM libraries WHERE deleted_at IS NULL ORDER BY name, id')
    .all() as DbLibrary[];
  return rows.map(toLibrary);
}

/** Patches a live library; null when it is missing or soft-deleted. */
export function updateLibrary(
  db: Database,
  id: string,
  patch: Partial<
    Pick<
      LibraryRow,
      | 'name'
      | 'recycleFolder'
      | 'processHardlinked'
      | 'verifyFullDecode'
      | 'runHours'
      | 'watchFolder'
    >
  >,
  now: Date,
): LibraryRow | null {
  const sets: string[] = ['updated_at = ?'];
  const values: (string | number | null)[] = [now.toISOString()];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    values.push(patch.name);
  }
  if (patch.recycleFolder !== undefined) {
    sets.push('recycle_folder = ?');
    values.push(patch.recycleFolder);
  }
  if (patch.processHardlinked !== undefined) {
    sets.push('process_hardlinked = ?');
    values.push(patch.processHardlinked ? 1 : 0);
  }
  if (patch.verifyFullDecode !== undefined) {
    sets.push('verify_full_decode = ?');
    values.push(patch.verifyFullDecode ? 1 : 0);
  }
  if (patch.runHours !== undefined) {
    sets.push('run_hours = ?');
    values.push(patch.runHours === null ? null : JSON.stringify(patch.runHours));
  }
  if (patch.watchFolder !== undefined) {
    sets.push('watch_folder = ?');
    values.push(patch.watchFolder ? 1 : 0);
  }
  const info = db
    .prepare(`UPDATE libraries SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`)
    .run(...values, id);
  return info.changes === 0 ? null : findLibrary(db, id);
}

export function softDeleteLibrary(db: Database, id: string, now: Date): boolean {
  const ts = now.toISOString();
  return (
    db
      .prepare(
        'UPDATE libraries SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
      )
      .run(ts, ts, id).changes > 0
  );
}

/** The settings row migration 0008 leaves its conflicts in: a JSON array of sentences. */
const MIGRATION_NOTICES_KEY = 'libraries.migrationNotices';

/** What migration 0008 changed about libraries, in order; [] once dismissed or when it changed nothing. */
export function listMigrationNotices(db: Database): string[] {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(MIGRATION_NOTICES_KEY) as
    | { value: string }
    | undefined;
  if (!row) return [];
  try {
    const value: unknown = JSON.parse(row.value);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function clearMigrationNotices(db: Database): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(MIGRATION_NOTICES_KEY);
}
