import path from 'node:path';
import { backupDatabase, KEEP_BACKUPS, listBackups, pruneBackups, reasonOf } from './backup.ts';
import type { Database } from './open.ts';

export interface Migration {
  version: number;
  name: string;
  /**
   * 'off': run with foreign keys off (the table-rebuild recipe). `PRAGMA foreign_keys` is a no-op
   * inside a transaction, so it is switched before one opens; the transaction then refuses to
   * commit while `foreign_key_check` reports a violation. Switched back on afterwards.
   */
  foreignKeys?: 'off';
  /** `log` is `migrate`'s own (a no-op when none was given), for notices a migration leaves. */
  up(db: Database, log: (msg: string) => void): void;
}

export class SchemaTooNewError extends Error {
  constructor(
    public dbVersion: number,
    public appVersion: number,
    public backupHint: string,
  ) {
    super(
      `Database schema version ${dbVersion} is newer than this server supports (${appVersion}). ` +
        `Refusing to start. Restore a backup taken before the upgrade: ${backupHint}`,
    );
    this.name = 'SchemaTooNewError';
  }
}

export interface MigrateOptions {
  backupDir: string;
  keepBackups?: number;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: string[];
  backupFile: string | null;
}

/** The highest applied migration (0 for a database without one). */
export function schemaVersion(db: Database): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

function validate(migrations: Migration[]): Migration[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  sorted.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(
        `Migrations must be contiguous from 1 without duplicates: expected version ${i + 1}, found ${m.version} (${m.name})`,
      );
    }
  });
  return sorted;
}

export function migrate(
  db: Database,
  migrations: Migration[],
  opts: MigrateOptions,
): MigrateResult {
  const sorted = validate(migrations);
  const latest = sorted.length;
  const log = opts.log ?? (() => {});

  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const current = schemaVersion(db);

  if (current > latest) {
    // The copy taken before the upgrade that made it too new; a build or manual backup may already
    // be at the newer schema, so it is only the fallback.
    const all = listBackups(opts.backupDir);
    const newest = all.filter((n) => reasonOf(n) === 'migration').at(-1) ?? all.at(-1);
    throw new SchemaTooNewError(
      current,
      latest,
      newest ? path.join(opts.backupDir, newest) : 'no backup found',
    );
  }
  if (current === latest) return { from: current, to: current, applied: [], backupFile: null };

  const now = opts.now ?? (() => new Date());
  let backupFile: string | null = null;
  if (current > 0) {
    backupFile = backupDatabase(db, opts.backupDir, now(), current);
    pruneBackups(opts.backupDir, opts.keepBackups ?? KEEP_BACKUPS);
    log(`Backed up database to ${backupFile}`);
  }

  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  const applied: string[] = [];
  for (const m of sorted.filter((x) => x.version > current)) {
    const run = db.transaction(() => {
      m.up(db, log);
      if (m.foreignKeys === 'off' && (db.pragma('foreign_key_check') as unknown[]).length > 0) {
        throw new Error(`migration ${m.name} left foreign key violations`);
      }
      insert.run(m.version, m.name, now().toISOString());
    });
    if (m.foreignKeys === 'off') {
      const existing = db.pragma('foreign_key_check') as { table: string; rowid: number | null }[];
      if (existing.length > 0) {
        const shown = existing
          .slice(0, 10)
          .map((v) => `${v.table} rowid ${v.rowid ?? '?'}`)
          .join(', ');
        const more = existing.length > 10 ? ` (and ${existing.length - 10} more)` : '';
        throw new Error(
          `database has foreign key violations before migration ${m.name}: ${shown}${more}; restore the backup or fix them first`,
        );
      }
      db.pragma('foreign_keys = OFF');
      try {
        run();
      } finally {
        db.pragma('foreign_keys = ON');
      }
    } else {
      run();
    }
    applied.push(m.name);
    log(`Applied migration ${m.name}`);
  }
  return { from: current, to: latest, applied, backupFile };
}
