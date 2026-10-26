import { ORPCError } from '@orpc/client';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostGuardInterceptor } from './api/host-guard.ts';

const mocks = vi.hoisted(() => ({ me: vi.fn(), health: vi.fn(), subscribe: vi.fn() }));
vi.mock('./api/client.ts', () => ({
  api: {
    auth: { me: mocks.me },
    system: { health: mocks.health },
    events: { subscribe: mocks.subscribe },
    // The shell's activity widget (#9): no answer, so it stays hidden.
    queue: { status: () => new Promise(() => {}) },
    jobs: { list: () => new Promise(() => {}) },
  },
  isDefinedError: () => false,
  safe: async (p: Promise<unknown>) => {
    try {
      return [null, await p];
    } catch (e) {
      return [e, undefined];
    }
  },
}));

vi.mock('./pages/WorkflowsPage.tsx', () => ({ WorkflowsPage: () => <p>workflows page</p> }));
vi.mock('./pages/NewWorkflowPage.tsx', () => ({ NewWorkflowPage: () => <p>new workflow page</p> }));
vi.mock('./pages/EditorPage.tsx', () => ({ EditorPage: () => <p>editor page</p> }));
vi.mock('./pages/LibrariesPage.tsx', () => ({ LibrariesPage: () => <p>libraries page</p> }));
vi.mock('./pages/settings/TokensSection.tsx', () => ({
  TokensSection: () => <p>tokens section</p>,
}));
vi.mock('./pages/settings/AboutSection.tsx', () => ({ AboutSection: () => <p>about section</p> }));
vi.mock('./pages/settings/LicencesSection.tsx', () => ({
  LicencesSection: () => <p>licences section</p>,
}));
vi.mock('./pages/settings/GeneralSection.tsx', () => ({
  GeneralSection: () => <p>general section</p>,
}));
vi.mock('./pages/settings/QueueSection.tsx', () => ({ QueueSection: () => <p>queue section</p> }));
vi.mock('./pages/settings/RecycleSection.tsx', () => ({
  RecycleSection: () => <p>recycle section</p>,
}));
vi.mock('./pages/settings/PluginsSection.tsx', () => ({
  PluginsSection: () => <p>plugins section</p>,
}));
vi.mock('./pages/settings/AccountSection.tsx', () => ({
  AccountSection: () => <p>account section</p>,
}));

import { navigate } from 'wouter/use-browser-location';
import { App } from './App.tsx';
import { AuthProvider } from './auth/AuthProvider.tsx';

const appearance = { theme: 'system', serverName: null };

const hostError = () =>
  new ORPCError('HOST_NOT_ALLOWED', {
    defined: true,
    status: 403,
    message: 'Host not allowed',
    data: { host: 'media.example.com' },
  });

function renderApp() {
  return render(
    <AuthProvider>
      <App />
    </AuthProvider>,
  );
}

beforeEach(() => {
  mocks.me.mockReset();
  mocks.health.mockReset().mockResolvedValue({ status: 'ok', version: '0.0.0' });
  mocks.subscribe.mockReset().mockReturnValue(new Promise(() => {}));
});
afterEach(cleanup);

