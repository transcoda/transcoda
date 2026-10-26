import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeExec } from '../capabilities/ffmpeg.ts';
import {
  capDroppedCommand,
  hasAmbientCaps,
  offModeSetpriv,
  pickOffModeSetpriv,
  setChildCapDrop,
  setOffModeSetpriv,
  wrapChild,
} from './child-caps.ts';
import { nodeSpawner } from './process.ts';

describe('capDroppedCommand', () => {
  it('is the command itself without setpriv', () => {
    expect(capDroppedCommand('ffmpeg', ['-i', 'a'], null)).toEqual({
      file: 'ffmpeg',
      args: ['-i', 'a'],
    });
  });

  it('runs it through setpriv with no inheritable or ambient caps and no new privileges (same user and groups)', () => {
    expect(capDroppedCommand('/usr/bin/ffmpeg', ['-i', 'a'], '/usr/bin/setpriv')).toEqual({
      file: '/usr/bin/setpriv',
      args: [
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--no-new-privs',
        '--',
        '/usr/bin/ffmpeg',
        '-i',
        'a',
      ],
    });
  });
});

describe('server children are started through the configured setpriv', () => {
  let scratch: string;
  let log: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'tc-capdrop-'));
    log = join(scratch, 'argv.log');
    const fake = join(scratch, 'setpriv');
    await writeFile(
      fake,
      `#!/bin/sh\necho "$*" >> '${log}'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
    );
    await chmod(fake, 0o755);
    setChildCapDrop(fake);
  });
  afterEach(async () => {
    setChildCapDrop(null);
    await rm(scratch, { recursive: true, force: true });
  });

  it('wrapChild follows the setting', () => {
    expect(wrapChild('ffprobe', ['x']).args.slice(-2)).toEqual(['ffprobe', 'x']);
    setChildCapDrop(null);
    expect(wrapChild('ffprobe', ['x'])).toEqual({ file: 'ffprobe', args: ['x'] });
  });

  it('execFile runners (probe, verify, covers) go through it', async () => {
    const out = await makeExec({ timeout: 5000, maxBuffer: 1024 })('echo', ['hi']);
    expect(out.stdout).toBe('hi\n');
    expect((await readFile(log, 'utf8')).trim()).toMatch(
      /^--inh-caps=-all --ambient-caps=-all --no-new-privs -- echo hi$/,
    );
  });

  it('the ffmpeg process runner goes through it, with its own group and pid', async () => {
    const proc = nodeSpawner.spawn('echo', ['hi'], {
      logPath: join(scratch, 'job.log'),
      onProgress: () => {},
    });
    expect(proc.pid).toBeGreaterThan(0);
    await expect(proc.done).resolves.toEqual({ code: 0, signal: null });
    expect((await readFile(log, 'utf8')).trim()).toMatch(/-- echo hi$/);
    expect((await readFile(join(scratch, 'job.log'), 'utf8')).length).toBe(0);
  });
});

describe('isolation off: drop what the process still carries', () => {
  const status = (amb: string) =>
    `Name:\tnode\nCapEff:\t00000000000000e0\nCapAmb:\t${amb}\nNoNewPrivs:\t0\n`;

  it('hasAmbientCaps reads CapAmb: nonzero is true, zero or missing is false', () => {
    expect(hasAmbientCaps(status('00000000000000e0'))).toBe(true);
    expect(hasAmbientCaps(status('0000000000000000'))).toBe(false);
    expect(hasAmbientCaps('Name:\tnode\n')).toBe(false);
  });

  it('uses setpriv only on Linux, with setpriv present and ambient caps set', () => {
    const base = {
      platform: 'linux' as const,
      status: status('00000000000000e0'),
      setprivExists: true,
      path: '/usr/bin/setpriv',
    };
    expect(pickOffModeSetpriv(base)).toBe('/usr/bin/setpriv');
    expect(pickOffModeSetpriv({ ...base, status: status('0000000000000000') })).toBeNull();
    expect(pickOffModeSetpriv({ ...base, setprivExists: false })).toBeNull();
    expect(pickOffModeSetpriv({ ...base, platform: 'darwin' })).toBeNull();
    expect(pickOffModeSetpriv({ ...base, status: null })).toBeNull();
  });

  it('wrapChild wraps engine children in the picked setpriv when no isolation is configured', () => {
    setChildCapDrop(null);
    setOffModeSetpriv('/usr/bin/setpriv');
    try {
      expect(wrapChild('ffmpeg', ['-i', 'a'])).toEqual({
        file: '/usr/bin/setpriv',
        args: [
          '--inh-caps=-all',
          '--ambient-caps=-all',
          '--no-new-privs',
          '--',
          'ffmpeg',
          '-i',
          'a',
        ],
      });
      expect(offModeSetpriv()).toBe('/usr/bin/setpriv');
      setOffModeSetpriv(null);
      expect(wrapChild('ffmpeg', ['-i', 'a'])).toEqual({ file: 'ffmpeg', args: ['-i', 'a'] });
    } finally {
      setOffModeSetpriv(undefined);
    }
  });

  it('configured isolation wins over the fallback', () => {
    setOffModeSetpriv('/usr/bin/other');
    setChildCapDrop('/usr/bin/setpriv');
    try {
      expect(wrapChild('x', []).file).toBe('/usr/bin/setpriv');
    } finally {
      setChildCapDrop(null);
      setOffModeSetpriv(undefined);
    }
  });
});
