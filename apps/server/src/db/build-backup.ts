import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { backupDatabase, KEEP_BACKUPS, pruneBackups } from './backup.ts';
import { schemaVersion } from './migrate.ts';
import type { Database } from './open.ts';
import { getSetting, setSetting } from './repos/settings.ts';

/** Settings row holding the build id of the last start. */
export const LAST_BUILD_ID_KEY = 'app.lastBuildId';

/** First 12 hex characters of the file's sha256, or null when it cannot be read. */
export function hashBuildFile(file: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

export interface BuildBackupOptions {
  backupDir: string;
  buildId: string;
  /** The database had a schema before this start (migrate's `from > 0`). */
  existedBefore: boolean;
  /** migrate() already backed up this start. */
  migrationBackup: boolean;
  keepBackups?: number;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface BuildBackupResult {
  previous: string | null;
  backupFile: string | null;
}

/**
 * Runs at startup after migrate() and before anything else writes: when the build differs from
 * the one stored by the last start (or none is stored and the database already existed), takes a
 * `-build` backup (pruned with the migration backups), then stores the new id. No backup when
 * migrate() just took one or the database is brand new. Throws when the backup fails, as
 * migrate() does, so nothing writes to an unbacked-up database.
 */
export function backupOnBuildChange(db: Database, opts: BuildBackupOptions): BuildBackupResult {
  const previous = getSetting(db, LAST_BUILD_ID_KEY, z.string());
  if (previous === opts.buildId) return { previous, backupFile: null };
  const now = opts.now ?? (() => new Date());
  let backupFile: string | null = null;
  if (opts.existedBefore && !opts.migrationBackup) {
    backupFile = backupDatabase(db, opts.backupDir, now(), schemaVersion(db), 'build');
    pruneBackups(opts.backupDir, opts.keepBackups ?? KEEP_BACKUPS);
    opts.log?.(
      `Build changed (${previous ?? 'none'} → ${opts.buildId}); backed up database to ${backupFile}`,
    );
  }
  setSetting(db, LAST_BUILD_ID_KEY, opts.buildId, now());
  return { previous, backupFile };
}
