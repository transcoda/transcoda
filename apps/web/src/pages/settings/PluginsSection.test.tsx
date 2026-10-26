import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsFixture } from './settingsFixture.ts';

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock('../../api/client.ts', () => ({
  api: { settings: { get: mocks.get, update: mocks.update } },
}));

import { renderAt } from '../../test/render.tsx';
import { PluginsSection } from './PluginsSection.tsx';

beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue(settingsFixture());
  mocks.update.mockReset();
});
afterEach(cleanup);

const timeout = () => screen.getByRole('spinbutton', { name: /call timeout/i }) as HTMLInputElement;

describe('PluginsSection', () => {
  it('the call timeout is edited in seconds and sent in milliseconds', async () => {
    const answer = settingsFixture();
    answer.plugins.callTimeoutMs = { value: 5000, default: 30_000, source: { kind: 'database' } };
    mocks.update.mockResolvedValue(answer);
    renderAt('/settings/plugins', <PluginsSection />);
    await screen.findByRole('spinbutton', { name: /call timeout/i });
    expect(timeout().value).toBe('30');
    expect(screen.getByText('Applies to the next plugin call')).toBeTruthy();
    fireEvent.change(timeout(), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ pluginCallTimeoutMs: 5000 }));
    await waitFor(() => expect(timeout().value).toBe('5'));
  });

  it('a timeout outside 1–3600 seconds is refused by the field', async () => {
    renderAt('/settings/plugins', <PluginsSection />);
    await screen.findByRole('spinbutton', { name: /call timeout/i });
    fireEvent.change(timeout(), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a whole number from 1 to 3600')).toBeTruthy();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('finish-step timeout and isolation are read-only; catalogs link to the Plugins page', async () => {
    renderAt('/settings/plugins', <PluginsSection />);
    expect(await screen.findByText('600 seconds')).toBeTruthy();
    expect(screen.getByText('Separate user')).toBeTruthy();
    expect(screen.queryByRole('spinbutton', { name: /finish/i })).toBeNull();
    const link = screen.getByRole('link', { name: /catalogs are managed on the plugins page/i });
    expect(link.getAttribute('href')).toBe('/plugins');
  });

  it('isolation turned off names its variable', async () => {
    const loaded = settingsFixture();
    loaded.plugins.isolation = { mode: 'same-user', variable: 'TRANSCODA_PLUGIN_ISOLATION' };
    mocks.get.mockResolvedValue(loaded);
    const { container } = renderAt('/settings/plugins', <PluginsSection />);
    expect(await screen.findByText('Same user')).toBeTruthy();
    expect(container.textContent).toContain('From TRANSCODA_PLUGIN_ISOLATION');
  });
});
