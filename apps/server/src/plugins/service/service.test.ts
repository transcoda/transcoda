import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeHookContext } from '@transcoda/sdk/testing';
import { describe, expect, it } from 'vitest';
import { findPlugin } from '../../db/repos/plugins.ts';
import { createCoreRegistry } from '../../nodes/registry.ts';
import { fixturePluginPath } from '../testing/build.ts';

import {
  alive,
  indexUrl,
  install,
  pidOf,
  refresh,
  serve,
  setup,
  text,
  useTestCatalog,
} from './testing.ts';

useTestCatalog();

describe('start, restart and shutdown', () => {
  it('stop() finishes the operation in flight, then install, update and the rest refuse; the processes are gone', async () => {
    await serve('example');
    await serve('secrets');
    const t = setup();
    await t.deps.plugins.start();
    await refresh(t);
    const installing = t.deps.plugins.install({
      name: 'example',
      version: '0.1.0',
      catalogUrl: indexUrl,
    });
    await new Promise((r) => setTimeout(r, 5));
    const stopping = t.deps.plugins.stop();
    // Queued behind the install, and after the stop began.
    const late = t.deps.plugins.install({
      name: 'secrets',
      version: '0.1.0',
      catalogUrl: indexUrl,
    });
    expect((await installing).ok).toBe(true);
    await stopping;
    expect(await late).toEqual({ ok: false, reason: 'the server is shutting down' });
    expect(await t.deps.plugins.update('example', '0.2.0')).toEqual({
      ok: false,
      reason: 'the server is shutting down',
    });
    await expect(t.deps.plugins.disable('example')).rejects.toMatchObject({ code: 'invalid' });
    await expect(t.deps.plugins.saveSettings('example', {})).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(findPlugin(t.db, 'secrets')).toBeNull();
    expect(t.deps.plugins.pid('example')).toBeNull();
  });

  it('restart on boot: a second service over the same db and dir starts the plugin again; a bundle whose sha256 changed on disk is stopped with "bundle changed on disk; reinstall"', async () => {
    await serve('example');
    const first = setup();
    await first.deps.plugins.start();
    expect((await install(first, 'example')).ok).toBe(true);
    await first.deps.plugins.stop();

    const second = setup({ db: first.db, pluginsDir: first.deps.config.pluginsDir });
    await second.deps.plugins.start();
    expect(second.deps.plugins.get('example')).toMatchObject({ state: 'running', enabled: true });
    expect(second.deps.nodes.get('example:note')?.unavailable?.()).toBeNull();
    await second.deps.plugins.stop();

    const tampered = join(first.deps.config.pluginsDir, 'example-0.1.0.js');
    await writeFile(tampered, `${text('example')}\n// changed`);
    const third = setup({ db: first.db, pluginsDir: first.deps.config.pluginsDir });
    await third.deps.plugins.start();
    expect(third.deps.plugins.get('example')).toMatchObject({
      state: 'stopped',
      stateReason: 'bundle changed on disk; reinstall',
      enabled: true,
    });
    // Its nodes stay known, and say why they cannot run.
    expect(third.deps.nodes.get('example:note')?.unavailable?.()).toBe(
      'plugin example is not running: bundle changed on disk; reinstall',
    );
    // A restart re-checks the file too.
    await expect(third.deps.plugins.restart('example')).resolves.toMatchObject({
      state: 'stopped',
    });
  });

  it('crash-loop guard: a plugin started by three boots that never got past the stable mark is disabled on the next boot, with the reason', async () => {
    await serve('example');
    const first = setup();
    await first.deps.plugins.start();
    expect((await install(first, 'example')).ok).toBe(true);
    await first.deps.plugins.stop();
    // Three boots that each die (no stop(), nothing reaches the stable mark) while it runs.
    for (let i = 0; i < 3; i += 1) {
      const boot = setup({ db: first.db, pluginsDir: first.deps.config.pluginsDir });
      await boot.deps.plugins.start();
      expect(boot.deps.plugins.get('example')).toMatchObject({ state: 'running' });
    }
    const guarded = setup({ db: first.db, pluginsDir: first.deps.config.pluginsDir });
    await guarded.deps.plugins.start();
    expect(guarded.deps.plugins.get('example')).toMatchObject({
      state: 'disabled',
      enabled: false,
      stateReason:
        'disabled: the server stopped unexpectedly 3 times in a row while this plugin was starting or running; enable it to try again',
    });
    expect(findPlugin(first.db, 'example')?.enabled).toBe(false);
    // Enabling is the explicit retry: it runs again, and the count starts over.
    await expect(guarded.deps.plugins.enable('example')).resolves.toMatchObject({
      state: 'running',
    });
    const after = setup({ db: first.db, pluginsDir: first.deps.config.pluginsDir });
    await after.deps.plugins.start();
    expect(after.deps.plugins.get('example')).toMatchObject({ state: 'running' });
  });

  it('crash-loop guard: a clean shutdown resets the count', async () => {
    await serve('example');
    const first = setup();
    await first.deps.plugins.start();
    expect((await install(first, 'example')).ok).toBe(true);
    await first.deps.plugins.stop();
    for (let i = 0; i < 4; i += 1) {
      const boot = setup({ db: first.db, pluginsDir: first.deps.config.pluginsDir });
      await boot.deps.plugins.start();
      expect(boot.deps.plugins.get('example')).toMatchObject({ state: 'running' });
      await boot.deps.plugins.stop();
    }
  });

  it('a stored plugin whose node type core now provides is stopped with that reason, its other nodes unavailable', async () => {
    await serve('example');
    const first = setup();
    await first.deps.plugins.start();
    await install(first, 'example');
    await first.deps.plugins.stop();

    const core = createCoreRegistry().list();
    const stand = core[0];
    if (!stand) throw new Error('no core node');
    const errors: unknown[] = [];
    const second = setup({
      db: first.db,
      pluginsDir: first.deps.config.pluginsDir,
      nodes: [...core, { def: { ...stand.def, type: 'example:note' }, source: { kind: 'core' } }],
      log: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
    });
    await second.deps.plugins.start();
    expect(second.deps.plugins.get('example')).toMatchObject({
      state: 'stopped',
      stateReason:
        'its nodes cannot be registered: node type example:note is already provided by core',
    });
    expect(errors).toContainEqual(
      expect.objectContaining({ msg: 'plugin stopped', plugin: 'example' }),
    );
    expect(second.deps.nodes.get('example:note')?.source).toEqual({ kind: 'core' });
  });

  it('disable → nodes PLUGIN_UNAVAILABLE ("plugin example is disabled"), enable → running again', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    const pid = pidOf(t, 'example');
    const disabled = await t.deps.plugins.disable('example');
    expect(disabled).toMatchObject({ enabled: false, state: 'disabled' });
    expect(findPlugin(t.db, 'example')?.enabled).toBe(false);
    expect(alive(pid)).toBe(false);
    expect(t.deps.nodes.get('example:note')?.unavailable?.()).toBe('plugin example is disabled');
    expect(
      t.deps.workflows.listNodes().find((n) => n.type === 'example:note')?.availability,
    ).toEqual({
      available: false,
      reason: 'plugin example is disabled',
    });
    const enabled = await t.deps.plugins.enable('example');
    expect(enabled).toMatchObject({ enabled: true, state: 'running' });
    expect(findPlugin(t.db, 'example')?.enabled).toBe(true);
    expect(t.deps.nodes.get('example:note')?.unavailable?.()).toBeNull();
    const restarted = await t.deps.plugins.restart('example');
    expect(restarted.state).toBe('running');
  });

  it('a disabled plugin stays disabled across a restart of the server', async () => {
    await serve('example');
    const first = setup();
    await first.deps.plugins.start();
    await install(first, 'example');
    await first.deps.plugins.disable('example');
    await first.deps.plugins.stop();
    const second = setup({ db: first.db, pluginsDir: first.deps.config.pluginsDir });
    await second.deps.plugins.start();
    expect(second.deps.plugins.get('example')).toMatchObject({ state: 'disabled', enabled: false });
  });

  it('stop() kills every plugin process (no pid alive afterwards)', async () => {
    await serve('example');
    await serve('secrets');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    await install(t, 'secrets');
    const pids = [pidOf(t, 'example'), pidOf(t, 'secrets')];
    expect(pids.every(alive)).toBe(true);
    await t.deps.plugins.stop();
    expect(pids.some(alive)).toBe(false);
  });

  it('start() logs one summary line and makes the plugins directory', async () => {
    const info: unknown[] = [];
    const t = setup({ log: { info: (m) => info.push(m), warn: () => {}, error: () => {} } });
    await t.deps.plugins.start();
    expect(info).toContain('plugins: 0 installed, 0 running, 0 stopped, 0 restarting, 0 disabled');
    expect(await readdir(t.deps.config.pluginsDir)).toEqual([]);
  });
});

