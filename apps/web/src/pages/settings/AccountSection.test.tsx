import { ORPCError } from '@orpc/client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ changePassword: vi.fn() }));
vi.mock('../../api/client.ts', () => ({
  api: { auth: { changePassword: mocks.changePassword } },
}));

import { renderAt } from '../../test/render.tsx';
import { AccountSection } from './AccountSection.tsx';

beforeEach(() => {
  mocks.changePassword.mockReset();
});
afterEach(cleanup);

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const save = () => screen.getByRole('button', { name: 'Change password' }) as HTMLButtonElement;
function fill(current: string, next: string, repeat: string) {
  fireEvent.change(field('Current password'), { target: { value: current } });
  fireEvent.change(field('New password'), { target: { value: next } });
  fireEvent.change(field('Repeat new password'), { target: { value: repeat } });
}

describe('AccountSection', () => {
  it('Save waits for all three fields, a long enough new password and a matching repeat', () => {
    renderAt('/settings/account', <AccountSection />);
    expect(field('Current password').type).toBe('password');
    expect(field('New password').getAttribute('autocomplete')).toBe('new-password');
    // Empty fields: off, with no reason printed (it would only say what the form shows).
    expect(save().disabled).toBe(true);
    expect(save().getAttribute('aria-describedby')).toBeNull();
    expect(document.querySelector('.form-reason')).toBeNull();
    expect(screen.queryByText(/Fill in/)).toBeNull();
    // One heading: the section's; no "Change password" group label over the fields.
    expect(screen.queryByRole('heading', { name: 'Change password' })).toBeNull();
    fill('old-password', 'short', '');
    expect(save().disabled).toBe(true);
    expect(screen.queryByText(/needs at least/)).toBeNull();
    fill('old-password', 'short', 'short');
    expect(save().disabled).toBe(true);
    expect(screen.getByText('The new password needs at least 12 characters')).toBeTruthy();
    fill('old-password', 'a-long-new-password', 'a-long-new-passwort');
    expect(save().disabled).toBe(true);
    expect(screen.getByText("The new passwords don't match")).toBeTruthy();
    fill('old-password', 'a-long-new-password', 'a-long-new-password');
    expect(save().disabled).toBe(false);
  });

  it('on success: a toast, the fields clear, only the two passwords are sent', async () => {
    mocks.changePassword.mockResolvedValue({ ok: true });
    renderAt('/settings/account', <AccountSection />);
    fill('old-password', 'a-long-new-password', 'a-long-new-password');
    fireEvent.click(save());
    await waitFor(() =>
      expect(mocks.changePassword).toHaveBeenCalledWith({
        currentPassword: 'old-password',
        newPassword: 'a-long-new-password',
      }),
    );
    expect(
      await screen.findByText('Password changed. Other sessions were signed out.'),
    ).toBeTruthy();
    expect(field('Current password').value).toBe('');
    expect(field('New password').value).toBe('');
    expect(field('Repeat new password').value).toBe('');
  });

  it('a wrong current password is marked on that field', async () => {
    mocks.changePassword.mockRejectedValue(
      new ORPCError('INVALID_CREDENTIALS', { message: 'The current password is wrong' }),
    );
    renderAt('/settings/account', <AccountSection />);
    fill('nope', 'a-long-new-password', 'a-long-new-password');
    fireEvent.click(save());
    expect(await screen.findByText('The current password is wrong')).toBeTruthy();
    expect(field('Current password').getAttribute('aria-invalid')).toBe('true');
    expect(field('New password').value).toBe('a-long-new-password');
  });

  it("rate limited: the server's message", async () => {
    mocks.changePassword.mockRejectedValue(
      new ORPCError('RATE_LIMITED', {
        message: 'Too many attempts',
        data: { retryAfterSeconds: 30 },
      }),
    );
    renderAt('/settings/account', <AccountSection />);
    fill('nope', 'a-long-new-password', 'a-long-new-password');
    fireEvent.click(save());
    expect((await screen.findByRole('alert')).textContent).toContain('Too many attempts');
  });
});
