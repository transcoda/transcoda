import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../config.ts';

const HEX_KEY = /^[0-9a-fA-F]{64}$/;

function decode(hex: string, source: string): Buffer {
  const trimmed = hex.trim();
  if (!HEX_KEY.test(trimmed)) {
    throw new ConfigError(`${source} must be exactly 64 hex characters (32 bytes)`);
  }
  return Buffer.from(trimmed, 'hex');
}

export function loadOrCreateSecretKey(
  configDir: string,
  fromEnvHex: string | null,
  warn: (msg: string) => void = () => {},
): Buffer {
  if (fromEnvHex) return decode(fromEnvHex, 'TRANSCODA_SECRET_KEY');

  const file = path.join(configDir, 'secret.key');
  const read = (): Buffer => {
    const key = decode(fs.readFileSync(file, 'utf8'), file);
    if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077) !== 0) {
      warn(`${file} is readable by group/others; run chmod 600 on it`);
    }
    return key;
  };

  if (fs.existsSync(file)) return read();

  fs.mkdirSync(configDir, { recursive: true });
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(file, key.toString('hex'), { mode: 0o600, flag: 'wx' });
  } catch (e) {
    // Lost a creation race with another process: use the key it wrote.
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return read();
    throw e;
  }
  return key;
}
