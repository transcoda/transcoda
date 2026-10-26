import type { User } from '@transcoda/contract';
import type { Database } from '../open.ts';

export type UserWithHash = User & { passwordHash: string };

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
}

export function toUser(row: UserRow): User {
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

const toUserWithHash = (row: UserRow): UserWithHash => ({
  ...toUser(row),
  passwordHash: row.password_hash,
});

export function countUsers(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  return row.n;
}

export function createUser(
  db: Database,
  input: { username: string; passwordHash: string },
  now: Date,
): UserWithHash {
  const row: UserRow = {
    id: crypto.randomUUID(),
    username: input.username,
    password_hash: input.passwordHash,
    created_at: now.toISOString(),
  };
  db.prepare(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES (@id, @username, @password_hash, @created_at)',
  ).run(row);
  return toUserWithHash(row);
}

export function findUserByUsername(db: Database, username: string): UserWithHash | null {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | UserRow
    | undefined;
  return row ? toUserWithHash(row) : null;
}

export function findUserById(db: Database, id: string): User | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function updatePasswordHash(db: Database, id: string, passwordHash: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}
