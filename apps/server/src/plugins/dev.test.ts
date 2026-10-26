import { realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { devPluginRuntimes } from './dev.ts';
import { fixturePluginPath, hostPath } from './testing/build.ts';

const run = (paths: string[], installed: string[] = [], sdkVersion?: string) =>
  devPluginRuntimes(paths, hostPath(), { installed, sdkVersion });

describe('devPluginRuntimes', () => {
  it('a dev bundle yields an enabled runtime with empty settings, read from the bundle itself', async () => {
    const path = fixturePluginPath('example');
    const { runtimes, refused } = await run([path]);
    expect(refused).toEqual([]);
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]).toMatchObject({
      name: 'example',
      version: '0.1.0',
      bundlePath: realpathSync(path),
      enabled: true,
      // Dev bundles run as the server's user, from their own path (never staged).
      isolated: false,
      settings: {},
      policy: { allowedOrigins: [], allowInsecureTls: false },
      manifest: {
        name: 'example',
        sdk: '^1',
        nodes: ['example:extension-is', 'example:note', 'example:fixed-language'],
        integration: null,
        triggers: [],
        hooks: [],
      },
    });
    expect(runtimes[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a name that an installed plugin already has', async () => {
    const path = fixturePluginPath('example');
    expect(await run([path], ['example'])).toEqual({
      runtimes: [],
      refused: [{ path, reason: 'dev plugin example shadows the installed one; remove it first' }],
    });
  });

  it('refuses a second bundle of the same name, a bundle that is no plugin, a missing file and an unsupported sdk', async () => {
    const example = fixturePluginPath('example');
    const bad = fixturePluginPath('badexport');
    const out = await run([example, example, bad, '/nonexistent/plugin.js']);
    expect(out.runtimes.map((r) => r.name)).toEqual(['example']);
    expect(out.refused.map((r) => r.reason)).toEqual([
      'dev plugin example shadows the installed one; remove it first',
      'bundle has no plugin default export',
      expect.stringContaining('cannot read /nonexistent/plugin.js'),
    ]);
    const old = await run([example], [], '2.0.0');
    expect(old.runtimes).toEqual([]);
    expect(old.refused[0]?.reason).toBe('sdk ^1 is not supported by this server');
  });
});
