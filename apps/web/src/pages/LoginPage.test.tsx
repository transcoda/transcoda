import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  login: vi.fn(),
  error: null as null | { code: string; data?: unknown },
}));
vi.mock('../api/client.ts', () => ({
  api: {
    auth: { login: mocks.login },
    system: { health: vi.fn().mockResolvedValue({ status: 'ok', version: '0.0.0' }) },
  },
  isDefinedError: (e: unknown) => e !== null && e === mocks.error,
  safe: async (p: Promise<unknown>) => {
    try {
      return [null, await p];
    } catch {
      return [mocks.error, undefined];
    }
  },
}));
vi.mock('../auth/useAuth.ts', () => ({ useAuth: () => ({ refresh: mocks.refresh }) }));

import { LoginPage } from './LoginPage.tsx';

function submit() {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'a' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'b' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

beforeEach(() => {
  mocks.refresh.mockReset();
  mocks.login.mockReset().mockResolvedValue({ ok: true });
  mocks.error = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('LoginPage', () => {
  it('names the host once: the brand footer beside the form, the intro line on a phone', () => {
    const { container } = render(<LoginPage />);
    const intro = container.querySelector('.auth-host-intro') as HTMLElement;
    expect(intro.textContent).toBe(`to Transcoda on ${window.location.hostname}`);
    expect(container.querySelector('.auth-meta')?.textContent).toContain(window.location.host);
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
    // Wide: the intro line is hidden (the footer says it). Phone: the footer is hidden.
    expect(css).toMatch(
      /@media \(min-width: 900px\) \{\s*\.lead:has\(> \.auth-host-intro\) \{\s*display: none;/,
    );
    expect(css).toMatch(/@media \(max-width: 899px\) \{[^@]*\.auth-meta \{\s*display: none;/);
  });

  it('shows an error instead of rejecting when refresh fails after login', async () => {
    mocks.refresh.mockRejectedValue(new Error('boom'));
    render(<LoginPage />);
    submit();
    expect((await screen.findByRole('alert')).textContent).toMatch(/loading your session failed/);
  });

  it('shows the wrong-credentials alert and marks the password field', async () => {
    mocks.error = { code: 'INVALID_CREDENTIALS' };
    mocks.login.mockRejectedValue(new Error('bad'));
    render(<LoginPage />);
    submit();
    expect((await screen.findByRole('alert')).textContent).toMatch(/wrong username or password/i);
    expect(screen.getByLabelText('Password').getAttribute('aria-invalid')).toBe('true');
  });

  it('locks the form while rate limited and unlocks after the wait', async () => {
    mocks.error = { code: 'RATE_LIMITED', data: { retryAfterSeconds: 2 } };
    mocks.login.mockRejectedValue(new Error('slow down'));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<LoginPage />);
    submit();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /too many attempts. try again shortly\.$/i,
    );
    const button = screen.getByRole('button', { name: /wait 2 s/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect((screen.getByLabelText('Password') as HTMLInputElement).disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('button', { name: /wait 1 s/ })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/try again shortly\.$/i);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Password'));
  });
});
