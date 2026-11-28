import { ORPCError } from '@orpc/client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  plugins: {
    list: vi.fn(),
    catalog: vi.fn(),
    get: vi.fn(),
    install: vi.fn(),
    update: vi.fn(),
    updateCheck: vi.fn(),
    remove: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    restart: vi.fn(),
    catalogsAdd: vi.fn(),
    catalogsRemove: vi.fn(),
    settingsGet: vi.fn(),
    settingsSave: vi.fn(),
    settingsTest: vi.fn(),
  },
  nodes: { list: vi.fn() },
  events: { subscribe: vi.fn() },
}));
vi.mock('../../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { EventsProvider } from '../../hooks/use-events.ts';
import { REFETCH_COALESCE_MS } from '../../hooks/use-refetch-on.ts';
import {
  catalogOutput,
  plugin,
  pluginDetail,
  serviceDetail,
} from '../../testing/fixtures/plugins.ts';
import { renderAt } from '../../testing/render.tsx';
import { PluginsPage } from './PluginsPage.tsx';
import { NETWORK_NONE, NETWORK_NOTE, NETWORK_UNLISTED } from './plugin-text.ts';
import {
  catalogWith,
  fake,
  installFailed,
  listOf,
  nodeInfo,
  open,
  openSettings,
  row,
  setupPluginsPageMocks,
  view,
} from './testing.tsx';

setupPluginsPageMocks(mocks);
afterEach(cleanup);

describe('PluginsPage installed plugins', () => {
  it('a row shows the tile, title, version, what uses it and its status, with Settings', async () => {
    mocks.plugins.list.mockResolvedValue(
      listOf([
        plugin({
          usedBy: [
            { id: 'w1', name: 'TV cleanup', active: true },
            { id: 'w2', name: 'Movie shrink', active: false },
          ],
        }),
      ]),
    );
    await open();
    const r = row();
    expect(within(r).getByRole('heading', { name: 'Example', level: 3 })).toBeTruthy();
    expect(within(r).getByText('1.0.0')).toBeTruthy();
    expect(within(r).getByText('Used by TV cleanup, Movie shrink')).toBeTruthy();
    expect(within(r).getByText('Running')).toBeTruthy();
    expect(r.querySelector('.plugin-tile')?.textContent).toBe('Ex');
    const settings = within(r).getByRole('button', { name: 'Example settings' });
    expect(settings.getAttribute('aria-expanded')).toBe('false');
    expect(within(r).queryByRole('button', { name: /^Update/ })).toBeNull();
  });

  it('a row lists the hosts the installed build connects to, as the install dialog does', async () => {
    mocks.plugins.list.mockResolvedValue(
      listOf([
        plugin({
          name: 'ntfy',
          network: [
            { origin: 'https://discord.com' },
            { origin: 'http://ntfy.example.com' },
            { setting: 'url', label: 'server URL' },
          ],
        }),
        plugin({ name: 'quiet', network: [] }),
        plugin({ name: 'old', network: null }),
      ]),
    );
    view();
    await screen.findByRole('article', { name: 'ntfy' });

    const ntfy = row('ntfy');
    expect(within(ntfy).getByRole('heading', { name: 'Connects to', level: 4 })).toBeTruthy();
    const hosts = within(ntfy).getByRole('list', { name: 'Connects to' });
    expect(
      within(hosts)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'discord.com',
      'http://ntfy.example.com',
      'The server URL you enter in its settings',
    ]);
    expect(within(ntfy).getByText(NETWORK_NOTE)).toBeTruthy();

    const quiet = row('quiet');
    expect(
      within(within(quiet).getByRole('list', { name: 'Connects to' })).getByRole('listitem')
        .textContent,
    ).toBe(NETWORK_NONE);
    expect(within(quiet).getByText(NETWORK_NOTE)).toBeTruthy();

    const old = row('old');
    expect(within(old).queryByRole('list', { name: 'Connects to' })).toBeNull();
    expect(within(old).getByText(NETWORK_UNLISTED)).toBeTruthy();
    expect(within(old).queryByText(NETWORK_NOTE)).toBeNull();
  });

  it('the status badge says how the last connection test went', async () => {
    const at = '2026-10-17T09:00:00.000Z';
    mocks.plugins.list.mockResolvedValue(
      listOf([
        plugin({
          name: 'jellyfin',
          hasIntegration: true,
          lastTest: { at, ok: false, kind: 'unreachable' },
        }),
        plugin({ name: 'sonarr', hasIntegration: true, lastTest: { at, ok: true, kind: null } }),
        plugin({ name: 'ntfy', hasIntegration: true, lastTest: null }),
      ]),
    );
    view();
    await screen.findByRole('article', { name: 'jellyfin' });
    expect(within(row('jellyfin')).getByText("Can't reach server")).toBeTruthy();
    expect(within(row('sonarr')).getByText('Connected')).toBeTruthy();
    expect(within(row('ntfy')).getByText('Not tested')).toBeTruthy();
    expect(within(row('ntfy')).getByText('Not used by any workflow yet')).toBeTruthy();
  });

  it("Settings opens inline with the plugin's buttons and the nodes it adds, kind first", async () => {
    await open();
    const r = openSettings();
    expect(
      within(r).getByRole('button', { name: 'Example settings' }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(within(r).getByRole('button', { name: 'Disable Example' })).toBeTruthy();
    expect(within(r).getByRole('button', { name: 'Restart Example' })).toBeTruthy();
    expect(within(r).getByRole('button', { name: 'Remove plugin Example' })).toBeTruthy();
    const nodes = await within(r).findByRole('list', { name: 'Nodes Example adds' });
    await waitFor(() =>
      expect(within(nodes).getByRole('listitem').textContent).toBe('Action: Shout'),
    );
  });

  it('the tmdb row carries the TMDB notice in its settings and other rows do not', async () => {
    mocks.plugins.list.mockResolvedValue(
      listOf([plugin(), plugin({ name: 'tmdb', nodes: ['tmdb:original-language'] })]),
    );
    await open();
    const notice = 'This product uses the TMDB API but is not endorsed or certified by TMDB.';
    expect(within(openSettings('tmdb')).getByText(notice)).toBeTruthy();
    expect(within(openSettings()).queryByText(notice)).toBeNull();
  });

  it('a stopped plugin says why under its name and offers Enable, not Restart', async () => {
    mocks.plugins.list.mockResolvedValue(
      listOf([
        plugin({
          state: 'stopped',
          enabled: false,
          stateReason: 'exited with code 3 (3 crashes in 10 min)',
        }),
      ]),
    );
    await open();
    const r = row();
    expect(within(r).getByText('stopped: exited with code 3 (3 crashes in 10 min)')).toBeTruthy();
    expect(within(r).getByText('Stopped')).toBeTruthy();
    openSettings();
    fireEvent.click(within(r).getByRole('button', { name: 'Enable Example' }));
    await waitFor(() => expect(mocks.plugins.enable).toHaveBeenCalledWith({ name: 'example' }));
    expect(within(r).queryByRole('button', { name: 'Restart Example' })).toBeNull();
  });

  it('Disable and Restart call the API and refetch', async () => {
    await open();
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Restart Example' }));
    await waitFor(() => expect(mocks.plugins.restart).toHaveBeenCalledWith({ name: 'example' }));
    await waitFor(() => expect(mocks.plugins.list.mock.calls.length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole('button', { name: 'Disable Example' }));
    await waitFor(() => expect(mocks.plugins.disable).toHaveBeenCalledWith({ name: 'example' }));
  });

  it('a failed action shows its reason in the row', async () => {
    mocks.plugins.restart.mockRejectedValue(
      new ORPCError('PLUGIN_NOT_RUNNING', {
        defined: true,
        status: 409,
        message: 'The plugin is not running',
        data: { reason: 'stopped: bundle has no plugin default export' },
      }),
    );
    await open();
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Restart Example' }));
    const alert = await within(row()).findByRole('alert');
    expect(alert.textContent).toContain('stopped: bundle has no plugin default export');
  });

  it('Update checks first, shows the dialog, and Update then calls plugins.update', async () => {
    mocks.plugins.list.mockResolvedValue(listOf([plugin({ updateAvailable: '1.1.0' })]));
    mocks.plugins.update.mockResolvedValue(pluginDetail({ version: '1.1.0' }));
    mocks.plugins.updateCheck.mockResolvedValue({
      wouldBreak: [
        { id: 'w1', name: 'TV cleanup', active: true, version: 4, reason: 'dropped' as const },
      ],
      needsReview: [],
      unknown: false,
    });
    await open();
    expect(within(row()).getByText('1.1.0 available')).toBeTruthy();
    const update = within(row()).getByRole('button', { name: 'Update Example to 1.1.0' });
    expect(update.textContent).toBe('Update');
    fireEvent.click(update);
    const dialog = await screen.findByRole('dialog', { name: 'Update example to 1.1.0' });
    expect(mocks.plugins.updateCheck).toHaveBeenCalledWith({ name: 'example', version: '1.1.0' });
    expect(dialog.textContent).toContain('TV cleanup (active v4)');
    expect(mocks.plugins.update).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }));
    await waitFor(() =>
      expect(mocks.plugins.update).toHaveBeenCalledWith({ name: 'example', version: '1.1.0' }),
    );
    // The dialog closes and focus lands on the row's heading, not on a removed button.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(within(row()).getByRole('heading', { name: 'Example' })),
    );
  });

  it('Cancel in the Update dialog updates nothing', async () => {
    mocks.plugins.list.mockResolvedValue(listOf([plugin({ updateAvailable: '1.1.0' })]));
    mocks.plugins.updateCheck.mockResolvedValue({
      wouldBreak: [],
      needsReview: [{ id: 'w1', name: 'TV cleanup' }],
      unknown: false,
    });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Update Example to 1.1.0' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update example to 1.1.0' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.plugins.update).not.toHaveBeenCalled();
  });

  it('Update with no effect on any workflow updates at once: no dialog, the usual toast', async () => {
    mocks.plugins.list.mockResolvedValue(listOf([plugin({ updateAvailable: '1.1.0' })]));
    mocks.plugins.update.mockResolvedValue(pluginDetail({ version: '1.1.0' }));
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Update Example to 1.1.0' }));
    await waitFor(() =>
      expect(mocks.plugins.update).toHaveBeenCalledWith({ name: 'example', version: '1.1.0' }),
    );
    expect(mocks.plugins.updateCheck).toHaveBeenCalledWith({ name: 'example', version: '1.1.0' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('Updated example to 1.1.0')).toBeTruthy();
  });

  it.each([
    [
      'a version to review',
      { wouldBreak: [], needsReview: [{ id: 'w1', name: 'TV' }], unknown: false },
    ],
    ['an unchecked release', { wouldBreak: [], needsReview: [], unknown: true }],
  ])('Update opens the dialog for %s', async (_, check) => {
    mocks.plugins.list.mockResolvedValue(listOf([plugin({ updateAvailable: '1.1.0' })]));
    mocks.plugins.updateCheck.mockResolvedValue(check);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Update Example to 1.1.0' }));
    expect(await screen.findByRole('dialog', { name: 'Update example to 1.1.0' })).toBeTruthy();
    expect(mocks.plugins.update).not.toHaveBeenCalled();
  });

  it('Update opens the dialog when the new version connects to a host the installed one does not, and marks it', async () => {
    const out = catalogOutput();
    const entry = out.catalogs[0]?.plugins[0];
    const installed = entry?.versions[0];
    if (!entry || !installed?.network) throw new Error('fixture has no network');
    entry.installed = '1.0.0';
    entry.latest = '1.1.0';
    entry.versions.push({
      ...installed,
      version: '1.1.0',
      network: [...installed.network, { origin: 'https://api.example.test' }],
    });
    mocks.plugins.catalog.mockResolvedValue(out);
    mocks.plugins.list.mockResolvedValue(listOf([plugin({ updateAvailable: '1.1.0' })]));
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Update Example to 1.1.0' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update example to 1.1.0' });
    expect(mocks.plugins.update).not.toHaveBeenCalled();
    expect(
      within(dialog).getByText(
        'example 1.1.0 connects to a host the installed version does not: api.example.test.',
      ),
    ).toBeTruthy();
    const hosts = within(dialog).getByRole('list', { name: 'Connects to' });
    expect(
      within(hosts)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['The Example URL you enter in its settings', 'api.example.testnew']);
  });

  it('a failed check shows the reason in the row and does not update', async () => {
    mocks.plugins.list.mockResolvedValue(listOf([plugin({ updateAvailable: '1.1.0' })]));
    mocks.plugins.updateCheck.mockRejectedValue(
      installFailed('example 1.1.0 is not in that catalog'),
    );
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Update Example to 1.1.0' }));
    const alert = await within(row()).findByRole('alert');
    expect(alert.textContent).toContain('example 1.1.0 is not in that catalog');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.plugins.update).not.toHaveBeenCalled();
  });

  it("older versions are offered only from the plugin's settings, through the same update dialog", async () => {
    const out = catalogOutput();
    const entry = out.catalogs[0]?.plugins[0];
    if (!entry?.versions[0]) throw new Error('fixture has no versions');
    entry.installed = '1.0.0';
    entry.versions.push({ ...entry.versions[0], version: '0.9.0' });
    mocks.plugins.catalog.mockResolvedValue(out);
    await open();
    const r = openSettings();
    const versions = within(r).getByRole('list', { name: 'Other versions' });
    expect(within(versions).getByText('needs SDK ^2')).toBeTruthy();
    expect(
      (
        within(versions).getByRole('button', {
          name: 'Switch Example to 2.0.0',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(within(versions).getByRole('button', { name: 'Switch Example to 0.9.0' }));
    expect(await screen.findByRole('dialog', { name: 'Update example to 0.9.0' })).toBeTruthy();
    expect(mocks.plugins.updateCheck).toHaveBeenCalledWith({ name: 'example', version: '0.9.0' });
  });

  it('keeps the installed list while it reloads (no page-level Loading flash)', async () => {
    await open();
    mocks.plugins.list.mockReturnValue(new Promise(() => {}));
    mocks.plugins.catalog.mockResolvedValue(catalogOutput({ plugins: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh the catalog' }));
    await waitFor(() => expect(mocks.plugins.catalog).toHaveBeenCalledWith({ refresh: true }));
    expect(row()).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('Remove asks first, names the workflows using it (the active one apart) and confirms with confirm: true', async () => {
    mocks.plugins.get.mockResolvedValue(
      pluginDetail({
        usedBy: [
          { id: 'w1', name: 'TV cleanup', active: true },
          { id: 'w2', name: 'Movies', active: false },
        ],
      }),
    );
    await open();
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Remove plugin Example' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove example?' });
    expect(
      within(dialog).getByText(
        'Remove example? Its settings are deleted too. 2 workflows use its nodes and will show "plugin missing": TV cleanup, Movies. TV cleanup is active and will stop running until a version without these nodes is activated.',
      ),
    ).toBeTruthy();
    expect(mocks.plugins.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(mocks.plugins.remove).toHaveBeenCalledWith({ name: 'example', confirm: true }),
    );
  });

  it('Remove says so when the workflows could not be looked up, and still lets the person cancel or remove', async () => {
    mocks.plugins.get.mockRejectedValue(new Error('timeout'));
    await open();
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Remove plugin Example' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove example?' });
    expect(within(dialog).getByText("Couldn't check which workflows use example")).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(mocks.plugins.remove).toHaveBeenCalledWith({ name: 'example', confirm: true }),
    );
  });

  it('Disable asks first when workflows use the plugin, listing them and the active ones', async () => {
    mocks.plugins.get.mockResolvedValue(
      pluginDetail({
        usedBy: [
          { id: 'w1', name: 'TV cleanup', active: true },
          { id: 'w2', name: 'Movies', active: false },
        ],
      }),
    );
    await open();
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Disable Example' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disable example?' });
    expect(mocks.plugins.disable).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(dialog.textContent).toContain('TV cleanup, Movies');
    expect(dialog.textContent).toContain(
      'TV cleanup is active and will stop running until example is enabled again.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(mocks.plugins.disable).toHaveBeenCalledWith({ name: 'example' }));
  });

  it('Disable needs no confirmation when nothing uses the plugin', async () => {
    await open();
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Disable Example' }));
    await waitFor(() => expect(mocks.plugins.disable).toHaveBeenCalledWith({ name: 'example' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the Remove dialog has a close button at the top and Cancel; neither removes', async () => {
    await open();
    openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Remove plugin Example' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove example?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.plugins.remove).not.toHaveBeenCalled();
  });

  it("a plugin with an integration opens its form inline: the stored secret's last four, Save and test, Remove plugin, and the last test with its effect", async () => {
    mocks.nodes.list.mockResolvedValue({
      nodes: [nodeInfo('service:refresh', 'finish', 'Refresh in Service', 'media-server')],
    });
    mocks.plugins.list.mockResolvedValue(
      listOf([
        plugin({
          name: 'service',
          hasIntegration: true,
          nodes: ['service:refresh'],
          lastTest: { at: new Date().toISOString(), ok: false, kind: 'unreachable' },
        }),
      ]),
    );
    mocks.plugins.get.mockResolvedValue(serviceDetail());
    mocks.plugins.settingsGet.mockResolvedValue({
      settings: {
        url: 'https://svc.test',
        apiKey: { set: true, endsWith: '4f2a' },
        pathMappings: [],
        insecureTls: false,
      },
      lastTest: {
        at: new Date(Date.now() - 2 * 60_000).toISOString(),
        result: { ok: false, kind: 'unreachable', message: 'connection refused at svc.test' },
      },
      needsReview: null,
    });
    view();
    await screen.findByRole('article', { name: 'service' });
    await waitFor(() => expect(mocks.nodes.list).toHaveBeenCalled());
    const r = openSettings('service');
    expect(await within(r).findByLabelText('Server URL')).toBeTruthy();
    expect((within(r).getByLabelText('API key') as HTMLInputElement).value).toBe(
      'Stored, ends in 4f2a',
    );
    expect(JSON.stringify(mocks.plugins.settingsGet.mock.results)).not.toContain('apiKey":"');
    // The path mapping editor stays part of the settings, under Advanced.
    fireEvent.click(within(r).getByRole('button', { name: 'Advanced' }));
    expect(within(r).getByRole('button', { name: 'Add mapping' })).toBeTruthy();
    const actions = within(r).getByRole('button', { name: 'Save and test' }).parentElement;
    expect(
      within(actions as HTMLElement).getByRole('button', { name: 'Remove plugin service' }),
    ).toBeTruthy();
    expect(
      within(r).getByText('Test failed 2 min ago: connection refused at svc.test'),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        within(r).getByText('Files are still replaced; only the library refresh is skipped.'),
      ).toBeTruthy(),
    );
  });

  it('refetches when plugins.changed arrives', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await open();
    await waitFor(() => expect(fake.streams).toHaveLength(1));
    // The first connect refetches once; let that settle before counting.
    await act(async () =>
      fake.last().push({
        type: 'queue.changed',
        paused: false,
        lanes: { encode: null, quick: null },
        encodeSlots: [],
      }),
    );
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS));
    const before = mocks.plugins.list.mock.calls.length;
    mocks.plugins.list.mockResolvedValue(
      listOf([plugin({ state: 'stopped', stateReason: 'exited with code 1' })]),
    );
    await act(async () =>
      fake.last().push({
        type: 'plugins.changed',
        name: 'example',
        state: 'stopped',
        stateReason: 'exited with code 1',
      }),
    );
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_COALESCE_MS));
    await waitFor(() => expect(mocks.plugins.list.mock.calls.length).toBeGreaterThan(before));
    expect(await screen.findByText('stopped: exited with code 1')).toBeTruthy();
  });

  it('with nothing installed and nothing needed, says so plainly', async () => {
    mocks.plugins.list.mockResolvedValue(listOf([]));
    view();
    expect(
      await screen.findByText('No plugins installed yet. Pick one from the catalog below.'),
    ).toBeTruthy();
    expect(screen.queryByRole('region', { name: /Your workflows need/ })).toBeNull();
  });
});

