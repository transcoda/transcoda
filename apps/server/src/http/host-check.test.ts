import { describe, expect, it } from 'vitest';
import { ALWAYS_ALLOWED_HOSTS, checkHost, checkOrigin, hostnameOf } from './host-check.ts';

const req = (headers: Record<string, string>) => new Request('http://x/', { headers });

describe('hostnameOf', () => {
  it('normalises', () => {
    expect(hostnameOf('Example.com:8080')).toBe('example.com');
    expect(hostnameOf('[::1]:8080')).toBe('::1');
    expect(hostnameOf('[::1]')).toBe('::1');
    expect(hostnameOf('')).toBeNull();
    expect(hostnameOf(null)).toBeNull();
    expect(hostnameOf('a b')).toBeNull();
    expect(hostnameOf('a/b')).toBeNull();
  });
});

describe('checkHost', () => {
  const allowed = ['media.example.com'];
  it('ok for allowed, localhost always; not-allowed otherwise; missing when absent', () => {
    expect(checkHost('Media.example.com:8080', allowed)).toBe('ok');
    expect(ALWAYS_ALLOWED_HOSTS).toEqual(['localhost', '127.0.0.1', '::1']);
    expect(checkHost('localhost:8080', [])).toBe('ok');
    expect(checkHost('evil.example', allowed)).toBe('not-allowed');
    expect(checkHost(null, allowed)).toBe('missing');
  });
});

describe('checkOrigin', () => {
  const allowed = ['media.example.com'];
  it('ok / mismatch / absent', () => {
    expect(checkOrigin(req({ origin: 'https://media.example.com' }), allowed)).toBe('ok');
    expect(checkOrigin(req({ origin: 'https://evil.example' }), allowed)).toBe('mismatch');
    expect(checkOrigin(req({ origin: 'null' }), allowed)).toBe('mismatch');
    expect(checkOrigin(req({}), allowed)).toBe('absent');
  });
  it('falls back to Referer', () => {
    expect(checkOrigin(req({ referer: 'http://media.example.com/a' }), allowed)).toBe('ok');
    expect(checkOrigin(req({ referer: 'http://evil.example/a' }), allowed)).toBe('mismatch');
  });
});
