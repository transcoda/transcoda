import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseIsolation, requireIsolationInProduction } from './config.ts';
import { OFFICIAL_BLOCKLIST_URL, OFFICIAL_CATALOG_URL } from './plugins/catalog-url.ts';
import { OFFICIAL_SIGNING_KEYS } from './plugins/official-keys.ts';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({});
    expect(c.port).toBe(8080);
    expect(c.host).toBe('0.0.0.0');
    expect(c.configDir).toBe('/config');
    expect(c.transcodeDir).toBe('/transcode');
    expect(c.allowedHosts).toEqual([]);
    expect(c.trustedProxies).toEqual([]);
    expect(c.secretKeyHex).toBeNull();
    expect(c.ffmpegPath).toBe('ffmpeg');
    expect(c.webDistDir).toBeNull();
  });

  it('reads the deep health settings', () => {
    const d = loadConfig({});
    expect(d.healthStallHours).toBe(6);
    expect(d.healthMinFreeGiB).toBe(5);
    const c = loadConfig({
      TRANSCODA_HEALTH_STALL_HOURS: '0.5',
      TRANSCODA_HEALTH_MIN_FREE_GIB: '12',
    });
    expect(c.healthStallHours).toBe(0.5);
    expect(c.healthMinFreeGiB).toBe(12);
  });

  it('reads the encode stall guard: 60 minutes by default, 0 turns it off', () => {
    expect(loadConfig({}).encodeStallMinutes).toBe(60);
    expect(loadConfig({ TRANSCODA_ENCODE_STALL_MINUTES: '90' }).encodeStallMinutes).toBe(90);
    expect(loadConfig({ TRANSCODA_ENCODE_STALL_MINUTES: '0' }).encodeStallMinutes).toBe(0);
    for (const value of ['abc', '-5']) {
      expect(() => loadConfig({ TRANSCODA_ENCODE_STALL_MINUTES: value })).toThrow(
        new ConfigError(
          `TRANSCODA_ENCODE_STALL_MINUTES must be 0 (off) or a positive number of minutes, got "${value}"`,
        ),
      );
    }
  });

  it.each([
    ['TRANSCODA_HEALTH_STALL_HOURS', '0'],
    ['TRANSCODA_HEALTH_STALL_HOURS', 'abc'],
    ['TRANSCODA_HEALTH_STALL_HOURS', '-1'],
    ['TRANSCODA_HEALTH_MIN_FREE_GIB', '0'],
    ['TRANSCODA_HEALTH_MIN_FREE_GIB', 'abc'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(
      new ConfigError(
        `${name} must be a positive number of ${name.endsWith('HOURS') ? 'hours' : 'GiB'}, got "${value}"`,
      ),
    );
  });

  it('parses allowed hosts trimmed and lowercased', () => {
    const c = loadConfig({ TRANSCODA_ALLOWED_HOSTS: 'Media.Local, nas.lan ' });
    expect(c.allowedHosts).toEqual(['media.local', 'nas.lan']);
  });

  it('reads TRANSCODA_PUBLIC_URL as an origin without a trailing slash', () => {
    expect(loadConfig({}).publicUrl).toBeNull();
    expect(loadConfig({ TRANSCODA_PUBLIC_URL: 'https://t.example.net/' }).publicUrl).toBe(
      'https://t.example.net',
    );
    expect(loadConfig({ TRANSCODA_PUBLIC_URL: 'http://nas.lan:8080' }).publicUrl).toBe(
      'http://nas.lan:8080',
    );
  });

  it.each([
    'ftp://x',
    'https://x/app',
    'not a url',
    'https://x/?q=1',
    'https://x?',
    'https://x/#',
    'https://x/#frag',
    'https:t.example.net',
    'https://u:p@x',
  ])('rejects TRANSCODA_PUBLIC_URL=%s', (value) => {
    expect(() => loadConfig({ TRANSCODA_PUBLIC_URL: value })).toThrow(
      'TRANSCODA_PUBLIC_URL must be an http(s) origin, for example https://transcoda.example.net',
    );
  });

  it('treats a blank TRANSCODA_PUBLIC_URL as unset', () => {
    expect(loadConfig({ TRANSCODA_PUBLIC_URL: '   ' }).publicUrl).toBeNull();
    expect(loadConfig({ TRANSCODA_PUBLIC_URL: '' }).publicUrl).toBeNull();
  });

  it('parses trusted proxies', () => {
    const c = loadConfig({ TRANSCODA_TRUSTED_PROXIES: '10.0.0.0/8, 192.168.1.1/32' });
    expect(c.trustedProxies).toEqual(['10.0.0.0/8', '192.168.1.1/32']);
  });

  it('accepts a 64-hex secret key', () => {
    const key = 'ab'.repeat(32);
    expect(loadConfig({ TRANSCODA_SECRET_KEY: key }).secretKeyHex).toBe(key);
  });

  it('TRANSCODA_BUILD_ID: unset or empty → null; a short id is kept; anything else is refused', () => {
    expect(loadConfig({}).buildId).toBeNull();
    expect(loadConfig({ TRANSCODA_BUILD_ID: ' ' }).buildId).toBeNull();
    expect(loadConfig({ TRANSCODA_BUILD_ID: 'a1b2c3d.20261021' }).buildId).toBe('a1b2c3d.20261021');
    for (const bad of ['has space', 'x'.repeat(65), 'a/b', 'é']) {
      expect(() => loadConfig({ TRANSCODA_BUILD_ID: bad }), bad).toThrow(ConfigError);
    }
  });

  it('rejects a malformed secret key', () => {
    expect(() => loadConfig({ TRANSCODA_SECRET_KEY: 'zz' })).toThrow(ConfigError);
  });

  it('rejects a non-numeric port', () => {
    expect(() => loadConfig({ TRANSCODA_PORT: 'abc' })).toThrow(ConfigError);
  });

  it('defaults ffprobe beside an ffmpeg path with a directory part', () => {
    expect(
      loadConfig({ TRANSCODA_FFMPEG_PATH: '/usr/lib/jellyfin-ffmpeg/ffmpeg' }).ffprobePath,
    ).toBe('/usr/lib/jellyfin-ffmpeg/ffprobe');
    expect(loadConfig({ TRANSCODA_FFMPEG_PATH: 'ffmpeg' }).ffprobePath).toBe('ffprobe');
    expect(loadConfig({}).ffprobePath).toBe('ffprobe');
  });

  it('takes an explicit ffprobe path', () => {
    const c = loadConfig({
      TRANSCODA_FFMPEG_PATH: '/opt/ff/ffmpeg',
      TRANSCODA_FFPROBE_PATH: '/x/ffprobe',
    });
    expect(c.ffprobePath).toBe('/x/ffprobe');
  });

  it('parses output roots', () => {
    expect(loadConfig({}).outputRoots).toEqual([]);
    expect(loadConfig({ TRANSCODA_OUTPUT_ROOTS: '/out, /mnt/x' }).outputRoots).toEqual([
      '/out',
      '/mnt/x',
    ]);
    // Normalised at load (final review M7).
    expect(loadConfig({ TRANSCODA_OUTPUT_ROOTS: '/out/,/mnt/x/../y' }).outputRoots).toEqual([
      '/out',
      '/mnt/y',
    ]);
  });

  it('rejects a relative output root', () => {
    expect(() => loadConfig({ TRANSCODA_OUTPUT_ROOTS: '/out,media/x' })).toThrow(
      new ConfigError('TRANSCODA_OUTPUT_ROOTS entries must be absolute paths'),
    );
  });

  it('parses PUID and PGID', () => {
    const c = loadConfig({ PUID: '1000', PGID: '100' });
    expect(c.puid).toBe(1000);
    expect(c.pgid).toBe(100);
    const unset = loadConfig({});
    expect(unset.puid).toBeNull();
    expect(unset.pgid).toBeNull();
    expect(loadConfig({ PUID: '' }).puid).toBeNull();
  });

  it('rejects a non-integer PUID', () => {
    expect(() => loadConfig({ PUID: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ PGID: '-1' })).toThrow(ConfigError);
  });

  describe('plugins', () => {
    it('defaults: the plugins dir under the config dir, the host beside the entry, the official catalog', () => {
      const c = loadConfig({ TRANSCODA_CONFIG_DIR: '/data/cfg' });
      expect(c.pluginsDir).toBe('/data/cfg/plugins');
      expect(c.pluginHostPath.endsWith('/plugin-host.js')).toBe(true);
      expect(c.pluginCatalogUrl).toBe(OFFICIAL_CATALOG_URL);
      expect(c.catalogToken).toBeNull();
      expect(c.devPlugins).toEqual([]);
      expect(c.pluginInspect).toBe(false);
      expect(loadConfig({}).pluginsDir).toBe('/config/plugins');
    });

    it('reads the host path, the catalog url and token, the dev plugins and the inspector', () => {
      const c = loadConfig({
        TRANSCODA_PLUGIN_HOST: '/opt/host.js',
        TRANSCODA_PLUGIN_CATALOG_URL: 'https://example.test/index.json',
        TRANSCODA_CATALOG_TOKEN: 'tok',
        TRANSCODA_DEV_PLUGINS: '/dev/a.js, /dev/b/../c.js',
        TRANSCODA_PLUGIN_INSPECT: '1',
        NODE_ENV: 'development',
      });
      expect(c.pluginHostPath).toBe('/opt/host.js');
      expect(c.pluginCatalogUrl).toBe('https://example.test/index.json');
      expect(c.catalogToken).toBe('tok');
      expect(c.devPlugins).toEqual(['/dev/a.js', '/dev/c.js']);
      expect(c.pluginInspect).toBe(true);
    });

    it('refuses dev plugins and the inspector in production', () => {
      expect(() =>
        loadConfig({ NODE_ENV: 'production', TRANSCODA_DEV_PLUGINS: '/dev/a.js' }),
      ).toThrow(new ConfigError('TRANSCODA_DEV_PLUGINS is not allowed with NODE_ENV=production'));
      expect(() => loadConfig({ NODE_ENV: 'production', TRANSCODA_PLUGIN_INSPECT: '1' })).toThrow(
        new ConfigError('TRANSCODA_PLUGIN_INSPECT is not allowed with NODE_ENV=production'),
      );
      expect(loadConfig({ NODE_ENV: 'production' }).devPlugins).toEqual([]);
    });

    it('validates the catalog url: https only in production, http and file elsewhere, never ftp', () => {
      const url = (v: string, NODE_ENV: string) =>
        loadConfig({ TRANSCODA_PLUGIN_CATALOG_URL: v, NODE_ENV }).pluginCatalogUrl;
      expect(url('https://x.test/i.json', 'production')).toBe('https://x.test/i.json');
      expect(url('http://127.0.0.1:1/i.json', 'development')).toBe('http://127.0.0.1:1/i.json');
      expect(url('file:///tmp/i.json', 'test')).toBe('file:///tmp/i.json');
      expect(() => url('http://x.test/i.json', 'production')).toThrow(
        new ConfigError('TRANSCODA_PLUGIN_CATALOG_URL must be an https url'),
      );
      expect(() => url('file:///tmp/i.json', 'production')).toThrow(ConfigError);
      expect(() => url('ftp://x.test/i', 'development')).toThrow(ConfigError);
      expect(() => url('nope', 'development')).toThrow(
        new ConfigError('TRANSCODA_PLUGIN_CATALOG_URL is not a url'),
      );
    });

    it('TRANSCODA_PLUGIN_CATALOG_KEY: unset pins the official keys, none is unsigned, otherwise parsed', () => {
      expect(loadConfig({}).pluginCatalogKeys).toEqual([...OFFICIAL_SIGNING_KEYS]);
      expect(loadConfig({ NODE_ENV: 'production' }).pluginCatalogKeys).toEqual([
        ...OFFICIAL_SIGNING_KEYS,
      ]);
      expect(loadConfig({ TRANSCODA_PLUGIN_CATALOG_KEY: 'none' }).pluginCatalogKeys).toBeNull();
      expect(() =>
        loadConfig({ NODE_ENV: 'production', TRANSCODA_PLUGIN_CATALOG_KEY: 'none' }),
      ).toThrow(
        new ConfigError(
          'TRANSCODA_PLUGIN_CATALOG_KEY=none is not allowed with NODE_ENV=production',
        ),
      );
      expect(
        loadConfig({ TRANSCODA_PLUGIN_CATALOG_KEY: `dev:${'a'.repeat(64)}` }).pluginCatalogKeys,
      ).toEqual([{ id: 'dev', publicKey: 'a'.repeat(64) }]);
      expect(() => loadConfig({ TRANSCODA_PLUGIN_CATALOG_KEY: 'a:xyz' })).toThrow(
        new ConfigError('TRANSCODA_PLUGIN_CATALOG_KEY: a:xyz: expected <id>:<64 hex>'),
      );
    });

    it('validates the blocklist url like the catalog url, default the official one', () => {
      expect(loadConfig({}).pluginBlocklistUrl).toBe(OFFICIAL_BLOCKLIST_URL);
      expect(() =>
        loadConfig({ NODE_ENV: 'production', TRANSCODA_PLUGIN_BLOCKLIST_URL: 'http://x' }),
      ).toThrow(new ConfigError('TRANSCODA_PLUGIN_BLOCKLIST_URL must be an https url'));
      expect(
        loadConfig({ NODE_ENV: 'development', TRANSCODA_PLUGIN_BLOCKLIST_URL: 'http://x' })
          .pluginBlocklistUrl,
      ).toBe('http://x');
      expect(() => loadConfig({ TRANSCODA_PLUGIN_BLOCKLIST_URL: 'nope' })).toThrow(
        new ConfigError('TRANSCODA_PLUGIN_BLOCKLIST_URL is not a url'),
      );
    });

    it('refuses a relative dev plugin path', () => {
      expect(() => loadConfig({ TRANSCODA_DEV_PLUGINS: '/dev/a.js,plugins/b.js' })).toThrow(
        new ConfigError('TRANSCODA_DEV_PLUGINS entries must be absolute paths'),
      );
    });
  });
});

