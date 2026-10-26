import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../auth/cookies.ts';
import { createUser } from '../db/repos/users.ts';
import { createTestApp } from '../test-app.ts';
import { resolveAuth } from './auth-context.ts';

function fixture() {
  const t = createTestApp();
  const user = createUser(t.db, { username: 'admin', passwordHash: 'x' }, t.clock.now());
  const session = t.deps.sessions.create(user.id);
  const { token } = t.deps.tokens.create(user.id, { name: 'cli', scopes: ['read'] });
  const req = (headers: Record<string, string>) =>
    new Request('http://localhost:8080/api/v1/auth/me', { headers });
  return { t, user, session, token, req };
}

describe('resolveAuth', () => {
  it('bearer header wins over cookie', async () => {
    const { t, session, token, req } = fixture();
    const { auth, clearCookie } = await resolveAuth(
      req({ authorization: `Bearer ${token}`, cookie: `${SESSION_COOKIE}=${session.id}` }),
      t.deps,
    );
    expect(auth.kind).toBe('token');
    expect(clearCookie).toBe(false);
  });

  it('invalid bearer does not fall back to cookie', async () => {
    const { t, session, req } = fixture();
    const { auth, clearCookie } = await resolveAuth(
      req({ authorization: 'Bearer nope', cookie: `${SESSION_COOKIE}=${session.id}` }),
      t.deps,
    );
    expect(auth.kind).toBe('none');
    expect(clearCookie).toBe(false);
  });

  it('resolves a valid session cookie', async () => {
    const { t, user, session, req } = fixture();
    const { auth, clearCookie } = await resolveAuth(
      req({ cookie: `other=1; ${SESSION_COOKIE}=${session.id}` }),
      t.deps,
    );
    expect(auth).toMatchObject({ kind: 'session', user: { id: user.id } });
    expect(clearCookie).toBe(false);
  });

  it('flags an invalid session cookie for clearing', async () => {
    const { t, req } = fixture();
    const { auth, clearCookie } = await resolveAuth(
      req({ cookie: `${SESSION_COOKIE}=garbage` }),
      t.deps,
    );
    expect(auth.kind).toBe('none');
    expect(clearCookie).toBe(true);
  });

  it('returns none without credentials', async () => {
    const { t, req } = fixture();
    expect(await resolveAuth(req({}), t.deps)).toEqual({
      auth: { kind: 'none' },
      clearCookie: false,
    });
  });
});
