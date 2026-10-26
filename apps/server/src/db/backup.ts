import fs from 'node:fs';
import path from 'node:path';
import type { Database } from './open.ts';

const BACKUP_PATTERN = /^transcoda-.*\.sqlite$/;
/** `transcoda-<YYYYMMDD-HHmmss>-v<schema>[-build|-manual][-<n>].sqlite` (n ≥ 2: same-second clash). */
const NAME_PATTERN =
  /^transcoda-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-v\d+(?:-(build|manual))?(?:-(\d+))?\.sqlite$/;

/** How many backups of each reason are kept (migration, build change, manual). */
export const KEEP_BACKUPS = 5;

/** Why a backup was taken: before migrations, on a new build, or a person's "Back up now". */
export type BackupReason = 'migration' | 'build' | 'manual';

export interface BackupInfo {
  /** File name only (never a path: the UI shows it). */
  name: string;
  size: number;
  /** When it was taken (from the stamp in the name, local time). */
  createdAt: string;
  reason: BackupReason;
}

/** The config directory's backups folder. */
export function backupDirOf(configDir: string): string {
  return path.join(configDir, 'backups');
}

function stamp(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(now.getFullYear(), 4)}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * Writes a consistent copy of the database with VACUUM INTO and returns its path. Names are
 * stamped per second; a name already taken gets `-2`, `-3`, … so a second backup within the same
 * second never fails on "output file already exists". The copy is written to `<name>.part`
 * (never listed), fsynced and renamed into place, so a failed or interrupted backup never shows
 * up as a backup; on failure the `.part` file is removed and the error rethrown.
 */
export function backupDatabase(
  db: Database,
  dir: string,
  now: Date,
  schemaVersion: number,
  reason: BackupReason = 'migration',
): string {
  fs.mkdirSync(dir, { recursive: true });
  const base = `transcoda-${stamp(now)}-v${schemaVersion}${reason === 'migration' ? '' : `-${reason}`}`;
  let file = path.join(dir, `${base}.sqlite`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base}-${n}.sqlite`);
  const part = `${file}.part`;
  try {
    // A leftover from a crash would make VACUUM INTO refuse.
    fs.rmSync(part, { force: true });
    db.prepare('VACUUM INTO ?').run(part);
    const fd = fs.openSync(part, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(part, file);
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw err;
  }
  return file;
}

/**
 * Deletes all but the `keep` newest backups of each reason (migration, build, manual), so a
 * build-change or manual backup never evicts the pre-migration copy. Returns deleted paths.
 */
export function pruneBackups(dir: string, keep: number): string[] {
  const byReason = new Map<BackupReason, string[]>();
  for (const n of listBackups(dir)) {
    const r = reasonOf(n);
    byReason.set(r, [...(byReason.get(r) ?? []), n]);
  }
  return [...byReason.values()].flatMap((names) =>
    names.slice(0, Math.max(0, names.length - keep)).map((n) => {
      const p = path.join(dir, n);
      fs.rmSync(p);
      return p;
    }),
  );
}

/** Why the backup `name` was taken (a name without a suffix is a migration backup). */
export function reasonOf(name: string): BackupReason {
  return (NAME_PATTERN.exec(name)?.[7] as BackupReason | undefined) ?? 'migration';
}

/** Sort key: the stamp, then the same-second counter (none counts as 1); other names by name. */
function sortKey(name: string): [string, number] {
  const m = NAME_PATTERN.exec(name);
  if (!m) return [name.slice('transcoda-'.length), 0];
  return [`${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}${m[6]}`, m[8] ? Number(m[8]) : 1];
}

/** Backup file names in `dir`, oldest first. */
export function listBackups(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => BACKUP_PATTERN.test(n))
    .sort((a, b) => {
      const [sa, na] = sortKey(a);
      const [sb, nb] = sortKey(b);
      if (sa !== sb) return sa < sb ? -1 : 1;
      if (na !== nb) return na - nb;
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

/** The backups in `dir`, newest first, for Settings → About. */
export function describeBackups(dir: string): BackupInfo[] {
  return listBackups(dir)
    .reverse()
    .flatMap((name) => {
      let st: fs.Stats;
      try {
        st = fs.statSync(path.join(dir, name));
      } catch {
        return []; // pruned meanwhile
      }
      const m = NAME_PATTERN.exec(name);
      const createdAt = m
        ? new Date(
            Number(m[1]),
            Number(m[2]) - 1,
            Number(m[3]),
            Number(m[4]),
            Number(m[5]),
            Number(m[6]),
          )
        : st.mtime;
      return [{ name, size: st.size, createdAt: createdAt.toISOString(), reason: reasonOf(name) }];
    });
}

/**
 * Opens the backup `name` in `dir` for a download, or returns null. The name must be one
 * `listBackups` lists, made of `[A-Za-z0-9._-]` (so never a `.part` file, a slash or `..`) and
 * resolve directly inside `dir`. The file is opened with O_NOFOLLOW and checked with fstat on that
 * fd, so a symlink or a non-file swapped in after the checks is refused at open (no TOCTOU). The
 * caller owns the returned fd and must close it.
 */
export function findBackupFile(dir: string, name: string): { fd: number; size: number } | null {
  // The charset also keeps the name safe in a Content-Disposition header.
  if (!BACKUP_PATTERN.test(name) || !/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) {
    return null;
  }
  if (!listBackups(dir).includes(name)) return null;
  const root = path.resolve(dir);
  const file = path.resolve(root, name);
  if (path.dirname(file) !== root) return null;
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null; // ELOOP for a symlink, or gone meanwhile
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.isFile()) return { fd, size: st.size };
  } catch {
    // fall through to close
  }
  fs.closeSync(fd);
  return null;
}