describe('parseIsolation', () => {
  const parse = (
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform = 'linux',
    own: number | null = 1234,
    ownGid: number | null = 4321,
  ) => parseIsolation(env, platform, own, ownGid);

  it('is null when TRANSCODA_PLUGIN_UID is unset or empty', () => {
    expect(parse({})).toBeNull();
    expect(parse({ TRANSCODA_PLUGIN_UID: '' })).toBeNull();
  });

  it('parses ids with the defaults for the run dir and setpriv', () => {
    expect(parse({ TRANSCODA_PLUGIN_UID: '65001', TRANSCODA_PLUGIN_GID: '65001' })).toEqual({
      uid: 65001,
      gid: 65001,
      runDir: '/run/transcoda/plugins',
      setprivPath: '/usr/bin/setpriv',
    });
    expect(
      parse({
        TRANSCODA_PLUGIN_UID: '70000',
        TRANSCODA_PLUGIN_GID: '70001',
        TRANSCODA_PLUGIN_RUN_DIR: '/tmp/run',
        TRANSCODA_SETPRIV: '/bin/setpriv',
      }),
    ).toEqual({ uid: 70000, gid: 70001, runDir: '/tmp/run', setprivPath: '/bin/setpriv' });
  });

  it('refuses each bad input with its exact message (never silently same-uid)', () => {
    expect(() => parse({ TRANSCODA_PLUGIN_UID: '65001' })).toThrow(
      new ConfigError('TRANSCODA_PLUGIN_UID needs TRANSCODA_PLUGIN_GID'),
    );
    expect(() => parse({ TRANSCODA_PLUGIN_UID: 'abc', TRANSCODA_PLUGIN_GID: '1' })).toThrow(
      new ConfigError('TRANSCODA_PLUGIN_UID must be a non-negative integer, got "abc"'),
    );
    expect(() => parse({ TRANSCODA_PLUGIN_UID: '1', TRANSCODA_PLUGIN_GID: '-1' })).toThrow(
      new ConfigError('TRANSCODA_PLUGIN_GID must be a non-negative integer, got "-1"'),
    );
    // Review Focus 4: the plugin uid equals the server's own uid.
    expect(() =>
      parse({ TRANSCODA_PLUGIN_UID: '1234', TRANSCODA_PLUGIN_GID: '65001' }, 'linux', 1234),
    ).toThrow(new ConfigError("TRANSCODA_PLUGIN_UID must differ from the server's uid"));
    // ... or the platform is not Linux.
    expect(() =>
      parse({ TRANSCODA_PLUGIN_UID: '65001', TRANSCODA_PLUGIN_GID: '65001' }, 'darwin'),
    ).toThrow(new ConfigError('TRANSCODA_PLUGIN_UID is only supported on Linux'));
    expect(() =>
      parse({
        TRANSCODA_PLUGIN_UID: '65001',
        TRANSCODA_PLUGIN_GID: '65001',
        TRANSCODA_PLUGIN_RUN_DIR: 'run/x',
      }),
    ).toThrow(new ConfigError('TRANSCODA_PLUGIN_RUN_DIR must be an absolute path'));
  });

  it('refuses a run dir equal to or inside the config dir (cleanRunDir must never reach it)', () => {
    const msg = 'TRANSCODA_PLUGIN_RUN_DIR must not be the config directory or inside it';
    const ids = { TRANSCODA_PLUGIN_UID: '65001', TRANSCODA_PLUGIN_GID: '65001' };
    for (const runDir of ['/config', '/config/', '/config/run', '/config/a/../b', '/x/../config']) {
      expect(() => parse({ ...ids, TRANSCODA_PLUGIN_RUN_DIR: runDir })).toThrow(
        new ConfigError(msg),
      );
    }
    expect(() =>
      parse({ ...ids, TRANSCODA_CONFIG_DIR: '/data/cfg', TRANSCODA_PLUGIN_RUN_DIR: '/data/cfg/p' }),
    ).toThrow(new ConfigError(msg));
    expect(parse({ ...ids, TRANSCODA_PLUGIN_RUN_DIR: '/config2/run' })?.runDir).toBe(
      '/config2/run',
    );
    expect(parse({ ...ids, TRANSCODA_PLUGIN_RUN_DIR: '/run/transcoda/plugins' })?.runDir).toBe(
      '/run/transcoda/plugins',
    );
  });

  it('accepts only ids 1..2147483647 (0 regains caps; 4294967295 is setpriv\'s "unchanged")', () => {
    for (const bad of ['0', '4294967295', '2147483648', '1'.repeat(20)]) {
      expect(() => parse({ TRANSCODA_PLUGIN_UID: bad, TRANSCODA_PLUGIN_GID: '65001' })).toThrow(
        new ConfigError(`TRANSCODA_PLUGIN_UID must be between 1 and 2147483647, got "${bad}"`),
      );
      expect(() => parse({ TRANSCODA_PLUGIN_UID: '65001', TRANSCODA_PLUGIN_GID: bad })).toThrow(
        new ConfigError(`TRANSCODA_PLUGIN_GID must be between 1 and 2147483647, got "${bad}"`),
      );
    }
    expect(parse({ TRANSCODA_PLUGIN_UID: '2147483647', TRANSCODA_PLUGIN_GID: '1' })).toMatchObject({
      uid: 2147483647,
      gid: 1,
    });
  });

  it("refuses the server's own gid", () => {
    expect(() =>
      parse({ TRANSCODA_PLUGIN_UID: '65001', TRANSCODA_PLUGIN_GID: '4321' }, 'linux', 1234, 4321),
    ).toThrow(new ConfigError("TRANSCODA_PLUGIN_GID must differ from the server's group"));
  });

  it('checks the platform before parsing the numbers', () => {
    expect(() => parse({ TRANSCODA_PLUGIN_UID: '0', TRANSCODA_PLUGIN_GID: '0' }, 'darwin')).toThrow(
      new ConfigError('TRANSCODA_PLUGIN_UID is only supported on Linux'),
    );
  });

  it('TRANSCODA_PLUGIN_ISOLATION accepts only "off" (or nothing)', () => {
    expect(loadConfig({}).pluginIsolationOff).toBe(false);
    expect(loadConfig({ TRANSCODA_PLUGIN_ISOLATION: '' }).pluginIsolationOff).toBe(false);
    expect(loadConfig({ TRANSCODA_PLUGIN_ISOLATION: 'off' }).pluginIsolationOff).toBe(true);
    for (const bad of ['on', 'OFF', 'false', '0']) {
      expect(() => loadConfig({ TRANSCODA_PLUGIN_ISOLATION: bad })).toThrow(
        new ConfigError(`TRANSCODA_PLUGIN_ISOLATION must be "off" or unset, got "${bad}"`),
      );
    }
  });

  it('loadConfig carries it as pluginIsolation (null when unset)', () => {
    expect(loadConfig({}).pluginIsolation).toBeNull();
  });
});

