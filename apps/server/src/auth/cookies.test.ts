import { describe, expect, it } from 'vitest';
import { clearSessionCookie, readCookie, SESSION_COOKIE, sessionCookie } from './cookies.ts';

const expires = new Date('2026-02-01T00:00:00.000Z');

describe('cookies', () => {
  it('sessionCookie includes HttpOnly, SameSite=Lax, Path=/ and no Secure when secure=false', () => {
    const c = sessionCookie('abc', { secure: false, expires });
    expect(c).toBe(
      `${SESSION_COOKIE}=abc; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}`,
    );
    expect(c).not.toContain('Secure');
  });

  it('includes Secure when secure=true', () => {
    expect(sessionCookie('abc', { secure: true, expires })).toMatch(/; Secure$/);
  });

  it('clearSessionCookie has Max-Age=0', () => {
    const c = clearSessionCookie({ secure: true });
    expect(c).toContain('Max-Age=0');
    expect(c).toMatch(/^tcd_session=;/);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(clearSessionCookie({ secure: false })).not.toContain('Secure');
  });

  it('readCookie finds a value among several cookies and returns null when absent', () => {
    expect(readCookie('a=1; tcd_session=xyz; b=2', 'tcd_session')).toBe('xyz');
    expect(readCookie('a=1; b=2', 'tcd_session')).toBeNull();
    expect(readCookie(null, 'tcd_session')).toBeNull();
    expect(readCookie('xtcd_session=no', 'tcd_session')).toBeNull();
  });
});
