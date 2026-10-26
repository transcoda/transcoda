import fs, { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../test-app.ts';
import { asSession, bearer, createToken, login, type Session, send } from '../test-http.ts';

const NAME = 'transcoda-20261021-180001-v7-build.sqlite';
const BYTES = Buffer.from('SQLite format 3\0 backup bytes');

let dir: string;
let t: TestApp;
let s: Session;
const url = (name: string) => `/system/backups/${name}/download`;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'transcoda-download-'));
  mkdirSync(join(dir, 'backups'));
  writeFileSync(join(dir, 'backups', NAME), BYTES);
  t = createTestApp({ config: { configDir: dir } });
  s = await login(t);
});
afterEach(async () => {
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /system/backups/{name}/download', () => {
  it('a session gets the file bytes as a private attachment', async () => {
    const res = await send(t, 'GET', url(NAME), { headers: asSession(s, false) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.sqlite3');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${NAME}"`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-length')).toBe(String(BYTES.length));
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES);
  });

  it('HEAD answers the headers and leaves no file open, however often', async () => {
    const open = vi.spyOn(fs, 'openSync');
    const close = vi.spyOn(fs, 'closeSync');
    const stream = vi.spyOn(fs, 'createReadStream');
    try {
      for (let i = 0; i < 5; i++) {
        const res = await t.app.request(`/api/v1${url(NAME)}`, {
          method: 'HEAD',
          headers: { host: 'localhost:8080', ...asSession(s, false) },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-length')).toBe(String(BYTES.length));
        expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${NAME}"`);
      }
      const backupFds = open.mock.results
        .filter((r, i) => r.type === 'return' && String(open.mock.calls[i]?.[0]).endsWith(NAME))
        .map((r) => r.value as number);
      expect(backupFds).toHaveLength(5);
      const closed = new Set(close.mock.calls.map((c) => c[0]));
      for (const fd of backupFds) expect(closed.has(fd)).toBe(true);
      expect(stream).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      close.mockRestore();
      stream.mockRestore();
    }
  });

  it('GET streams from the fd it checked (no second open by path)', async () => {
    const stream = vi.spyOn(fs, 'createReadStream');
    try {
      const res = await send(t, 'GET', url(NAME), { headers: asSession(s, false) });
      expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES);
      expect(stream).toHaveBeenCalledOnce();
      expect(stream.mock.calls[0]?.[0]).toBe('');
      expect(stream.mock.calls[0]?.[1]).toMatchObject({ autoClose: true, fd: expect.any(Number) });
    } finally {
      stream.mockRestore();
    }
  });

  it('a token with every scope → 403, no bytes', async () => {
    const { token } = await createToken(t, s, {
      name: 'all',
      scopes: ['read', 'plan', 'jobs:create', 'jobs:manage', 'workflows:write'],
    });
    const res = await send(t, 'GET', url(NAME), { headers: bearer(token) });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Backups are downloaded in the UI');
  });

  it('anonymous → 401', async () => {
    expect((await send(t, 'GET', url(NAME))).status).toBe(401);
  });

  it('a cross-site request → 403 even with the session cookie', async () => {
    const res = await send(t, 'GET', url(NAME), {
      headers: { ...asSession(s, false), 'sec-fetch-site': 'cross-site' },
    });
    expect(res.status).toBe(403);
  });

  it('traversal, slashes, other files and .part files → 404', async () => {
    writeFileSync(join(dir, 'transcoda.sqlite'), 'live db');
    writeFileSync(join(dir, 'backups', `${NAME}.part`), 'partial');
    writeFileSync(join(dir, 'backups', 'notes.txt'), 'x');
    symlinkSync(join(dir, 'transcoda.sqlite'), join(dir, 'backups', 'transcoda-link.sqlite'));
    for (const name of [
      '..%2Ftranscoda.sqlite',
      'transcoda-..%2F..%2Ftranscoda.sqlite',
      '%2E%2E',
      'transcoda-x%5C..%5Ctranscoda.sqlite',
      `${NAME}.part`,
      'notes.txt',
      'transcoda-missing.sqlite',
      'transcoda-link.sqlite',
    ]) {
      const res = await send(t, 'GET', url(name), { headers: asSession(s, false) });
      expect(res.status, name).toBe(404);
      expect(await res.text(), name).not.toContain('live db');
    }
  });
});
