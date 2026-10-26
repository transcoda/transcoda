import type { ReactNode } from 'react';
import { api } from '../api/client.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { Mark, Wordmark } from './Logo.tsx';

/** Two-panel layout of the setup and sign-in screens (screens/01-setup-and-login). */
export function AuthLayout({ children }: { children: ReactNode }) {
  const health = useAsync(() => api.system.health(), []);
  return (
    <div className="auth">
      <div className="auth-brand">
        <div className="auth-logo">
          <Mark size={40} tone="ink" />
          <Wordmark />
        </div>
        <p className="auth-tagline">
          Clean up
          <br />
          your media.
        </p>
        <div className="auth-meta">
          <span>{health.data ? `v${health.data.version}` : null}</span>
          <span>{window.location.host}</span>
        </div>
      </div>
      <main className="auth-main">
        <div className="auth-card">{children}</div>
      </main>
    </div>
  );
}
