import BetterSqlite3 from 'better-sqlite3';

export type Database = BetterSqlite3.Database;

export function openDatabase(file: string | ':memory:'): Database {
  const db = new BetterSqlite3(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * Runs `fn` in a transaction committed with `synchronous = FULL` (the WAL is synced at commit),
 * then restores the connection's previous setting. For writes that must survive power loss before
 * the disk action they announce (the replace journal, the recycle index). Not nestable inside a
 * transaction: SQLite applies the setting at commit.
 */
export function durably<T>(db: Database, fn: () => T): T {
  if (db.inTransaction) throw new Error('durably() must not run inside a transaction');
  const previous = db.pragma('synchronous', { simple: true }) as number;
  db.pragma('synchronous = FULL');
  try {
    return db.transaction(fn)();
  } finally {
    db.pragma(`synchronous = ${previous}`);
  }
}

export function closeDatabase(db: Database): void {
  db.close();
}
