import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  capabilities: vi.fn(),
  get: vi.fn(),
  backups: vi.fn(),
  update: vi.fn(),
}));
vi.mock('../../api/client.ts', () => ({
  api: {
    system: {
      health: mocks.health,
      capabilities: mocks.capabilities,
      update: mocks.update,
      backups: { list: mocks.backups, create: vi.fn() },
    },
    settings: { get: mocks.get },
  },
}));

import { resetAppUpdate } from '../../hooks/useAppUpdate.ts';
import { renderAt } from '../../test/render.tsx';
import { AboutSection } from './AboutSection.tsx';
import { UPDATE_COMMAND } from './AppUpdatePanel.tsx';

const NO_UPDATE = { current: '1.4.0', checking: true, checkedAt: null, update: null };

beforeEach(() => {
  resetAppUpdate();
  mocks.update.mockReset().mockResolvedValue(NO_UPDATE);
  mocks.backups.mockReset().mockResolvedValue({ backups: [], keep: 5 });
  mocks.health.mockReset().mockResolvedValue({ status: 'ok', version: '1.4.0' });
  mocks.get.mockReset().mockResolvedValue({ about: { version: '1.4.0', node: 'v24.22.0' } });
  mocks.capabilities.mockReset().mockResolvedValue({
    available: true,
    path: '/usr/lib/jellyfin-ffmpeg/ffmpeg',
    version: '8.1.3-Jellyfin',
    encoders: ['libx264', 'hevc_vaapi'],
    hwaccels: ['vaapi', 'qsv'],
    filters: [],
    deviceProfiles: [],
  });
});
afterEach(cleanup);

