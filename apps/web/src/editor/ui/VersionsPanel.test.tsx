import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthValue } from '../../auth/AuthProvider.tsx';
import { renderAt } from '../../test/render.tsx';

const mocks = vi.hoisted(() => ({ versions: vi.fn() }));
vi.mock('../../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return {
    api: { workflows: { versions: mocks.versions } },
    isDefinedError: orpc.isDefinedError,
    safe: orpc.safe,
  };
});

import { useVersionList, VersionsPanel } from './VersionsPanel.tsx';

/** The panel with the page's list (`useVersionList`), fetched while open as the page would. */
function WithList(props: Omit<Parameters<typeof VersionsPanel>[0], 'load' | 'onRetry'>) {
  const list = useVersionList(props.workflowId, props.open ? 'shown' : null);
  return <VersionsPanel {...props} load={list.load} onRetry={list.reload} />;
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const auth: AuthValue = {
  status: 'authenticated',
  user: { id: 'u1', username: 'jan', createdAt: minutesAgo(9999) },
  blockedHost: null,
  appearance: { theme: 'system', serverName: null },
  setAppearance: () => {},
  refresh: async () => {},
  logout: async () => {},
};

function renderPanel(props: Partial<Parameters<typeof WithList>[0]> = {}) {
  const onClose = vi.fn();
  const view = renderAt(
    '/workflows/wf1',
    <AuthContext.Provider value={auth}>
      <WithList
        open
        workflowId="wf1"
        currentVersion={8}
        viewing={8}
        activeVersion={null}
        onClose={onClose}
        {...props}
      />
    </AuthContext.Provider>,
  );
  return { ...view, onClose };
}

beforeEach(() => {
  mocks.versions.mockReset().mockResolvedValue({
    versions: [
      { version: 8, note: 'Layout only', createdBy: 'u1', createdAt: minutesAgo(2) },
      { version: 7, note: null, createdBy: 'u1', createdAt: minutesAgo(90) },
      {
        version: 6,
        note: 'Updated Bump 1→2',
        createdBy: 'system:upgrade',
        createdAt: minutesAgo(200),
      },
      { version: 5, note: null, createdBy: 'u2', createdAt: minutesAgo(300) },
    ],
  });
});
afterEach(cleanup);

describe('VersionsPanel', () => {
  it('marks the active row " · active" with a check icon; the current row still links to the plain route', async () => {
    renderPanel({ activeVersion: 7 });
    const panel = screen.getByRole('dialog', { name: 'Versions' });
    const links = await within(panel).findAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'v8 · Layout only · 2 min ago',
      'v7 · saved by you · 1 h ago · active',
      'v6 · Updated Bump 1→2 · 3 h ago · automatic update',
      'v5 · saved · 5 h ago · another user',
    ]);
    expect(links[1]?.querySelector('svg')).not.toBeNull();
    expect(links[0]?.querySelector('svg')).toBeNull();
    expect(links[0]?.getAttribute('href')).toBe('/workflows/wf1');
  });

  it('lists versions newest first with note and relative time; the author only when it is not me ("automatic update", "another user", never a raw id)', async () => {
    renderPanel({ viewing: 7 });
    const panel = screen.getByRole('dialog', { name: 'Versions' });
    const links = await within(panel).findAllByRole('link');
    expect(mocks.versions).toHaveBeenCalledWith({ id: 'wf1' });
    expect(links.map((l) => l.textContent)).toEqual([
      'v8 · Layout only · 2 min ago',
      'v7 · saved by you · 1 h ago',
      'v6 · Updated Bump 1→2 · 3 h ago · automatic update',
      'v5 · saved · 5 h ago · another user',
    ]);
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/workflows/wf1',
      '/workflows/wf1?version=7',
      '/workflows/wf1?version=6',
      '/workflows/wf1?version=5',
    ]);
    expect(links[1]?.getAttribute('aria-current')).toBe('page');
    expect(links[0]?.hasAttribute('aria-current')).toBe(false);
  });

  it('a failed load shows the error inside the panel with "Try again"; Escape and a row click close it', async () => {
    mocks.versions.mockRejectedValueOnce(new Error('offline'));
    const { onClose } = renderPanel();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load the versions');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    const link = await screen.findByRole('link', { name: /^v7 ·/ });
    fireEvent.keyDown(link, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(link);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('has a Close button that closes the panel', async () => {
    const { onClose } = renderPanel();
    const panel = screen.getByRole('dialog', { name: 'Versions' });
    await within(panel).findAllByRole('link');
    fireEvent.click(within(panel).getByRole('button', { name: 'Close versions' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while closed', () => {
    renderPanel({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.versions).not.toHaveBeenCalled();
  });
});
