import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeps } from './bootstrap.ts';
import { type Config, ConfigError, loadConfig } from './config.ts';
import { SchemaTooNewError } from './db/migrate.ts';
import { openDatabase } from './db/open.ts';
import { exitCodeFor } from './exit-code.ts';
import { createLogger } from './logger.ts';
import { IsolationError } from './plugins/isolation.ts';

let dir: string;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function config(env: NodeJS.ProcessEnv = {}): Config {
  // No test reaches GitHub: the blocklist is a local, empty, valid list read unsigned.
  const blocklist = join(dir, 'blocklist.json');
  writeFileSync(
    blocklist,
    JSON.stringify({ schema: 1, generated: '2026-01-01T00:00:00.000Z', entries: [] }),
  );
  return loadConfig({
    TRANSCODA_PLUGIN_BLOCKLIST_URL: pathToFileURL(blocklist).href,
    TRANSCODA_PLUGIN_CATALOG_KEY: 'none',
    TRANSCODA_CONFIG_DIR: join(dir, 'config'),
    TRANSCODA_FFMPEG_PATH: join(dir, 'no-such-ffmpeg'),
    TRANSCODA_SECRET_KEY: '',
    ...env,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'transcoda-main-'));
  vi.clearAllMocks();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('createDeps', () => {
  it('stops with an IsolationError, before anything is opened, when plugin isolation cannot work', async () => {
    const cfg: Config = {
      ...config(),
      pluginIsolation: {
        uid: 65001,
        gid: 65001,
        runDir: join(dir, 'no-run-dir'),
        setprivPath: join(dir, 'no-setpriv'),
      },
    };
    await expect(createDeps(cfg, log)).rejects.toBeInstanceOf(IsolationError);
    expect(() => statSync(join(dir, 'config'))).toThrow();
  });

  it('refuses production on Linux without isolation (exit 2) unless it is explicitly off', async () => {
    const cfg: Config = { ...config(), nodeEnv: 'production' };
    if (process.platform === 'linux') {
      const err = await createDeps(cfg, log).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect(exitCodeFor(err)).toBe(2);
      expect(() => statSync(join(dir, 'config'))).toThrow();
    }
  });

  it('says in production that hosts run as the server user when isolation is explicitly off', async () => {
    const cfg: Config = { ...config(), nodeEnv: 'production', pluginIsolationOff: true };
    const deps = await createDeps(cfg, log);
    try {
      expect(log.warn).toHaveBeenCalledWith(
        "plugin hosts run as the server's user (TRANSCODA_PLUGIN_UID is not set)",
      );
      await deps.engine.stop();
    } finally {
      deps.close();
    }
  });

  it('on an empty config dir creates secret.key (0600), transcoda.sqlite and runs migrations', async () => {
    const deps = await createDeps(config(), log);
    try {
      expect(statSync(join(dir, 'config', 'secret.key')).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'config', 'transcoda.sqlite')).isFile()).toBe(true);
      const row = deps.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as {
        n: number;
      };
      expect(row.n).toBe(12);
      expect(deps.setupRequired()).toBe(true);
      expect(log.info).toHaveBeenCalledWith(
        expect.stringMatching(
          /^workflow upgrades: 0 upgraded \(0 with behaviour changes\), 0 broken, 0 unchanged$/,
        ),
      );
    } finally {
      deps.close();
    }
  });

  it('starts the engine on an empty db: an empty sweep, the scheduler running and unpaused', async () => {
    const deps = await createDeps(config(), log);
    try {
      expect(deps.engine.scheduler.status()).toEqual({
        paused: false,
        lanes: { encode: null, quick: null },
        encodeSlots: [{ id: 'encode', label: 'Encode', jobId: null }],
        preparing: [],
        ready: [],
      });
      await deps.engine.stop();
    } finally {
      deps.close();
    }
  });

  it('a failing engine start leaves the engine stopped with a visible error; the server still starts', async () => {
    const cfg = { ...config(), transcodeDir: join(dir, 'not-a-dir') };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(cfg.transcodeDir, 'file, not a directory');
    const deps = await createDeps(cfg, log);
    try {
      expect(deps.engine.startError).toMatch(/ENOTDIR/);
      expect(log.error).toHaveBeenCalledWith(
        expect.stringMatching(/^engine did not start: .*no jobs will run$/),
      );
      expect(deps.engine.scheduler.status().paused).toBe(false);
    } finally {
      deps.close();
    }
  });

  it('starts the plugin service before the workflows are upgraded: the plugins directory exists (0700) and one summary line is logged', async () => {
    const deps = await createDeps(config(), log);
    try {
      expect(statSync(join(dir, 'config', 'plugins')).mode & 0o777).toBe(0o700);
      const infos = log.info.mock.calls.map((c) => String(c[0]));
      const summary = infos.findIndex((m) => m.startsWith('plugins: 0 installed'));
      const upgrades = infos.findIndex((m) => m.startsWith('workflow upgrades:'));
      expect(summary).toBeGreaterThanOrEqual(0);
      expect(summary).toBeLessThan(upgrades);
    } finally {
      deps.close();
    }
  });

  it('a plugins directory that cannot be used is logged and does not stop the server', async () => {
    const cfg = config();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(cfg.configDir, { recursive: true });
    writeFileSync(cfg.pluginsDir, 'a file, not a directory');
    const deps = await createDeps(cfg, log);
    try {
      expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/^plugins did not start: /));
      expect(deps.plugins.list()).toEqual([]);
    } finally {
      deps.close();
    }
  });

  it('warns but still starts when ffmpeg is unavailable', async () => {
    const deps = await createDeps(config(), log);
    try {
      expect(deps.capabilities().available).toBe(false);
      expect(log.warn).toHaveBeenCalled();
    } finally {
      deps.close();
    }
  });

  it('throws SchemaTooNewError for a newer schema, without calling process.exit', async () => {
    const cfg = config();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(cfg.configDir, { recursive: true });
    const db = openDatabase(join(cfg.configDir, 'transcoda.sqlite'));
    db.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    db.prepare('INSERT INTO schema_migrations VALUES (99, ?, ?)').run('future', 'x');
    db.close();
    const exit = vi.spyOn(process, 'exit');
    await expect(createDeps(cfg, log)).rejects.toBeInstanceOf(SchemaTooNewError);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it('backs up the database when the build changes, before the workflow upgrades, and stores the id', async () => {
    const backups = () =>
      readdirSync(join(dir, 'config', 'backups'), { withFileTypes: true }).map((d) => d.name);
    const lastBuild = (deps: { db: { prepare(sql: string): { get(): unknown } } }) =>
      deps.db.prepare("SELECT value FROM settings WHERE key = 'app.lastBuildId'").get();

    // A brand-new database: nothing to back up, the id is stored.
    let deps = await createDeps(config({ TRANSCODA_BUILD_ID: 'b1' }), log);
    expect(lastBuild(deps)).toEqual({ value: '"b1"' });
    deps.close();
    expect(() => backups()).toThrow();

    // Same build: no backup.
    deps = await createDeps(config({ TRANSCODA_BUILD_ID: 'b1' }), log);
    deps.close();
    expect(() => backups()).toThrow();

    // New build: one -build backup, logged before the workflow upgrades run.
    log.info.mockClear();
    deps = await createDeps(config({ TRANSCODA_BUILD_ID: 'b2' }), log);
    try {
      expect(lastBuild(deps)).toEqual({ value: '"b2"' });
      expect(backups()).toEqual([
        expect.stringMatching(/^transcoda-\d{8}-\d{6}-v\d+-build\.sqlite$/),
      ]);
      const infos = log.info.mock.calls.map((c) => String(c[0]));
      const backedUp = infos.findIndex((m) =>
        m.startsWith('Build changed (b1 → b2); backed up database to '),
      );
      const upgrades = infos.findIndex((m) => m.startsWith('workflow upgrades:'));
      expect(backedUp).toBeGreaterThanOrEqual(0);
      expect(backedUp).toBeLessThan(upgrades);
    } finally {
      deps.close();
    }
  });

  it('without TRANSCODA_BUILD_ID the build id is a short hash of the running server file', async () => {
    const deps = await createDeps(config(), log);
    try {
      const row = deps.db
        .prepare("SELECT value FROM settings WHERE key = 'app.lastBuildId'")
        .get() as {
        value: string;
      };
      expect(JSON.parse(row.value)).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      deps.close();
    }
  });

  it('prunes the limiter and purges sessions every 10 minutes, and stops on close()', async () => {
    vi.useFakeTimers();
    try {
      const deps = await createDeps(config(), log);
      const prune = vi.spyOn(deps.limiter, 'prune');
      const purge = vi.spyOn(deps.sessions, 'purgeExpired');
      const recycle = vi.spyOn(deps.engine, 'pruneRecycle');
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(prune).toHaveBeenCalledTimes(1);
      expect(purge).toHaveBeenCalledTimes(1);
      expect(recycle).toHaveBeenCalledTimes(1);
      deps.close();
      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(prune).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('main --check-plugin', () => {
  it('runs one sandboxed host and prints the manifest, without a database, a config directory or ffmpeg', async () => {
    const { execFile } = await import('node:child_process');
    const { existsSync } = await import('node:fs');
    const { fixturePluginPath, hostPath, SERVER_DIR } = await import('./plugins/testing/build.ts');
    const configDir = join(dir, 'never-created');
    const run = (bundle: string) =>
      new Promise<{ code: number | null; stdout: string }>((resolve) => {
        execFile(
          join(SERVER_DIR, 'node_modules', '.bin', 'tsx'),
          ['src/main.ts', '--check-plugin', bundle],
          {
            cwd: SERVER_DIR,
            env: {
              ...process.env,
              TRANSCODA_CONFIG_DIR: configDir,
              TRANSCODA_FFMPEG_PATH: join(dir, 'no-such-ffmpeg'),
              TRANSCODA_PLUGIN_HOST: hostPath(),
            },
          },
          (err, stdout) =>
            resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout }),
        );
      });
    const ok = await run(fixturePluginPath('example'));
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout.trim())).toMatchObject({
      ok: true,
      name: 'example',
      compatible: true,
    });
    const bad = await run(fixturePluginPath('badexport'));
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.stdout.trim())).toEqual({
      ok: false,
      error: 'bundle has no plugin default export',
    });
    expect(existsSync(configDir)).toBe(false);
  }, 60_000);
});

describe('createLogger', () => {
  it('writes JSON lines in production and plain text otherwise', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    createLogger('production').info({ msg: 'hello', n: 1 });
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({
      level: 'info',
      msg: 'hello',
      n: 1,
    });
    createLogger('development').info('plain');
    expect(out.mock.calls[1]?.[0]).toBe('plain');
    out.mockRestore();
  });
});

describe('exitCodeFor', () => {
  it('maps ConfigError to 2, SchemaTooNewError to 3, anything else to 1', () => {
    expect(exitCodeFor(new ConfigError('bad'))).toBe(2);
    expect(exitCodeFor(new IsolationError('x'))).toBe(2);
    expect(exitCodeFor(new SchemaTooNewError(5, 3, '/b'))).toBe(3);
    expect(exitCodeFor(new Error('x'))).toBe(1);
    expect(exitCodeFor('boom')).toBe(1);
  });
});
