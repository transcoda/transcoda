import { expect } from 'vitest';
import { SESSION_COOKIE } from './auth/cookies.ts';
import { createUser } from './db/repos/users.ts';
import type { TestApp } from './test-app.ts';

/** REST helpers for procedure tests: requests through `TestApp.app` under `/api/v1`. */

export const HOST = 'localhost:8080';
export const ORIGIN = 'http://localhost:8080';
export const CREDS = { username: 'admin', password: 'correct-horse-battery' };

export interface Session {
  cookie: string;
  csrf: string;
}

export async function send(
  t: TestApp,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { host: HOST, ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return t.app.request(`/api/v1${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
}

export async function login(t: TestApp): Promise<Session> {
  const res = await send(t, 'POST', '/auth/setup', { body: CREDS });
  expect(res.status).toBe(200);
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '';
  const cookie = header.slice(SESSION_COOKIE.length + 1).split(';')[0] ?? '';
  return withCsrf(t, cookie);
}

export async function withCsrf(t: TestApp, cookie: string): Promise<Session> {
  const meRes = await send(t, 'GET', '/auth/me', {
    headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
  });
  const csrf = ((await meRes.json()) as { csrfToken: string }).csrfToken;
  return { cookie, csrf };
}

/** Second user, created through the repo, with a session from the app's SessionService. */
export async function secondUser(t: TestApp): Promise<Session> {
  const user = createUser(t.db, { username: 'other', passwordHash: 'x' }, t.clock.now());
  return withCsrf(t, t.deps.sessions.create(user.id).id);
}

export function asSession(s: Session, mutation: boolean): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE}=${s.cookie}`,
    ...(mutation ? { origin: ORIGIN, 'x-csrf-token': s.csrf } : {}),
  };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export async function createToken(
  t: TestApp,
  s: Session,
  body: Record<string, unknown> = { name: 'ci', scopes: ['read'] },
): Promise<{ id: string; token: string }> {
  const res = await send(t, 'POST', '/tokens', { body, headers: asSession(s, true) });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; token: string };
}
