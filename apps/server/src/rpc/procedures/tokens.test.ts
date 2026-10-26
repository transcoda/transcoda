import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../auth/cookies.ts';
import { createTestApp } from '../../test-app.ts';
import {
  asSession,
  bearer,
  createToken,
  login,
  ORIGIN,
  secondUser,
  send,
} from '../../test-http.ts';

describe('tokens procedures', () => {
  it('create returns the plaintext once and list omits it', async () => {
    const t = createTestApp();
    const s = await login(t);
    const created = await createToken(t, s);
    expect(created.token).toMatch(/^tcd_[A-Za-z0-9_-]{43}$/);
    const res = await send(t, 'GET', '/tokens', { headers: asSession(s, false) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(created.token);
    const list = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: created.id,
      name: 'ci',
      scopes: ['read'],
      revokedAt: null,
    });
    expect(list[0]).not.toHaveProperty('token');
  });

  it('a created token with scope read authenticates system.capabilities', async () => {
    const t = createTestApp();
    const s = await login(t);
    const { token } = await createToken(t, s);
    const res = await send(t, 'GET', '/system/capabilities', { headers: bearer(token) });
    expect(res.status).toBe(200);
  });

  it("token with only 'plan' scope → 403 on a read procedure", async () => {
    const t = createTestApp();
    const s = await login(t);
    const { token } = await createToken(t, s, { name: 'planner', scopes: ['plan'] });
    const res = await send(t, 'GET', '/system/capabilities', { headers: bearer(token) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('FORBIDDEN');
  });

  it('create via bearer token → 401 (session required)', async () => {
    const t = createTestApp();
    const s = await login(t);
    const { token } = await createToken(t, s);
    const res = await send(t, 'POST', '/tokens', {
      body: { name: 'x', scopes: ['read'] },
      headers: bearer(token),
    });
    expect(res.status).toBe(401);
  });

  it('list and revoke via bearer token → 401', async () => {
    const t = createTestApp();
    const s = await login(t);
    const { id, token } = await createToken(t, s);
    expect((await send(t, 'GET', '/tokens', { headers: bearer(token) })).status).toBe(401);
    expect((await send(t, 'DELETE', `/tokens/${id}`, { headers: bearer(token) })).status).toBe(401);
  });

  it('create without a CSRF token → 403', async () => {
    const t = createTestApp();
    const s = await login(t);
    const res = await send(t, 'POST', '/tokens', {
      body: { name: 'x', scopes: ['read'] },
      headers: { cookie: `${SESSION_COOKIE}=${s.cookie}`, origin: ORIGIN },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('CSRF_FAILED');
  });

  it('revoke → 200, then bearer → 401, list shows revokedAt', async () => {
    const t = createTestApp();
    const s = await login(t);
    const { id, token } = await createToken(t, s);
    expect((await send(t, 'GET', '/system/capabilities', { headers: bearer(token) })).status).toBe(
      200,
    );
    const res = await send(t, 'DELETE', `/tokens/${id}`, { headers: asSession(s, true) });
    expect(res.status).toBe(200);
    expect((await send(t, 'GET', '/system/capabilities', { headers: bearer(token) })).status).toBe(
      401,
    );
    const list = (await (
      await send(t, 'GET', '/tokens', { headers: asSession(s, false) })
    ).json()) as Array<{ id: string; revokedAt: string | null }>;
    expect(list.find((x) => x.id === id)?.revokedAt).toBe(t.clock.now().toISOString());
  });

  it('revoke without a CSRF token → 403', async () => {
    const t = createTestApp();
    const s = await login(t);
    const { id } = await createToken(t, s);
    const res = await send(t, 'DELETE', `/tokens/${id}`, {
      headers: { cookie: `${SESSION_COOKIE}=${s.cookie}`, origin: ORIGIN },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('CSRF_FAILED');
  });

  it('users only see and revoke their own tokens', async () => {
    const t = createTestApp();
    const a = await login(t);
    const b = await secondUser(t);
    const { id, token } = await createToken(t, a);
    const listB = await send(t, 'GET', '/tokens', { headers: asSession(b, false) });
    expect(listB.status).toBe(200);
    expect(await listB.json()).toEqual([]);
    const res = await send(t, 'DELETE', `/tokens/${id}`, { headers: asSession(b, true) });
    expect(res.status).toBe(404);
    expect((await send(t, 'GET', '/system/capabilities', { headers: bearer(token) })).status).toBe(
      200,
    );
    const listA = (await (
      await send(t, 'GET', '/tokens', { headers: asSession(a, false) })
    ).json()) as Array<{ id: string; revokedAt: string | null }>;
    expect(listA.find((x) => x.id === id)?.revokedAt).toBeNull();
  });

  it('revoke unknown id → 404', async () => {
    const t = createTestApp();
    const s = await login(t);
    const res = await send(t, 'DELETE', '/tokens/00000000-0000-4000-8000-000000000000', {
      headers: asSession(s, true),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('create with scopes: [] → 400', async () => {
    const t = createTestApp();
    const s = await login(t);
    const res = await send(t, 'POST', '/tokens', {
      body: { name: 'x', scopes: [] },
      headers: asSession(s, true),
    });
    expect(res.status).toBe(400);
  });

  it('create with a past expiresAt → 400 INVALID_EXPIRY', async () => {
    const t = createTestApp();
    const s = await login(t);
    const res = await send(t, 'POST', '/tokens', {
      body: { name: 'x', scopes: ['read'], expiresAt: '2025-01-01T00:00:00.000Z' },
      headers: asSession(s, true),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ defined: true, code: 'INVALID_EXPIRY', status: 400 });
    expect(
      await (await send(t, 'GET', '/tokens', { headers: asSession(s, false) })).json(),
    ).toEqual([]);
  });
});