describe('test app', () => {
  it('close() stops the plugins and removes the plugins directory it made', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    const dir = t.deps.config.pluginsDir;
    expect((await readdir(dir)).length).toBeGreaterThan(0);
    await t.close();
    await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(t.deps.plugins.pid('example')).toBeNull();
  });
});

describe('live limits', () => {
  it('applyLimits changes the timeout of the next plugin call, without a restart', async () => {
    const t = setup({ plugins: { devPlugins: [fixturePluginPath('spin')] } });
    await t.deps.plugins.start();
    const data = t.deps.nodes.get('spin:spin')?.def.data;
    if (!data) throw new Error('no data hook');
    t.deps.plugins.applyLimits({ callTimeoutMs: 400 });
    const started = Date.now();
    const err = await data({ ...fakeHookContext() } as never, {} as never).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: 'plugin spin timed out after 0.4 s' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('cancelling a plugin call', () => {
  it('a run whose job is already stopped is refused as cancelled, not retryable, and never reaches the plugin', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    const run = t.deps.nodes.get('example:note')?.def.run;
    if (!run) throw new Error('no run hook');
    const ctl = new AbortController();
    ctl.abort();
    const err = await run(
      { ...fakeHookContext(), signal: ctl.signal } as never,
      { text: 'x' } as never,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      message: 'call to plugin example was canceled',
      retryable: false,
    });
    // A live signal runs the call.
    const live = await run(
      {
        ...fakeHookContext(),
        originalPath: '/m/a.mkv',
        newPath: '/m/a.mkv',
        signal: new AbortController().signal,
      } as never,
      { text: 'x' } as never,
    );
    expect(live).toEqual({ ok: true, message: 'noted /m/a.mkv' });
  });
});
