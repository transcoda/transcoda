import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logout = vi.fn();
const appearance = vi.hoisted(() => ({
  current: { theme: 'system', serverName: null } as { theme: string; serverName: string | null },
}));
const jobsList = vi.hoisted(() => vi.fn());
const pluginsList = vi.hoisted(() => vi.fn());
vi.mock('../api/client.ts', () => ({
  api: {
    system: { health: vi.fn().mockResolvedValue({ status: 'ok', version: '1.2.3' }) },
    jobs: { list: jobsList, get: vi.fn() },
    plugins: { list: pluginsList },
    queue: {
      status: vi.fn().mockResolvedValue({
        paused: false,
        lanes: { encode: null, quick: null },
        preparing: [],
      }),
    },
  },
}));
vi.mock('../auth/useAuth.ts', () => ({
  useAuth: () => ({ user: { username: 'admin' }, logout, appearance: appearance.current }),
}));

import { setBeforeNavigate } from '../lib/navigation.tsx';
import { resetTmdbInstalled } from '../plugins/useTmdbInstalled.ts';
import { counts, fx } from '../test/fixtures/jobs.ts';
import { plugin } from '../test/fixtures/plugins.ts';
import { renderAt } from '../test/render.tsx';
import { Shell } from './Shell.tsx';

beforeEach(() => {
  resetTmdbInstalled();
  pluginsList.mockReset().mockResolvedValue({ plugins: [] });
  jobsList.mockReset().mockResolvedValue({ jobs: [], counts: counts() });
});
afterEach(() => {
  cleanup();
  logout.mockReset();
  appearance.current = { theme: 'system', serverName: null };
});

