import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseSigningKeys,
  publicKeyFromHex,
  type SigningKey,
  verifySignature,
} from './signature.ts';

function makeKey(id: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const key: SigningKey = { id, publicKey: raw.toString('hex') };
  return { key, privateKey };
}

const data = new TextEncoder().encode('{"hello":"world"}');

function sigFile(
  privateKey: ReturnType<typeof makeKey>['privateKey'],
  keyId: string,
  over: Record<string, unknown> = {},
  bytes: Uint8Array = data,
) {
  return JSON.stringify({
    schema: 1,
    alg: 'ed25519',
    keyId,
    signature: sign(null, bytes, privateKey).toString('base64'),
    ...over,
  });
}

describe('verifySignature', () => {
  it('accepts a valid signature and names the key', () => {
    const k = makeKey('k1');
    expect(verifySignature(data, sigFile(k.privateKey, 'k1'), [k.key])).toEqual({
      ok: true,
      keyId: 'k1',
    });
  });

  it('rejects data that changed by one byte', () => {
    const k = makeKey('k1');
    const text = sigFile(k.privateKey, 'k1');
    const flipped = Uint8Array.from(data);
    flipped[3] = (flipped[3] ?? 0) ^ 1;
    expect(verifySignature(flipped, text, [k.key])).toEqual({
      ok: false,
      reason: 'mismatch',
      message: 'signature does not match',
    });
  });

  it('rejects a key id that is not listed', () => {
    const k = makeKey('k1');
    expect(verifySignature(data, sigFile(k.privateKey, 'k2'), [k.key])).toEqual({
      ok: false,
      reason: 'unknown-key',
      message: 'signed with an unknown key k2',
    });
  });

  it('treats an empty key list as every key unknown', () => {
    const k = makeKey('k1');
    const r = verifySignature(data, sigFile(k.privateKey, 'k1'), []);
    expect(r).toMatchObject({ ok: false, reason: 'unknown-key' });
  });

  it('rejects the right key id with a signature from another key', () => {
    const a = makeKey('k1');
    const b = makeKey('k1');
    expect(verifySignature(data, sigFile(b.privateKey, 'k1'), [a.key])).toMatchObject({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('rejects text that is not JSON', () => {
    const r = verifySignature(data, '{', []);
    expect(r).toMatchObject({ ok: false, reason: 'malformed' });
    if (!r.ok) expect(r.message.startsWith('malformed signature file: not JSON')).toBe(true);
  });

  it('rejects another schema version', () => {
    const k = makeKey('k1');
    expect(
      verifySignature(data, sigFile(k.privateKey, 'k1', { schema: 2 }), [k.key]),
    ).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('rejects a signature that is not exactly 64 bytes', () => {
    const k = makeKey('k1');
    const short = Buffer.alloc(63, 1).toString('base64');
    const r = verifySignature(data, sigFile(k.privateKey, 'k1', { signature: short }), [k.key]);
    expect(r).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('rejects an extra key and a non-canonical base64 signature', () => {
    const k = makeKey('k1');
    expect(verifySignature(data, sigFile(k.privateKey, 'k1', { extra: 1 }), [k.key])).toMatchObject(
      { ok: false, reason: 'malformed' },
    );
    const good = sign(null, data, k.privateKey).toString('base64');
    for (const bad of [
      `${good.slice(0, 10)}\n${good.slice(10)}`,
      `${good.slice(0, 5)}-${good.slice(6)}`,
      good.replace(/==$/, 'A='),
    ]) {
      expect(
        verifySignature(data, sigFile(k.privateKey, 'k1', { signature: bad }), [k.key]),
      ).toMatchObject({ ok: false, reason: 'malformed' });
    }
  });

  it('rejects a bad key id and another algorithm', () => {
    const k = makeKey('k1');
    expect(verifySignature(data, sigFile(k.privateKey, 'bad id'), [k.key])).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    expect(
      verifySignature(data, sigFile(k.privateKey, 'k1', { alg: 'rsa' }), [k.key]),
    ).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('finds the signing key among several', () => {
    const a = makeKey('a');
    const b = makeKey('b');
    expect(verifySignature(data, sigFile(b.privateKey, 'b'), [a.key, b.key])).toEqual({
      ok: true,
      keyId: 'b',
    });
  });
});

describe('publicKeyFromHex', () => {
  it('builds a key from 64 hex characters and refuses anything else', () => {
    const k = makeKey('k1');
    expect(publicKeyFromHex(k.key.publicKey).asymmetricKeyType).toBe('ed25519');
    expect(() => publicKeyFromHex('abc')).toThrow();
    expect(() => publicKeyFromHex('g'.repeat(64))).toThrow();
    expect(() => publicKeyFromHex('A'.repeat(64))).toThrow();
  });
});

describe('parseSigningKeys', () => {
  it('parses comma-separated id:hex entries', () => {
    expect(parseSigningKeys(`a:${'f'.repeat(64)},b:${'0'.repeat(64)}`)).toEqual([
      { id: 'a', publicKey: 'f'.repeat(64) },
      { id: 'b', publicKey: '0'.repeat(64) },
    ]);
  });

  it('names the bad entry', () => {
    expect(() => parseSigningKeys('a:xyz')).toThrow(new Error('a:xyz: expected <id>:<64 hex>'));
    expect(() => parseSigningKeys(`bad id:${'f'.repeat(64)}`)).toThrow('expected <id>:<64 hex>');
  });
});