describe('AboutSection', () => {
  it('shows the Transcoda, Node and ffmpeg versions and the ffmpeg path', async () => {
    render(<AboutSection />);
    expect(await screen.findByText('1.4.0')).toBeTruthy();
    expect(await screen.findByText('v24.22.0')).toBeTruthy();
    expect(await screen.findByText('8.1.3-Jellyfin')).toBeTruthy();
    expect(screen.getByText('/usr/lib/jellyfin-ffmpeg/ffmpeg')).toBeTruthy();
  });

  it('found by name on the PATH, ffmpeg gets no second "ffmpeg" line', async () => {
    mocks.capabilities.mockResolvedValue({ ...(await mocks.capabilities()), path: 'ffmpeg' });
    const { container } = render(<AboutSection />);
    await screen.findByText('8.1.3-Jellyfin');
    expect(container.querySelector('.about-path')).toBeNull();
  });

  it('puts the backups right under the versions, then the encoders, then the licences', async () => {
    const { container } = render(<AboutSection />);
    await screen.findByText('8.1.3-Jellyfin');
    const order = [...(container.querySelector('.about')?.children ?? [])].map(
      (el) => el.className,
    );
    expect(order).toEqual(['about-list', 'about-backups', 'about-caps', 'about-link']);
    // The codec summary sits inside "Show all encoders", not above it.
    const summary = screen.getByRole('list', { name: 'Encoders Transcoda uses' });
    expect(summary.closest('details')).toBeTruthy();
  });

  it('sums up the encoders Transcoda uses first, then lists every one behind "Show all encoders"', async () => {
    const { container } = render(<AboutSection />);
    await screen.findByText('8.1.3-Jellyfin');
    const summary = within(screen.getByRole('list', { name: 'Encoders Transcoda uses' }));
    expect(summary.getByText('HEVC').closest('li')?.textContent).toBe('HEVChevc_vaapi (hardware)');
    expect(summary.getByText('H.264').closest('li')?.textContent).toBe('H.264libx264');
    expect(summary.getByText('Hardware').closest('li')?.textContent).toBe('Hardwarevaapi, qsv');
    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe('Show all encoders');
    expect(details.querySelector('summary .icon')).toBeTruthy();
    expect(screen.getByText('hevc_vaapi')).toBeTruthy();
    expect(screen.getByText('qsv')).toBeTruthy();
  });

  it('says when ffmpeg is unavailable, with its error', async () => {
    mocks.capabilities.mockResolvedValue({
      available: false,
      path: '/opt/ffmpeg',
      error: 'not found',
      deviceProfiles: [],
    });
    const { container } = render(<AboutSection />);
    expect(await screen.findByText('Not available: not found')).toBeTruthy();
    expect(container.querySelector('details')).toBeNull();
  });

  it('links to the open-source licences', async () => {
    render(<AboutSection />);
    await screen.findByText('8.1.3-Jellyfin');
    const link = screen.getByRole('link', { name: 'Open-source licences' });
    expect(link.getAttribute('href')).toBe('/settings/about/licences');
  });

  it('shows the database backups with "Back up now"', async () => {
    render(<AboutSection />);
    expect(await screen.findByRole('heading', { name: 'Database backups' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeTruthy();
  });

  it('a value that cannot be read says so', async () => {
    mocks.get.mockRejectedValue(new Error('down'));
    render(<AboutSection />);
    expect(await screen.findByText('1.4.0')).toBeTruthy();
    expect(await screen.findByText('Could not be read')).toBeTruthy();
  });

  describe('a newer release', () => {
    // The dates read "Nov 2" only within their own year.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-05T12:00:00Z') });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const update = {
      version: '1.6.0',
      url: 'https://github.com/transcoda/transcoda/releases/tag/v1.6.0',
      changelogUrl: 'https://github.com/transcoda/transcoda/blob/main/CHANGELOG.md',
      releases: [
        {
          version: '1.6.0',
          date: '2026-11-02',
          entries: [
            { type: 'fixed', text: 'Dry runs no longer hang.' },
            { type: 'breaking', text: 'Set TRANSCODA_X again after updating.' },
            { type: 'new', text: 'A new node.' },
          ],
        },
        { version: '1.5.0', date: '2026-10-20', entries: [{ type: 'improved', text: 'Faster.' }] },
      ],
      olderReleases: 2,
    };

    it('comes first, with the running version, the release link and the command to copy', async () => {
      mocks.update.mockResolvedValue({ ...NO_UPDATE, update });
      const { container } = renderAt('/settings/about', <AboutSection />);
      const panel = await screen.findByRole('region', { name: 'Transcoda 1.6.0 is available' });
      expect(container.querySelector('.about')?.firstElementChild).toBe(panel);
      expect(within(panel).getByText(/You have 1\.4\.0/)).toBeTruthy();
      expect(
        within(panel).getByRole('link', { name: 'Release on GitHub' }).getAttribute('href'),
      ).toBe(update.url);
      expect(within(panel).getByText(UPDATE_COMMAND)).toBeTruthy();
      expect(within(panel).getByRole('button', { name: 'Copy' })).toBeTruthy();
    });

    it('lists the notes per version, newest first, with what to change before updating first', async () => {
      mocks.update.mockResolvedValue({ ...NO_UPDATE, update });
      renderAt('/settings/about', <AboutSection />);
      const panel = await screen.findByRole('region', { name: 'Transcoda 1.6.0 is available' });
      const versions = within(panel).getAllByRole('heading', { level: 4 });
      expect(versions.map((h) => h.textContent)).toEqual(['1.6.0Nov 2', '1.5.0Oct 20']);
      const labels = [...(versions[0]?.parentElement?.querySelectorAll('.group-h3') ?? [])];
      expect(labels.map((l) => l.textContent)).toEqual(['Before you update', 'New', 'Fixed']);
      expect(within(panel).getByText('Set TRANSCODA_X again after updating.')).toBeTruthy();
      expect(within(panel).getByText(/2 older versions since yours/)).toBeTruthy();
      expect(
        within(panel).getByRole('link', { name: 'full changelog on GitHub' }).getAttribute('href'),
      ).toBe(update.changelogUrl);
    });

    it("without readable notes: the notice and the command, no What's new", async () => {
      mocks.update.mockResolvedValue({
        ...NO_UPDATE,
        update: { ...update, releases: [], olderReleases: 0 },
      });
      renderAt('/settings/about', <AboutSection />);
      const panel = await screen.findByRole('region', { name: 'Transcoda 1.6.0 is available' });
      expect(within(panel).getByText(UPDATE_COMMAND)).toBeTruthy();
      expect(within(panel).queryByText("What's new")).toBeNull();
    });
  });

  it('no newer release: no notice', async () => {
    renderAt('/settings/about', <AboutSection />);
    await screen.findByText('8.1.3-Jellyfin');
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: /is available/ })).toBeNull();
  });
});
