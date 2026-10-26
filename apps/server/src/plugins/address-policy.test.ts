import { describe, expect, it } from 'vitest';
import { addressVerdict, classifyAddress, isPrivateHost } from './address-policy.ts';

describe('classifyAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['::1', 'loopback'],
    ['0.0.0.0', 'loopback'],
    ['::', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['0:0:0:0:0:ffff:7f00:0001', 'loopback'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['169.254.169.254', 'metadata'],
    ['::ffff:169.254.169.254', 'metadata'],
    ['fd00:ec2::254', 'metadata'],
    ['100.100.100.200', 'metadata'],
    ['169.254.1.1', 'link-local'],
    ['fe80::1', 'link-local'],
    ['fe80::1%en0', 'link-local'],
    ['224.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['ff02::1', 'reserved'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.17.0.2', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.5', 'private'],
    ['100.64.0.1', 'private'],
    ['fd12:3456::1', 'private'],
    ['::ffff:192.168.1.5', 'private'],
    ['172.32.0.1', 'public'],
    ['8.8.8.8', 'public'],
    ['2606:4700::1111', 'public'],
    ['not-an-ip', 'reserved'],
  ])('%s is %s', (ip, kind) => {
    expect(classifyAddress(ip)).toBe(kind);
  });
});

describe('isPrivateHost', () => {
  it.each([
    ['sonarr', true],
    ['sonarr.lan', true],
    ['SONARR.LOCAL', true],
    ['nas.home.arpa', true],
    ['jellyfin.internal', true],
    ['box.tail1234.ts.net', true],
    ['192.168.1.5', true],
    ['[fd12::1]', true],
    ['media.example.com', false],
    ['8.8.8.8', false],
    ['api.themoviedb.org', false],
    ['lan.example.com', false],
  ])('%s -> %s', (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });
});

describe('addressVerdict', () => {
  it('refuses loopback, link-local, metadata and reserved whatever the origin', () => {
    for (const kind of ['loopback', 'link-local', 'metadata', 'reserved'] as const) {
      expect(addressVerdict(kind, true)).not.toBeNull();
      expect(addressVerdict(kind, false)).not.toBeNull();
    }
  });

  it('allows private addresses only for a private origin, and public addresses always', () => {
    expect(addressVerdict('private', true)).toBeNull();
    expect(addressVerdict('private', false)).not.toBeNull();
    expect(addressVerdict('public', true)).toBeNull();
    expect(addressVerdict('public', false)).toBeNull();
  });
});
