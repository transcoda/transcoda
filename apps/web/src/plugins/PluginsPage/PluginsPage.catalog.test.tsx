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

import { catalogOutput, plugin } from '../../testing/fixtures/plugins.ts';
import {
  CUSTOM_CATALOG_WARNING,
  NETWORK_NONE,
  NETWORK_NOTE,
  NETWORK_UNLISTED,
} from './plugin-text.ts';
import {
  catalogWith,
  details,
  installFailed,
  listOf,
  open,
  row,
  setupPluginsPageMocks,
  view,
} from './testing.tsx';

setupPluginsPageMocks(mocks);
afterEach(cleanup);

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
    // What it does first, in the catalog's words.
    expect(within(dialog).getByText('Shouts at your files.')).toBeTruthy();
    expect(fact('Source')).toBe('Official catalog, built from public source');
    expect(fact('Signature')).toBe('Signed with key official-1');
    // The whole checksum, with a way to copy it.
    expect(fact('Checksum (SHA-256)')).toBe(`${'abcdef0123456789'.repeat(4)}Copy`);
    expect(within(facts).getByRole('button', { name: 'Copy the checksum' })).toBeTruthy();
    expect(dialog.textContent).not.toContain(' · ');
    // Where it may connect, with what that promises, before the promise itself.
    const hosts = within(dialog).getByRole('list', { name: 'Connects to' });
    expect(
      within(hosts)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['The Example URL you enter in its settings']);
    expect(within(dialog).getByText(NETWORK_NOTE)).toBeTruthy();
    const link = within(dialog).getByRole('link', { name: /View on GitHub/ });
    expect(link.getAttribute('href')).toBe('https://github.com/transcoda/plugins/attestations/1');
    // Focus starts on Cancel, so the tooltip is not open when the dialog opens.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    const tip = within(facts).getByRole('button', { name: 'What is a build proof?' });
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

  it('the install dialog lists fixed hosts by name, says when a plugin connects nowhere, and when its build predates the list', async () => {
    const withNetwork = (network: unknown) => {
      const out = catalogOutput();
      const v = out.catalogs[0]?.plugins[0]?.versions[0];
      if (!v) throw new Error('fixture has no version');
      v.network = network as typeof v.network;
      return out;
    };
    const hostsIn = async (network: unknown) => {
      cleanup();
      mocks.plugins.list.mockResolvedValue(listOf([]));
      mocks.plugins.catalog.mockResolvedValue(withNetwork(network));
      view();
      fireEvent.click(await screen.findByRole('button', { name: 'Install Example 1.0.0' }));
      return screen.findByRole('dialog', { name: 'Install Example 1.0.0?' });
    };

    let dialog = await hostsIn([
      { origin: 'https://discord.com' },
      { origin: 'http://ntfy.example.com' },
    ]);
    const hosts = within(dialog).getByRole('list', { name: 'Connects to' });
    expect(
      within(hosts)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['discord.com', 'http://ntfy.example.com']);
    dialog = await hostsIn([]);
    expect(
      within(within(dialog).getByRole('list', { name: 'Connects to' })).getByRole('listitem')
        .textContent,
    ).toBe(NETWORK_NONE);
    expect(within(dialog).getByText(NETWORK_NOTE)).toBeTruthy();
    dialog = await hostsIn(null);
    expect(within(dialog).queryByRole('list', { name: 'Connects to' })).toBeNull();
    expect(within(dialog).getByText(NETWORK_UNLISTED)).toBeTruthy();
    expect(within(dialog).queryByText(NETWORK_NOTE)).toBeNull();
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
      "Example didn't install: Bundle has no plugin default export. See the server log (opens in a new tab) or try again.",
    );
    // The next step links to where the server log is and how to read it.
    const log = within(alert).getByRole('link', { name: /^server log/ });
    expect(log.getAttribute('href')).toBe(
      'https://github.com/transcoda/transcoda/blob/main/docs/plugins.md#server-log',
    );
    expect(log.getAttribute('target')).toBe('_blank');
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
      name: 'Install Example',
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
    expect(within(dialog).getByText('A custom catalog', { selector: 'dd' })).toBeTruthy();
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
    expect(within(dialog).getByText('A custom catalog', { selector: 'dd' })).toBeTruthy();
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
