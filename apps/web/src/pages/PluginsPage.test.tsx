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
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import type { PluginSummary } from '@transcoda/contract';
import { resetCatalogCache } from '../hooks/useCatalog.ts';
import { EventsProvider } from '../hooks/useEvents.ts';
import { REFETCH_COALESCE_MS } from '../hooks/useRefetchOn.ts';
import { CUSTOM_CATALOG_WARNING } from '../plugins/pluginText.ts';
import { fakeEventSource } from '../test/fakeEventStream.ts';
import { catalogOutput, plugin, pluginDetail, serviceDetail } from '../test/fixtures/plugins.ts';
import { renderAt } from '../test/render.tsx';
import { PluginsPage } from './PluginsPage.tsx';

let fake: ReturnType<typeof fakeEventSource>;

/** A node of the server's node list, as nodes.list answers it. */
function nodeInfo(type: string, kind: string, title: string, finishPhase: string | null = null) {
  return {
    type,
    version: 1,
    kind,
    title,
    description: '',
    icon: 'plug',
    inputs: [],
    outputs: [],
    settingsSchema: {},
    onNodeSettings: [],
    source: { kind: 'plugin', name: type.split(':')[0], version: '1.0.0' },
    availability: { available: true },
    finishPhase,
  };
}

const listOf = (plugins: PluginSummary[], missing: unknown[] = []) => ({ plugins, missing });

beforeEach(() => {
  resetCatalogCache();
  fake = fakeEventSource();
  mocks.events.subscribe.mockReset().mockImplementation(fake.subscribe);
  mocks.nodes.list.mockReset().mockResolvedValue({
    nodes: [
      nodeInfo('example:shout', 'action', 'Shout'),
      nodeInfo('jellyfin:refresh', 'finish', 'Refresh in Jellyfin', 'media-server'),
    ],
  });
  mocks.plugins.list.mockReset().mockResolvedValue(listOf([plugin()]));
  mocks.plugins.catalog.mockReset().mockResolvedValue(catalogOutput());
  mocks.plugins.get.mockReset().mockResolvedValue(pluginDetail());
  for (const name of [
    'install',
    'update',
    'remove',
    'enable',
    'disable',
    'restart',
    'catalogsAdd',
    'catalogsRemove',
  ] as const) {
    mocks.plugins[name].mockReset().mockResolvedValue(pluginDetail());
  }
  mocks.plugins.remove.mockResolvedValue({ ok: true });
  mocks.plugins.updateCheck
    .mockReset()
    .mockResolvedValue({ wouldBreak: [], needsReview: [], unknown: false });
  mocks.plugins.settingsGet.mockReset();
  mocks.plugins.settingsSave.mockReset();
  mocks.plugins.settingsTest.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function view() {
  return renderAt(
    '/plugins',
    <EventsProvider>
      <PluginsPage />
    </EventsProvider>,
  );
}

/** The page with the example plugin installed and listed under its catalog title. */
async function open() {
  const v = view();
  await waitFor(() => row());
  return v;
}

const installed = () => screen.getByRole('region', { name: 'Installed' });
/** An installed row: titled from the catalog ("Example"), or by name while no catalog lists it. */
const row = (title: string | RegExp = /^example$/i) =>
  within(installed()).getByRole('article', { name: title });
const details = () => screen.getByText('Catalog details').closest('details') as HTMLDetailsElement;

/** Opens a row's settings; returns the row. */
function openSettings(title = 'Example') {
  const r = row(title);
  fireEvent.click(within(r).getByRole('button', { name: `${title} settings` }));
  return r;
}

function installFailed(reason: string) {
  return new ORPCError('PLUGIN_INSTALL_FAILED', {
    defined: true,
    status: 422,
    message: 'The plugin could not be installed',
    data: { reason },
  });
}

/** The official catalog with these entries (each based on the fixture's example entry). */
function catalogWith(...entries: Array<Record<string, unknown>>) {
  const out = catalogOutput();
  const c = out.catalogs[0];
  const base = c?.plugins[0];
  if (!c || !base) throw new Error('fixture has no entry');
  c.plugins = entries.map((e) => ({ ...base, ...e }) as typeof base);
  return out;
}

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
    expect(r.querySelector('.plugin-tile')?.textContent).toBe('E');
    const settings = within(r).getByRole('button', { name: 'Example settings' });
    expect(settings.getAttribute('aria-expanded')).toBe('false');
    expect(within(r).queryByRole('button', { name: /^Update/ })).toBeNull();
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
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Update Example to 1.1.0' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update example to 1.1.0' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.plugins.update).not.toHaveBeenCalled();
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
    expect(screen.queryByRole('region', { name: 'Installed' })).toBeNull();
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
    expect(within(source).getByText('3 blocked')).toBeTruthy();
    expect(source.textContent).not.toContain('·');
    fireEvent.click(within(source).getByRole('button', { name: 'Refresh the catalog' }));
    await waitFor(() => expect(mocks.plugins.catalog).toHaveBeenCalledWith({ refresh: true }));
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
    const updates = screen.getByRole('region', { name: 'Updates' });
    expect(
      within(updates)
        .getAllByRole('article')
        .map((a) => a.getAttribute('aria-labelledby')),
    ).toHaveLength(1);
    expect(within(updates).getByRole('article', { name: 'other' })).toBeTruthy();
  });
});

