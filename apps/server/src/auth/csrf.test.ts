import { describe, expect, it } from 'vitest';
import { CSRF_HEADER, csrfTokenFor, verifyCsrfToken } from './csrf.ts';

const k1 = Buffer.alloc(32, 1);
const k2 = Buffer.alloc(32, 2);

describe('csrf', () => {
  it('header name', () => expect(CSRF_HEADER).toBe('x-csrf-token'));

  it('token is stable for the same session and secret', () => {
    expect(csrfTokenFor(k1, 'h1')).toBe(csrfTokenFor(k1, 'h1'));
    expect(csrfTokenFor(k1, 'h1')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('differs across sessions and across secrets', () => {
    expect(csrfTokenFor(k1, 'h1')).not.toBe(csrfTokenFor(k1, 'h2'));
    expect(csrfTokenFor(k1, 'h1')).not.toBe(csrfTokenFor(k2, 'h1'));
  });

  it('verify accepts the right token and rejects wrong, empty, null and different-length tokens', () => {
    const t = csrfTokenFor(k1, 'h1');
    expect(verifyCsrfToken(k1, 'h1', t)).toBe(true);
    expect(verifyCsrfToken(k1, 'h2', t)).toBe(false);
    expect(verifyCsrfToken(k2, 'h1', t)).toBe(false);
    expect(verifyCsrfToken(k1, 'h1', `${t.slice(0, 42)}${t.endsWith('A') ? 'B' : 'A'}`)).toBe(
      false,
    );
    expect(verifyCsrfToken(k1, 'h1', '')).toBe(false);
    expect(verifyCsrfToken(k1, 'h1', null)).toBe(false);
    expect(verifyCsrfToken(k1, 'h1', t.slice(0, 20))).toBe(false);
    expect(verifyCsrfToken(k1, 'h1', `${t}x`)).toBe(false);
  });
});
