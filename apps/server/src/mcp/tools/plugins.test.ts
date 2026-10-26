import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixturePluginPath } from '../../plugins/testing/build.ts';
import { createTestApp, type TestApp } from '../../test-app.ts';
import { createToken, login, type Session } from '../../test-http.ts';
import { mcpClient } from '../test-client.ts';

vi.setConfig({ testTimeout: 30_000 });

let t: TestApp;
let s: Session;

beforeEach(async () => {
  t = createTestApp({ plugins: { devPlugins: [fixturePluginPath('example')] } });
  await t.deps.plugins.start();
  s = await login(t);
});
afterEach(async () => {
  await t.close();
});

const text = (res: unknown) =>
  ((res as { content?: { text: string }[] }).content ?? [])[0]?.text ?? '';

describe('list_plugins', () => {
  it('a read token lists the installed example with its state and nodes, and nothing about settings', async () => {
    const { token } = await createToken(t, s, { name: 'r', scopes: ['read'] });
    const client = await mcpClient(t, token);
    const res = await client.callTool({ name: 'list_plugins', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toBe(
      'example 0.1.0 — running, nodes: example:extension-is, example:note, example:fixed-language',
    );
    const plugins = (res.structuredContent as { plugins: Array<Record<string, unknown>> }).plugins;
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({ name: 'example', state: 'running', enabled: true });
    expect(plugins[0]).not.toHaveProperty('settings');
    expect(JSON.stringify(res)).not.toMatch(/settings|secret/i);
  });

  it('shows why a plugin does not run', async () => {
    const { token } = await createToken(t, s, { name: 'r', scopes: ['read'] });
    await t.deps.plugins.disable('example');
    const client = await mcpClient(t, token);
    const res = await client.callTool({ name: 'list_plugins', arguments: {} });
    expect(text(res)).toMatch(/^example 0\.1\.0 — disabled/);
  });

  it('says BLOCKLISTED with the reason when the blocklist names an installed plugin, and carries it in the data', async () => {
    const { token } = await createToken(t, s, { name: 'r', scopes: ['read'] });
    const [example] = t.deps.plugins.list();
    if (!example) throw new Error('example is not listed');
    const blocked = { reason: 'Exfiltrates tokens', url: 'https://example.com/advisory/1' };
    vi.spyOn(t.deps.plugins, 'listing').mockReturnValue({
      plugins: [
        { ...example, state: 'stopped', stateReason: 'blocklisted: Exfiltrates tokens', blocked },
      ],
      missing: [],
    });
    const client = await mcpClient(t, token);
    const res = await client.callTool({ name: 'list_plugins', arguments: {} });
    expect(text(res)).toBe(
      'example 0.1.0 — stopped (blocklisted: Exfiltrates tokens), nodes: example:extension-is, example:note, example:fixed-language, BLOCKLISTED: Exfiltrates tokens',
    );
    const plugins = (res.structuredContent as { plugins: Array<Record<string, unknown>> }).plugins;
    expect(plugins[0]?.blocked).toEqual(blocked);
    const { tools } = await client.listTools();
    expect(tools.find((x) => x.name === 'list_plugins')?.description).toContain(
      'whether the blocklist stops it',
    );
  });

  it('is offered to a read token only: a plan-only token does not see it', async () => {
    const { token } = await createToken(t, s, { name: 'p', scopes: ['plan'] });
    const client = await mcpClient(t, token);
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name)).not.toContain('list_plugins');
    const res = await client.callTool({ name: 'list_plugins', arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not found/);
  });
});
