import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { catalogOutput, plugin, pluginDetail } from '../../testing/fixtures/plugins.ts';
import { renderAt } from '../../testing/render.tsx';
import { PluginsPage, updateAllSummary } from './PluginsPage.tsx';
import { catalogWith, listOf, setupPluginsPageMocks, view } from './testing.tsx';

setupPluginsPageMocks(mocks);
afterEach(cleanup);

describe('PluginsPage updates', () => {
  const NONE = { wouldBreak: [], needsReview: [], unknown: false };
  const three = () =>
    listOf([
      plugin({ name: 'sonarr', updateAvailable: '2.0.0' }),
      plugin({ name: 'radarr', updateAvailable: '3.0.0' }),
      plugin({ name: 'jellyfin', updateAvailable: '4.0.0' }),
    ]);
  const updatesRegion = () => screen.findByRole('region', { name: /^Updates ?[0-9,]*$/ });

  it('?show=updates opens the Updates tab', async () => {
    mocks.plugins.list.mockResolvedValue(three());
    renderAt(
      '/plugins?show=updates',
      <EventsProvider>
        <PluginsPage />
      </EventsProvider>,
    );
    const show = screen.getByRole('radiogroup', { name: 'Show' });
    expect(
      within(show)
        .getByRole('radio', { name: /^Updates/ })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      await within(await updatesRegion()).findByRole('article', { name: 'sonarr' }),
    ).toBeTruthy();
  });

  it('Update all shows only with 2 or more updates, and only on the Updates tab', async () => {
    mocks.plugins.list.mockResolvedValue(
      listOf([plugin({ updateAvailable: '1.1.0' }), plugin({ name: 'other' })]),
    );
    const v = renderAt(
      '/plugins?show=updates',
      <EventsProvider>
        <PluginsPage />
      </EventsProvider>,
    );
    await within(await updatesRegion()).findByRole('article', { name: 'Example' });
    expect(screen.queryByRole('button', { name: 'Update all' })).toBeNull();
    v.unmount();
    // On the All tab, three updates show no Update all.
    mocks.plugins.list.mockResolvedValue(three());
    view();
    await screen.findByRole('article', { name: 'sonarr' });
    expect(screen.queryByRole('button', { name: 'Update all' })).toBeNull();
  });

  it('Update all waits for the catalogs, which say whether an update adds a host', async () => {
    mocks.plugins.list.mockResolvedValue(three());
    mocks.plugins.catalog.mockReturnValue(new Promise(() => {}));
    renderAt(
      '/plugins?show=updates',
      <EventsProvider>
        <PluginsPage />
      </EventsProvider>,
    );
    const button = await screen.findByRole('button', { name: 'Update all' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.plugins.updateCheck).not.toHaveBeenCalled();
  });

  it('Update all updates one after another, skips one that touches a workflow and names it at the end', async () => {
    mocks.plugins.list.mockResolvedValue(three());
    mocks.plugins.updateCheck.mockImplementation(async ({ name }: { name: string }) =>
      name === 'radarr'
        ? {
            ...NONE,
            wouldBreak: [{ id: 'w', name: 'TV', active: true, version: 2, reason: 'dropped' }],
          }
        : NONE,
    );
    let inFlight = 0;
    let most = 0;
    const done: string[] = [];
    const releases: Array<() => void> = [];
    mocks.plugins.update.mockImplementation(async ({ name }: { name: string }) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise<void>((r) => releases.push(r));
      inFlight -= 1;
      done.push(name);
      return pluginDetail({ name });
    });
    renderAt(
      '/plugins?show=updates',
      <EventsProvider>
        <PluginsPage />
      </EventsProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Update all' }));
    const running = await screen.findByRole('button', { name: 'Updating 1 of 3…' });
    expect((running as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(releases).toHaveLength(1));
    releases[0]?.();
    // radarr is checked and skipped; jellyfin's update starts only after sonarr's finished.
    await screen.findByRole('button', { name: 'Updating 3 of 3…' });
    await waitFor(() => expect(releases).toHaveLength(2));
    releases[1]?.();
    const summary = await screen.findByText(
      'Updated 2; radarr needs a look: it changes a node your workflows use.',
    );
    expect(summary.closest('[role="status"]')).toBeTruthy();
    expect(most).toBe(1);
    expect(done).toEqual(['sonarr', 'jellyfin']);
    expect(mocks.plugins.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'radarr' }),
    );
    expect(mocks.plugins.updateCheck.mock.calls.map(([i]) => i)).toEqual([
      { name: 'sonarr', version: '2.0.0' },
      { name: 'radarr', version: '3.0.0' },
      { name: 'jellyfin', version: '4.0.0' },
    ]);
  });

  it('Update all skips a plugin whose new version connects to a new host and names it', async () => {
    mocks.plugins.list.mockResolvedValue(three());
    const sonarrUrl = { setting: 'url', label: 'Sonarr URL' };
    const version = (v: string, network: unknown) => ({
      ...catalogOutput().catalogs[0]?.plugins[0]?.versions[0],
      version: v,
      network,
    });
    mocks.plugins.catalog.mockResolvedValue(
      catalogWith(
        {
          name: 'sonarr',
          title: 'sonarr',
          installed: '1.0.0',
          latest: '2.0.0',
          versions: [
            version('1.0.0', [sonarrUrl]),
            version('2.0.0', [sonarrUrl, { origin: 'https://api.example.test' }]),
          ],
        },
        { name: 'radarr', title: 'radarr', installed: '1.0.0', latest: '3.0.0' },
        { name: 'jellyfin', title: 'jellyfin', installed: '1.0.0', latest: '4.0.0' },
      ),
    );
    renderAt(
      '/plugins?show=updates',
      <EventsProvider>
        <PluginsPage />
      </EventsProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Update all' }));
    expect(
      await screen.findByText('Updated 2; sonarr needs a look: it connects to a new host.'),
    ).toBeTruthy();
    expect(mocks.plugins.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'sonarr' }),
    );
  });

  it('Update all with nothing to look at ends with a toast', async () => {
    mocks.plugins.list.mockResolvedValue(three());
    renderAt(
      '/plugins?show=updates',
      <EventsProvider>
        <PluginsPage />
      </EventsProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Update all' }));
    expect(await screen.findByText('Updated 3 plugins')).toBeTruthy();
    expect(mocks.plugins.update).toHaveBeenCalledTimes(3);
  });
});

describe('updateAllSummary', () => {
  it('groups what needs a look and names failures', () => {
    expect(
      updateAllSummary({
        updated: 0,
        changes: ['Sonarr', 'Radarr'],
        unchecked: ['ntfy'],
        hosts: ['Discord', 'Seerr'],
        failed: [{ title: 'Jellyfin', reason: 'offline' }],
      }),
    ).toBe(
      "Nothing updated; Sonarr and Radarr need a look: they change nodes your workflows use; ntfy needs a look: it can't be checked against your workflows; Discord and Seerr need a look: they connect to new hosts; Jellyfin failed: offline.",
    );
    expect(
      updateAllSummary({ updated: 2, changes: [], unchecked: [], hosts: [], failed: [] }),
    ).toBeNull();
  });
});