describe('PluginsPage plugins your workflows need', () => {
  const missing = [
    { name: 'jellyfin', workflows: [{ id: 'w1', name: 'TV cleanup' }] },
    { name: 'sonarr', workflows: [{ id: 'w1', name: 'TV cleanup' }] },
  ];

  beforeEach(() => {
    mocks.plugins.list.mockResolvedValue(listOf([], missing));
    mocks.plugins.catalog.mockResolvedValue(
      catalogWith(
        { name: 'jellyfin', title: 'Jellyfin', description: 'Jellyfin plugin: rescans.' },
        { name: 'sonarr', title: 'Sonarr', description: 'Sonarr plugin: reads.' },
      ),
    );
  });

  it('names them and the workflows using them, with one install button and no empty Installed list', async () => {
    view();
    const card = await screen.findByRole('region', { name: 'Your workflows need 2 plugins' });
    await waitFor(() =>
      expect(
        within(card).getByRole('button', { name: 'Install Jellyfin and Sonarr' }),
      ).toBeTruthy(),
    );
    expect(card.textContent).toContain('TV cleanup uses Jellyfin and Sonarr.');
    expect(screen.queryByRole('region', { name: /^Installed ?[0-9,]*$/ })).toBeNull();
  });

  it('installs them one confirmation dialog after the other; Cancel stops', async () => {
    view();
    const card = await screen.findByRole('region', { name: 'Your workflows need 2 plugins' });
    fireEvent.click(
      await within(card).findByRole('button', { name: 'Install Jellyfin and Sonarr' }),
    );
    const first = await screen.findByRole('dialog', { name: 'Install Jellyfin 1.0.0?' });
    fireEvent.click(within(first).getByRole('button', { name: 'Install' }));
    await waitFor(() =>
      expect(mocks.plugins.install).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'jellyfin' }),
      ),
    );
    const second = await screen.findByRole('dialog', { name: 'Install Sonarr 1.0.0?' });
    fireEvent.click(within(second).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.plugins.install).toHaveBeenCalledTimes(1);
  });

  it('a needed plugin no catalog lists is named without an install button', async () => {
    mocks.plugins.list.mockResolvedValue(
      listOf([], [{ name: 'mystery', workflows: [{ id: 'w2', name: 'Odd one' }] }]),
    );
    view();
    const card = await screen.findByRole('region', { name: 'Your workflows need 1 plugin' });
    await waitFor(() => expect(card.textContent).toContain('No catalog lists mystery'));
    expect(within(card).queryByRole('button')).toBeNull();
  });
});

