import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginIsolation } from '../../platform/config.ts';
import { fixturePluginPath } from '../testing/build.ts';

import {
  alive,
  install,
  manifestOf,
  pidOf,
  serve,
  setup,
  text,
  update,
  useTestCatalog,
} from './testing.ts';

useTestCatalog();

// Isolation, end to end over the real host, with a stand-in for setpriv: a script that records its
// argv and then execs what follows `--` (this machine is not Linux and has no capabilities). The
// real setpriv is exercised in the image check (Task 7 step 4).
describe('plugin isolation (staging)', () => {
  let scratch: string;
  let runDir: string;
  let invocations: string;
  let isolation: PluginIsolation;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'tc-iso-'));
    runDir = join(scratch, 'run');
    await mkdir(runDir);
    invocations = join(scratch, 'invocations.log');
    const fake = join(scratch, 'setpriv');
    await writeFile(
      fake,
      `#!/bin/sh\necho "$*" >> '${invocations}'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
    );
    await chmod(fake, 0o755);
    isolation = { uid: 65001, gid: 65001, runDir, setprivPath: fake };
  });
  afterEach(() => rm(scratch, { recursive: true, force: true }));

  const lines = async (): Promise<string[]> =>
    (await readFile(invocations, 'utf8').catch(() => '')).split('\n').filter((l) => l !== '');

  it('a host starts through setpriv from a staged copy under the run dir: mode 0640, real path in the sandbox grant', async () => {
    await serve('example');
    const t = setup({ isolation });
    await t.deps.plugins.start();
    const r = await install(t, 'example');
    if (!r.ok) throw new Error(r.reason);
    expect(r.plugin.state).toBe('running');
    const staged = join(await realpath(runDir), 'example-0.1.0.js');
    expect(await readdir(runDir)).toEqual(['example-0.1.0.js']);
    expect((await stat(staged)).mode & 0o777).toBe(0o640);
    expect(await readFile(staged, 'utf8')).toBe(text('example'));
    const [line] = await lines();
    expect(line).toMatch(
      /^--reuid=65001 --regid=65001 --clear-groups --inh-caps=-all --ambient-caps=-all --no-new-privs -- /,
    );
    expect(line).toContain(`--allow-fs-read=${staged}`);
    expect(line?.endsWith(` ${staged}`)).toBe(true);
    expect(line).not.toContain('/plugins/example-0.1.0.js');
  });

  it('a tampered bundle is refused before it is staged', async () => {
    await serve('example');
    const first = setup({ isolation });
    await first.deps.plugins.start();
    await install(first, 'example');
    await first.deps.plugins.stop();
    await writeFile(
      join(first.deps.config.pluginsDir, 'example-0.1.0.js'),
      `${text('example')}\n// x`,
    );
    const second = setup({
      db: first.db,
      pluginsDir: first.deps.config.pluginsDir,
      isolation,
    });
    await second.deps.plugins.start();
    expect(second.deps.plugins.get('example')).toMatchObject({
      state: 'stopped',
      stateReason: 'bundle changed on disk; reinstall',
    });
    expect(await readdir(runDir)).toEqual([]);
  });

  it('update: the candidate runs from its own staged copy, the old copy goes after the swap, a failed update leaves no new copy', async () => {
    await serve('example');
    await serve('example', '0.2.0');
    await serve('example', '0.3.0', {
      edit: (c) => c.replace('await ctx.log("debug", "example 0.1.0 loaded");', 'process.exit(4);'),
    });
    const t = setup({ isolation });
    await t.deps.plugins.start();
    await install(t, 'example');
    const real = await realpath(runDir);

    expect(await update(t, 'example', '0.3.0')).toMatchObject({ ok: false });
    expect(await readdir(runDir)).toEqual(['example-0.1.0.js']);

    const r = await update(t, 'example', '0.2.0');
    if (!r.ok) throw new Error(r.reason);
    const all = await lines();
    expect(all.at(-1)?.endsWith(` ${join(real, 'example-0.2.0.js')}`)).toBe(true);
    expect(await readdir(runDir)).toEqual(['example-0.2.0.js']);
    // A restart stages again from the installed copy.
    await t.deps.plugins.restart('example');
    expect(t.deps.plugins.get('example')?.state).toBe('running');
    expect(await readdir(runDir)).toEqual(['example-0.2.0.js']);
  });

  it('Review focus 5: a missing run dir stops that plugin with the reason, no restart loop, the other plugin keeps running', async () => {
    await serve('example');
    await serve('ctxprobe');
    const t = setup({ isolation });
    await t.deps.plugins.start();
    expect((await install(t, 'example')).ok).toBe(true);
    const other = (await manifestOf('ctxprobe')).name;
    expect((await install(t, other)).ok).toBe(true);
    const otherPid = pidOf(t, other);
    await rm(runDir, { recursive: true });
    const before = (await lines()).length;

    const detail = await t.deps.plugins.restart('example');
    expect(detail.state).toBe('stopped');
    expect(detail.stateReason).toMatch(/^cannot stage bundle: ENOENT/);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.deps.plugins.get('example')?.state).toBe('stopped');
    expect((await lines()).length).toBe(before);
    expect(t.deps.plugins.get(other)?.state).toBe('running');
    expect(alive(otherPid)).toBe(true);
  });

  it('disable and remove take the staged copy away; start() clears what an earlier run left', async () => {
    await serve('example');
    const t = setup({ isolation });
    await writeFile(join(runDir, 'leftover-9.9.9.js'), 'x');
    await t.deps.plugins.start();
    expect(await readdir(runDir)).toEqual([]);
    await install(t, 'example');
    expect(await readdir(runDir)).toEqual(['example-0.1.0.js']);
    await t.deps.plugins.disable('example');
    expect(await readdir(runDir)).toEqual([]);
    await t.deps.plugins.enable('example');
    expect(await readdir(runDir)).toEqual(['example-0.1.0.js']);
    await t.deps.plugins.remove('example');
    expect(await readdir(runDir)).toEqual([]);
  });

  it('a dev plugin is not isolated: no setpriv, run from its own path, never staged', async () => {
    const t = setup({ isolation, plugins: { devPlugins: [fixturePluginPath('example')] } });
    await t.deps.plugins.start();
    expect(t.deps.plugins.get('example')).toMatchObject({ state: 'running' });
    expect(await lines()).toEqual([]);
    expect(await readdir(runDir)).toEqual([]);
  });
});
