import { fcRuns } from '@transcoda/shared/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { triggerHeaders, triggerToken } from './trigger.ts';

// Header values as fetch's Headers accepts them (no CR, LF or NUL).
const headerValue = fc.string({ maxLength: 200 }).filter((v) => !/[\r\n\0]/.test(v));
const auths = fc.constantFrom(null, { basic: true } as const, { header: 'x-api-key' });

describe('trigger credentials, for any header', () => {
  it('triggerToken never throws and returns null or a non-empty string', () => {
    fc.assert(
      fc.property(headerValue, headerValue, auths, (authorization, key, auth) => {
        const headers = new Headers();
        headers.set('authorization', authorization);
        headers.set('x-api-key', key);
        const token = triggerToken(headers, auth);
        expect(token === null || (typeof token === 'string' && token.length > 0)).toBe(true);
      }),
      fcRuns(),
    );
  });

  it('Basic auth gives back exactly the password, whatever the user name', () => {
    const user = fc.string({ maxLength: 40 }).filter((u) => !u.includes(':'));
    const password = fc.string({ minLength: 1, maxLength: 80 });
    fc.assert(
      fc.property(user, password, (u, p) => {
        const value = `Basic ${Buffer.from(`${u}:${p}`, 'utf8').toString('base64')}`;
        const headers = new Headers({ authorization: value });
        expect(triggerToken(headers, { basic: true })).toBe(p);
      }),
      fcRuns(),
    );
  });

  it('the headers a plugin sees never hold the credentials', () => {
    fc.assert(
      fc.property(headerValue, headerValue, auths, (authorization, key, auth) => {
        const headers = new Headers({ cookie: 'tcd_session=s', 'x-other': 'kept' });
        headers.set('authorization', authorization);
        headers.set('x-api-key', key);
        const seen = triggerHeaders(headers, auth);
        expect(seen).not.toHaveProperty('authorization');
        expect(seen).not.toHaveProperty('cookie');
        if (auth && 'header' in auth) expect(seen).not.toHaveProperty('x-api-key');
        expect(seen['x-other']).toBe('kept');
      }),
      fcRuns(),
    );
  });
});
