import { randomBytes } from 'node:crypto';
import type { JsonValue } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import {
  decryptValue,
  encryptValue,
  isEncrypted,
  maskSettings,
  openSettings,
  SettingsDecryptError,
  sealSettings,
  secretValues,
} from './crypto.ts';

const key = randomBytes(32);

describe('encryptValue / decryptValue', () => {
  it('round-trips', () => {
    const enc = encryptValue(key, 'sonarr', 'apiKey', 'K1');
    expect(isEncrypted(enc)).toBe(true);
    expect(decryptValue(key, 'sonarr', 'apiKey', enc)).toBe('K1');
  });

  it('rejects a different plugin, path or key', () => {
    const enc = encryptValue(key, 'sonarr', 'apiKey', 'K1');
    expect(() => decryptValue(key, 'radarr', 'apiKey', enc)).toThrow(SettingsDecryptError);
    expect(() => decryptValue(key, 'sonarr', 'token', enc)).toThrow(SettingsDecryptError);
    expect(() => decryptValue(randomBytes(32), 'sonarr', 'apiKey', enc)).toThrow(
      SettingsDecryptError,
    );
    expect(() => decryptValue(key, 'sonarr', 'token', enc)).toThrow('cannot decrypt sonarr.token');
  });

  it('uses a fresh nonce each time', () => {
    const a = encryptValue(key, 'sonarr', 'apiKey', 'K1');
    const b = encryptValue(key, 'sonarr', 'apiKey', 'K1');
    expect(a.$enc).not.toBe(b.$enc);
  });

  it('does not mistake plain values for encrypted ones', () => {
    expect(isEncrypted('x')).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
    expect(isEncrypted({ set: true })).toBe(false);
    expect(isEncrypted({ $enc: 1 })).toBe(false);
  });
});

describe('sealSettings / openSettings / maskSettings', () => {
  const secrets = ['apiKey'];

  it('encrypts a new secret and leaves plain keys alone', () => {
    // A long plaintext: a two-letter one appears in random base64 ciphertext about 1% of runs.
    const apiKey = 'plain-api-key-K1';
    const sealed = sealSettings(key, 'sonarr', { url: 'http://x', apiKey }, secrets, null);
    expect(sealed.url).toBe('http://x');
    expect(isEncrypted(sealed.apiKey)).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain(apiKey);
  });

  it('keeps the previous value for { set: true } or an absent key', () => {
    const prev = sealSettings(key, 'sonarr', { url: 'a', apiKey: 'K1' }, secrets, null);
    const kept = sealSettings(key, 'sonarr', { url: 'b', apiKey: { set: true } }, secrets, prev);
    expect(kept.apiKey).toEqual(prev.apiKey);
    const absent = sealSettings(key, 'sonarr', { url: 'b' }, secrets, prev);
    expect(absent.apiKey).toEqual(prev.apiKey);
  });

  it('removes a secret on an empty string', () => {
    const prev = sealSettings(key, 'sonarr', { url: 'a', apiKey: 'K1' }, secrets, null);
    const cleared = sealSettings(key, 'sonarr', { url: 'a', apiKey: '' }, secrets, prev);
    expect('apiKey' in cleared).toBe(false);
  });

  it('refuses an $enc marker in a non-secret value at any depth', () => {
    const forged = { $enc: 'AAAA' };
    expect(() => sealSettings(key, 'p', { url: forged }, secrets, null)).toThrow();
    expect(() => sealSettings(key, 'p', { a: { b: [1, forged] } }, secrets, null)).toThrow();
  });

  it('refuses a secret field of an unrecognised shape instead of dropping it', () => {
    const prev = sealSettings(key, 'p', { apiKey: 'K1' }, secrets, null);
    for (const bad of [5, true, null, ['x'], { set: false }, { $enc: 'x' }]) {
      expect(() => sealSettings(key, 'p', { apiKey: bad as JsonValue }, secrets, prev)).toThrow();
    }
  });

  it('open is the inverse of seal', () => {
    const input = { url: 'http://x', apiKey: 'K1' };
    expect(openSettings(key, 'sonarr', sealSettings(key, 'sonarr', input, secrets, null))).toEqual(
      input,
    );
  });

  it('mask never contains the payload or the plaintext', () => {
    const sealed = sealSettings(key, 'sonarr', { url: 'u', apiKey: 'K1-secret' }, secrets, null);
    const masked = maskSettings(sealed);
    expect(masked).toEqual({ url: 'u', apiKey: { set: true } });
    const text = JSON.stringify(masked);
    expect(text).not.toContain('K1-secret');
    expect(text).not.toContain((sealed.apiKey as { $enc: string }).$enc);
  });

  it('secretValues lists non-empty string secrets', () => {
    const opened: Record<string, JsonValue> = { url: 'u', apiKey: 'K1', other: 3 };
    expect(secretValues(opened, ['apiKey', 'missing', 'other'])).toEqual(['K1']);
  });
});
