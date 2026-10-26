import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SESSION_COOKIE } from '../../auth/cookies.ts';
import { getSetting, setSetting } from '../../db/repos/settings.ts';
import { countUsers } from '../../db/repos/users.ts';
import { createTestApp, type TestApp } from '../../test-app.ts';

const HOST = 'localhost:8080';
const ORIGIN = 'http://localhost:8080';
const CREDS = { username: 'admin', password: 'correct-horse-battery' };

/** The raw `tcd_session` Set-Cookie header, if any. */
function sessionSetCookie(res: Response): string | null {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? null;
}

/** The `tcd_session` cookie value set by the response ('' for a clearing cookie, null if absent). */
function extractCookie(res: Response): string | null {
  const header = sessionSetCookie(res);
  if (header === null) return null;
  return header.slice(SESSION_COOKIE.length + 1).split(';')[0] ?? '';
}

function call(
  t: TestApp,
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown; cookie?: string | undefined; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { host: HOST, ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie !== undefined) headers.cookie = `${SESSION_COOKIE}=${opts.cookie}`;
  return Promise.resolve(
    t.app.request(`/api/v1${path}`, {
      method,
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
  );
}

async function setup(t: TestApp, headers: Record<string, string> = {}): Promise<string> {
  const res = await call(t, 'POST', '/auth/setup', { body: CREDS, headers });
  expect(res.status).toBe(200);
  const cookie = extractCookie(res);
  expect(cookie).toBeTruthy();
  return cookie as string;
}

async function loginCookie(t: TestApp): Promise<string> {
  const res = await call(t, 'POST', '/auth/login', { body: CREDS });
  expect(res.status).toBe(200);
  return extractCookie(res) as string;
}

/** A form-encoded POST, as a cross-site HTML form would send it (no CORS preflight). */
function formPost(t: TestApp, path: string, headers: Record<string, string>): Promise<Response> {
  return Promise.resolve(
    t.app.request(`/api/v1${path}`, {
      method: 'POST',
      headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(CREDS).toString(),
    }),
  );
}

async function me(t: TestApp, cookie?: string, headers: Record<string, string> = {}) {
  const res = await call(t, 'GET', '/auth/me', { cookie, headers });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe('auth procedures', () => {
  it('me reports setupRequired on an empty db', async () => {
    const t = createTestApp();
    const { res, body } = await me(t);
    expect(res.status).toBe(200);
    expect(body).toEqual({
      setupRequired: true,
      user: null,
      csrfToken: null,
      appearance: { theme: 'system', serverName: null },
    });
  });

  it('setup creates the admin, sets an HttpOnly SameSite=Lax cookie, records the host', async () => {
    const t = createTestApp();
    const res = await call(t, 'POST', '/auth/setup', {
      body: CREDS,
      headers: { host: 'media.lan:8080' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { username: string } };
    expect(body.user.username).toBe('admin');
    const header = sessionSetCookie(res) ?? '';
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('Secure');
    expect(countUsers(t.db)).toBe(1);
    expect(getSetting(t.db, 'allowed_hosts', z.array(z.string()))).toContain('media.lan');
    // Host check now admits media.lan.
    const after = await call(t, 'GET', '/system/health', { headers: { host: 'media.lan' } });
    expect(after.status).toBe(200);
  });

  it('setup does not record always-allowed hosts', async () => {
    const t = createTestApp();
    await setup(t);
    expect(getSetting(t.db, 'allowed_hosts', z.array(z.string())) ?? []).not.toContain('localhost');
  });

  it('setup twice → 409', async () => {
    const t = createTestApp();
    await setup(t);
    const res = await call(t, 'POST', '/auth/setup', { body: { ...CREDS, username: 'other' } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('SETUP_ALREADY_DONE');
  });

  it('two concurrent setups → exactly one 2xx and one 409, one user', async () => {
    const t = createTestApp();
    const [a, b] = await Promise.all([
      call(t, 'POST', '/auth/setup', { body: CREDS }),
      call(t, 'POST', '/auth/setup', { body: { ...CREDS, username: 'second' } }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(countUsers(t.db)).toBe(1);
  });

  it('login with wrong password → 401 and the 6th failure → 429 with retryAfterSeconds', async () => {
    const t = createTestApp();
    await setup(t);
    for (let i = 0; i < 5; i++) {
      const res = await call(t, 'POST', '/auth/login', {
        body: { ...CREDS, password: 'wrong-password-123' },
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_CREDENTIALS');
    }
    const res = await call(t, 'POST', '/auth/login', {
      body: { ...CREDS, password: 'wrong-password-123' },
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string; data: { retryAfterSeconds: number } };
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.data.retryAfterSeconds).toBe(60);
    // Even the right password is refused while locked.
    expect((await call(t, 'POST', '/auth/login', { body: CREDS })).status).toBe(429);
  });

  it('10 concurrent wrong-password logins → at most 5 are 401, the rest 429', async () => {
    const t = createTestApp();
    await setup(t);
    const wrong = { ...CREDS, password: 'wrong-password-123' };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call(t, 'POST', '/auth/login', { body: wrong })),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(5);
    expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
    expect((await call(t, 'POST', '/auth/login', { body: CREDS })).status).toBe(429);
  });

  it('a correct password on the 5th attempt still succeeds', async () => {
    const t = createTestApp();
    await setup(t);
    for (let i = 0; i < 4; i++) {
      const res = await call(t, 'POST', '/auth/login', {
        body: { ...CREDS, password: 'wrong-password-123' },
      });
      expect(res.status).toBe(401);
    }
    const res = await call(t, 'POST', '/auth/login', { body: CREDS });
    expect(res.status).toBe(200);
    // Success cleared the reservation and the failures.
    const again = await call(t, 'POST', '/auth/login', {
      body: { ...CREDS, password: 'wrong-password-123' },
    });
    expect(again.status).toBe(401);
  });

  it('cross-origin form-encoded setup → 403 CSRF_FAILED and no user created', async () => {
    const t = createTestApp();
    const res = await formPost(t, '/auth/setup', { origin: 'http://evil.example' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('CSRF_FAILED');
    expect(sessionSetCookie(res)).toBeNull();
    expect(countUsers(t.db)).toBe(0);
  });

  it('setup with Sec-Fetch-Site: cross-site (no Origin) or a foreign Referer → 403', async () => {
    const t = createTestApp();
    const a = await formPost(t, '/auth/setup', { 'sec-fetch-site': 'cross-site' });
    expect(a.status).toBe(403);
    const b = await formPost(t, '/auth/setup', { referer: 'http://evil.example/page' });
    expect(b.status).toBe(403);
    const c = await formPost(t, '/auth/setup', { origin: 'null' });
    expect(c.status).toBe(403);
    expect(countUsers(t.db)).toBe(0);
  });

  it('same-origin JSON setup → 200', async () => {
    const t = createTestApp();
    await setup(t, { origin: ORIGIN, 'sec-fetch-site': 'same-origin' });
    expect(countUsers(t.db)).toBe(1);
  });

  it('setup with an Origin matching the request Host (not yet allowed) → 200', async () => {
    const t = createTestApp();
    await setup(t, { host: 'media.lan:8080', origin: 'http://media.lan:8080' });
    expect(countUsers(t.db)).toBe(1);
  });

  it("the brief's Step 5 request (JSON, Host localhost:8080, no Origin) → 200 with the cookie", async () => {
    const t = createTestApp();
    const res = await call(t, 'POST', '/auth/setup', { body: CREDS });
    expect(res.status).toBe(200);
    expect(sessionSetCookie(res)).toMatch(/^tcd_session=[^;]+; .*HttpOnly; SameSite=Lax/);
  });

  it('cross-origin login → 403 CSRF_FAILED, no cookie, no failure recorded', async () => {
    const t = createTestApp();
    await setup(t);
    const res = await formPost(t, '/auth/login', { origin: 'http://evil.example' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('CSRF_FAILED');
    expect(sessionSetCookie(res)).toBeNull();
    const ok = await call(t, 'POST', '/auth/login', {
      body: CREDS,
      headers: { origin: ORIGIN },
    });
    expect(ok.status).toBe(200);
  });

  it('me after the touch interval re-sends tcd_session with the later Expires; within it, no Set-Cookie', async () => {
    const t = createTestApp();
    const cookie = await setup(t);
    t.clock.advance(30 * 60 * 1000); // within the 1 h touch interval
    const within = await me(t, cookie);
    expect(within.body.user).not.toBeNull();
    expect(within.res.headers.getSetCookie()).toEqual([]);

    t.clock.advance(2 * 3600 * 1000); // past it
    const later = await me(t, cookie);
    expect(later.body.user).not.toBeNull();
    const header = sessionSetCookie(later.res) ?? '';
    expect(extractCookie(later.res)).toBe(cookie);
    const expected = new Date(t.clock.now().getTime() + 30 * 24 * 3600 * 1000);
    expect(header).toContain(`Expires=${expected.toUTCString()}`);
    expect(header).toContain('HttpOnly');
    expect(header).not.toContain('Secure');
  });

  it('the refreshed cookie carries Secure when the request came over HTTPS via a trusted proxy', async () => {
    const t = createTestApp({ config: { trustedProxies: ['10.0.0.1'] }, remoteAddr: '10.0.0.1' });
    const https = { 'x-forwarded-proto': 'https' };
    const cookie = await setup(t, https);
    t.clock.advance(2 * 3600 * 1000);
    const { res } = await me(t, cookie, https);
    expect(sessionSetCookie(res)).toContain('Secure');
  });

  it('logout after the touch interval only clears the cookie (no refresh)', async () => {
    const t = createTestApp();
    const cookie = await setup(t);
    const csrf = (await me(t, cookie)).body.csrfToken as string;
    t.clock.advance(2 * 3600 * 1000);
    const res = await call(t, 'POST', '/auth/logout', {
      cookie,
      headers: { origin: ORIGIN, 'x-csrf-token': csrf },
    });
    expect(res.status).toBe(200);
    const sessionCookies = res.headers
      .getSetCookie()
      .filter((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(sessionCookies).toHaveLength(1);
    expect(sessionCookies[0]).toContain('Max-Age=0');
  });

  it('login with an unknown user → 401 INVALID_CREDENTIALS', async () => {
    const t = createTestApp();
    await setup(t);
    const res = await call(t, 'POST', '/auth/login', { body: { ...CREDS, username: 'nobody' } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_CREDENTIALS');
  });

  it('login succeeds, rotates the session id', async () => {
    const t = createTestApp();
    const first = await setup(t);
    const res = await call(t, 'POST', '/auth/login', {
      body: { ...CREDS, username: 'ADMIN' },
      cookie: first,
    });
    expect(res.status).toBe(200);
    const second = extractCookie(res);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect((await me(t, first)).body.user).toBeNull();
    expect((await me(t, second as string)).body.user).toMatchObject({ username: 'admin' });
  });

  it('me with a valid cookie returns the user and a csrfToken', async () => {
    const t = createTestApp();
    const cookie = await setup(t);
    const { res, body } = await me(t, cookie);
    expect(res.status).toBe(200);
    expect(body.setupRequired).toBe(false);
    expect(body.user).toMatchObject({ username: 'admin' });
    expect(typeof body.csrfToken).toBe('string');
    expect(sessionSetCookie(res)).toBeNull();
  });

  it('logout without X-CSRF-Token → 403 CSRF_FAILED', async () => {
    const t = createTestApp();
    const cookie = await setup(t);
    const res = await call(t, 'POST', '/auth/logout', { cookie, headers: { origin: ORIGIN } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('CSRF_FAILED');
    expect((await me(t, cookie)).body.user).not.toBeNull();
  });

  it('logout without a session → 401', async () => {
    const t = createTestApp();
    await setup(t);
    const res = await call(t, 'POST', '/auth/logout', { headers: { origin: ORIGIN } });
    expect(res.status).toBe(401);
  });

  it('logout with the token and Origin: http://localhost:8080 → 200 and the cookie is cleared', async () => {
    const t = createTestApp();
    const cookie = await setup(t);
    const csrf = (await me(t, cookie)).body.csrfToken as string;
    const res = await call(t, 'POST', '/auth/logout', {
      cookie,
      headers: { origin: ORIGIN, 'x-csrf-token': csrf },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(extractCookie(res)).toBe('');
    expect(sessionSetCookie(res)).toContain('Max-Age=0');
    expect((await me(t, cookie)).body.user).toBeNull();
  });

  it('logout with the token, no Origin but Sec-Fetch-Site: same-origin → 200', async () => {
    const t = createTestApp();
    const cookie = await setup(t);
    const csrf = (await me(t, cookie)).body.csrfToken as string;
    const res = await call(t, 'POST', '/auth/logout', {
      cookie,
      headers: { 'sec-fetch-site': 'same-origin', 'x-csrf-token': csrf },
    });
    expect(res.status).toBe(200);
  });

  it('logout with the token but neither Origin nor Sec-Fetch-Site → 403', async () => {
    const t = createTestApp();
    const cookie = await setup(t);
    const csrf = (await me(t, cookie)).body.csrfToken as string;
    const res = await call(t, 'POST', '/auth/logout', {
      cookie,
      headers: { 'x-csrf-token': csrf },
    });
    expect(res.status).toBe(403);
  });

  it('logout with Origin: http://evil.example → 403', async () => {
    const t = createTestApp();
    const cookie = await setup(t);
    const csrf = (await me(t, cookie)).body.csrfToken as string;
    const res = await call(t, 'POST', '/auth/logout', {
      cookie,
      headers: { origin: 'http://evil.example', 'x-csrf-token': csrf },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('CSRF_FAILED');
  });

  it('me with an expired cookie → user null and Set-Cookie clears it', async () => {
    const t = createTestApp();
    const cookie = await setup(t);
    t.clock.advance(31 * 24 * 3600 * 1000);
    const { res, body } = await me(t, cookie);
    expect(res.status).toBe(200);
    expect(body.user).toBeNull();
    expect(body.csrfToken).toBeNull();
    expect(extractCookie(res)).toBe('');
    expect(sessionSetCookie(res)).toContain('Max-Age=0');
  });

  it('me with Authorization: Bearer nope → user null, 200', async () => {
    const t = createTestApp();
    await setup(t);
    const { res, body } = await me(t, undefined, { authorization: 'Bearer nope' });
    expect(res.status).toBe(200);
    expect(body.user).toBeNull();
  });

  it('me with a valid API token returns the user and no csrfToken', async () => {
    const t = createTestApp();
    await setup(t);
    const user = (await me(t, await loginCookie(t))).body.user as { id: string };
    const { token } = t.deps.tokens.create(user.id, { name: 'cli', scopes: ['read'] });
    const { body } = await me(t, undefined, { authorization: `Bearer ${token}` });
    expect(body.user).toMatchObject({ username: 'admin' });
    expect(body.csrfToken).toBeNull();
  });

  it('system.capabilities with Bearer nope → 401', async () => {
    const t = createTestApp();
    await setup(t);
    const res = await call(t, 'GET', '/system/capabilities', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('UNAUTHORIZED');
  });

  it('system.capabilities: a token without read → 403; with read or a session → 200', async () => {
    const t = createTestApp();
    const cookie = await setup(t);
    const user = (await me(t, cookie)).body.user as { id: string };
    const noRead = t.deps.tokens.create(user.id, { name: 'plan', scopes: ['plan'] }).token;
    const read = t.deps.tokens.create(user.id, { name: 'read', scopes: ['read'] }).token;
    const get = (headers: Record<string, string>, c?: string) =>
      call(t, 'GET', '/system/capabilities', { headers, cookie: c });
    expect((await get({ authorization: `Bearer ${noRead}` })).status).toBe(403);
    expect((await get({ authorization: `Bearer ${read}` })).status).toBe(200);
    expect((await get({}, cookie)).status).toBe(200);
  });

  it('Secure flag present when X-Forwarded-Proto: https from a trusted proxy and absent otherwise', async () => {
    const trusted = createTestApp({
      config: { trustedProxies: ['10.0.0.1'] },
      remoteAddr: '10.0.0.1',
    });
    const res = await call(trusted, 'POST', '/auth/setup', {
      body: CREDS,
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res.status).toBe(200);
    expect(sessionSetCookie(res)).toContain('Secure');

    const untrusted = createTestApp({
      config: { trustedProxies: ['10.0.0.1'] },
      remoteAddr: '192.168.1.5',
    });
    const res2 = await call(untrusted, 'POST', '/auth/setup', {
      body: CREDS,
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res2.status).toBe(200);
    expect(sessionSetCookie(res2)).not.toContain('Secure');
  });

  describe('behind a proxy that rewrites Host', () => {
    const PROXY_HEADERS = {
      host: 'transcoda:8080',
      'x-forwarded-host': 'media.example.com',
      origin: 'https://media.example.com',
    };
    const proxied = (remoteAddr: string) =>
      createTestApp({ config: { trustedProxies: ['172.16.0.0/12'] }, remoteAddr });

    it('trusted proxy: setup records the X-Forwarded-Host; login and me work afterwards', async () => {
      const t = proxied('172.17.0.1');
      const res = await call(t, 'POST', '/auth/setup', { body: CREDS, headers: PROXY_HEADERS });
      expect(res.status).toBe(200);
      const stored = getSetting(t.db, 'allowed_hosts', z.array(z.string())) ?? [];
      expect(stored).toContain('media.example.com');
      expect(stored).not.toContain('transcoda');

      const login = await call(t, 'POST', '/auth/login', { body: CREDS, headers: PROXY_HEADERS });
      expect(login.status).toBe(200);
      const cookie = extractCookie(login) as string;
      const { res: meRes, body } = await me(t, cookie, PROXY_HEADERS);
      expect(meRes.status).toBe(200);
      expect((body.user as { username: string }).username).toBe('admin');
    });

    it('untrusted remote: X-Forwarded-Host is ignored (Origin mismatch, nothing recorded)', async () => {
      const t = proxied('203.0.113.9');
      const res = await call(t, 'POST', '/auth/setup', { body: CREDS, headers: PROXY_HEADERS });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('CSRF_FAILED');
      expect(countUsers(t.db)).toBe(0);
      expect(getSetting(t.db, 'allowed_hosts', z.array(z.string())) ?? []).toEqual([]);

      // Without the Origin the setup passes, and records the Host header, not X-Forwarded-Host.
      const { origin: _origin, ...noOrigin } = PROXY_HEADERS;
      const ok = await call(t, 'POST', '/auth/setup', { body: CREDS, headers: noOrigin });
      expect(ok.status).toBe(200);
      expect(getSetting(t.db, 'allowed_hosts', z.array(z.string()))).toEqual(['transcoda']);
    });
  });

  it('works over /rpc too (setup then me via RPC)', async () => {
    const t = createTestApp();
    const res = await t.app.request('/rpc/auth/setup', {
      method: 'POST',
      headers: { host: HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ json: CREDS }),
    });
    expect(res.status).toBe(200);
    expect(extractCookie(res)).toBeTruthy();
  });
});

describe('auth.me appearance', () => {
  it('carries the theme row; the server name only for a signed-in caller', async () => {
    const t = createTestApp();
    const cookie = await setup(t);
    setSetting(t.db, 'ui.theme', 'light', t.clock.now());
    setSetting(t.db, 'server.name', 'Basement', t.clock.now());
    expect((await me(t)).body.appearance).toEqual({ theme: 'light', serverName: null });
    expect((await me(t, cookie)).body.appearance).toEqual({
      theme: 'light',
      serverName: 'Basement',
    });
  });
});

describe('auth.changePassword', () => {
  const NEW_PASSWORD = 'a-brand-new-passphrase';

  async function signedIn(t: TestApp, cookie: string): Promise<Record<string, string>> {
    const csrf = (await me(t, cookie)).body.csrfToken as string;
    return { origin: ORIGIN, 'x-csrf-token': csrf };
  }

  function change(
    t: TestApp,
    cookie: string | undefined,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<Response> {
    return call(t, 'POST', '/auth/password', { cookie, headers, body });
  }

  const loginWith = (t: TestApp, password: string) =>
    call(t, 'POST', '/auth/login', { body: { ...CREDS, password } });

  it('a wrong current password → 401 INVALID_CREDENTIALS and nothing changes', async () => {
    const t = createTestApp();
    const cookie = await setup(t);
    const res = await change(t, cookie, await signedIn(t, cookie), {
      currentPassword: 'not-the-password',
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('INVALID_CREDENTIALS');
    expect(body.message).toBe('The current password is wrong');
    expect((await loginWith(t, CREDS.password)).status).toBe(200);
  });

  it('the right one changes it, keeps this session and signs out the others', async () => {
    const t = createTestApp();
    const cookie = await setup(t);
    const other = await loginCookie(t);
    const res = await change(t, cookie, await signedIn(t, cookie), {
      currentPassword: CREDS.password,
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await me(t, cookie)).body.user).toMatchObject({ username: 'admin' });
    expect((await me(t, other)).body.user).toBeNull();
    expect((await loginWith(t, CREDS.password)).status).toBe(401);
    expect((await loginWith(t, NEW_PASSWORD)).status).toBe(200);
  });

  it('API tokens keep working after a change', async () => {
    const t = createTestApp();
    const cookie = await setup(t);
    const user = (await me(t, cookie)).body.user as { id: string };
    const { token } = t.deps.tokens.create(user.id, { name: 'cli', scopes: ['read'] });
    await change(t, cookie, await signedIn(t, cookie), {
      currentPassword: CREDS.password,
      newPassword: NEW_PASSWORD,
    });
    const { body } = await me(t, undefined, { authorization: `Bearer ${token}` });
    expect(body.user).toMatchObject({ username: 'admin' });
  });

  it('without the CSRF header → 403; anonymous → 401; any API token → 403 "Passwords are changed in the UI"', async () => {
    const t = createTestApp();
    const cookie = await setup(t);
    const input = { currentPassword: CREDS.password, newPassword: NEW_PASSWORD };
    expect((await change(t, cookie, {}, input)).status).toBe(403);
    expect((await change(t, undefined, {}, input)).status).toBe(401);
    const user = (await me(t, cookie)).body.user as { id: string };
    const { token } = t.deps.tokens.create(user.id, {
      name: 'all',
      scopes: ['read', 'plan', 'jobs:create', 'jobs:manage', 'workflows:write'],
    });
    const res = await change(t, undefined, { authorization: `Bearer ${token}` }, input);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Passwords are changed in the UI');
    expect((await loginWith(t, CREDS.password)).status).toBe(200);
  });

  it('a new password under 12 characters → 400', async () => {
    const t = createTestApp();
    const cookie = await setup(t);
    const res = await change(t, cookie, await signedIn(t, cookie), {
      currentPassword: CREDS.password,
      newPassword: 'short-pass1',
    });
    expect(res.status).toBe(400);
  });

  it('the sixth wrong attempt → 429 RATE_LIMITED', async () => {
    const t = createTestApp();
    const cookie = await setup(t);
    const headers = await signedIn(t, cookie);
    const wrong = { currentPassword: 'wrong-password-123', newPassword: NEW_PASSWORD };
    for (let i = 0; i < 5; i++) {
      expect((await change(t, cookie, headers, wrong)).status).toBe(401);
    }
    const res = await change(t, cookie, headers, wrong);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe('RATE_LIMITED');
  });
});