describe('PluginsPage toolbar', () => {
  it('shows the catalog source as separate items: official, when checked, how many blocked, and Refresh', async () => {
    const out = catalogOutput();
    const official = out.catalogs[0];
    if (!official) throw new Error('no catalog');
    official.fetchedAt = new Date(Date.now() - 57 * 60_000).toISOString();
    mocks.plugins.catalog.mockResolvedValue(out);
    await open();
    const source = screen.getByText('Official catalog').closest('.plugins-source') as HTMLElement;
    expect(await within(source).findByText('checked 57 min ago')).toBeTruthy();
    expect(within(source).getByText('3 blocked versions')).toBeTruthy();
    expect(source.textContent).not.toContain('·');
    fireEvent.click(within(source).getByRole('button', { name: 'Refresh the catalog' }));
    await waitFor(() => expect(mocks.plugins.catalog).toHaveBeenCalledWith({ refresh: true }));
  });

  it('leaves out a blocked count of 0', async () => {
    const out = catalogOutput();
    out.blocklist.entries = 0;
    mocks.plugins.catalog.mockResolvedValue(out);
    await open();
    const source = screen.getByText('Official catalog').closest('.plugins-source') as HTMLElement;
    expect(within(source).queryByText(/blocked/)).toBeNull();
  });

  it('leaves out a tab with nothing in it: no Updates while every plugin is up to date', async () => {
    mocks.plugins.list.mockResolvedValue(listOf([plugin()]));
    await open();
    const show = screen.getByRole('radiogroup', { name: 'Show' });
    expect(within(show).getByRole('radio', { name: 'Installed 1' })).toBeTruthy();
    expect(within(show).queryByRole('radio', { name: /Updates/ })).toBeNull();
  });

  it('keeps the Updates tab open when a link asks for it, even with nothing to update', async () => {
    mocks.plugins.list.mockResolvedValue(listOf([plugin()]));
    renderAt(
      '/plugins?show=updates',
      <EventsProvider>
        <PluginsPage />
      </EventsProvider>,
    );
    expect(await screen.findByText('Every installed plugin is up to date.')).toBeTruthy();
    const show = screen.getByRole('radiogroup', { name: 'Show' });
    expect(
      within(show).getByRole('radio', { name: 'Updates 0' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('search narrows the installed rows and the catalog cards', async () => {
    mocks.plugins.catalog.mockResolvedValue(
      catalogWith(
        { name: 'example', title: 'Example', installed: '1.0.0' },
        { name: 'ntfy', title: 'ntfy', description: 'ntfy plugin: sends a push.' },
      ),
    );
    await open();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search plugins' }), {
      target: { value: 'push' },
    });
    expect(screen.getByText('No installed plugin matches “push”.')).toBeTruthy();
    expect(screen.getByRole('article', { name: 'ntfy' })).toBeTruthy();
    expect(screen.queryByRole('article', { name: 'Example' })).toBeNull();
  });

  it('Show is one radio group: Installed hides the catalog, Updates lists only plugins with one; arrow keys move it', async () => {
    mocks.plugins.list.mockResolvedValue(
      listOf([plugin(), plugin({ name: 'other', updateAvailable: '2.0.0' })]),
    );
    await open();
    const show = screen.getByRole('radiogroup', { name: 'Show' });
    const all = within(show).getByRole('radio', { name: 'All' });
    expect(all.getAttribute('aria-checked')).toBe('true');
    expect(within(show).getByRole('radio', { name: 'Installed 2' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Other' })).toBeTruthy();
    fireEvent.keyDown(all, { key: 'ArrowRight' });
    const inst = within(show).getByRole('radio', { name: 'Installed 2' });
    expect(inst.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(inst);
    expect(screen.queryByRole('region', { name: 'Other' })).toBeNull();
    fireEvent.click(within(show).getByRole('radio', { name: 'Updates 1' }));
    const updates = screen.getByRole('region', { name: /^Updates ?[0-9,]*$/ });
    expect(
      within(updates)
        .getAllByRole('article')
        .map((a) => a.getAttribute('aria-labelledby')),
    ).toHaveLength(1);
    expect(within(updates).getByRole('article', { name: 'other' })).toBeTruthy();
  });
});
