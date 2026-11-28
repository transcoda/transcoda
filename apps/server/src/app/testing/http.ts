import fsp, { type FileHandle } from 'node:fs/promises';
import { expect, type MockInstance, vi } from 'vitest';
import { SESSION_COOKIE } from '../../auth/cookies.ts';
import { createUser } from '../../db/repos/users.ts';
import type { TestApp } from './app.ts';

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

/** A request under way that the test can abort, as a client that goes away. */
export interface AbortableRequest {
  response: Promise<Response>;
  /** Aborts the request; the route's `c.req.raw.signal` has fired when this returns. */
  abort(): void;
}

/**
 * A GET under `/api/v1` that the test aborts later. Never pass `signal` to `app.request` for this:
 * it wraps the signal in a new Request that follows it only through a weak reference (undici), so
 * once nothing holds that Request a garbage collection cuts the link and the abort never reaches
 * the route. Here `abort` holds the Request the route gets, so the abort always arrives.
 */
export function abortableGet(
  t: Pick<TestApp, 'app'>,
  path: string,
  headers: Record<string, string> = {},
): AbortableRequest {
  const controller = new AbortController();
  const request = new Request(`http://localhost/api/v1${path}`, {
    headers: { host: HOST, ...headers },
    signal: controller.signal,
  });
  return {
    response: Promise.resolve(t.app.request(request)),
    abort() {
      controller.abort();
      // Uses `request` after the abort, so nothing may collect it before.
      expect(request.signal.aborted).toBe(true);
    },
  };
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

/** A FileHandle a route opened, with a spy on its `close` (and on `stat`, to make it fail). */
export interface TrackedHandle {
  path: string;
  handle: FileHandle;
  close: MockInstance<FileHandle['close']>;
}

/**
 * Tracks every FileHandle opened through `fs/promises` `open` (the default export, which the file
 * routes call): a list that fills as handles open. `failStat` makes each tracked handle's `stat`
 * reject. Restored by `vi.restoreAllMocks()`.
 */
export function trackFileHandles(opts: { failStat?: boolean } = {}): TrackedHandle[] {
  const tracked: TrackedHandle[] = [];
  const realOpen = fsp.open;
  vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
    const handle = await realOpen(...args);
    const close = vi.spyOn(handle, 'close');
    if (opts.failStat) {
      vi.spyOn(handle, 'stat').mockRejectedValue(
        Object.assign(new Error('EIO: i/o error, fstat'), { code: 'EIO' }),
      );
    }
    tracked.push({ path: String(args[0]), handle, close });
    return handle;
  });
  return tracked;
}

/** Every tracked handle was closed (a closed FileHandle's fd is -1). */
export async function expectAllClosed(tracked: TrackedHandle[], count = 1): Promise<void> {
  expect(tracked).toHaveLength(count);
  await vi.waitFor(() => {
    for (const t of tracked) expect(t.close, t.path).toHaveBeenCalled();
  });
  // The fd reads -1 before the native close finishes: wait for it, and let a failed close fail.
  for (const t of tracked) {
    for (const r of t.close.mock.results) await r.value;
    expect(t.handle.fd, t.path).toBe(-1);
  }
}
