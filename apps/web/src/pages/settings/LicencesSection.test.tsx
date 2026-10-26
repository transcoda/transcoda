import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LicencesOutput } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ licences: vi.fn() }));
vi.mock('../../api/client.ts', () => ({ api: { system: { licences: mocks.licences } } }));

import { LicencesSection } from './LicencesSection.tsx';

const list: LicencesOutput = {
  available: true,
  format: 1,
  packages: [
    {
      name: '@xyflow/react',
      version: '12.12.0',
      licence: 'MIT',
      homepage: 'https://reactflow.dev',
      origin: 'npm',
      usedBy: ['web'],
      textKey: 'sha256:mit',
    },
    {
      name: 'jellyfin-ffmpeg',
      version: '8.1.3-1-bookworm',
      licence: 'GPL-3.0-or-later',
      homepage: 'https://github.com/jellyfin/jellyfin-ffmpeg',
      origin: 'image',
      usedBy: ['image'],
      textKey: 'sha256:gpl',
    },
    {
      name: 'lucide',
      version: '0.0.0',
      licence: 'ISC',
      homepage: null,
      origin: 'vendored',
      usedBy: ['web'],
      textKey: 'sha256:isc',
    },
  ],
  texts: {
    'sha256:mit': 'MIT License\n\nCopyright (c) webkid GmbH',
    'sha256:gpl': 'GNU GENERAL PUBLIC LICENSE',
    'sha256:isc': 'ISC License',
  },
};

// Braces: a function returned from beforeEach would run as its teardown (the mock itself here).
beforeEach(() => {
  mocks.licences.mockReset().mockResolvedValue(list);
});
afterEach(cleanup);

describe('LicencesSection', () => {
  it('says what Transcoda is licensed under, with a link to its licence', async () => {
    const { container } = render(<LicencesSection />);
    await screen.findByText('@xyflow/react 12.12.0 · MIT');
    expect(container.querySelector('.section-intro')?.textContent).toBe(
      'Transcoda is free software under the GNU GPL v3. It is built on the components below.',
    );
    const link = screen.getByRole('link', { name: 'GNU GPL v3' });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/transcoda/transcoda/blob/main/LICENSE',
    );
  });

  it('lists every component as a closed disclosure, image and vendored ones tagged', async () => {
    const { container } = render(<LicencesSection />);
    await screen.findByText('@xyflow/react 12.12.0 · MIT');
    const items = [...container.querySelectorAll('.licence-list > li')];
    expect(items).toHaveLength(3);
    for (const li of items) expect(li.querySelector('details')?.open).toBe(false);
    expect(screen.getByText('jellyfin-ffmpeg 8.1.3-1-bookworm · GPL-3.0-or-later')).toBeTruthy();
    expect(screen.getByText('image')).toBeTruthy();
    expect(screen.getByText('vendored')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('3 components');
  });

  it('opening a disclosure shows the full text', async () => {
    const { container } = render(<LicencesSection />);
    const summary = await screen.findByText('@xyflow/react 12.12.0 · MIT');
    expect(screen.queryByText(/Copyright \(c\) webkid GmbH/)).toBeNull();
    const details = summary.closest('details') as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    const pre = await screen.findByText(/Copyright \(c\) webkid GmbH/);
    expect(pre.tagName).toBe('PRE');
    expect(pre.classList.contains('licence-text')).toBe(true);
    expect(container.querySelectorAll('pre')).toHaveLength(1);
  });

  it('the search narrows the list and the status says how many match', async () => {
    const { container } = render(<LicencesSection />);
    await screen.findByText('@xyflow/react 12.12.0 · MIT');
    const search = screen.getByRole('searchbox', { name: 'Search components' });
    fireEvent.change(search, { target: { value: 'gpl' } });
    expect(await screen.findByText('1 of 3')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('1 of 3');
    expect(container.querySelectorAll('.licence-list > li')).toHaveLength(1);
    expect(screen.getByText('jellyfin-ffmpeg 8.1.3-1-bookworm · GPL-3.0-or-later')).toBeTruthy();
  });

  it('nothing matching says so', async () => {
    render(<LicencesSection />);
    await screen.findByText('@xyflow/react 12.12.0 · MIT');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search components' }), {
      target: { value: 'zzz' },
    });
    expect(await screen.findByText('0 of 3')).toBeTruthy();
    expect(screen.getByText('No component matches “zzz”.')).toBeTruthy();
  });

  it('a build without a list says how to get one', async () => {
    mocks.licences.mockResolvedValue({ available: false });
    render(<LicencesSection />);
    expect(await screen.findByText(/This build has no licence list/)).toBeTruthy();
    expect(screen.getByText('pnpm licences').tagName).toBe('CODE');
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('a failed request says the list could not be loaded', async () => {
    mocks.licences.mockRejectedValue(new Error('down'));
    render(<LicencesSection />);
    expect(await screen.findByText('The licence list could not be loaded.')).toBeTruthy();
  });
});
