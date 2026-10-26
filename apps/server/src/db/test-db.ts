import { migrate } from './migrate.ts';
import { migrations } from './migrations/index.ts';
import { type Database, openDatabase } from './open.ts';

/** In-memory database with foreign keys on and all migrations applied. */
export function createTestDb(): Database {
  const db = openDatabase(':memory:');
  migrate(db, migrations, { backupDir: '' });
  return db;
}