describe('requireIsolationInProduction', () => {
  const iso = { uid: 65001, gid: 65001, runDir: '/run/x', setprivPath: '/usr/bin/setpriv' };
  const base = { ...loadConfig({}), nodeEnv: 'production' as const };
  const text =
    'plugin isolation is off: mount a tmpfs at /run/transcoda (see docs/env.md) or set TRANSCODA_PLUGIN_ISOLATION=off to run plugins as the server user';

  it('refuses production on Linux without isolation, unless it is explicitly off', () => {
    expect(() => requireIsolationInProduction(base, 'linux')).toThrow(new ConfigError(text));
    expect(() =>
      requireIsolationInProduction({ ...base, pluginIsolationOff: true }, 'linux'),
    ).not.toThrow();
  });

  it('is quiet with isolation, outside production and off Linux', () => {
    expect(() =>
      requireIsolationInProduction({ ...base, pluginIsolation: iso }, 'linux'),
    ).not.toThrow();
    expect(() =>
      requireIsolationInProduction({ ...base, nodeEnv: 'development' }, 'linux'),
    ).not.toThrow();
    expect(() => requireIsolationInProduction({ ...base, nodeEnv: 'test' }, 'linux')).not.toThrow();
    expect(() => requireIsolationInProduction(base, 'darwin')).not.toThrow();
  });
});
