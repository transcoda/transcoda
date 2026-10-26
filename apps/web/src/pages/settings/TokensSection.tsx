import type { ApiToken } from '@transcoda/contract';
import { TOKEN_SCOPES, type TokenScope } from '@transcoda/shared';
import { type FormEvent, useId, useRef, useState } from 'react';
import { api, safe } from '../../api/client.ts';
import { DisabledReason, RequiredMark } from '../../components/Form.tsx';
import { Icon } from '../../components/Icon.tsx';
import { Loading } from '../../components/Loading.tsx';
import { RowMenu } from '../../components/RowMenu.tsx';
import { useAsync } from '../../hooks/useAsync.ts';
import { copyShortcut, copyText } from '../../lib/clipboard.ts';
import { fmtAgo, fmtDate, fmtDayMonth } from '../../lib/time.ts';

const SCOPE_HINTS: Record<TokenScope, string> = {
  read: 'see workflows, jobs',
  plan: 'dry runs only',
  'jobs:create': 'queue files',
  'jobs:manage': 'cancel, retry',
  'workflows:write': 'can change what runs on files',
};

function When({ iso, children }: { iso: string; children: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {children}
    </time>
  );
}

type Created = ApiToken & { token: string };

/** Settings → API tokens: create, copy once, revoke. The section's h2 comes from SettingsPage. */
export function TokensSection() {
  const { data, error: loadError, loading, reload } = useAsync(() => api.tokens.list(), []);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<TokenScope[]>([]);
  const [expires, setExpires] = useState('');
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  /** Shown when the clipboard can't be written (plain http): what to press instead. */
  const [copyHint, setCopyHint] = useState<string | null>(null);
  const tokenRef = useRef<HTMLElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const id = useId();

  /** What still blocks "Create token" (the line under the disabled button). */
  const missing =
    name.trim() === '' && scopes.length === 0
      ? 'Enter a name and pick at least one scope'
      : name.trim() === ''
        ? 'Enter a name'
        : scopes.length === 0
          ? 'Pick at least one scope'
          : null;

  function toggle(scope: TokenScope, on: boolean) {
    setScopes((s) => TOKEN_SCOPES.filter((x) => (x === scope ? on : s.includes(x))));
  }

  function resetForm() {
    setName('');
    setScopes([]);
    setExpires('');
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Enter a token name');
      return;
    }
    setPending(true);
    try {
      const input: { name: string; scopes: TokenScope[]; expiresAt?: string } = {
        name: name.trim(),
        scopes,
      };
      if (expires) input.expiresAt = new Date(`${expires}T23:59:59.999`).toISOString();
      const [err, out] = await safe(api.tokens.create(input));
      if (err || !out) {
        setError('Could not create the token, check the values and try again');
        return;
      }
      setCreated(out);
      setCopied(false);
      setCopyHint(null);
      resetForm();
      reload();
    } finally {
      setPending(false);
    }
  }

  async function onRevoke(t: ApiToken) {
    setError(null);
    const [err] = await safe(api.tokens.revoke({ id: t.id }));
    if (err) setError('Could not revoke the token, try again');
    reload();
  }

  async function onCopy() {
    if (!created) return;
    // On plain http there may be no way to write the clipboard: then the token is selected.
    const result = await copyText(created.token, tokenRef.current);
    setCopied(result === 'copied');
    setCopyHint(
      result === 'copied'
        ? null
        : result === 'selected'
          ? `Selected. Press ${copyShortcut()} to copy.`
          : `Select the token and press ${copyShortcut()} to copy.`,
    );
  }

  return (
    <div className="tokens">
      <p className="section-intro">
        Let other tools (diskmap, scripts, Sonarr hooks) call Transcoda's API at{' '}
        <span className="mono">/api/v1</span>.
      </p>

      {error ? (
        <div className="alert alert-danger" role="alert">
          <Icon name="cross" strokeWidth={2.4} round />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="sr-only" role="status" aria-live="polite">
        {copied ? 'Copied' : ''}
      </div>

      {created ? (
        <section className="reveal" aria-labelledby={`${id}-new`}>
          <div className="reveal-head">
            <Icon name="check" size={20} strokeWidth={2.4} />
            <h3 id={`${id}-new`}>“{created.name}” created</h3>
            <span className="reveal-warn">Copy it now. It won't be shown again.</span>
          </div>
          <div className="reveal-row">
            <code ref={tokenRef} className="reveal-token">
              {created.token}
            </code>
            <button type="button" className="btn btn-ink btn-lg" onClick={onCopy}>
              <Icon name="copy" size={16} />
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              className="btn btn-ink-outline btn-lg"
              onClick={() => {
                setCreated(null);
                setCopied(false);
                setCopyHint(null);
              }}
            >
              I've saved it
            </button>
          </div>
          <p className="reveal-hint" role="status">
            {copyHint}
          </p>
          <div className="reveal-meta">
            scopes: {created.scopes.join(' · ')} · expires{' '}
            {created.expiresAt ? fmtDate(created.expiresAt) : 'never'}
          </div>
        </section>
      ) : (
        <form className="panel token-form" onSubmit={onCreate}>
          <h3>New token</h3>
          <div className="token-form-row">
            <div className="field field-name">
              <label htmlFor={`${id}-name`}>
                Name
                <RequiredMark />
              </label>
              <input
                id={`${id}-name`}
                className="input"
                aria-required
                maxLength={64}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="field field-expires">
              <label htmlFor={`${id}-exp`}>Expires</label>
              <input
                id={`${id}-exp`}
                className="input"
                type="date"
                aria-describedby={`${id}-exp-hint`}
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
              <span id={`${id}-exp-hint`} className="field-hint">
                Optional. Leave empty and the token never expires.
              </span>
            </div>
          </div>
          <fieldset className="scopes">
            <legend>Scopes</legend>
            <div className="scope-list">
              {TOKEN_SCOPES.map((s) => (
                <label key={s} className="scope-chip">
                  <input
                    type="checkbox"
                    aria-label={s}
                    aria-describedby={`${id}-scope-${s}`}
                    checked={scopes.includes(s)}
                    onChange={(e) => toggle(s, e.target.checked)}
                  />
                  <span>
                    <b className="mono">{s}</b>
                    <span id={`${id}-scope-${s}`}> · {SCOPE_HINTS[s]}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="form-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={pending || missing !== null}
              {...(missing ? { 'aria-describedby': `${id}-reason` } : {})}
            >
              Create token
            </button>
          </div>
          {missing ? <DisabledReason id={`${id}-reason`}>{missing}</DisabledReason> : null}
        </form>
      )}

      {loadError ? (
        <div className="alert alert-danger" role="alert">
          <Icon name="cross" strokeWidth={2.4} round />
          <span>Could not load tokens</span>
        </div>
      ) : loading && !data ? (
        <Loading />
      ) : (
        <section className="panel token-table" aria-label="Existing tokens">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Scopes</th>
                <th scope="col">Created</th>
                <th scope="col">Expires</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-row">
                    No tokens yet.
                  </td>
                </tr>
              ) : null}
              {(data ?? []).map((t) => {
                const revoked = Boolean(t.revokedAt);
                const isNew = created?.id === t.id;
                return (
                  <tr key={t.id} className={revoked ? 'is-revoked' : isNew ? 'is-new' : undefined}>
                    <td className="token-name">
                      <span>{t.name}</span>
                      {isNew ? <span className="new-tag">New</span> : null}
                    </td>
                    <td>
                      <div className="scope-tags">
                        {t.scopes.map((s) => (
                          <span key={s} className="scope-tag">
                            {s}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <When iso={t.createdAt}>{fmtAgo(t.createdAt)}</When>
                    </td>
                    <td>
                      {revoked ? (
                        '—'
                      ) : t.expiresAt ? (
                        <When iso={t.expiresAt}>{fmtDate(t.expiresAt)}</When>
                      ) : (
                        'Never'
                      )}
                    </td>
                    <td className={t.lastUsedAt ? undefined : 'faint'}>
                      {t.lastUsedAt ? (
                        <When iso={t.lastUsedAt}>{fmtAgo(t.lastUsedAt)}</When>
                      ) : (
                        'Never'
                      )}
                    </td>
                    <td className="token-action">
                      {t.revokedAt ? (
                        <span className="revoked-tag">
                          <Icon name="cross" size={12} strokeWidth={2.6} />
                          <When iso={t.revokedAt}>{`Revoked ${fmtDayMonth(t.revokedAt)}`}</When>
                        </span>
                      ) : (
                        <RowMenu
                          name={t.name}
                          items={[
                            {
                              label: 'Revoke',
                              icon: 'trash',
                              danger: true,
                              onSelect: () => void onRevoke(t),
                            },
                          ]}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
