import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  capabilities: vi.fn(),
  get: vi.fn(),
  backups: vi.fn(),
}));
vi.mock('../../api/client.ts', () => ({
  api: {
    system: {
      health: mocks.health,
      capabilities: mocks.capabilities,
      backups: { list: mocks.backups, create: vi.fn() },
    },
    settings: { get: mocks.get },
  },
}));

import { AboutSection } from './AboutSection.tsx';

beforeEach(() => {
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
});
