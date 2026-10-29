import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { api, isDefinedError, safe } from '../api/client.ts';
import { useAuth } from '../auth/useAuth.ts';
import { AuthLayout } from '../components/AuthLayout.tsx';
import { CredentialsForm } from '../components/CredentialsForm.tsx';
import { usePageTitle } from '../lib/pageTitle.ts';

export function LoginPage() {
  usePageTitle('Sign in');
  const { refresh } = useAuth();
  const [, navigate] = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  // Seconds left while rate limited; the form is locked until it reaches 0.
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function onSubmit(creds: { username: string; password: string }) {
    setError(null);
    setWrong(false);
    const [err] = await safe(api.auth.login(creds));
    if (!err) {
      try {
        await refresh();
        navigate('/');
      } catch {
        setError('Signed in, but loading your session failed. Reload the page.');
      }
    } else if (isDefinedError(err) && err.code === 'INVALID_CREDENTIALS') {
      setError('Wrong username or password.');
      setWrong(true);
    } else if (isDefinedError(err) && err.code === 'RATE_LIMITED') {
      setWait(Math.max(1, Math.ceil(err.data.retryAfterSeconds)));
    } else {
      setError('Login failed, try again');
    }
  }

  const locked = wait > 0;
  return (
    <AuthLayout>
      <CredentialsForm
        title="Sign in"
        // The host once: the brand panel's footer beside the form, this line on a phone (where
        // that footer is hidden).
        intro={
          <span className="auth-host-intro">{`to Transcoda on ${window.location.hostname}`}</span>
        }
        submitLabel={locked ? `Sign in · wait ${wait} s` : 'Sign in'}
        minPasswordLength={1}
        error={locked ? 'Too many attempts. Try again shortly.' : error}
        errorTone={locked ? 'warning' : 'danger'}
        passwordInvalid={wrong && !locked}
        locked={locked}
        onSubmit={onSubmit}
      />
    </AuthLayout>
  );
}
