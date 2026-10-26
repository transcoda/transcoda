import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sections.ts', () => ({
  SETTINGS_SECTIONS: [
    { id: 'api-tokens', title: 'API tokens', icon: 'key', Component: () => <p>tokens body</p> },
    {
      id: 'about',
      title: 'About',
      icon: 'info',
      Component: () => <p>about body</p>,
      subs: [
        { id: 'licences', title: 'Open-source licences', Component: () => <p>licences body</p> },
      ],
    },
  ],
}));

import { renderAt } from '../../test/render.tsx';
import { SettingsPage } from './SettingsPage.tsx';

afterEach(cleanup);

describe('SettingsPage (desktop)', () => {
  it('has a Settings h1, a sub-nav of the sections and the current one as h2', () => {
    renderAt('/settings/about', <SettingsPage section="about" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['API tokens', 'About']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/settings/api-tokens',
      '/settings/about',
    ]);
    expect(within(nav).getByRole('link', { name: 'About' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      within(nav).getByRole('link', { name: 'API tokens' }).getAttribute('aria-current'),
    ).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'About' })).toBeTruthy();
    expect(screen.getByText('about body')).toBeTruthy();
    expect(screen.queryByText('tokens body')).toBeNull();
  });

  it('/settings goes to the first section, replacing the entry', () => {
    const view = renderAt('/settings', <SettingsPage />);
    expect(view.location()).toBe('/settings/api-tokens');
  });

  it('an unknown section shows Page not found with a way back to /settings', () => {
    const view = renderAt('/settings/nope', <SettingsPage section="nope" />);
    expect(view.location()).toBe('/settings/nope');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to settings' })).toBeTruthy();
  });

  it('a sub-page shows its own h2 and keeps its section current in the sub-nav', () => {
    renderAt('/settings/about/licences', <SettingsPage section="about" sub="licences" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Open-source licences' })).toBeTruthy();
    expect(screen.getByText('licences body')).toBeTruthy();
    expect(screen.queryByText('about body')).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    const about = within(nav).getByRole('link', { name: 'About' });
    expect(about.classList.contains('is-active')).toBe(true);
    // The section is current, but the page is its sub-page.
    expect(about.getAttribute('aria-current')).toBe('true');
  });

  it('an unknown sub-page goes back to its section', () => {
    const view = renderAt('/settings/about/nope', <SettingsPage section="about" sub="nope" />);
    expect(view.location()).toBe('/settings/about');
  });

  it('a section without sub-pages refuses one', () => {
    const view = renderAt('/settings/api-tokens/x', <SettingsPage section="api-tokens" sub="x" />);
    expect(view.location()).toBe('/settings/api-tokens');
  });
});

describe('SettingsPage (phone)', () => {
  const realMatchMedia = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = (query: string) =>
      ({
        matches: query === '(max-width: 639px)',
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  });
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it('/settings is a list of the sections', () => {
    const view = renderAt('/settings', <SettingsPage />);
    expect(view.location()).toBe('/settings');
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Settings' });
    const links = within(list).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/settings/api-tokens',
      '/settings/about',
    ]);
    expect(links.map((a) => a.textContent)).toEqual(['API tokens', 'About']);
    expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull();
  });

  it('a section has a back link to the list above its h2, and no sub-nav', () => {
    renderAt('/settings/about', <SettingsPage section="about" />);
    const back = screen.getByRole('link', { name: 'Settings' });
    expect(back.getAttribute('href')).toBe('/settings');
    expect(back.textContent).toContain('‹');
    const h2 = screen.getByRole('heading', { level: 2, name: 'About' });
    expect(back.compareDocumentPosition(h2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull();
    expect(screen.getByText('about body')).toBeTruthy();
  });

  it('a sub-page has a back link to its section', () => {
    renderAt('/settings/about/licences', <SettingsPage section="about" sub="licences" />);
    const back = screen.getByRole('link', { name: 'About' });
    expect(back.getAttribute('href')).toBe('/settings/about');
    expect(screen.getByRole('heading', { level: 2, name: 'Open-source licences' })).toBeTruthy();
  });
});
