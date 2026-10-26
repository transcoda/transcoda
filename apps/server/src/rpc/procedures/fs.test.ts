import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../test-app.ts';
import { asSession, bearer, createToken, login, type Session, send } from '../../test-http.ts';

const ALL_SCOPES = ['read', 'plan', 'jobs:create', 'jobs:manage', 'workflows:write'];

let t: TestApp;
let s: Session;
let base: string;
let configDir: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'transcoda-fs-')));
  configDir = join(base, 'config');
  await mkdir(configDir);
  await mkdir(join(base, 'media/Shows'), { recursive: true });
  t = createTestApp({ config: { configDir } });
  s = await login(t);
});
afterEach(async () => {
  await t.close();
  await rm(base, { recursive: true, force: true });
});

const url = (path: string) => `/fs/dirs?path=${encodeURIComponent(path)}`;

describe('fs.browseDirs', () => {
  it('lists folders for a session, hiding the config folder', async () => {
    const res = await send(t, 'GET', url(base), { headers: asSession(s, false) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; entries: Array<{ name: string }> };
    expect(body.path).toBe(base);
    expect(body.entries.map((e) => e.name)).toEqual(['media']);
  });

  it('refuses to browse into the config folder, with the same answer as a missing folder', async () => {
    const hidden = await send(t, 'GET', url(configDir), { headers: asSession(s, false) });
    const missing = await send(t, 'GET', url(join(base, 'nope')), { headers: asSession(s, false) });
    expect(hidden.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(await hidden.json()).toEqual(await missing.json());
  });

  it('defaults to / and rejects a relative path with 400', async () => {
    const root = await send(t, 'GET', '/fs/dirs', { headers: asSession(s, false) });
    expect(root.status).toBe(200);
    expect(((await root.json()) as { path: string }).path).toBe('/');
    const rel = await send(t, 'GET', url('media'), { headers: asSession(s, false) });
    expect(rel.status).toBe(400);
  });

  it('refuses every API token with 403 "Folder browsing is a UI action", whatever its scopes', async () => {
    const { token } = await createToken(t, s, { name: 'all', scopes: ALL_SCOPES });
    const res = await send(t, 'GET', url(base), { headers: bearer(token) });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Folder browsing is a UI action');
  });

  it('needs a session: 401 without credentials', async () => {
    const res = await send(t, 'GET', url(base));
    expect(res.status).toBe(401);
  });
});
