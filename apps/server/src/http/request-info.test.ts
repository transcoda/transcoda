import { describe, expect, it } from 'vitest';
import { ConfigError } from '../config.ts';
import {
  clientIp,
  isHttps,
  isTrustedProxy,
  parseTrustedProxies,
  requestHost,
} from './request-info.ts';

const req = (headers: Record<string, string> = {}, url = 'http://example.com/') =>
  new Request(url, { headers });

describe('parseTrustedProxies', () => {
  it('accepts CIDRs, bare addresses and IPv6', () => {
    const list = parseTrustedProxies(['10.0.0.0/8', '192.168.1.5', 'fd00::/8']);
    expect(isTrustedProxy(list, '10.1.2.3')).toBe(true);
    expect(isTrustedProxy(list, '192.168.1.5')).toBe(true);
    expect(isTrustedProxy(list, '192.168.1.6')).toBe(false);
    expect(isTrustedProxy(list, 'fd12::1')).toBe(true);
    expect(isTrustedProxy(list, '11.0.0.1')).toBe(false);
  });

  it('rejects junk', () => {
    expect(() => parseTrustedProxies(['nope'])).toThrow(ConfigError);
    expect(() => parseTrustedProxies(['10.0.0.0/99'])).toThrow(ConfigError);
    expect(() => parseTrustedProxies(['10.0.0.0/x'])).toThrow(ConfigError);
  });

  it('treats ::ffff:10.0.0.1 as 10.0.0.1', () => {
    const list = parseTrustedProxies(['10.0.0.0/8']);
    expect(isTrustedProxy(list, '::ffff:10.0.0.1')).toBe(true);
    expect(isTrustedProxy(list, '::ffff:11.0.0.1')).toBe(false);
  });
});

describe('clientIp', () => {
  const trusted = parseTrustedProxies(['10.0.0.0/8']);

  it('ignores X-Forwarded-For from an untrusted remote', () => {
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4' }), '8.8.8.8', trusted)).toBe('8.8.8.8');
  });

  it('uses the last untrusted hop from a trusted proxy', () => {
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 10.0.0.2' }), '10.0.0.1', trusted)).toBe(
      '1.2.3.4',
    );
    // A spoofed leftmost entry is not trusted over the real hop.
    expect(
      clientIp(req({ 'x-forwarded-for': '6.6.6.6, 1.2.3.4, 10.0.0.2' }), '10.0.0.1', trusted),
    ).toBe('1.2.3.4');
  });

  it('falls back to remoteAddr without the header or when all hops are trusted', () => {
    expect(clientIp(req(), '10.0.0.1', trusted)).toBe('10.0.0.1');
    expect(clientIp(req({ 'x-forwarded-for': '10.0.0.3' }), '10.0.0.1', trusted)).toBe('10.0.0.1');
  });
});

describe('isHttps', () => {
  const trusted = parseTrustedProxies(['10.0.0.0/8']);

  it('honours X-Forwarded-Proto only from trusted', () => {
    const r = req({ 'x-forwarded-proto': 'https' });
    expect(isHttps(r, '10.0.0.1', trusted)).toBe(true);
    expect(isHttps(r, '8.8.8.8', trusted)).toBe(false);
  });

  it('uses the request URL protocol otherwise', () => {
    expect(isHttps(req({}, 'https://example.com/'), '8.8.8.8', trusted)).toBe(true);
  });
});

describe('requestHost', () => {
  const trusted = parseTrustedProxies(['10.0.0.0/8']);
  const r = req({ host: 'transcoda:8080', 'x-forwarded-host': 'media.example.com, other.example' });

  it('uses the first X-Forwarded-Host value from a trusted proxy', () => {
    expect(requestHost(r, '10.0.0.1', trusted)).toBe('media.example.com');
  });

  it('ignores X-Forwarded-Host from an untrusted remote', () => {
    expect(requestHost(r, '8.8.8.8', trusted)).toBe('transcoda:8080');
  });

  it('falls back to Host when the header is absent or empty', () => {
    expect(requestHost(req({ host: 'a.example' }), '10.0.0.1', trusted)).toBe('a.example');
    expect(
      requestHost(req({ host: 'a.example', 'x-forwarded-host': ' ' }), '10.0.0.1', trusted),
    ).toBe('a.example');
    expect(requestHost(req({}), '10.0.0.1', trusted)).toBeNull();
  });
});
