import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPluginBundle, parseCheckArgs, runCheckPlugin } from './check-plugin.ts';
import { fixturePluginPath, hostPath } from './testing/build.ts';

describe('parseCheckArgs', () => {
  it('takes the bundle, the bare --expect-denials flag and --other-bundle', () => {
    expect(parseCheckArgs(['--check-plugin', '/a.js'])).toEqual({
      bundle: '/a.js',
      expectDenials: false,
    });
    expect(
      parseCheckArgs(['--check-plugin', '/a.js', '--expect-denials', '--other-bundle', '/b.js']),
    ).toEqual({ bundle: '/a.js', expectDenials: true, otherBundle: '/b.js' });
  });

  it('refuses a missing file, the =value form and unknown flags', () => {
    expect(() => parseCheckArgs(['--check-plugin'])).toThrow(/usage/);
    expect(() => parseCheckArgs(['--check-plugin', '--expect-denials'])).toThrow(/usage/);
    expect(() => parseCheckArgs(['--check-plugin', '/a.js', '--expect-denials=true'])).toThrow(
      'unknown argument --expect-denials=true',
    );
    expect(() => parseCheckArgs(['--check-plugin', '/a.js', '--other-bundle'])).toThrow(
      '--other-bundle needs a file',
    );
  });
});

describe('runCheckPlugin', () => {
  const env = () => ({ TRANSCODA_PLUGIN_HOST: hostPath() });

  async function run(argv: string[], e: NodeJS.ProcessEnv = env()) {
    const lines: string[] = [];
    const code = await runCheckPlugin(argv, e, (l) => lines.push(l));
    return { code, lines };
  }

  it('prints one JSON line and exits 0 for a good bundle', async () => {
    const { code, lines } = await run(['--check-plugin', fixturePluginPath('example')]);
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      ok: true,
      name: 'example',
      version: '0.1.0',
      compatible: true,
    });
  });

  it('reports the host process identity: null off Linux, the own uid and no isolation capabilities on Linux when the host shares the server user', async () => {
    const { lines } = await run(['--check-plugin', fixturePluginPath('example')]);
    const out = JSON.parse(lines[0] ?? '') as { isolation: Record<string, unknown> | null };
    if (process.platform !== 'linux') {
      expect(out.isolation).toBeNull();
      return;
    }
    expect(out.isolation).toMatchObject({
      uid: process.getuid?.(),
      noNewPrivs: expect.any(Number),
    });
  });

  it('with isolation configured, a host that is not that user fails the identity probes, never ok', async () => {
    // A stand-in for setpriv that changes nothing: the host keeps the server's own identity.
    const dir = mkdtempSync(join(tmpdir(), 'tc-chk-'));
    try {
      const fake = join(dir, 'setpriv');
      writeFileSync(fake, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n');
      chmodSync(fake, 0o755);
      const result = await checkPluginBundle(
        fixturePluginPath('denial'),
        {
          hostPath: hostPath(),
          isolation: { uid: 65001, gid: 65001, runDir: dir, setprivPath: fake },
        },
        { expectDenials: true, otherBundle: fixturePluginPath('example') },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const probes = (result.failures ?? []).map((f) => f.probe);
      // Identity is unknown off Linux (also a failure: unverifiable is not verified); the fixture's
      // own probes catch the same thing everywhere.
      expect(probes).toEqual(expect.arrayContaining(['identity.uid', 'signalServer', 'uid']));
      expect(probes).toContain('identity.noNewPrivs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 with the reason for a bundle with no plugin export, a missing file, bad usage and a relative host', async () => {
    const bad = await run(['--check-plugin', fixturePluginPath('badexport')]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.lines[0] ?? '')).toEqual({
      ok: false,
      error: 'bundle has no plugin default export',
    });
    expect((await run(['--check-plugin', '/nonexistent/x.js'])).code).toBe(1);
    const usage = await run(['--check-plugin']);
    expect(usage.code).toBe(1);
    expect(JSON.parse(usage.lines[0] ?? '')).toMatchObject({ ok: false });
    const relative = await run(['--check-plugin', fixturePluginPath('example')], {
      TRANSCODA_PLUGIN_HOST: 'plugin-host.js',
    });
    expect(JSON.parse(relative.lines[0] ?? '')).toEqual({
      ok: false,
      error: 'TRANSCODA_PLUGIN_HOST must be an absolute path',
    });
  });

  it('--expect-denials on the denial fixture reports the probe count; --other-bundle is the second file', async () => {
    const denial = fixturePluginPath('denial');
    const { code, lines } = await run([
      '--check-plugin',
      denial,
      '--expect-denials',
      '--other-bundle',
      fixturePluginPath('example'),
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ ok: true, name: 'denial', probes: 19 });
  });
});
