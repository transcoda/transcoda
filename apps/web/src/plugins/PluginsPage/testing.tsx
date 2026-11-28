// Shared setup for the plugins page tests: fixtures, the default mocked answers, render helpers.
import { ORPCError } from '@orpc/client';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { PluginSummary } from '@transcoda/contract';
import { afterEach, beforeEach, type Mock, vi } from 'vitest';
import { resetCatalogCache } from '../../hooks/use-catalog.ts';
import { EventsProvider } from '../../hooks/use-events.ts';
import { fakeEventSource } from '../../testing/fake-event-stream.ts';
import { catalogOutput, plugin, pluginDetail } from '../../testing/fixtures/plugins.ts';
import { renderAt } from '../../testing/render.tsx';
import { PluginsPage } from './PluginsPage.tsx';

/** The mocked client each plugins page test file declares with vi.hoisted. */
export interface PluginsPageMocks {
  plugins: Record<
    | 'list'
    | 'catalog'
    | 'get'
    | 'install'
    | 'update'
    | 'updateCheck'
    | 'remove'
    | 'enable'
    | 'disable'
    | 'restart'
    | 'catalogsAdd'
    | 'catalogsRemove'
    | 'settingsGet'
    | 'settingsSave'
    | 'settingsTest',
    Mock
  >;
  nodes: { list: Mock };
  events: { subscribe: Mock };
}

let mocks: PluginsPageMocks;

export let fake: ReturnType<typeof fakeEventSource>;

/** A node of the server's node list, as nodes.list answers it. */
export function nodeInfo(
  type: string,
  kind: string,
  title: string,
  finishPhase: string | null = null,
) {
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

export const listOf = (plugins: PluginSummary[], missing: unknown[] = []) => ({ plugins, missing });

export function view(): ReturnType<typeof renderAt> {
  return renderAt(
    '/plugins',
    <EventsProvider>
      <PluginsPage />
    </EventsProvider>,
  );
}

/** The page with the example plugin installed and listed under its catalog title. */
export async function open(): Promise<ReturnType<typeof renderAt>> {
  const v = view();
  await waitFor(() => row());
  return v;
}

export const installed = () => screen.getByRole('region', { name: /^Installed ?[0-9,]*$/ });
/** An installed row: titled from the catalog ("Example"), or by name while no catalog lists it. */
export const row = (title: string | RegExp = /^example$/i) =>
  within(installed()).getByRole('article', { name: title });
export const details = () =>
  screen.getByText('Catalog details').closest('details') as HTMLDetailsElement;

/** Opens a row's settings; returns the row. */
export function openSettings(title = 'Example') {
  const r = row(title);
  fireEvent.click(within(r).getByRole('button', { name: `${title} settings` }));
  return r;
}

export function installFailed(reason: string) {
  return new ORPCError('PLUGIN_INSTALL_FAILED', {
    defined: true,
    status: 422,
    message: 'The plugin could not be installed',
    data: { reason },
  });
}

/** The official catalog with these entries (each based on the fixture's example entry). */
export function catalogWith(...entries: Record<string, unknown>[]) {
  const out = catalogOutput();
  const c = out.catalogs[0];
  const base = c?.plugins[0];
  if (!c || !base) throw new Error('fixture has no entry');
  c.plugins = entries.map((e) => ({ ...base, ...e }) as typeof base);
  return out;
}

/**
 * Registers the default answers of the mocked client before each test and the clean-up after
 * it. Each test file declares `mocks` (vi.hoisted) and mocks the client itself.
 */
export function setupPluginsPageMocks(m: PluginsPageMocks) {
  mocks = m;
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
    vi.useRealTimers();
  });
}
