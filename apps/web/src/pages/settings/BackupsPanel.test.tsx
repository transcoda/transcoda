import { ORPCError } from '@orpc/client';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Backup, BackupsListOutput } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
vi.mock('../../api/client.ts', () => ({
  api: { system: { backups: { list: mocks.list, create: mocks.create } } },
}));

import { BackupsPanel } from './BackupsPanel.tsx';

const build: Backup = {
  name: 'transcoda-20261021-180001-v7-build.sqlite',
  size: 2_400_000,
  createdAt: '2026-10-21T16:00:01.000Z',
  reason: 'build',
};
const migration: Backup = {
  name: 'transcoda-20261020-090000-v6.sqlite',
  size: 612_000,
  createdAt: '2026-10-20T07:00:00.000Z',
  reason: 'migration',
};
const manual: Backup = {
  name: 'transcoda-20261021-190000-v7-manual.sqlite',
  size: 2_500_000,
  createdAt: '2026-10-21T17:00:00.000Z',
  reason: 'manual',
};

beforeEach(() => {
  mocks.list
    .mockReset()
    .mockResolvedValue({ backups: [build, migration], keep: 5 } satisfies BackupsListOutput);
  mocks.create.mockReset();
});
afterEach(cleanup);

describe('BackupsPanel', () => {
  it('lists each backup by file name with its size and why it was taken', async () => {
    render(<BackupsPanel />);
    const list = await screen.findByRole('list', { name: 'Database backups' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText(build.name)).toBeTruthy();
    expect(items[0]?.textContent).toContain('Build change');
    expect(items[0]?.textContent).toContain('2.40 MB');
    expect(items[1]?.textContent).toContain('Before migration');
    expect(items[1]?.textContent).toContain('612 kB');
    expect(screen.getByText(/keeps the 5 newest of each kind/)).toBeTruthy();
  });

  it('each row has a Download link to the session-only download route', async () => {
    render(<BackupsPanel />);
    await screen.findByText(build.name);
    const link = screen.getByRole('link', { name: `Download ${build.name}` });
    expect(link.getAttribute('href')).toBe(`/api/v1/system/backups/${build.name}/download`);
    expect(link.hasAttribute('download')).toBe(true);
    expect(screen.getAllByRole('link', { name: /^Download / })).toHaveLength(2);
  });

  it('says a backup holds account and secret data, and what secret.key has to do with it', async () => {
    render(<BackupsPanel />);
    await screen.findByText(build.name);
    const note = screen.getByText(/keep it private/);
    expect(note.textContent).toContain('password and API token hashes');
    expect(note.textContent).toContain('plugin secrets');
    // The secret.key detail sits with the restore steps, under "Restoring a backup".
    const help = screen.getByRole('button', { name: 'Restoring a backup' });
    expect(help.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(help);
    expect(screen.getByText(/are encrypted with/).textContent).toContain('secret.key');
  });

  it('says how to restore a backup', async () => {
    render(<BackupsPanel />);
    await screen.findByText(build.name);
    fireEvent.click(screen.getByRole('button', { name: 'Restoring a backup' }));
    const note = screen.getByText(/To restore/);
    expect(note.textContent).toContain('stop Transcoda (the container)');
    expect(note.textContent).toContain('an older backup is migrated again at start');
    expect(note.textContent).toContain('the same secret.key');
    expect(note.textContent).toContain('transcoda.sqlite');
    expect(note.textContent).toContain('-wal');
    expect(note.textContent).toContain('-shm');
  });

  it('uses the standard secondary button, readable in both themes (not the lime-card ink style)', async () => {
    render(<BackupsPanel />);
    const backUp = await screen.findByRole('button', { name: 'Back up now' });
    expect(backUp.className).toContain('btn-secondary');
    expect(screen.getByRole('link', { name: `Download ${build.name}` }).className).toContain(
      'btn-secondary',
    );
    expect(document.querySelector('.btn-ink-outline')).toBeNull();
  });

  it('"Back up now" takes a backup and shows it first', async () => {
    mocks.create.mockResolvedValue(manual);
    render(<BackupsPanel />);
    await screen.findByText(build.name);
    mocks.list.mockResolvedValue({ backups: [manual, build, migration], keep: 5 });
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(await screen.findByText(manual.name)).toBeTruthy();
    const items = within(screen.getByRole('list', { name: 'Database backups' })).getAllByRole(
      'listitem',
    );
    expect(items[0]?.textContent).toContain('Manual');
    const status = screen.getByRole('status');
    expect(status.textContent).toContain(`Backed up to ${manual.name}`);
    expect(status.className).not.toContain('sr-only');
  });

  it('while a backup runs the button keeps focus and ignores clicks (aria-disabled)', async () => {
    let finish: (b: Backup) => void = () => {};
    mocks.create.mockReturnValue(new Promise<Backup>((r) => (finish = r)));
    render(<BackupsPanel />);
    await screen.findByText(build.name);
    const button = screen.getByRole('button', { name: 'Back up now' }) as HTMLButtonElement;
    button.focus();
    fireEvent.click(button);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(mocks.create).toHaveBeenCalledOnce();
    finish(manual);
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBeNull());
  });

  it("a rate-limited backup shows the server's message", async () => {
    mocks.create.mockRejectedValue(
      new ORPCError('RATE_LIMITED', {
        message: 'A backup was taken moments ago; try again in 12 s',
        data: { retryAfterSeconds: 12 },
      }),
    );
    render(<BackupsPanel />);
    await screen.findByText(build.name);
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    expect((await screen.findByRole('alert')).textContent).toContain('try again in 12 s');
  });

  it('a failed backup says so', async () => {
    mocks.create.mockRejectedValue(new Error('disk full'));
    render(<BackupsPanel />);
    await screen.findByText(build.name);
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      "Couldn't back up the database",
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Back up now' }).getAttribute('aria-disabled'),
      ).toBeNull(),
    );
  });

  it('no backups yet, or a list that cannot be read, says so', async () => {
    mocks.list.mockResolvedValue({ backups: [], keep: 5 });
    render(<BackupsPanel />);
    expect(await screen.findByText('No backups yet.')).toBeTruthy();
    cleanup();
    mocks.list.mockRejectedValue(new Error('down'));
    render(<BackupsPanel />);
    expect(await screen.findByText('Backups could not be read')).toBeTruthy();
  });
});
