import { ORPCError } from '@orpc/client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsFixture } from './settingsFixture.ts';

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock('../../api/client.ts', () => ({
  api: { settings: { get: mocks.get, update: mocks.update } },
}));

import { renderAt } from '../../test/render.tsx';
import { RecycleSection } from './RecycleSection.tsx';

beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue(settingsFixture());
  mocks.update.mockReset();
});
afterEach(cleanup);

const save = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
const retention = () => screen.getByRole('spinbutton', { name: /retention/i }) as HTMLInputElement;

describe('RecycleSection', () => {
  it('shows the values, their source and the current usage', async () => {
    renderAt('/settings/recycle', <RecycleSection />);
    expect(
      (await screen.findByRole('spinbutton', { name: /retention/i })).getAttribute('value'),
    ).toBe('7');
    expect(
      (screen.getByRole('spinbutton', { name: /maximum share/i }) as HTMLInputElement).value,
    ).toBe('25');
    // Both hold their defaults: no source tags.
    expect(screen.queryByText('Default')).toBeNull();
    // The usage: a bold value under its label, the check interval as its muted hint.
    expect(screen.getByText('Recycled originals now').className).toContain('setting-label');
    expect(screen.getByText('12.3 GB in 41 files').className).toBe('recycle-usage-value');
    expect(screen.getByText('Checked at start and every 10 minutes').className).toBe(
      'setting-hint',
    );
  });

  it('Save is disabled until something changes, and again when changed back', async () => {
    renderAt('/settings/recycle', <RecycleSection />);
    await screen.findByRole('spinbutton', { name: /retention/i });
    expect(save().disabled).toBe(true);
    // No "No changes to save": a reason only when it names something to fix.
    expect(screen.queryByText('No changes to save')).toBeNull();
    expect(save().getAttribute('aria-describedby')).toBeNull();
    fireEvent.change(retention(), { target: { value: '14' } });
    expect(save().disabled).toBe(false);
    expect(screen.queryByText('No changes to save')).toBeNull();
    fireEvent.change(retention(), { target: { value: '7' } });
    expect(save().disabled).toBe(true);
  });

  it('sends only the changed field; the answer replaces the form', async () => {
    const answer = settingsFixture();
    answer.recycle.retentionDays = { value: 14, default: 7, source: { kind: 'database' } };
    mocks.update.mockResolvedValue(answer);
    renderAt('/settings/recycle', <RecycleSection />);
    await screen.findByRole('spinbutton', { name: /retention/i });
    fireEvent.change(retention(), { target: { value: '14' } });
    fireEvent.click(save());
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ recycleRetentionDays: 14 }));
    expect(await screen.findByText('Set here')).toBeTruthy();
    expect(retention().value).toBe('14');
    expect(save().disabled).toBe(true);
  });

  it('a value out of range is named by its field and not sent', async () => {
    renderAt('/settings/recycle', <RecycleSection />);
    await screen.findByRole('spinbutton', { name: /retention/i });
    fireEvent.change(retention(), { target: { value: '9999' } });
    fireEvent.click(save());
    expect(await screen.findByText('Enter a whole number from 0 to 3650')).toBeTruthy();
    expect(retention().getAttribute('aria-invalid')).toBe('true');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("a validation answer shows the server's message by the field", async () => {
    mocks.update.mockRejectedValue(
      new ORPCError('BAD_REQUEST', {
        message: 'Input validation failed',
        data: { issues: [{ path: ['recycleMaxFreePercent'], message: 'Too big: at most 100' }] },
      }),
    );
    renderAt('/settings/recycle', <RecycleSection />);
    await screen.findByRole('spinbutton', { name: /retention/i });
    fireEvent.change(screen.getByRole('spinbutton', { name: /maximum share/i }), {
      target: { value: '50' },
    });
    fireEvent.click(save());
    expect(await screen.findByText('Too big: at most 100')).toBeTruthy();
    expect(
      screen.getByRole('spinbutton', { name: /maximum share/i }).getAttribute('aria-invalid'),
    ).toBe('true');
  });

  it('another failure shows its message for the form', async () => {
    mocks.update.mockRejectedValue(
      new ORPCError('FORBIDDEN', { message: 'Settings are changed in the UI' }),
    );
    renderAt('/settings/recycle', <RecycleSection />);
    await screen.findByRole('spinbutton', { name: /retention/i });
    fireEvent.change(retention(), { target: { value: '3' } });
    fireEvent.click(save());
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Settings are changed in the UI',
    );
  });
});
