import { readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CapabilitiesSchema, FfmpegCapabilitiesSchema } from '@transcoda/contract';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../auth/cookies.ts';
import { createUser } from '../db/repos/users.ts';
import { tempDir } from '../engine/fixtures.ts';
import { createTestApp } from '../test-app.ts';
import {
  type Exec,
  makeExec,
  parseEncoders,
  parseFilters,
  parseHwaccels,
  parseVersion,
  probeFfmpeg,
} from './ffmpeg.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const VERSION = fixture('ffmpeg-version.txt');
const ENCODERS = fixture('ffmpeg-encoders.txt');
const HWACCELS = fixture('ffmpeg-hwaccels.txt');
const FILTERS = fixture('ffmpeg-filters.txt');

describe('parsers', () => {
  it('parseVersion reads the version token', () => {
    expect(parseVersion(VERSION)).toBe('9.0.2');
    expect(parseVersion('ffmpeg version 8.1.1-Jellyfin Copyright (c) 2000-2026')).toBe(
      '8.1.1-Jellyfin',
    );
  });

  it('parseVersion throws on garbage', () => {
    expect(() => parseVersion('hello world')).toThrow();
  });

  it('parseEncoders lists encoder names and skips the legend', () => {
    const encoders = parseEncoders(ENCODERS);
    expect(encoders).toContain('libx264');
    expect(encoders).toContain('h264_videotoolbox');
    expect(encoders).not.toContain('=');
    expect(encoders).not.toContain('------');
  });

  it('parseHwaccels lists methods after the header', () => {
    expect(parseHwaccels(HWACCELS)).toContain('videotoolbox');
    expect(parseHwaccels(HWACCELS)).not.toContain('Hardware');
  });
});

describe('parseFilters', () => {
  it('lists exactly the filter lines of the fixture, in order', () => {
    const f = parseFilters(FILTERS);
    expect(f).toHaveLength(481);
    expect(f.slice(0, 2)).toEqual(['aap', 'abench']);
    expect(f).toContain('scale');
    expect(f).toContain('pan');
  });

  it('returns [] for output without the separator', () => {
    expect(parseFilters('Filters:\n  T.. = Timeline support\n')).toEqual([]);
  });
});

describe('probeFfmpeg', () => {
  const exec: Exec = async (_file, args) => {
    if (args.includes('-version')) return { stdout: VERSION, stderr: '' };
    if (args.includes('-encoders')) return { stdout: ENCODERS, stderr: '' };
    if (args.includes('-hwaccels')) return { stdout: HWACCELS, stderr: '' };
    if (args.includes('-filters')) return { stdout: FILTERS, stderr: '' };
    throw new Error(`unexpected args ${args.join(' ')}`);
  };

  it('returns available capabilities', async () => {
    const caps = await probeFfmpeg('/usr/bin/ffmpeg', exec);
    expect(FfmpegCapabilitiesSchema.parse(caps)).toMatchObject({
      available: true,
      path: '/usr/bin/ffmpeg',
      version: '9.0.2',
      filters: expect.arrayContaining(['scale']),
    });
  });

  it('exec rejecting ENOENT yields available:false with the message', async () => {
    const failing: Exec = async () => {
      throw new Error('spawn ffmpeg ENOENT');
    };
    expect(await probeFfmpeg('ffmpeg', failing)).toEqual({
      available: false,
      path: 'ffmpeg',
      error: 'spawn ffmpeg ENOENT',
    });
  });

  it('garbage stdout yields available:false', async () => {
    const garbage: Exec = async () => ({ stdout: 'not ffmpeg', stderr: '' });
    const caps = await probeFfmpeg('ffmpeg', garbage);
    expect(caps.available).toBe(false);
  });
});

describe('GET /api/v1/system/capabilities', () => {
  const HOST = { host: 'localhost:8080' };
  const caps = {
    available: true as const,
    path: 'ffmpeg',
    version: '9.0.2',
    encoders: ['libx264'],
    hwaccels: ['videotoolbox'],
    filters: ['scale'],
  };
  const get = (t: ReturnType<typeof createTestApp>, headers: Record<string, string> = {}) =>
    Promise.resolve(
      t.app.request('/api/v1/system/capabilities', { headers: { ...HOST, ...headers } }),
    );

  it('401 without auth', async () => {
    expect((await get(createTestApp({ capabilities: caps }))).status).toBe(401);
  });

  it('401 with an invalid bearer', async () => {
    expect(
      (await get(createTestApp({ capabilities: caps }), { authorization: 'Bearer nope' })).status,
    ).toBe(401);
  });

  it('200 with a session, matching the schema', async () => {
    const t = createTestApp({ capabilities: caps });
    const user = createUser(t.db, { username: 'admin', passwordHash: 'x' }, t.clock.now());
    const session = t.deps.sessions.create(user.id);
    const res = await get(t, { cookie: `${SESSION_COOKIE}=${session.id}` });
    expect(res.status).toBe(200);
    expect(CapabilitiesSchema.parse(await res.json())).toMatchObject(caps);
  });

  it('200 with a read-scope token', async () => {
    const t = createTestApp({ capabilities: caps });
    const user = createUser(t.db, { username: 'admin', passwordHash: 'x' }, t.clock.now());
    const { token } = t.deps.tokens.create(user.id, { name: 'ro', scopes: ['read'] });
    const res = await get(t, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(CapabilitiesSchema.parse(await res.json())).toMatchObject(caps);
  });
});

describe('makeExec', () => {
  it('an abort SIGKILLs the running child (no orphan, even one ignoring SIGTERM) and rejects', async () => {
    const dir = await tempDir('exec-');
    try {
      const pidFile = join(dir, 'pid');
      const exec = makeExec({ timeout: 60_000, maxBuffer: 1024 });
      const ac = new AbortController();
      // One process that ignores SIGTERM: only a SIGKILL ends it.
      const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000);`;
      const run = exec(process.execPath, ['-e', script], { signal: ac.signal });
      run.catch(() => {});
      let pid = 0;
      for (let i = 0; i < 200 && pid === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
        pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
      }
      expect(pid).toBeGreaterThan(0);
      ac.abort();
      await expect(run).rejects.toMatchObject({ name: 'AbortError' });
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 100 && alive(); i += 1) await new Promise((r) => setTimeout(r, 20));
      expect(alive()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('hands stdout to onStdout while the child runs, and still returns all of it', async () => {
    const exec = makeExec({ timeout: 60_000, maxBuffer: 1024 });
    const chunks: string[] = [];
    const script = `process.stdout.write('a=1\\n'); setTimeout(() => process.stdout.write('b=2\\n'), 50);`;
    const res = await exec(process.execPath, ['-e', script], {
      onStdout: (chunk) => chunks.push(chunk),
    });
    expect(chunks.join('')).toBe('a=1\nb=2\n');
    expect(res.stdout).toBe('a=1\nb=2\n');
  });
});
