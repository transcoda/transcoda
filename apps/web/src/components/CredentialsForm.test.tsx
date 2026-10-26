import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialsForm } from './CredentialsForm.tsx';

afterEach(cleanup);

const base = { title: 'Log in', submitLabel: 'Log in', minPasswordLength: 12 };

function fill(username: string, password: string) {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
}

describe('CredentialsForm', () => {
  it('renders the error text', () => {
    render(
      <CredentialsForm {...base} onSubmit={async () => {}} error="Wrong username or password" />,
    );
    expect(screen.getByText('Wrong username or password')).toBeTruthy();
  });

  it('submits with a trimmed username', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<CredentialsForm {...base} onSubmit={onSubmit} />);
    fill('  admin  ', 'correct horse battery');
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        username: 'admin',
        password: 'correct horse battery',
      }),
    );
  });

  it('disables the button while pending', async () => {
    let finish!: () => void;
    const onSubmit = () =>
      new Promise<void>((r) => {
        finish = r;
      });
    render(<CredentialsForm {...base} onSubmit={onSubmit} />);
    fill('admin', 'correct horse battery');
    const button = screen.getByRole('button', { name: 'Log in' }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    finish();
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it('sets minLength on the password input', () => {
    render(<CredentialsForm {...base} minPasswordLength={12} onSubmit={async () => {}} />);
    expect((screen.getByLabelText('Password') as HTMLInputElement).minLength).toBe(12);
  });
});
