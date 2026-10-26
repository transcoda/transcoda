import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateSecretKey } from './secret-key.ts';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-secret-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const HEX = 'ab'.repeat(32);

describe('loadOrCreateSecretKey', () => {
  it('uses env key when given', () => {
    const key = loadOrCreateSecretKey(dir, HEX);
    expect(key.length).toBe(32);
    expect(key.toString('hex')).toBe(HEX);
    expect(fs.existsSync(path.join(dir, 'secret.key'))).toBe(false);
  });

  it('generates and persists a key with mode 0600', () => {
    const sub = path.join(dir, 'nested', 'config');
    const key = loadOrCreateSecretKey(sub, null);
    expect(key.length).toBe(32);
    const file = path.join(sub, 'secret.key');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(key.toString('hex'));
  });

  it('reads the same key back on second call', () => {
    const a = loadOrCreateSecretKey(dir, null);
    const b = loadOrCreateSecretKey(dir, null);
    expect(b.equals(a)).toBe(true);
  });

  it('rejects env key of wrong length', () => {
    expect(() => loadOrCreateSecretKey(dir, 'abcd')).toThrow(/64 hex/);
    expect(() => loadOrCreateSecretKey(dir, 'zz'.repeat(32))).toThrow(/64 hex/);
  });

  it('rejects a malformed key file without leaking its content', () => {
    fs.writeFileSync(path.join(dir, 'secret.key'), 'nothex-secret-content', { mode: 0o600 });
    try {
      loadOrCreateSecretKey(dir, null);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/64 hex/);
      expect((e as Error).message).not.toContain('nothex-secret-content');
    }
  });

  it('warns (without the key) when the file mode is broader than 0600', () => {
    const file = path.join(dir, 'secret.key');
    fs.writeFileSync(file, HEX, { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const msgs: string[] = [];
    const key = loadOrCreateSecretKey(dir, null, (m) => msgs.push(m));
    expect(key.toString('hex')).toBe(HEX);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).not.toContain(HEX);
  });

  it('does not warn for mode 0600', () => {
    const msgs: string[] = [];
    loadOrCreateSecretKey(dir, null, (m) => msgs.push(m));
    loadOrCreateSecretKey(dir, null, (m) => msgs.push(m));
    expect(msgs).toEqual([]);
  });
});