describe('Shell', () => {
  const NOTICE = 'This product uses the TMDB API but is not endorsed or certified by TMDB.';

  it('shows the TMDB notice when the tmdb plugin is installed', async () => {
    pluginsList.mockResolvedValue({ plugins: [plugin(), plugin({ name: 'tmdb' })] });
    render(<Shell>x</Shell>);
    expect(await screen.findByText(NOTICE)).toBeTruthy();
  });

  it('shows no TMDB notice in the rail (editor) layout', async () => {
    pluginsList.mockResolvedValue({ plugins: [plugin({ name: 'tmdb' })] });
    render(<Shell rail>x</Shell>);
    await waitFor(() => expect(pluginsList).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('asks for the plugin list once across Shells', async () => {
    const first = render(<Shell>x</Shell>);
    await screen.findByText('admin');
    await waitFor(() => expect(pluginsList).toHaveBeenCalledTimes(1));
    first.unmount();
    render(<Shell>x</Shell>);
    await screen.findByText('admin');
    expect(pluginsList).toHaveBeenCalledTimes(1);
  });

  it('shows no TMDB notice without the tmdb plugin, or when the list cannot be read', async () => {
    const view = render(<Shell>x</Shell>);
    await screen.findByText('admin');
    expect(pluginsList).toHaveBeenCalled();
    expect(screen.queryByText(NOTICE)).toBeNull();
    view.unmount();
    pluginsList.mockRejectedValue(new Error('down'));
    render(<Shell>x</Shell>);
    await screen.findByText('admin');
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('shows username and nav, and no version (it lives in About and on the login page)', async () => {
    render(
      <Shell>
        <p>content</p>
      </Shell>,
    );
    expect(await screen.findByText('admin')).toBeTruthy();
    expect(screen.queryByText('v1.2.3')).toBeNull();
    expect(screen.getByText('admin')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Workflows' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByText('content')).toBeTruthy();
  });

  it('has one Settings item (API tokens live inside it); Jobs is a link', () => {
    render(<Shell>x</Shell>);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByText('API tokens')).toBeNull();
    expect(nav.textContent).not.toContain('later');
    expect(within(nav).getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe(
      '/settings',
    );
    expect(within(nav).getByRole('link', { name: 'Jobs' }).getAttribute('href')).toBe('/jobs');
  });

  it('starts with a skip link to the main content, in both layouts', () => {
    for (const rail of [false, true]) {
      const { container } = render(<Shell rail={rail}>x</Shell>);
      const skip = container.querySelector('a.skip-link') as HTMLAnchorElement;
      expect(skip.textContent).toBe('Skip to content');
      expect(skip.getAttribute('href')).toBe('#main-content');
      const main = container.querySelector('main') as HTMLElement;
      expect(main.id).toBe('main-content');
      expect(main.getAttribute('tabindex')).toBe('-1');
      // It is the first thing a keyboard reaches.
      expect(container.querySelector('.shell')?.firstElementChild).toBe(skip);
      cleanup();
    }
  });

  it('Plugins is a link now, not a coming-in-M3 item', () => {
    render(<Shell>x</Shell>);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Plugins' }).getAttribute('href')).toBe(
      '/plugins',
    );
    expect(nav.textContent).not.toContain('coming in M3');
  });

  it('Shell shows the running count on the Jobs nav item', async () => {
    jobsList.mockResolvedValue({
      jobs: [],
      counts: counts({ encoding: 1, verifying: 1, queued: 37, failed: 4 }),
    });
    render(<Shell>x</Shell>);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const jobs = await within(nav).findByRole('link', { name: 'Jobs, 2 running' });
    expect(jobs.querySelector('.nav-count')?.textContent).toBe('2');
    expect(jobsList).toHaveBeenCalledWith({ limit: 1 });
  });

  describe('activity widget (#9)', () => {
    const busy = () =>
      jobsList.mockResolvedValue({
        jobs: [fx.running],
        counts: counts({ encoding: 1, queued: 3 }),
      });

    it('sits in the top bar left of the user while a job runs', async () => {
      busy();
      const { container } = render(<Shell>x</Shell>);
      const button = await screen.findByRole('button', { name: /^Activity: encoding 1 job/ });
      const end = container.querySelector('.topbar-end') as HTMLElement;
      const activity = button.closest('.activity') as HTMLElement;
      expect(activity.parentElement).toBe(end);
      expect(activity.nextElementSibling).toBe(end.querySelector('.user'));
    });

    it('is absent when nothing runs or waits', async () => {
      render(<Shell>x</Shell>);
      await screen.findByText('admin');
      // The widget's own list (the running states) has answered.
      await waitFor(() =>
        expect(jobsList.mock.calls.some(([input]) => input && 'state' in input)).toBe(true),
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByRole('button', { name: /^Activity/ })).toBeNull();
    });

    it('is absent in the rail (the editor has no top bar)', async () => {
      busy();
      render(<Shell rail>x</Shell>);
      await waitFor(() => expect(jobsList).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByRole('button', { name: /^Activity/ })).toBeNull();
    });
  });

  it('Shell links Libraries', () => {
    renderAt('/libraries', <Shell>x</Shell>);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const link = within(nav).getByRole('link', { name: 'Libraries' });
    expect(link.getAttribute('href')).toBe('/libraries');
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(within(nav).queryByText('M3.5')).toBeNull();
  });

  it('shows an error when logout fails, without an unhandled rejection', async () => {
    logout.mockRejectedValue(new Error('boom'));
    render(<Shell>x</Shell>);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/couldn't sign out/i);
  });

  it('calls logout', async () => {
    logout.mockResolvedValue(undefined);
    render(<Shell>x</Shell>);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(logout).toHaveBeenCalled());
  });

  it('rail mode (the editor): no top bar, icon nav with names and tooltips, home and log out', async () => {
    logout.mockResolvedValue(undefined);
    const { container } = render(<Shell rail>x</Shell>);
    expect(container.querySelector('.topbar')).toBeNull();
    expect(screen.queryByText('v1.2.3')).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const workflows = within(nav).getByRole('link', { name: 'Workflows' });
    expect(workflows.getAttribute('title')).toBe('Workflows');
    expect(within(nav).getByRole('link', { name: 'Settings' }).getAttribute('title')).toBe(
      'Settings',
    );
    expect(within(nav).getByRole('link', { name: 'Transcoda home' }).getAttribute('href')).toBe(
      '/',
    );
    expect(within(nav).getByRole('link', { name: 'Jobs' }).getAttribute('title')).toBe('Jobs');
    fireEvent.click(within(nav).getByRole('button', { name: 'Sign out admin' }));
    await waitFor(() => expect(logout).toHaveBeenCalled());
  });

  it('Settings is the current nav item on every settings section', () => {
    for (const path of ['/settings', '/settings/about', '/settings/api-tokens']) {
      renderAt(path, <Shell>x</Shell>);
      const nav = screen.getByRole('navigation', { name: 'Main' });
      expect(within(nav).getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe(
        'page',
      );
      cleanup();
    }
  });

  it('shows the server name after the brand when one is set', async () => {
    appearance.current = { theme: 'system', serverName: 'Basement' };
    const { container } = render(<Shell>x</Shell>);
    await screen.findByText('admin');
    const name = container.querySelector('.topbar .server-name') as HTMLElement;
    expect(name.textContent).toBe('Basement');
    expect(container.querySelector('.topbar .brand')?.nextElementSibling).toBe(name);
  });

  it('shows no server name when none is set', async () => {
    const { container } = render(<Shell>x</Shell>);
    await screen.findByText('admin');
    expect(container.querySelector('.server-name')).toBeNull();
  });

  it('Workflows stays the current nav item inside a workflow', () => {
    renderAt('/workflows/abc', <Shell rail>x</Shell>);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Workflows' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe(
      null,
    );
  });

  it('every nav link, the rail mark and the brand go through the leave guard', () => {
    const asked: string[] = [];
    const release = setBeforeNavigate((target) => {
      asked.push('to' in target ? target.to : 'run');
      return false;
    });
    try {
      for (const rail of [true, false]) {
        const view = renderAt('/workflows/abc', <Shell rail={rail}>x</Shell>);
        const nav = screen.getByRole('navigation', { name: 'Main' });
        fireEvent.click(within(nav).getByRole('link', { name: 'Workflows' }));
        fireEvent.click(within(nav).getByRole('link', { name: 'Settings' }));
        fireEvent.click(
          rail
            ? within(nav).getByRole('link', { name: 'Transcoda home' })
            : (view.container.querySelector('.brand') as HTMLElement),
        );
        expect(view.location()).toBe('/workflows/abc');
        cleanup();
      }
    } finally {
      release();
    }
    expect(asked).toEqual(['/', '/settings', '/', '/', '/settings', '/']);
  });

  it('Sign out (top bar and rail) asks the leave guard first; a held log out runs only when let go', async () => {
    logout.mockResolvedValue(undefined);
    const held: Array<() => void> = [];
    const release = setBeforeNavigate((target) => {
      if ('run' in target) held.push(target.run);
      return false;
    });
    try {
      for (const rail of [false, true]) {
        render(<Shell rail={rail}>x</Shell>);
        fireEvent.click(screen.getByRole('button', { name: rail ? 'Sign out admin' : 'Sign out' }));
        cleanup();
      }
      await Promise.resolve();
      expect(logout).not.toHaveBeenCalled();
      expect(held).toHaveLength(2);
      held[0]?.();
      await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    } finally {
      release();
    }
  });

  describe('phone (below 640 px): one shell header with a drawer on every page', () => {
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

    it('shows the brand and a Menu button that opens and closes the navigation drawer', () => {
      const { container } = render(<Shell>x</Shell>);
      const header = container.querySelector('header.topbar') as HTMLElement;
      expect(within(header).getByRole('link', { name: /transcoda/i })).toBeTruthy();
      const menu = within(header).getByRole('button', { name: 'Menu' });
      expect(menu.getAttribute('aria-controls')).toBe('main-nav');
      expect(menu.getAttribute('aria-expanded')).toBe('false');
      const nav = screen.getByRole('navigation', { name: 'Main' });
      expect(nav.getAttribute('data-open')).toBeNull();
      fireEvent.click(menu);
      expect(menu.getAttribute('aria-expanded')).toBe('true');
      expect(nav.getAttribute('data-open')).toBe('true');
      fireEvent.click(menu);
      expect(menu.getAttribute('aria-expanded')).toBe('false');
    });

    it('the editor (rail) gets the phone header and drawer too, never the icon rail (P1)', () => {
      const { container } = render(<Shell rail>x</Shell>);
      expect(container.querySelector('.shell.is-rail')).toBeNull();
      expect(container.querySelector('.sidenav.rail')).toBeNull();
      const header = container.querySelector('header.topbar') as HTMLElement;
      expect(within(header).getByRole('button', { name: 'Menu' })).toBeTruthy();
    });

    it('closes on Escape (focus back on Menu) and when a destination is chosen', () => {
      renderAt('/jobs', <Shell>x</Shell>);
      const menu = screen.getByRole('button', { name: 'Menu' });
      const nav = screen.getByRole('navigation', { name: 'Main' });
      fireEvent.click(menu);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(menu.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(menu);
      fireEvent.click(menu);
      fireEvent.click(within(nav).getByRole('link', { name: 'Libraries' }));
      expect(menu.getAttribute('aria-expanded')).toBe('false');
    });

    it('puts the activity count before the Menu button', async () => {
      jobsList.mockResolvedValue({
        jobs: [fx.running],
        counts: counts({ encoding: 1, queued: 3 }),
      });
      const { container } = render(<Shell>x</Shell>);
      const button = await screen.findByRole('button', { name: /^Activity: encoding 1 job/ });
      expect(button.querySelector('.activity-count')?.textContent).toBe('4');
      const header = container.querySelector('header.topbar') as HTMLElement;
      expect(button.closest('.activity')?.parentElement).toBe(header);
      expect(button.closest('.activity')?.nextElementSibling).toBe(
        within(header).getByRole('button', { name: 'Menu' }),
      );
    });

    it('leaves the server name out of the phone header', async () => {
      appearance.current = { theme: 'system', serverName: 'Basement' };
      const { container } = render(<Shell>x</Shell>);
      await screen.findByText('admin');
      expect(container.querySelector('.server-name')).toBeNull();
    });

    it('keeps one Sign out, with the user name, inside the drawer', async () => {
      logout.mockResolvedValue(undefined);
      render(<Shell>x</Shell>);
      const nav = screen.getByRole('navigation', { name: 'Main' });
      expect(screen.getAllByRole('button', { name: 'Sign out' })).toHaveLength(1);
      expect(within(nav).getByText('admin')).toBeTruthy();
      fireEvent.click(within(nav).getByRole('button', { name: 'Sign out' }));
      await waitFor(() => expect(logout).toHaveBeenCalled());
    });
  });

  it('wide windows have no Menu button', () => {
    render(<Shell>x</Shell>);
    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
  });
});
