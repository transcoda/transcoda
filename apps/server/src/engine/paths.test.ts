import type { Stats } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/open.ts';
import { insertLibrary, type LibraryRow } from '../db/repos/libraries.ts';
import { insertWorkflow } from '../db/repos/workflows.ts';
import { createTestDb } from '../db/test-db.ts';
import type { Fingerprint } from './fingerprint.ts';
import { tempDir } from './fixtures.ts';
import { checkPath, isRecycleOrTemp, listMediaFiles, skipReasonFor } from './paths.ts';

const NOW = new Date('2026-10-16T20:00:00.000Z');

let base: string;
let root: string;
let outside: string;
let db: Database;

function addLibrary(path: string, id = 'l1', extra: Partial<LibraryRow> = {}): LibraryRow {
  return insertLibrary(
    db,
    {
      id,
      name: id,
      path,
      recycleFolder: null,
      processHardlinked: false,
      ...extra,
    },
    NOW,
  );
}

beforeEach(async () => {
  base = await tempDir('paths-');
  root = join(base, 'lib');
  outside = join(base, 'outside');
  await mkdir(join(root, 'sub'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'sub', 'x.mkv'), '');
  await writeFile(join(outside, 'secret.mkv'), '');
  db = createTestDb();
  insertWorkflow(
    db,
    { id: 'w1', kind: 'workflow', name: 'W', graph: emptyGraph('workflow'), createdBy: 'u' },
    NOW,
  );
});

afterEach(async () => {
  db.close();
  await rm(base, { recursive: true, force: true });
});

describe('checkPath', () => {
  it('accepts a file under the root and returns its realpath and library', async () => {
    addLibrary(root);
    const r = await checkPath(db, join(root, 'sub', 'x.mkv'));
    expect(r).toMatchObject({ ok: true, realPath: join(root, 'sub', 'x.mkv') });
    if (r.ok) expect(r.library.id).toBe('l1');
  });

  it('accepts the root itself given with a trailing slash', async () => {
    addLibrary(root);
    expect(await checkPath(db, `${root}/`)).toMatchObject({ ok: true, realPath: root });
  });

  it('accepts a file through a symlinked root, whichever side the symlink is on', async () => {
    const alias = join(base, 'alias');
    await symlink(root, alias);
    // The library stored through the symlink, the file given by its real path …
    addLibrary(alias, 'l1');
    const viaReal = await checkPath(db, join(root, 'sub', 'x.mkv'));
    expect(viaReal).toMatchObject({ ok: true, realPath: join(root, 'sub', 'x.mkv') });
    if (viaReal.ok) expect(viaReal.library.path).toBe(root);
    // … and the file given through the symlink.
    expect(await checkPath(db, join(alias, 'sub', 'x.mkv'))).toMatchObject({
      ok: true,
      realPath: join(root, 'sub', 'x.mkv'),
    });
  });

  it('accepts a file given through a symlink alias of a root stored by its realpath', async () => {
    const alias = join(base, 'alias');
    await symlink(root, alias);
    addLibrary(root);
    expect(await checkPath(db, join(alias, 'sub', 'x.mkv'))).toMatchObject({
      ok: true,
      realPath: join(root, 'sub', 'x.mkv'),
    });
  });

  it('rejects a path outside every library root', async () => {
    addLibrary(root);
    expect(await checkPath(db, '/etc/passwd')).toEqual({
      ok: false,
      reason: 'outside library root',
    });
    expect(await checkPath(db, join(root, '..', 'outside', 'secret.mkv'))).toEqual({
      ok: false,
      reason: 'outside library root',
    });
  });

  it('rejects a symlink inside the root that resolves outside it', async () => {
    addLibrary(root);
    await symlink(join(outside, 'secret.mkv'), join(root, 'sub', 'link.mkv'));
    await symlink(outside, join(root, 'escape'));
    expect(await checkPath(db, join(root, 'sub', 'link.mkv'))).toEqual({
      ok: false,
      reason: 'symlink escapes root',
    });
    expect(await checkPath(db, join(root, 'escape', 'secret.mkv'))).toEqual({
      ok: false,
      reason: 'symlink escapes root',
    });
  });

  it('rejects a symlink from one library into another', async () => {
    const other = join(base, 'other');
    await mkdir(other);
    await writeFile(join(other, 'y.mkv'), '');
    addLibrary(root, 'l1');
    addLibrary(other, 'l2');
    await symlink(join(other, 'y.mkv'), join(root, 'y.mkv'));
    expect(await checkPath(db, join(root, 'y.mkv'))).toEqual({
      ok: false,
      reason: 'symlink escapes root',
    });
  });

  it('reports a missing file (and a dangling symlink) as not found', async () => {
    addLibrary(root);
    await symlink(join(root, 'gone.mkv'), join(root, 'dangling.mkv'));
    expect(await checkPath(db, join(root, 'nope.mkv'))).toEqual({
      ok: false,
      reason: 'not found',
    });
    expect(await checkPath(db, join(root, 'dangling.mkv'))).toEqual({
      ok: false,
      reason: 'not found',
    });
  });

  it('ignores a soft-deleted library', async () => {
    addLibrary(root);
    db.prepare('UPDATE libraries SET deleted_at = ?').run(NOW.toISOString());
    expect(await checkPath(db, join(root, 'sub', 'x.mkv'))).toEqual({
      ok: false,
      reason: 'outside library root',
    });
  });
});

