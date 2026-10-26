import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsFixture } from './settingsFixture.ts';

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), setAppearance: vi.fn() }));
vi.mock('../../api/client.ts', () => ({
  api: { settings: { get: mocks.get, update: mocks.update } },
}));
vi.mock('../../auth/useAuth.ts', () => ({
  useAuth: () => ({ setAppearance: mocks.setAppearance }),
}));

import { renderAt } from '../../test/render.tsx';
import { GeneralSection } from './GeneralSection.tsx';

beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue(settingsFixture());
  mocks.update.mockReset();
  mocks.setAppearance.mockReset();
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

const save = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
const nameBox = () => screen.getByRole('textbox', { name: 'Server name' }) as HTMLInputElement;

describe('GeneralSection', () => {
  it('server name: empty is no name, typing enables Save, and only the name is sent', async () => {
    const answer = settingsFixture();
    answer.general.serverName = { value: 'Den', default: null, source: { kind: 'database' } };
    mocks.update.mockResolvedValue(answer);
    renderAt('/settings/general', <GeneralSection />);
    await screen.findByRole('textbox', { name: 'Server name' });
    expect(nameBox().value).toBe('');
    expect(nameBox().getAttribute('placeholder')).toBe('Transcoda');
    expect(nameBox().maxLength).toBe(64);
    expect(save().disabled).toBe(true);
    expect(screen.getByText('No changes to save')).toBeTruthy();
    fireEvent.change(nameBox(), { target: { value: '  ' } });
    expect(save().disabled).toBe(true);
    fireEvent.change(nameBox(), { target: { value: 'Den' } });
    fireEvent.click(save());
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ serverName: 'Den' }));
    await waitFor(() =>
      expect(mocks.setAppearance).toHaveBeenCalledWith({ theme: 'system', serverName: 'Den' }),
    );
    expect(save().disabled).toBe(true);
  });

  it('clearing a saved name sends null', async () => {
    const loaded = settingsFixture();
    loaded.general.serverName = { value: 'Den', default: null, source: { kind: 'database' } };
    mocks.get.mockResolvedValue(loaded);
    mocks.update.mockResolvedValue(settingsFixture());
    renderAt('/settings/general', <GeneralSection />);
    await waitFor(() => expect(nameBox().value).toBe('Den'));
    fireEvent.change(nameBox(), { target: { value: '' } });
    fireEvent.click(save());
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ serverName: null }));
  });

  it('a theme choice previews at once and is reverted when leaving unsaved', async () => {
    const view = renderAt('/settings/general', <GeneralSection />);
    const light = (await screen.findByRole('radio', { name: 'Light' })) as HTMLInputElement;
    expect((screen.getByRole('radio', { name: 'System' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(light);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(save().disabled).toBe(false);
    expect(localStorage.getItem('transcoda.theme')).toBeNull();
    view.unmount();
    expect(localStorage.getItem('transcoda.theme')).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('a saved theme stays after leaving and goes to the top bar', async () => {
    const answer = settingsFixture();
    answer.general.theme = { value: 'dark', default: 'system', source: { kind: 'database' } };
    mocks.update.mockResolvedValue(answer);
    const view = renderAt('/settings/general', <GeneralSection />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Dark' }));
    fireEvent.click(save());
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ theme: 'dark' }));
    await waitFor(() =>
      expect(mocks.setAppearance).toHaveBeenCalledWith({ theme: 'dark', serverName: null }),
    );
    view.unmount();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('a failed save reverts the previewed theme', async () => {
    mocks.update.mockRejectedValue(new Error('down'));
    renderAt('/settings/general', <GeneralSection />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Light' }));
    fireEvent.click(save());
    expect((await screen.findByRole('alert')).textContent).toContain('down');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect((screen.getByRole('radio', { name: 'System' }) as HTMLInputElement).checked).toBe(true);
  });

  it('public URL and allowed hosts are read-only, each with its source', async () => {
    const { container } = renderAt('/settings/general', <GeneralSection />);
    expect(await screen.findByText('Not set: notifications carry no link')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /public url/i })).toBeNull();
    expect(
      [...container.querySelectorAll('.setting-source code')].map((c) => c.textContent),
    ).toContain('TRANSCODA_PUBLIC_URL');
    const hosts = screen.getByRole('list', { name: 'Allowed hosts' });
    expect(hosts.textContent).toContain('localhost');
    expect(hosts.textContent).toContain('Built in');
    expect(hosts.textContent).toContain('Recorded at setup');
    expect(hosts.textContent).toContain('From TRANSCODA_ALLOWED_HOSTS');
  });
});
