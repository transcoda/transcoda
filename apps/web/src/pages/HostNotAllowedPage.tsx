import { AuthLayout } from '../components/AuthLayout.tsx';
import { Icon } from '../components/Icon.tsx';

/** Shown when the server's host check rejects the host name this UI was opened under. */
export function HostNotAllowedPage({ host }: { host: string }) {
  const name = host || window.location.hostname;
  return (
    <AuthLayout>
      <div className="credentials">
        <div className="credentials-head">
          <div className="eyebrow">Host check</div>
          <h1>Host name not allowed</h1>
        </div>
        <div className="alert alert-danger" role="alert">
          <Icon name="cross" strokeWidth={2.4} round />
          <span>
            This host name isn't allowed: <span className="mono">{name}</span>. Add it to{' '}
            <span className="mono">TRANSCODA_ALLOWED_HOSTS</span>.
          </span>
        </div>
        <p className="lead">
          Then restart Transcoda and reload this page, or open it under a host name that is already
          allowed.
        </p>
      </div>
    </AuthLayout>
  );
}
