import { useState } from 'react';
import { useLocation } from 'wouter';
import { api, isDefinedError, safe } from '../api/client.ts';
import { useAuth } from '../auth/useAuth.ts';
import { AuthLayout } from '../components/AuthLayout.tsx';
import { CredentialsForm } from '../components/CredentialsForm.tsx';
import { usePageTitle } from '../lib/pageTitle.ts';

export function SetupPage() {
  usePageTitle('Set up');
  const { refresh } = useAuth();
  const [, navigate] = useLocation();
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(creds: { username: string; password: string }) {
    setError(null);
    const [err] = await safe(api.auth.setup(creds));
    if (!err) {
      try {
        await refresh();
        navigate('/');
      } catch {
        setError('Account created, but loading your session failed. Reload the page.');
      }
    } else if (isDefinedError(err) && err.code === 'SETUP_ALREADY_DONE') {
      try {
        await refresh();
        navigate('/login');
      } catch {
        setError('Setup was already completed, but loading your session failed. Reload the page.');
      }
    } else {
      setError('Setup failed. Check the values and try again.');
    }
  }

  return (
    <AuthLayout>
      <CredentialsForm
        eyebrow="First run"
        title="Create the admin account"
        intro="This is the only account on this server. Nothing else opens until it exists."
        submitLabel="Create account and sign in"
        minPasswordLength={12}
        error={error}
        onSubmit={onSubmit}
      />
    </AuthLayout>
  );
}
