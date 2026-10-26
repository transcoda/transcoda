import { SettingsSchema } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../../test-app.ts';
import { asSession, bearer, createToken, login, type Session, send } from '../../test-http.ts';

const ALL_SCOPES = ['read', 'plan', 'jobs:create', 'jobs:manage', 'workflows:write'];

let t: TestApp;
let s: Session;

beforeEach(async () => {
  t = createTestApp();
  s = await login(t);
});
afterEach(async () => {
  await t.close();
});

const rows = () => t.db.prepare('SELECT key FROM settings ORDER BY key').all();

describe('settings.get', () => {
  it('a session reads every section in the schema', async () => {
    const res = await send(t, 'GET', '/settings', { headers: asSession(s, false) });
    expect(res.status).toBe(200);
    const body = SettingsSchema.parse(await res.json());
    expect(body.general.theme.value).toBe('system');
    expect(body.about.version).toBe('9.9.9');
  });

  it('a token with read may read', async () => {
    const { token } = await createToken(t, s, { name: 'r', scopes: ['read'] });
    const res = await send(t, 'GET', '/settings', { headers: bearer(token) });
    expect(res.status).toBe(200);
  });

  it('anonymous → 401', async () => {
    expect((await send(t, 'GET', '/settings')).status).toBe(401);
  });
});

describe('settings.update', () => {
  it('a session without the CSRF header → 403 CSRF_FAILED, nothing written', async () => {
    const before = rows();
    const res = await send(t, 'PATCH', '/settings', {
      body: { theme: 'light' },
      headers: asSession(s, false),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('CSRF_FAILED');
    expect(rows()).toEqual(before);
  });

  it('a session with CSRF → 200 and the new value', async () => {
    const res = await send(t, 'PATCH', '/settings', {
      body: { theme: 'light', recycleRetentionDays: 30 },
      headers: asSession(s, true),
    });
    expect(res.status).toBe(200);
    const body = SettingsSchema.parse(await res.json());
    expect(body.general.theme).toMatchObject({ value: 'light', source: { kind: 'database' } });
    expect(body.recycle.retentionDays.value).toBe(30);
  });

  it('an unknown or out-of-range field → 400, nothing written', async () => {
    const before = rows();
    for (const body of [
      { queuePaused: true },
      { 'recycle.retentionDays': 3 },
      { pluginCallTimeoutMs: 999 },
      { testEncodeKeepHours: 73 },
      { testEncodeKeepHours: 1.5 },
      {},
    ]) {
      const res = await send(t, 'PATCH', '/settings', { body, headers: asSession(s, true) });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(rows()).toEqual(before);
  });

  it('a token with every scope → 403 "Settings are changed in the UI", nothing written', async () => {
    const { token } = await createToken(t, s, { name: 'all', scopes: ALL_SCOPES });
    const before = rows();
    const res = await send(t, 'PATCH', '/settings', {
      body: { theme: 'light' },
      headers: bearer(token),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Settings are changed in the UI');
    expect(rows()).toEqual(before);
  });

  it('a token with every scope is refused for the test-encode retention too, nothing written', async () => {
    const { token } = await createToken(t, s, { name: 'keep', scopes: ALL_SCOPES });
    const before = rows();
    const res = await send(t, 'PATCH', '/settings', {
      body: { testEncodeKeepHours: 6 },
      headers: bearer(token),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Settings are changed in the UI');
    expect(rows()).toEqual(before);
  });

  it('a session sets the test-encode retention', async () => {
    const res = await send(t, 'PATCH', '/settings', {
      body: { testEncodeKeepHours: 6 },
      headers: asSession(s, true),
    });
    expect(res.status).toBe(200);
    const body = SettingsSchema.parse(await res.json());
    expect(body.queue.testEncodeKeepHours).toEqual({
      value: 6,
      default: 2,
      source: { kind: 'database' },
    });
  });

  it('anonymous → 401', async () => {
    const res = await send(t, 'PATCH', '/settings', { body: { theme: 'light' } });
    expect(res.status).toBe(401);
  });

  it('the plugin call timeout reaches the running plugin service', async () => {
    const apply = vi.spyOn(t.deps.plugins, 'applyLimits');
    const res = await send(t, 'PATCH', '/settings', {
      body: { pluginCallTimeoutMs: 5000 },
      headers: asSession(s, true),
    });
    expect(res.status).toBe(200);
    expect(apply).toHaveBeenCalledWith({ callTimeoutMs: 5000 });
  });
});
