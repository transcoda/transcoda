import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.ts';
import { ALWAYS_HIDDEN, browseDirs, hiddenRoots, usableInstallDir } from './browse.ts';

const isRoot = process.getuid?.() === 0;
let base: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'transcoda-browse-')));
});
afterEach(async () => {
  // Restore modes so the tree can be removed.
  for (const dir of ['locked', 'ro']) await chmod(join(base, dir), 0o755).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

const names = (r: Exclude<Awaited<ReturnType<typeof browseDirs>>, 'refused'>) =>
  r.entries.map((e) => e.name);

async function ok(path: string, hidden: string[] = [], max?: number, scanCap?: number) {
  const r = await browseDirs(path, {
    hidden,
    ...(max === undefined ? {} : { max }),
    ...(scanCap === undefined ? {} : { scanCap }),
  });
  if (r === 'refused') throw new Error(`refused ${path}`);
  return r;
}

describe('browseDirs', () => {
  it('lists only directories, sorted, without dot-directories', async () => {
    for (const d of ['b', 'a', '10', '9', '.hidden', 'Zed']) await mkdir(join(base, d));
    await writeFile(join(base, 'file.mkv'), 'x');
    const r = await ok(base);
    expect(names(r)).toEqual(['9', '10', 'a', 'b', 'Zed']);
    expect(r.path).toBe(base);
    expect(r.parent).toBe(dirname(base));
    expect(r.truncated).toBe(false);
    expect(r.writable).toBe(true);
    expect(r.entries[0]).toEqual({ name: '9', path: join(base, '9'), writable: true });
  });

  it('truncates beyond the cap and says so', async () => {
    for (let i = 0; i < 7; i++) await mkdir(join(base, `d${i}`));
    const r = await ok(base, [], 5);
    expect(r.entries).toHaveLength(5);
    expect(r.truncated).toBe(true);
    expect(names(await ok(base, [], 7))).toHaveLength(7);
    expect((await ok(base, [], 7)).truncated).toBe(false);
  });

  it('normalises .. and resolves symlinks to the real path', async () => {
    await mkdir(join(base, 'a/b'), { recursive: true });
    await symlink(join(base, 'a'), join(base, 'link'));
    expect((await ok(`${base}/a/b/../..`)).path).toBe(base);
    expect((await ok(`${base}/link/b/..`)).path).toBe(join(base, 'a'));
    expect((await ok(`${base}/link`)).path).toBe(join(base, 'a'));
  });

  it('lists a symlink to a folder by its name, with the target as path; ignores a symlink to a file', async () => {
    await mkdir(join(base, 'real'));
    await writeFile(join(base, 'f'), 'x');
    await symlink(join(base, 'real'), join(base, 'alias'));
    await symlink(join(base, 'f'), join(base, 'filelink'));
    const r = await ok(base);
    expect(names(r)).toEqual(['alias', 'real']);
    expect(r.entries[0]?.path).toBe(join(base, 'real'));
  });

  it('marks root at / as having no parent', async () => {
    const r = await ok('/');
    expect(r.parent).toBeNull();
    expect(r.path).toBe('/');
  });

  it('hides a configured folder and anything under it, and refuses browsing into it', async () => {
    await mkdir(join(base, 'config/deep'), { recursive: true });
    await mkdir(join(base, 'media'));
    const hidden = [join(base, 'config')];
    expect(names(await ok(base, hidden))).toEqual(['media']);
    expect(await browseDirs(join(base, 'config'), { hidden })).toBe('refused');
    expect(await browseDirs(join(base, 'config/deep'), { hidden })).toBe('refused');
    expect(await browseDirs(join(base, 'media/../config/deep'), { hidden })).toBe('refused');
  });

  it('hides a symlink that points into a hidden folder and refuses it', async () => {
    await mkdir(join(base, 'config/deep'), { recursive: true });
    await mkdir(join(base, 'media'));
    await symlink(join(base, 'config'), join(base, 'shortcut'));
    await symlink(join(base, 'config/deep'), join(base, 'media/inner'));
    const hidden = [join(base, 'config')];
    expect(names(await ok(base, hidden))).toEqual(['media']);
    expect(names(await ok(join(base, 'media'), hidden))).toEqual([]);
    expect(await browseDirs(join(base, 'shortcut'), { hidden })).toBe('refused');
    expect(await browseDirs(join(base, 'shortcut/deep'), { hidden })).toBe('refused');
  });

  it('hides a hidden folder given through a symlink in the hidden list itself', async () => {
    await mkdir(join(base, 'real-config'));
    await symlink(join(base, 'real-config'), join(base, 'config-link'));
    const hidden = [join(base, 'config-link')];
    expect(names(await ok(base, hidden))).toEqual([]);
    expect(await browseDirs(join(base, 'real-config'), { hidden })).toBe('refused');
  });

  it('refuses a symlink inside a hidden folder that points out (the request as spelled is hidden)', async () => {
    await mkdir(join(base, 'config'));
    await mkdir(join(base, 'media/Shows'), { recursive: true });
    await symlink(join(base, 'media'), join(base, 'config/out'));
    const hidden = [join(base, 'config')];
    expect(await browseDirs(join(base, 'config/out'), { hidden })).toBe('refused');
    expect(await browseDirs(join(base, 'config/out/Shows'), { hidden })).toBe('refused');
    expect(names(await ok(join(base, 'media'), hidden))).toEqual(['Shows']);
  });

  it('refuses a dot component in the request, also reached through a symlink', async () => {
    await mkdir(join(base, '.secret/inner'), { recursive: true });
    await symlink(join(base, '.secret'), join(base, 'visible'));
    expect(await browseDirs(join(base, '.secret'), { hidden: [] })).toBe('refused');
    expect(await browseDirs(join(base, '.secret/inner'), { hidden: [] })).toBe('refused');
    expect(await browseDirs(join(base, 'visible'), { hidden: [] })).toBe('refused');
    expect(names(await ok(base))).toEqual([]);
  });

  it('refuses a path whose device and inode match a hidden root, or any ancestor of it (bind mounts)', async () => {
    await mkdir(join(base, 'config'));
    await mkdir(join(base, 'media/Shows'), { recursive: true });
    await mkdir(join(base, 'plain'));
    const config = join(base, 'config');
    // Fake a second path to the same inode: `media` is "a bind mount of config".
    const identify = async (path: string) => {
      if (path === config || path === join(base, 'media')) return '1:42';
      return `1:${path.length}:${path}`;
    };
    const hidden = [config];
    const opts = { hidden, identify };
    expect(await browseDirs(join(base, 'media'), opts)).toBe('refused');
    expect(await browseDirs(join(base, 'media/Shows'), opts)).toBe('refused');
    const listed = await browseDirs(base, opts);
    if (listed === 'refused') throw new Error('refused');
    expect(names(listed)).toEqual(['plain']);
    expect(names(await ok(base))).toEqual(['config', 'media', 'plain']);
  });

  it('stops reading a directory at the scan cap and says so', async () => {
    for (let i = 0; i < 10; i++) await mkdir(join(base, `d${i}`));
    const r = await ok(base, [], 500, 4);
    expect(r.truncated).toBe(true);
    expect(r.entries.length).toBeLessThanOrEqual(4);
    expect((await ok(base, [], 500, 10)).truncated).toBe(false);
  });

  it('checks only as many folders as it lists: later ones are not looked at', async () => {
    for (let i = 0; i < 6; i++) await mkdir(join(base, `d${i}`));
    const seen: string[] = [];
    const identify = async (path: string) => {
      seen.push(path);
      return null;
    };
    const r = await browseDirs(base, { hidden: [], max: 2, identify });
    expect(names(r as Exclude<typeof r, 'refused'>)).toEqual(['d0', 'd1']);
    expect((r as { truncated: boolean }).truncated).toBe(true);
    expect(seen.some((p) => p.endsWith('/d1'))).toBe(true);
    expect(seen.some((p) => /\/d[2-5]$/.test(p))).toBe(false);
  });

  it('refuses a missing path, a file and a relative path the same way as a hidden one', async () => {
    await writeFile(join(base, 'f'), 'x');
    await mkdir(join(base, 'config'));
    const hidden = [join(base, 'config')];
    const refusals = await Promise.all([
      browseDirs(join(base, 'config'), { hidden }),
      browseDirs(join(base, 'nope'), { hidden }),
      browseDirs(join(base, 'f'), { hidden }),
      browseDirs('relative/path', { hidden }),
      browseDirs('', { hidden }),
    ]);
    expect(refusals).toEqual(['refused', 'refused', 'refused', 'refused', 'refused']);
  });

  it.skipIf(isRoot)('omits unreadable folders and marks read-only ones not writable', async () => {
    await mkdir(join(base, 'open'));
    await mkdir(join(base, 'locked'));
    await mkdir(join(base, 'ro'));
    await chmod(join(base, 'locked'), 0o000);
    await chmod(join(base, 'ro'), 0o555);
    const r = await ok(base);
    expect(r.entries.map((e) => [e.name, e.writable])).toEqual([
      ['open', true],
      ['ro', false],
    ]);
    expect(await browseDirs(join(base, 'locked'), { hidden: [] })).toBe('refused');
    expect((await ok(join(base, 'ro'))).writable).toBe(false);
  });
});

describe('hiddenRoots', () => {
  it('lists the config, transcode, plugin run and install folders plus the system ones', () => {
    const config = {
      ...loadConfig({ TRANSCODA_CONFIG_DIR: '/cfg', TRANSCODA_TRANSCODE_DIR: '/scratch' }),
      pluginIsolation: { uid: 991, gid: 991, runDir: '/plug/run', setprivPath: '/usr/bin/setpriv' },
    };
    const roots = hiddenRoots(config, '/opt/transcoda');
    expect(roots).toEqual(
      expect.arrayContaining([
        '/cfg',
        '/scratch',
        '/plug/run',
        '/opt/transcoda',
        '/proc',
        '/sys',
        '/dev',
        '/run',
        '/etc',
        '/boot',
        '/root',
      ]),
    );
  });

  it('hides the default plugin run dir when isolation is not configured, and never leaks the list order', () => {
    const roots = hiddenRoots(loadConfig({}), '/app');
    expect(roots).toEqual(
      expect.arrayContaining(['/config', '/transcode', '/run/transcoda/plugins']),
    );
    expect(ALWAYS_HIDDEN).toEqual(['/proc', '/sys', '/dev', '/run', '/etc', '/boot', '/root']);
  });
});

describe('usableInstallDir', () => {
  it('ignores / with a log line, and keeps any other folder', () => {
    const lines: string[] = [];
    const log = { warn: (e: { msg: string }) => void lines.push(e.msg) };
    expect(usableInstallDir('/', log)).toBeNull();
    expect(lines).toHaveLength(1);
    expect(usableInstallDir('/app', log)).toBe('/app');
    expect(lines).toHaveLength(1);
    expect(hiddenRoots(loadConfig({}), null)).not.toContain('/');
  });
});