describe('App', () => {
  it('shows a styled loading status while the session is checked', () => {
    mocks.me.mockReturnValue(new Promise(() => {}));
    renderApp();
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Loading…');
    // The shared Loading (L12), filling the screen before any page can render.
    expect(status.className).toBe('loading');
    expect(status.closest('main')?.className).toBe('app-loading');
  });

  it('shows the host-not-allowed screen when auth.me fails with HOST_NOT_ALLOWED', async () => {
    mocks.me.mockRejectedValue(hostError());
    mocks.health.mockRejectedValue(hostError());
    renderApp();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      "This host name isn't allowed: media.example.com. Add it to TRANSCODA_ALLOWED_HOSTS.",
    );
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('switches to the host-not-allowed screen when any later call is rejected', async () => {
    mocks.me.mockResolvedValue({ setupRequired: false, user: null, csrfToken: null, appearance });
    renderApp();
    expect(await screen.findByLabelText('Password')).toBeTruthy();
    await act(async () => {
      await expect(
        hostGuardInterceptor({ next: () => Promise.reject(hostError()) }),
      ).rejects.toBeInstanceOf(ORPCError);
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /isn't allowed: media\.example\.com/,
    );
  });

  it('opens the event stream only once signed in', async () => {
    mocks.me.mockResolvedValue({ setupRequired: false, user: null, csrfToken: null, appearance });
    renderApp();
    expect(await screen.findByLabelText('Password')).toBeTruthy();
    expect(mocks.subscribe).not.toHaveBeenCalled();
    cleanup();

    mocks.me.mockResolvedValue({
      setupRequired: false,
      user: { id: 'u1', username: 'admin' },
      csrfToken: 't',
      appearance,
    });
    renderApp();
    expect(await screen.findByText('workflows page')).toBeTruthy();
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
  });

  it('falls back to the sign-in screen for other auth.me failures', async () => {
    mocks.me.mockRejectedValue(new Error('network'));
    renderApp();
    expect(await screen.findByLabelText('Password')).toBeTruthy();
  });

  it.each([
    ['/', 'workflows page', false],
    ['/workflows/new', 'new workflow page', false],
    ['/workflows/wf1', 'editor page', true],
    ['/no/such/page', 'Page not found', false],
  ])('signed in, %s shows the %s inside the shell', async (path, text, rail) => {
    mocks.me.mockResolvedValue({
      setupRequired: false,
      user: { id: 'u1', username: 'admin' },
      csrfToken: 't',
      appearance,
    });
    window.history.pushState(null, '', path);
    try {
      const { container } = renderApp();
      expect(await screen.findByText(text)).toBeTruthy();
      // The editor gets the icon rail (no top bar); the other pages the full shell.
      expect(container.querySelector('.shell')?.classList.contains('is-rail')).toBe(rail);
    } finally {
      window.history.pushState(null, '', '/');
    }
  });

  it('keeps one shell while navigating (the version and job counts are not fetched per page)', async () => {
    mocks.me.mockResolvedValue({
      setupRequired: false,
      user: { id: 'u1', username: 'admin' },
      csrfToken: 't',
      appearance,
    });
    try {
      renderApp();
      expect(await screen.findByText('workflows page')).toBeTruthy();
      expect(await screen.findByText('v0.0.0')).toBeTruthy();
      act(() => navigate('/libraries'));
      expect(await screen.findByText('libraries page')).toBeTruthy();
      act(() => navigate('/workflows/wf1'));
      expect(await screen.findByText('editor page')).toBeTruthy();
      act(() => navigate('/'));
      expect(await screen.findByText('workflows page')).toBeTruthy();
      expect(mocks.health).toHaveBeenCalledTimes(1);
    } finally {
      window.history.pushState(null, '', '/');
    }
  });

  describe('settings routes', () => {
    const signedIn = {
      setupRequired: false,
      user: { id: 'u1', username: 'admin' },
      csrfToken: 't',
      appearance: { theme: 'system', serverName: null },
    };
    beforeEach(() => mocks.me.mockResolvedValue(signedIn));
    afterEach(() => window.history.pushState(null, '', '/'));

    it('the old /settings/tokens URL replaces itself with /settings/api-tokens', async () => {
      window.history.pushState(null, '', '/settings/tokens');
      const length = window.history.length;
      renderApp();
      expect(await screen.findByText('tokens section')).toBeTruthy();
      expect(window.location.pathname).toBe('/settings/api-tokens');
      expect(window.history.length).toBe(length);
    });

    it('/settings opens General, replacing the entry', async () => {
      window.history.pushState(null, '', '/settings');
      const length = window.history.length;
      renderApp();
      expect(await screen.findByText('general section')).toBeTruthy();
      expect(window.location.pathname).toBe('/settings/general');
      expect(window.history.length).toBe(length);
    });

    it('an unknown section says the page does not exist, with a way back to Settings', async () => {
      window.history.pushState(null, '', '/settings/nope');
      renderApp();
      expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Back to settings' }).getAttribute('href')).toBe(
        '/settings',
      );
      expect(window.location.pathname).toBe('/settings/nope');
    });

    it('/settings/about/licences shows the licences under About', async () => {
      window.history.pushState(null, '', '/settings/about/licences');
      renderApp();
      expect(await screen.findByText('licences section')).toBeTruthy();
      expect(screen.getByRole('heading', { level: 2, name: 'Open-source licences' })).toBeTruthy();
    });

    it('/settings/about shows About inside the shell, Settings current in the nav', async () => {
      window.history.pushState(null, '', '/settings/about');
      renderApp();
      expect(await screen.findByText('about section')).toBeTruthy();
      const nav = screen.getByRole('navigation', { name: 'Main' });
      expect(within(nav).getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe(
        'page',
      );
    });
  });

  describe('server appearance', () => {
    afterEach(() => {
      delete document.documentElement.dataset.theme;
      localStorage.clear();
      document.title = 'Transcoda';
    });

    it('applies the theme from auth.me, also before sign-in, and caches it', async () => {
      mocks.me.mockResolvedValue({
        setupRequired: false,
        user: null,
        csrfToken: null,
        appearance: { theme: 'light', serverName: null },
      });
      renderApp();
      expect(await screen.findByLabelText('Password')).toBeTruthy();
      expect(document.documentElement.dataset.theme).toBe('light');
      expect(localStorage.getItem('transcoda.theme')).toBe('light');
    });

    it('names the browser tab after the server once signed in', async () => {
      mocks.me.mockResolvedValue({
        setupRequired: false,
        user: { id: 'u1', username: 'admin' },
        csrfToken: 't',
        appearance: { theme: 'system', serverName: 'Basement' },
      });
      renderApp();
      expect(await screen.findByText('workflows page')).toBeTruthy();
      expect(document.title).toBe('Basement · Transcoda');
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    });
  });
});
