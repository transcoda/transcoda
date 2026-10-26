import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: { plugins: {} }, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { catalogOutput } from '../test/fixtures/plugins.ts';
import { renderAt } from '../test/render.tsx';
import { CatalogGroups, catalogCards, compareVersions, matchesQuery } from './CatalogSection.tsx';
import type { CatalogView } from './usePlugins.ts';

type Entry = CatalogView['plugins'][number];

afterEach(cleanup);

const official = catalogOutput().catalogs[0] as CatalogView;
const base = official.plugins[0] as Entry;
function entry(over: Partial<Entry>): Entry {
  return { ...base, ...over };
}

/** The official catalog with Sonarr, Jellyfin (installed), ntfy and a plugin no group knows. */
function catalog(over: Partial<CatalogView> = {}): CatalogView {
  return {
    ...official,
    plugins: [
      entry({
        name: 'sonarr',
        title: 'Sonarr',
        description: "Sonarr plugin: reads a series' original language.",
        nodes: [
          { type: 'sonarr:original-language', kind: 'data', title: 'Original language' },
          { type: 'sonarr:rescan', kind: null, title: null },
        ],
      }),
      entry({ name: 'ntfy', title: 'ntfy', description: 'ntfy plugin: sends a push.' }),
      entry({ name: 'jellyfin', title: 'Jellyfin', installed: '1.0.0' }),
      entry({ name: 'example', title: 'Example' }),
    ],
    ...over,
  };
}

function show(catalogs: CatalogView[], onInstall = vi.fn(), query = '') {
  renderAt(
    '/plugins',
    <CatalogGroups groups={catalogCards(catalogs, query)} onInstall={onInstall} />,
  );
  return onInstall;
}

describe('compareVersions', () => {
  it('compares numerically, and a pre-release sorts before its release', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('2.0.0-beta.1', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0-beta.2', '2.0.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('2.0.0-alpha', '2.0.0-beta')).toBeLessThan(0);
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0);
  });
});

describe('catalogCards', () => {
  it('groups by purpose in page order, by title within a group, and leaves out empty groups', () => {
    const groups = catalogCards([catalog()], '');
    expect(groups.map((g) => [g.group.title, g.cards.map((c) => c.entry.name)])).toEqual([
      ['Media managers', ['sonarr']],
      ['Media servers', ['jellyfin']],
      ['Notifications', ['ntfy']],
      ['Other', ['example']],
    ]);
  });

  it('offers the latest version only, or none when no version runs here', () => {
    const [card] = catalogCards([catalog({ plugins: [base] })], '')[0]?.cards ?? [];
    expect(card?.version?.version).toBe('1.0.0');
    const none = catalogCards([catalog({ plugins: [entry({ latest: null })] })], '');
    expect(none[0]?.cards[0]?.version).toBeNull();
  });

  it('matches every word of the search in the title, name, description or node names', () => {
    const names = (query: string) =>
      catalogCards([catalog()], query).flatMap((g) => g.cards.map((c) => c.entry.name));
    expect(names('original LANGUAGE')).toEqual(['sonarr']);
    expect(names('push')).toEqual(['ntfy']);
    expect(names('nothing like it')).toEqual([]);
    expect(matchesQuery('', ['x'])).toBe(true);
  });
});

describe('CatalogGroups', () => {
  it('shows each group under its heading with the line beside it', () => {
    show([catalog()]);
    const section = screen.getByRole('region', { name: 'Media managers' });
    expect(within(section).getByText('Sonarr, Radarr and friends')).toBeTruthy();
    expect(within(section).getByRole('heading', { name: 'Sonarr', level: 3 })).toBeTruthy();
  });

  it('a card drops the "X plugin:" lead-in, and its chips name each node with its kind', () => {
    show([catalog()]);
    const card = screen.getByRole('article', { name: 'Sonarr' });
    expect(within(card).getByText("Reads a series' original language.")).toBeTruthy();
    const chips = within(card).getByRole('list', { name: 'Nodes Sonarr adds' });
    const items = within(chips).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['Data: Original language', 'Rescan']);
    expect(items[0]?.classList.contains('is-data')).toBe(true);
    // An older manifest has no kind: a neutral chip named by the node type.
    expect(items[1]?.className).toBe('node-chip');
  });

  it('Install is a secondary button on the card (the dialog holds the primary) and hands the build to the page', () => {
    const onInstall = show([catalog()]);
    const button = within(screen.getByRole('article', { name: 'Sonarr' })).getByRole('button', {
      name: 'Install Sonarr 1.0.0',
    });
    expect(button.className).toContain('btn-secondary');
    fireEvent.click(button);
    expect(onInstall).toHaveBeenCalledWith(
      expect.objectContaining({ version: expect.objectContaining({ version: '1.0.0' }) }),
      button,
    );
    // Older or newer versions are not offered here.
    expect(screen.queryByRole('button', { name: /2\.0\.0/ })).toBeNull();
  });

  it('an installed plugin says Installed instead of offering Install', () => {
    show([catalog()]);
    const card = screen.getByRole('article', { name: 'Jellyfin' });
    expect(within(card).getByText('Installed')).toBeTruthy();
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('without a version that runs here, Install is disabled and says why', () => {
    show([catalog({ plugins: [entry({ latest: null })] })]);
    const button = screen.getByRole('button', { name: 'Install example' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const reason = document.getElementById(button.getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toBe('Needs SDK ^2');
  });

  it("a custom catalog's card names where it comes from, in its Install label too", () => {
    show([
      catalog({ catalogUrl: 'https://mine.test/index.json', official: false, plugins: [base] }),
    ]);
    const card = screen.getByRole('article', { name: 'Example' });
    expect(within(card).getByText('mine.test')).toBeTruthy();
    expect(
      within(card).getByRole('button', { name: 'Install Example 1.0.0 from mine.test' }),
    ).toBeTruthy();
  });

  it("a plugin's own icon is an image from a data URL, never markup in the page", () => {
    const icon = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    show([catalog({ plugins: [entry({ icon })] })]);
    const card = screen.getByRole('article', { name: 'Example' });
    const img = card.querySelector('.plugin-tile img');
    expect(img?.getAttribute('src')).toBe(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(icon)}`,
    );
    expect(card.querySelector('script')).toBeNull();
    // One that cannot be encoded (a lone surrogate) falls back to the monogram, not a crash.
    cleanup();
    show([catalog({ plugins: [entry({ icon: '<svg>\ud800</svg>' })] })]);
    expect(document.querySelector('.plugin-tile')?.textContent).toBe('E');
    // Without one, the title's first letter.
    cleanup();
    show([catalog({ plugins: [base] })]);
    expect(document.querySelector('.plugin-tile')?.textContent).toBe('E');
  });
});
