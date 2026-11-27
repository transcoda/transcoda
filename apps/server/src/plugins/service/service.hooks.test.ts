import { describe, expect, it } from 'vitest';

import { install, serve, setup, useTestCatalog } from './testing.ts';

useTestCatalog();

describe('job hooks', () => {
  it('hookTarget reaches running plugins that declare the hook, through the supervisor', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    const target = t.deps.plugins.hookTarget();
    expect(target.running()).toEqual(['example']);
    expect(target.declaredHooks('example')).toEqual([]);
    expect(target.declaredHooks('ghost')).toEqual([]);
    // The hook goes to the process through the supervisor (which redacts the answer); a plugin
    // without that hook function answers ok.
    expect(
      await target.hook('example', 'onJobDone', { id: 'j1', dryRun: false } as never),
    ).toMatchObject({ ok: true });
    await t.deps.plugins.disable('example');
    expect(target.running()).toEqual([]);
  });
});
