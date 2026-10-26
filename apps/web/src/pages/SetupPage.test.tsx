import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  setup: vi.fn(),
  navigate: vi.fn(),
  already: false,
}));
vi.mock('../api/client.ts', () => ({
  api: {
    auth: { setup: mocks.setup },
    system: { health: vi.fn().mockResolvedValue({ status: 'ok', version: '0.0.0' }) },
  },
  isDefinedError: () => mocks.already,
  safe: async (p: Promise<unknown>) => {
    try {
      return [null, await p];
    } catch {
      return [{ code: 'SETUP_ALREADY_DONE' }, undefined];
    }
  },
}));
vi.mock('../auth/useAuth.ts', () => ({ useAuth: () => ({ refresh: mocks.refresh }) }));
vi.mock('wouter', () => ({ useLocation: () => ['/', mocks.navigate] }));

import { SetupPage } from './SetupPage.tsx';

function submit() {
  render(<SetupPage />);
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-enough-pass' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create account and sign in' }));
}

beforeEach(() => {
  mocks.refresh.mockReset().mockRejectedValue(new Error('boom'));
  mocks.setup.mockReset();
  mocks.navigate.mockReset();
  mocks.already = false;
});
afterEach(cleanup);

describe('SetupPage', () => {
  it('shows an alert when refresh fails after a successful setup', async () => {
    mocks.setup.mockResolvedValue({ ok: true });
    submit();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Account created.*failed/);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('shows an alert when refresh fails after SETUP_ALREADY_DONE', async () => {
    mocks.already = true;
    mocks.setup.mockRejectedValue(new Error('already'));
    submit();
    expect((await screen.findByRole('alert')).textContent).toMatch(/already completed.*failed/);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('a password under 12 characters is not sent: the form says so and focuses the field', async () => {
    render(<SetupPage />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account and sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Use at least 12 characters for the password.',
    );
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText('Password'));
  });

  it('a failed setup says so in two sentences', async () => {
    mocks.setup.mockRejectedValue(new Error('nope'));
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Setup failed. Check the values and try again.',
    );
  });
});
