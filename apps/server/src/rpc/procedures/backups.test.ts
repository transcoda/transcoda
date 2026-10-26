import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupSchema, BackupsListOutputSchema } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../test-app.ts';
import { asSession, bearer, createToken, login, type Session, send } from '../../test-http.ts';

const ALL_SCOPES = ['read', 'plan', 'jobs:create', 'jobs:manage', 'workflows:write'];

let dir: string;
let t: TestApp;
let s: Session;
const backups = () => {
  try {
    return readdirSync(join(dir, 'backups')).sort();
  } catch {
    return [];
  }
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'transcoda-backups-'));
  t = createTestApp({ config: { configDir: dir } });
  s = await login(t);
});
afterEach(async () => {
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('system.backups.list', () => {
  it('lists file names, sizes, times and reasons, newest first, without a path', async () => {
    mkdirSync(join(dir, 'backups'));
    writeFileSync(join(dir, 'backups', 'transcoda-20261020-090000-v6.sqlite'), 'abc');
    writeFileSync(join(dir, 'backups', 'transcoda-20261021-180001-v7-build.sqlite'), 'abcd');
    writeFileSync(join(dir, 'backups', 'notes.txt'), '');
    const res = await send(t, 'GET', '/system/backups', { headers: asSession(s, false) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(dir);
    const body = BackupsListOutputSchema.parse(JSON.parse(text));
    expect(body.keep).toBe(5);
    expect(body.backups.map((b) => [b.name, b.size, b.reason])).toEqual([
      ['transcoda-20261021-180001-v7-build.sqlite', 4, 'build'],
      ['transcoda-20261020-090000-v6.sqlite', 3, 'migration'],
    ]);
  });

  it('no backups folder yet → an empty list', async () => {
    const res = await send(t, 'GET', '/system/backups', { headers: asSession(s, false) });
    expect(BackupsListOutputSchema.parse(await res.json()).backups).toEqual([]);
  });

  it('a token with read may list; anonymous → 401', async () => {
    const { token } = await createToken(t, s, { name: 'r', scopes: ['read'] });
    expect((await send(t, 'GET', '/system/backups', { headers: bearer(token) })).status).toBe(200);
    expect((await send(t, 'GET', '/system/backups')).status).toBe(401);
  });
});

describe('system.backups.create', () => {
  it('a session with CSRF takes a manual backup and gets its entry back', async () => {
    const res = await send(t, 'POST', '/system/backups', { headers: asSession(s, true) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(dir);
    const b = BackupSchema.parse(JSON.parse(text));
    expect(b.reason).toBe('manual');
    expect(b.name).toMatch(/^transcoda-\d{8}-\d{6}-v\d+-manual\.sqlite$/);
    expect(b.size).toBeGreaterThan(0);
    expect(backups()).toEqual([b.name]);
  });

  it('a second backup within 30 s → 429 with a clear message; after 30 s it works again', async () => {
    expect((await send(t, 'POST', '/system/backups', { headers: asSession(s, true) })).status).toBe(
      200,
    );
    t.clock.advance(29_000);
    const res = await send(t, 'POST', '/system/backups', { headers: asSession(s, true) });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('A backup was taken moments ago');
    expect(backups()).toHaveLength(1);
    t.clock.advance(1_000);
    expect((await send(t, 'POST', '/system/backups', { headers: asSession(s, true) })).status).toBe(
      200,
    );
    expect(backups()).toHaveLength(2);
  });

  it('keeps 5 manual backups and never prunes a migration backup for one', async () => {
    mkdirSync(join(dir, 'backups'));
    writeFileSync(join(dir, 'backups', 'transcoda-20251001-120000-v6.sqlite'), '');
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, 'backups', `transcoda-2025101${i}-120000-v7-manual.sqlite`), '');
    }
    await send(t, 'POST', '/system/backups', { headers: asSession(s, true) });
    const names = backups();
    expect(names).toHaveLength(6);
    expect(names).toContain('transcoda-20251001-120000-v6.sqlite');
    expect(names).not.toContain('transcoda-20251010-120000-v7-manual.sqlite');
  });

  it('a session without the CSRF header → 403, nothing written', async () => {
    const res = await send(t, 'POST', '/system/backups', { headers: asSession(s, false) });
    expect(res.status).toBe(403);
    expect(backups()).toEqual([]);
  });

  it('a token with every scope → 403 "Backups are taken in the UI", nothing written', async () => {
    const { token } = await createToken(t, s, { name: 'all', scopes: ALL_SCOPES });
    const res = await send(t, 'POST', '/system/backups', { headers: bearer(token) });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Backups are taken in the UI');
    expect(backups()).toEqual([]);
  });

  it('anonymous → 401', async () => {
    expect((await send(t, 'POST', '/system/backups')).status).toBe(401);
    expect(backups()).toEqual([]);
  });
});