describe('isRecycleOrTemp', () => {
  it('matches the default and a custom recycle folder and replace tmp files', () => {
    const lib = addLibrary(root);
    expect(isRecycleOrTemp(join(root, '.transcoda-recycle'), lib)).toBe(true);
    expect(isRecycleOrTemp(join(root, '.transcoda-recycle', 'a.mkv'), lib)).toBe(true);
    expect(isRecycleOrTemp(join(root, 'sub', '.transcoda-1.tmp'), lib)).toBe(true);
    expect(isRecycleOrTemp(join(root, 'sub', 'x.mkv'), lib)).toBe(false);
    expect(isRecycleOrTemp(join(root, '.transcoda-recycled', 'a.mkv'), lib)).toBe(false);
    const custom = { ...lib, recycleFolder: join(root, 'Trash') };
    expect(isRecycleOrTemp(join(root, 'Trash', 'a.mkv'), custom)).toBe(true);
    expect(isRecycleOrTemp(join(root, '.transcoda-recycle', 'a.mkv'), custom)).toBe(true);
  });
});

describe('listMediaFiles', () => {
  it('lists media files recursively and sorted, skipping non-media, recycle and tmp files', async () => {
    const lib = addLibrary(root);
    await mkdir(join(root, '.transcoda-recycle', 'sub'), { recursive: true });
    await writeFile(join(root, '.transcoda-recycle', 'sub', 'old.mkv'), '');
    await writeFile(join(root, 'sub', '.transcoda-1.tmp'), '');
    await writeFile(join(root, 'sub', 'notes.txt'), '');
    await writeFile(join(root, 'sub', 'A.MP4'), '');
    await writeFile(join(root, 'b.webm'), '');
    await writeFile(join(root, 'sub', 'x.mkv.transcoda-1.orig'), '');
    expect(await listMediaFiles(root, lib)).toEqual([
      join(root, 'b.webm'),
      join(root, 'sub', 'A.MP4'),
      join(root, 'sub', 'x.mkv'),
    ]);
  });

  it('does not follow symlinked directories (no loops, no escapes)', async () => {
    const lib = addLibrary(root);
    await symlink(root, join(root, 'loop'));
    await symlink(outside, join(root, 'escape'));
    expect(await listMediaFiles(root, lib)).toEqual([join(root, 'sub', 'x.mkv')]);
  });
});

describe('skipReasonFor', () => {
  const lib: LibraryRow = {
    id: 'l1',
    name: 'l1',
    path: '/lib',
    runHours: null,
    recycleFolder: null,
    processHardlinked: false,
    verifyFullDecode: false,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    deletedAt: null,
  };
  const fp = (minutesAgo: number, nlink = 1): Fingerprint => ({
    sizeBytes: 10,
    mtimeMs: NOW.getTime() - minutesAgo * 60_000,
    ino: 1,
    dev: 1,
    nlink,
  });
  const file = { isFile: () => true } as Stats;

  it('a file modified within the settle window is still growing; window 0 never', () => {
    expect(skipReasonFor(fp(1), file, lib, NOW, 3)).toBe('still growing');
    expect(skipReasonFor(fp(1), file, lib, NOW, 0)).toBeNull();
    expect(skipReasonFor(fp(5), file, lib, NOW, 3)).toBeNull();
  });

  it('a hardlinked file is skipped unless the library processes hardlinked files', () => {
    expect(skipReasonFor(fp(60, 2), file, lib, NOW, 3)).toBe('hardlinked');
    expect(skipReasonFor(fp(60, 2), file, { ...lib, processHardlinked: true }, NOW, 3)).toBeNull();
  });

  it('something that is not a regular file is not media', () => {
    expect(skipReasonFor(fp(60), { isFile: () => false } as Stats, lib, NOW, 3)).toBe('not media');
  });
});