describe('PluginsPage catalog', () => {
  it('Install opens the dialog with the provenance and the promise, and installs on confirm', async () => {
    mocks.plugins.list.mockResolvedValue(listOf([]));
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Install Example 1.0.0' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install Example 1.0.0?' });
    // Provenance as labelled rows, not a "·" chain that wraps mid-list.
    const facts = dialog.querySelector('dl') as HTMLElement;
    expect(facts.getAttribute('aria-label')).toBe('Where this plugin comes from');
    const fact = (label: string) =>
      within(facts).getByText(label, { selector: 'dt' }).parentElement?.querySelector('dd')
        ?.textContent;
    expect(fact('Source')).toBe('Built by CI');
    expect(fact('Signature')).toBe('Signed with key official-1');
    expect(fact('SHA-256')).toBe('abcdef012345');
    expect(dialog.textContent).not.toContain(' · ');
    const link = within(dialog).getByRole('link', { name: /View on GitHub/ });
    expect(link.getAttribute('href')).toBe('https://github.com/transcoda/plugins/attestations/1');
    // Focus starts on Cancel, so the tooltip is not open when the dialog opens.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    const tip = within(facts).getByRole('button', { name: 'What is an attestation?' });
    const text = document.getElementById(tip.getAttribute('aria-describedby') ?? '');
    expect(text?.getAttribute('role')).toBe('tooltip');
    expect(text?.textContent).toMatch(
      /built from the public source in the transcoda-plugins repository.*exactly the code you can read there/,
    );
    const summary = within(dialog).getByText('What a plugin can and cannot do');
    expect(summary.closest('details')?.open).toBe(false);
    expect(within(dialog).getByText(/^This is accident protection, not a wall\./)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    await waitFor(() =>
      expect(mocks.plugins.install).toHaveBeenCalledWith({
        name: 'example',
        version: '1.0.0',
        catalogUrl: 'https://catalog.test/index.json',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('the catalog is grouped by purpose, with cards showing the nodes a plugin adds', async () => {
    mocks.plugins.list.mockResolvedValue(listOf([]));
    mocks.plugins.catalog.mockResolvedValue(
      catalogWith(
        {
          name: 'jellyfin',
          title: 'Jellyfin',
          description: 'Jellyfin plugin: rescans a file after a replace.',
          nodes: [{ type: 'jellyfin:refresh', kind: 'finish', title: 'Refresh in Jellyfin' }],
        },
        { name: 'example', title: 'Example' },
      ),
    );
    view();
    const servers = await screen.findByRole('region', { name: 'Media servers' });
    const card = within(servers).getByRole('article', { name: 'Jellyfin' });
    expect(within(card).getByText('Rescans a file after a replace.')).toBeTruthy();
    expect(within(card).getByRole('listitem').textContent).toBe('Finish: Refresh in Jellyfin');
    expect(
      within(screen.getByRole('region', { name: 'Other' })).getByRole('article', {
        name: 'Example',
      }),
    ).toBeTruthy();
  });

  it('the official catalog install dialog has no custom-catalog warning', async () => {
    mocks.plugins.list.mockResolvedValue(listOf([]));
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Install Example 1.0.0' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install Example 1.0.0?' });
    expect(within(dialog).queryByText(CUSTOM_CATALOG_WARNING)).toBeNull();
  });

  it('after an install, focus moves to the new plugin row heading', async () => {
    mocks.plugins.list.mockResolvedValue(listOf([]));
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Install Example 1.0.0' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install Example 1.0.0?' });
    mocks.plugins.list.mockResolvedValue(listOf([plugin()]));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    await waitFor(() => row());
    const heading = within(row()).getByRole('heading', { name: 'Example', level: 3 });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('an install failure shows the reason inside the dialog and keeps it open', async () => {
    mocks.plugins.install.mockRejectedValue(installFailed('bundle has no plugin default export'));
    mocks.plugins.list.mockResolvedValue(listOf([]));
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Install Example 1.0.0' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install Example 1.0.0?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    const alert = await within(dialog).findByRole('alert');
    // Whose install failed, why (as a sentence), and what to do next.
    expect(alert.textContent).toBe(
      "Example didn't install: Bundle has no plugin default export. Its output is in the server log; try again once that is fixed.",
    );
    expect(screen.getByRole('dialog', { name: 'Install Example 1.0.0?' })).toBeTruthy();
  });

  it('an installed plugin reads Installed in the catalog, without Install', async () => {
    mocks.plugins.catalog.mockResolvedValue(catalogWith({ installed: '1.0.0' }));
    await open();
    const card = within(screen.getByRole('region', { name: 'Other' })).getByRole('article', {
      name: 'Example',
    });
    expect(within(card).getByText('Installed')).toBeTruthy();
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('a plugin with no version for this server has Install disabled with the reason', async () => {
    mocks.plugins.list.mockResolvedValue(listOf([]));
    mocks.plugins.catalog.mockResolvedValue(catalogWith({ latest: null }));
    view();
    const button = (await screen.findByRole('button', {
      name: 'Install example',
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText('Needs SDK ^2')).toBeTruthy();
  });

  it('a catalog that failed to load says so in plain words, keeps the raw reason as a tooltip and offers Try again', async () => {
    mocks.plugins.catalog.mockResolvedValue(
      catalogOutput({ error: 'catalog.json: unexpected token', plugins: [] }),
    );
    await open();
    const text = await screen.findByText(/^Couldn't load this catalog\./);
    expect(text.textContent).not.toContain('unexpected token');
    const alert = text.closest('[role="alert"]') as HTMLElement;
    expect(alert.getAttribute('title')).toBe('catalog.json: unexpected token');
    // An error is not an empty catalog.
    expect(screen.queryByText('The catalog lists no plugins.')).toBeNull();
    mocks.plugins.catalog.mockResolvedValue(catalogOutput());
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mocks.plugins.catalog).toHaveBeenCalledWith({ refresh: true }));
    await waitFor(() => expect(screen.queryByText(/^Couldn't load this catalog/)).toBeNull());
  });

  it('a failed catalog request is plain too, and the empty Installed text does not point at the catalog', async () => {
    mocks.plugins.list.mockResolvedValue(listOf([]));
    mocks.plugins.catalog.mockRejectedValue(new TypeError('Failed to fetch'));
    view();
    expect(await screen.findByText(/^Couldn't load the catalog\./)).toBeTruthy();
    expect(screen.queryByText(/Could not reach the server/)).toBeNull();
    expect(screen.queryByText(/Pick one from the catalog below/)).toBeNull();
    expect(
      screen.getByText(
        "No plugins installed. The catalog couldn't be loaded, so there is nothing to pick from yet.",
      ),
    ).toBeTruthy();
  });

  it('Refresh refetches with refresh: true and shows the answer', async () => {
    await open();
    mocks.plugins.catalog.mockResolvedValue(catalogOutput({ plugins: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh the catalog' }));
    await waitFor(() => expect(mocks.plugins.catalog).toHaveBeenCalledWith({ refresh: true }));
    expect(await screen.findByText('The catalog lists no plugins.')).toBeTruthy();
  });

  it('Catalog details is collapsed at the end and lists each catalog with its full address', async () => {
    await open();
    const d = details();
    expect(d.open).toBe(false);
    const sources = within(d).getByRole('list', { name: 'Catalogs' });
    expect(within(sources).getByText('https://catalog.test/index.json')).toBeTruthy();
    expect(within(sources).getByText('Signed with key official-1')).toBeTruthy();
    expect(
      within(d).getByText("Older versions can be installed from a plugin's settings."),
    ).toBeTruthy();
  });

  it('explains the signing key as a visible hint, not only in the placeholder', async () => {
    await open();
    const input = within(details()).getByLabelText('Signing key (id:hex)');
    const hint = document.getElementById(input.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toMatch(/64 hex characters/);
    expect(hint?.textContent).toMatch(/unsigned catalog/);
    expect(input.getAttribute('placeholder')).not.toMatch(/64 hex/);
  });

  it('adding a custom catalog shows the warning before the input and adds by URL; it can be removed again', async () => {
    await open();
    const form = within(details())
      .getByRole('heading', { name: 'Add a custom catalog' })
      .closest('form') as HTMLElement;
    const warning = within(form).getByText(CUSTOM_CATALOG_WARNING);
    const input = within(form).getByLabelText(/^Catalog URL/);
    expect(input.getAttribute('aria-required')).toBe('true');
    expect(document.querySelector(`label[for="${input.id}"] .required-mark`)).not.toBeNull();
    expect(warning.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Disabled until there is a URL, with the reason under it.
    const add = within(form).getByRole('button', { name: 'Add catalog' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.getAttribute('aria-describedby')).toBe(
      within(form).getByText('Enter the catalog URL').id,
    );
    expect(mocks.plugins.catalogsAdd).not.toHaveBeenCalled();

    const custom = {
      ...catalogOutput().catalogs[0],
      catalogUrl: 'https://mine.test/index.json',
      official: false,
      signed: false,
      keyIds: [],
    };
    mocks.plugins.catalogsAdd.mockResolvedValue({
      ...catalogOutput(),
      catalogs: [...catalogOutput().catalogs, custom],
    });
    fireEvent.change(input, { target: { value: 'https://mine.test/index.json' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add catalog' }));
    await waitFor(() =>
      expect(mocks.plugins.catalogsAdd).toHaveBeenCalledWith({
        url: 'https://mine.test/index.json',
      }),
    );
    expect(await within(details()).findByText('https://mine.test/index.json')).toBeTruthy();
    expect(screen.getByText('1 custom catalog')).toBeTruthy();
    // The custom catalog's install dialog does not claim a CI build.
    fireEvent.click(screen.getByRole('button', { name: 'Install Example 1.0.0 from mine.test' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install Example 1.0.0?' });
    expect(within(dialog).getByText('From a custom catalog', { selector: 'dd' })).toBeTruthy();
    expect(within(dialog).getByText('Unsigned', { selector: 'dd' })).toBeTruthy();
    expect(within(dialog).getByText(CUSTOM_CATALOG_WARNING)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    mocks.plugins.catalogsRemove.mockResolvedValue(catalogOutput());
    fireEvent.click(
      within(details()).getByRole('button', {
        name: 'Remove catalog https://mine.test/index.json',
      }),
    );
    await waitFor(() =>
      expect(mocks.plugins.catalogsRemove).toHaveBeenCalledWith({
        url: 'https://mine.test/index.json',
      }),
    );
    await waitFor(() =>
      expect(within(details()).queryByText('https://mine.test/index.json')).toBeNull(),
    );
  });

  it('a custom catalog added with a signing key is sent with it, and its dialog says signed and drops the warning', async () => {
    await open();
    const form = within(details())
      .getByRole('heading', { name: 'Add a custom catalog' })
      .closest('form') as HTMLElement;
    const key = `k1:${'ab'.repeat(32)}`;
    mocks.plugins.catalogsAdd.mockResolvedValue({
      ...catalogOutput(),
      catalogs: [
        ...catalogOutput().catalogs,
        {
          ...catalogOutput().catalogs[0],
          catalogUrl: 'https://signed.test/index.json',
          official: false,
          signed: true,
          keyIds: ['k1'],
        },
      ],
    });
    fireEvent.change(within(form).getByLabelText(/^Catalog URL/), {
      target: { value: 'https://signed.test/index.json' },
    });
    fireEvent.change(within(form).getByLabelText('Signing key (id:hex)'), {
      target: { value: ` ${key} ` },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Add catalog' }));
    await waitFor(() =>
      expect(mocks.plugins.catalogsAdd).toHaveBeenCalledWith({
        url: 'https://signed.test/index.json',
        signingKeys: key,
      }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Install Example 1.0.0 from signed.test' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Install Example 1.0.0?' });
    expect(within(dialog).getByText('From a custom catalog', { selector: 'dd' })).toBeTruthy();
    expect(within(dialog).getByText('Signed with key k1', { selector: 'dd' })).toBeTruthy();
    expect(within(dialog).queryByText(CUSTOM_CATALOG_WARNING)).toBeNull();
  });
});

describe('PluginsPage blocklist', () => {
  const blocked = { reason: 'Exfiltrates tokens', url: 'https://example.com/advisory/1' };

  it('an installed plugin the blocklist names shows the reason in an alert, with the advisory as a link', async () => {
    mocks.plugins.list.mockResolvedValue(
      listOf([
        plugin({ state: 'stopped', stateReason: 'blocklisted: Exfiltrates tokens', blocked }),
      ]),
    );
    await open();
    const alert = within(row()).getByRole('alert');
    expect(alert.textContent).toContain('Blocklisted: Exfiltrates tokens');
    expect(within(alert).getByRole('link', { name: 'Advisory' }).getAttribute('href')).toBe(
      'https://example.com/advisory/1',
    );
    expect(within(row()).getByText('Blocked')).toBeTruthy();
  });

  it('without an advisory url the alert has no link, and an unlisted plugin has no alert', async () => {
    mocks.plugins.list.mockResolvedValue(
      listOf([plugin({ blocked: { reason: 'Malware', url: null } })]),
    );
    await open();
    expect(within(row()).getByRole('alert').textContent).toBe('Blocklisted: Malware');
    expect(within(row()).queryByRole('link')).toBeNull();
    cleanup();
    mocks.plugins.list.mockResolvedValue(listOf([plugin()]));
    await open();
    expect(within(row()).queryByRole('alert')).toBeNull();
  });

  it('a link that is not a web link is not shown as one', async () => {
    mocks.plugins.list.mockResolvedValue(
      listOf([plugin({ blocked: { reason: 'Malware', url: 'javascript:alert(1)' } })]),
    );
    await open();
    expect(within(row()).queryByRole('link')).toBeNull();
  });

  it('a blocked latest version has Install disabled with the reason', async () => {
    const out = catalogOutput();
    const versions = out.catalogs[0]?.plugins[0]?.versions;
    if (!versions?.[0]) throw new Error('fixture has no versions');
    versions[0].blocked = blocked;
    mocks.plugins.list.mockResolvedValue(listOf([]));
    mocks.plugins.catalog.mockResolvedValue(out);
    view();
    const button = await screen.findByRole('button', { name: 'Install Example 1.0.0' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Blocklisted: Exfiltrates tokens')).toBeTruthy();
    fireEvent.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Catalog details says how many entries the blocklist has and when it was checked', async () => {
    const out = catalogOutput();
    out.blocklist.fetchedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    mocks.plugins.catalog.mockResolvedValue(out);
    await open();
    expect(
      await within(details()).findByText('Blocklist: 3 entries, checked 5 min ago'),
    ).toBeTruthy();
  });

  it('says so in plain words when the blocklist could not be read, with Try again', async () => {
    const out = catalogOutput();
    mocks.plugins.catalog.mockResolvedValue({
      ...out,
      blocklist: {
        url: out.blocklist.url,
        error: 'blocklist signature missing',
        fetchedAt: null,
        entries: 0,
      },
    });
    await open();
    const note = await screen.findByText(
      /^Couldn't check the blocklist, so Transcoda can't flag blocked plugins right now\./,
    );
    expect(note.textContent).not.toContain('signature missing');
    expect(note.getAttribute('title')).toBe('blocklist signature missing');
    // Nothing claims "0 blocked" when the list could not be read.
    expect(screen.queryByText('0 blocked')).toBeNull();
    mocks.plugins.catalog.mockClear();
    fireEvent.click(within(note).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mocks.plugins.catalog).toHaveBeenCalledWith({ refresh: true }));
  });
});
