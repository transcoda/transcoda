import { describe, expect, it } from 'vitest';
import { triggerHeaders, triggerToken } from './trigger.ts';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const token = (headers: Record<string, string>, auth: Parameters<typeof triggerToken>[1] = null) =>
  triggerToken(new Headers(headers), auth);

describe('triggerToken', () => {
  it('reads a Bearer token or the password of Basic auth', () => {
    expect(token({ authorization: 'Bearer tcd_abc' })).toBe('tcd_abc');
    expect(token({ authorization: 'bearer tcd_abc' })).toBe('tcd_abc');
    expect(token({ authorization: `Basic ${b64('sonarr:tcd_abc')}` }, { basic: true })).toBe(
      'tcd_abc',
    );
    expect(token({ authorization: `Basic ${b64(':tcd_a:b')}` })).toBe('tcd_a:b');
  });

  it('a declared header wins over Authorization; an empty one falls back', () => {
    const auth = { header: 'X-Api-Key' };
    expect(token({ 'x-api-key': 'tcd_h', authorization: 'Bearer tcd_b' }, auth)).toBe('tcd_h');
    expect(token({ 'x-api-key': ' ', authorization: 'Bearer tcd_b' }, auth)).toBe('tcd_b');
  });

  it('anything else is no token', () => {
    expect(token({})).toBeNull();
    expect(token({ authorization: 'Basic' })).toBeNull();
    expect(token({ authorization: 'Basic !!!' })).toBeNull();
    expect(token({ authorization: `Basic ${b64('no-colon')}` })).toBeNull();
    expect(token({ authorization: `Basic ${b64('user:')}` })).toBeNull();
    expect(token({ authorization: 'Bearer a b' })).toBeNull();
    expect(token({ authorization: 'Digest abc' })).toBeNull();
    expect(token({ 'x-api-key': 'tcd_h' })).toBeNull();
  });
});

describe('triggerHeaders', () => {
  it('drops credentials, the declared header and over-long values', () => {
    const headers = new Headers({
      authorization: 'Bearer x',
      'proxy-authorization': 'x',
      cookie: 'c',
      'x-api-key': 'k',
      'x-long': 'v'.repeat(5000),
      'user-agent': 'Sonarr/4.0',
    });
    expect(triggerHeaders(headers, { header: 'X-Api-Key' })).toEqual({
      'user-agent': 'Sonarr/4.0',
    });
  });

  it('keeps at most 64 headers', () => {
    const headers = new Headers();
    for (let i = 0; i < 80; i++) headers.set(`x-h${i}`, 'v');
    expect(Object.keys(triggerHeaders(headers, null))).toHaveLength(64);
  });
});
